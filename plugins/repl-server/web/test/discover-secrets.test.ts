/** Rollback of secrets imported for a registration that then failed. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import { rollbackImportedSecrets } from '../src/lib/discover-secrets.ts';

function recorder(options: { fail?: boolean } = {}): {
  paths: string[];
  api: { delete(path: string): Promise<unknown> };
} {
  const paths: string[] = [];
  return {
    paths,
    api: {
      delete: async (path: string): Promise<unknown> => {
        paths.push(path);
        if (options.fail === true) throw new ApiError(500, 'INTERNAL', 'boom');
        return undefined;
      },
    },
  };
}

test('deletes every imported secret name', async () => {
  const { api, paths } = recorder();
  await rollbackImportedSecrets(
    api,
    ['disc.srv.env.API_KEY', 'disc.srv.header.X-Token'],
    new Error('registration failed'),
  );
  assert.deepEqual(paths, [
    '/secrets/disc.srv.env.API_KEY',
    '/secrets/disc.srv.header.X-Token',
  ]);
});

test('delete failures are silent and do not replace the registration error', async () => {
  const { api, paths } = recorder({ fail: true });
  const error = new Error('registration failed');
  await assert.doesNotReject(rollbackImportedSecrets(api, ['disc.srv.env.API_KEY'], error));
  assert.equal(paths.length, 1);
});

test('nothing is deleted when no secrets were imported', async () => {
  const { api, paths } = recorder();
  await rollbackImportedSecrets(api, undefined, new Error('registration failed'));
  await rollbackImportedSecrets(api, [], new Error('registration failed'));
  assert.deepEqual(paths, []);
});

test('secrets are kept when the server id already exists', async () => {
  const { api, paths } = recorder();
  await rollbackImportedSecrets(
    api,
    ['disc.srv.env.API_KEY'],
    new ApiError(409, 'SERVER_EXISTS', 'server srv already exists'),
  );
  assert.deepEqual(paths, []);
});
