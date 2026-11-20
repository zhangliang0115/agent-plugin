import assert from 'node:assert/strict';
import test from 'node:test';

import { referencedNames } from '../src/lib/secrets.ts';

test('referencedNames collects literal keys, secret refs and arg secrets', () => {
  const names = referencedNames([
    {
      id: 'pg',
      envKeys: ['DATABASE_URL'],
      headerKeys: ['Authorization'],
      envSecrets: { DATABASE_URL: 'pg_db_url' },
      headerSecrets: { Authorization: 'pg_pat' },
      secretArgs: [{ index: 2, secret: 'internal_token' }],
    },
  ]);
  assert.deepEqual([...names].sort(), [
    'Authorization',
    'DATABASE_URL',
    'internal_token',
    'pg_db_url',
    'pg_pat',
  ]);
});

test('referencedNames ignores servers without secret fields', () => {
  assert.deepEqual([...referencedNames([{ id: 'static' }])], []);
  assert.deepEqual([...referencedNames([])], []);
});
