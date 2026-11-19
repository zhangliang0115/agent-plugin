/** Rollback decisions, reserved-key filtering and placeholder args for discovery. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  displayReason,
  filterDeclaredKeys,
  hasPlaceholderArgs,
  parseArgsText,
  rollbackImportedSecrets,
  shouldRollbackSecrets,
  type ServerProbe,
} from '../src/lib/discover-secrets.ts';

function recorder(
  options: { probe?: ServerProbe; failDelete?: boolean } = {},
): {
  paths: string[];
  gets: string[];
  api: { get(path: string): Promise<unknown>; delete(path: string): Promise<unknown> };
} {
  const paths: string[] = [];
  const gets: string[] = [];
  return {
    paths,
    gets,
    api: {
      get: async (path: string): Promise<unknown> => {
        gets.push(path);
        if (options.probe === 'missing') throw new ApiError(404, 'SERVER_NOT_FOUND', 'missing');
        if (options.probe === 'failed') throw new ApiError(0, 'NETWORK_ERROR', 'offline');
        return { server: {} };
      },
      delete: async (path: string): Promise<unknown> => {
        paths.push(path);
        if (options.failDelete === true) throw new ApiError(500, 'INTERNAL', 'boom');
        return undefined;
      },
    },
  };
}

test('shouldRollbackSecrets requires a definite rejection and a confirmed 404', () => {
  const cases: Array<[unknown, ServerProbe | undefined, boolean, string]> = [
    [new ApiError(400, 'BAD_REQUEST', 'bad'), 'missing', true, '400 + 404'],
    [new ApiError(422, 'VALIDATION_FAILED', 'bad'), 'missing', true, '422 + 404'],
    [new ApiError(400, 'BAD_REQUEST', 'bad'), 'present', false, '400 + server exists'],
    [new ApiError(422, 'VALIDATION_FAILED', 'bad'), 'failed', false, '422 + GET failed'],
    [new ApiError(422, 'VALIDATION_FAILED', 'bad'), undefined, false, '422 + no probe'],
    [new ApiError(0, 'NETWORK_ERROR', 'offline'), 'missing', false, 'network error'],
    [new ApiError(500, 'INTERNAL', 'boom'), 'missing', false, '5xx'],
    [new ApiError(201, 'INVALID_RESPONSE', 'bad json'), 'missing', false, '201 parse failure'],
    [new ApiError(409, 'CONFLICT', 'conflict'), 'missing', false, 'CONFLICT'],
    [new ApiError(409, 'SERVER_EXISTS', 'exists'), 'missing', false, 'SERVER_EXISTS'],
    [new Error('boom'), 'missing', false, 'not an ApiError'],
  ];
  for (const [error, probe, expected, label] of cases) {
    assert.equal(shouldRollbackSecrets(error, probe), expected, label);
  }
});

test('deletes every imported secret name after a 4xx and a missing server', async () => {
  const { api, paths, gets } = recorder({ probe: 'missing' });
  await rollbackImportedSecrets(
    api,
    'disc.srv',
    ['disc.srv.env.API_KEY', 'disc.srv.header.X-Token'],
    new ApiError(400, 'BAD_REQUEST', 'bad body'),
  );
  assert.deepEqual(gets, ['/servers/disc.srv']);
  assert.deepEqual(paths, [
    '/secrets/disc.srv.env.API_KEY',
    '/secrets/disc.srv.header.X-Token',
  ]);
});

test('secrets are kept when the server probe still finds the server', async () => {
  const { api, paths } = recorder({ probe: 'present' });
  await rollbackImportedSecrets(
    api,
    'disc.srv',
    ['disc.srv.env.API_KEY'],
    new ApiError(422, 'VALIDATION_FAILED', 'bad body'),
  );
  assert.deepEqual(paths, []);
});

test('secrets are kept when the server probe itself fails', async () => {
  const { api, paths } = recorder({ probe: 'failed' });
  await rollbackImportedSecrets(
    api,
    'disc.srv',
    ['disc.srv.env.API_KEY'],
    new ApiError(422, 'VALIDATION_FAILED', 'bad body'),
  );
  assert.deepEqual(paths, []);
});

test('network, 5xx, unparsable 2xx and conflict errors never delete secrets', async () => {
  const errors: Array<[unknown, string]> = [
    [new ApiError(0, 'NETWORK_ERROR', 'offline'), 'network'],
    [new ApiError(502, 'BAD_GATEWAY', 'proxy'), '5xx'],
    [new ApiError(201, 'INVALID_RESPONSE', 'bad json'), '201 parse'],
    [new ApiError(409, 'CONFLICT', 'write conflict'), 'CONFLICT'],
    [new ApiError(409, 'SERVER_EXISTS', 'server exists'), 'SERVER_EXISTS'],
  ];
  for (const [error, label] of errors) {
    const { api, paths, gets } = recorder({ probe: 'missing' });
    await rollbackImportedSecrets(api, 'disc.srv', ['disc.srv.env.API_KEY'], error);
    assert.deepEqual(paths, [], label);
    assert.deepEqual(gets, [], `${label}: no probe`);
  }
});

test('delete failures are silent and do not replace the registration error', async () => {
  const { api, paths } = recorder({ probe: 'missing', failDelete: true });
  const error = new ApiError(400, 'BAD_REQUEST', 'bad body');
  await assert.doesNotReject(
    rollbackImportedSecrets(api, 'disc.srv', ['disc.srv.env.API_KEY'], error),
  );
  assert.equal(paths.length, 1);
});

test('nothing is probed or deleted when no secrets were imported', async () => {
  const { api, paths, gets } = recorder({ probe: 'missing' });
  const error = new ApiError(400, 'BAD_REQUEST', 'bad body');
  await rollbackImportedSecrets(api, 'disc.srv', undefined, error);
  await rollbackImportedSecrets(api, 'disc.srv', [], error);
  assert.deepEqual(paths, []);
  assert.deepEqual(gets, []);
});

test('reserved keys are dropped from declared env and header keys', () => {
  assert.deepEqual(filterDeclaredKeys(['API_KEY', '__proto__', 'SAFE']), ['API_KEY', 'SAFE']);
  assert.deepEqual(filterDeclaredKeys([]), []);
});

test('placeholder args are detected anywhere in an argument', () => {
  assert.equal(hasPlaceholderArgs(['-y', '@mcp/server-filesystem', '<workspace>']), true);
  assert.equal(hasPlaceholderArgs(['--url=<url>']), true);
  assert.equal(hasPlaceholderArgs(['-y', '@mcp/server-fetch']), false);
  assert.equal(hasPlaceholderArgs([]), false);
});

test('parseArgsText keeps one argument per line and drops blank lines', () => {
  assert.deepEqual(parseArgsText('-y\n@mcp/server-filesystem\n/data/ws\n'), [
    '-y',
    '@mcp/server-filesystem',
    '/data/ws',
  ]);
  assert.deepEqual(parseArgsText('  -y  \n\n  /data/ws  \n'), ['-y', '/data/ws']);
  assert.deepEqual(parseArgsText(''), []);
});

test('displayReason names pre-registration editing only for placeholder args', () => {
  assert.equal(
    displayReason('npx 可用；注册时把 <workspace> 换成要暴露的绝对路径', ['<workspace>']),
    'npx 可用；注册前编辑参数，把 <workspace> 换成要暴露的绝对路径',
  );
  assert.equal(
    displayReason('未检测到 psql、~/.pgpass 或 DATABASE_URL', ['<url>']),
    '未检测到 psql、~/.pgpass 或 DATABASE_URL；注册前编辑参数',
  );
  assert.equal(displayReason('npx 可用', ['-y', '@mcp/server-fetch']), 'npx 可用');
});
