/** Env/header editor rows: server read-back, validation and wire serialization. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filledRows,
  rowsFromServer,
  rowsProblem,
  rowsToLiterals,
  rowsToSecretKeys,
  rowsToValues,
} from '../src/lib/env-header.ts';

test('rowsFromServer separates literals from secret references', () => {
  const rows = rowsFromServer(
    {
      envKeys: ['API_TOKEN', 'GHIDRA_INSTALL_DIR'],
      envSecrets: { API_TOKEN: 'disc.pg.env.API_TOKEN' },
      envLiterals: { GHIDRA_INSTALL_DIR: '/Users/me/ghidra' },
    },
    'env',
  );
  assert.deepEqual(rows, [
    { key: 'API_TOKEN', source: 'secret', value: 'disc.pg.env.API_TOKEN' },
    { key: 'GHIDRA_INSTALL_DIR', source: 'literal', value: '/Users/me/ghidra' },
  ]);
  assert.deepEqual(rowsFromServer({}, 'headers'), []);
});

test('rowsToValues keeps literals and turns secret rows into $secret refs', () => {
  assert.deepEqual(
    rowsToValues([
      { key: 'GHIDRA_INSTALL_DIR', source: 'literal', value: '/opt/ghidra' },
      { key: 'API_TOKEN', source: 'secret', value: 'disc.pg.env.API_TOKEN' },
      { key: 'EMPTY', source: 'literal', value: '' },
      { key: '', source: 'literal', value: '' },
    ]),
    {
      GHIDRA_INSTALL_DIR: '/opt/ghidra',
      API_TOKEN: { $secret: 'disc.pg.env.API_TOKEN' },
      EMPTY: '',
    },
  );
});

test('rowsToLiterals and rowsToSecretKeys split the AI draft shape', () => {
  const rows = [
    { key: 'GHIDRA_INSTALL_DIR', source: 'literal' as const, value: '/opt/ghidra' },
    { key: 'GITHUB_TOKEN', source: 'secret' as const, value: 'GITHUB_TOKEN' },
  ];
  assert.deepEqual(rowsToLiterals(rows), { GHIDRA_INSTALL_DIR: '/opt/ghidra' });
  assert.deepEqual(rowsToSecretKeys(rows), ['GITHUB_TOKEN']);
});

test('rowsProblem validates key patterns, duplicates and secret names', () => {
  assert.equal(rowsProblem([], 'env'), null);
  assert.match(rowsProblem([{ key: '1BAD', source: 'literal', value: '' }], 'env') ?? '', /不合法/);
  assert.match(
    rowsProblem([{ key: 'Good-Key', source: 'literal', value: '' }], 'env') ?? '',
    /不合法/,
  );
  assert.equal(rowsProblem([{ key: 'Good-Key', source: 'literal', value: '' }], 'headers'), null);
  assert.match(
    rowsProblem(
      [
        { key: 'TOKEN', source: 'literal', value: '' },
        { key: 'TOKEN', source: 'literal', value: 'x' },
      ],
      'env',
    ) ?? '',
    /重复/,
  );
  assert.match(
    rowsProblem([{ key: 'TOKEN', source: 'secret', value: '' }], 'env') ?? '',
    /密钥名不能为空/,
  );
  assert.equal(
    rowsProblem([{ key: 'TOKEN', source: 'secret', value: 'TOKEN' }], 'env', {
      secretNameMustMatchKey: true,
    }),
    null,
  );
  assert.match(
    rowsProblem([{ key: 'TOKEN', source: 'secret', value: 'OTHER' }], 'env', {
      secretNameMustMatchKey: true,
    }) ?? '',
    /密钥名必须与键名一致/,
  );
});

test('filledRows ignores blank rows but keeps intentionally empty literals', () => {
  assert.deepEqual(
    filledRows([
      { key: '', source: 'literal', value: '' },
      { key: 'EMPTY', source: 'literal', value: '' },
      { key: '', source: 'literal', value: 'orphan' },
    ]),
    [
      { key: 'EMPTY', source: 'literal', value: '' },
      { key: '', source: 'literal', value: 'orphan' },
    ],
  );
});
