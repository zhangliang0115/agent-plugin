/** Proposal validation: draft keys named like Object.prototype members stay data. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeProposalServer, toServerConfig } from '../src/ai/validate.ts';

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
