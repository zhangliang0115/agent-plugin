/** Proposal validation: draft keys named like Object.prototype members stay data. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { AdminApiError } from '../src/admin/servers.ts';
import { normalizeProposalServer, toServerConfig } from '../src/ai/validate.ts';

function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ghidra',
    transport: 'stdio',
    command: 'npx',
    ...overrides,
  };
}

test('envKeys/headerKeys named __proto__ or constructor become own data entries', () => {
  const server = normalizeProposalServer({
    id: 'proto',
    transport: 'stdio',
    command: 'npx',
    envKeys: ['__proto__', 'constructor', 'GITHUB_TOKEN'],
    headerKeys: ['__proto__'],
  });
  const config = toServerConfig(server);

  assert.equal(Object.getPrototypeOf(config.env), Object.prototype);
  assert.equal(Object.hasOwn(config.env, '__proto__'), true);
  assert.deepEqual(config.env['__proto__'], { $secret: '__proto__' });
  assert.deepEqual(config.env['constructor'], { $secret: 'constructor' });
  assert.deepEqual(
    Object.keys(config.env).sort(),
    ['GITHUB_TOKEN', '__proto__', 'constructor'].sort(),
  );
  assert.equal(Object.hasOwn(config.headers, '__proto__'), true);
  assert.deepEqual(config.headers['__proto__'], { $secret: '__proto__' });
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
});

test('literal env/headers pass validation and survive toServerConfig', () => {
  const server = normalizeProposalServer(
    draft({
      env: { GHIDRA_INSTALL_DIR: '/Users/me/tools/ghidra', DEBUG: '0' },
      headers: { 'X-Env': 'dev' },
      envKeys: ['GITHUB_TOKEN'],
    }),
  );
  assert.deepEqual(server.env, {
    GHIDRA_INSTALL_DIR: '/Users/me/tools/ghidra',
    DEBUG: '0',
  });
  assert.deepEqual(server.headers, { 'X-Env': 'dev' });

  const config = toServerConfig(server);
  assert.deepEqual(config.env, {
    GHIDRA_INSTALL_DIR: '/Users/me/tools/ghidra',
    DEBUG: '0',
    GITHUB_TOKEN: { $secret: 'GITHUB_TOKEN' },
  });
  assert.deepEqual(config.headers, { 'X-Env': 'dev' });
});

test('credential-shaped literals are rejected with AI_SECRET_LITERAL', () => {
  assert.throws(
    () => normalizeProposalServer(draft({ env: { API_TOKEN: `ghp_${'a'.repeat(36)}` } })),
    (error: unknown) =>
      error instanceof AdminApiError && error.status === 422 && error.code === 'AI_SECRET_LITERAL',
  );
  assert.throws(
    () => normalizeProposalServer(draft({ headers: { Authorization: 'Bearer abcdefghijklmnop' } })),
    (error: unknown) =>
      error instanceof AdminApiError && error.status === 422 && error.code === 'AI_SECRET_LITERAL',
  );
});

test('secret objects and duplicate literal/key declarations are rejected', () => {
  assert.throws(
    () => normalizeProposalServer(draft({ env: { API_TOKEN: { $secret: 'API_TOKEN' } } })),
    (error: unknown) =>
      error instanceof AdminApiError && error.status === 422 && error.code === 'AI_PROPOSAL_INVALID',
  );
  assert.throws(
    () =>
      normalizeProposalServer(
        draft({ env: { API_TOKEN: 'not-a-secret' }, envKeys: ['API_TOKEN'] }),
      ),
    (error: unknown) =>
      error instanceof AdminApiError && error.status === 422 && error.code === 'AI_PROPOSAL_INVALID',
  );
});
