import { test } from 'node:test';
import assert from 'node:assert/strict';

import { formatKeyValueLines, parseKeyValueLines, parseLines } from '../src/key-value-lines.ts';

test('splits multi-line text into trimmed, non-empty lines', () => {
  // Arrange
  const text = '  -y \n\n@scope/server  \n';

  // Act
  const lines = parseLines(text);

  // Assert
  assert.deepEqual(lines, ['-y', '@scope/server']);
});

test('parses KEY=VALUE lines and keeps equals signs inside the value', () => {
  // Arrange
  const text = 'TOKEN=${credential:FS_TOKEN}\nEXTRA=a=b\n';

  // Act
  const result = parseKeyValueLines(text);

  // Assert
  assert.deepEqual(result, {
    value: { TOKEN: '${credential:FS_TOKEN}', EXTRA: 'a=b' },
    errors: [],
  });
});

test('reports lines without a key and duplicate keys', () => {
  // Arrange
  const text = 'NOEQUALS\n=value\nKEY=1\nKEY=2';

  // Act
  const result = parseKeyValueLines(text);

  // Assert
  assert.deepEqual(result.value, { KEY: '2' });
  assert.deepEqual(result.errors, [
    '第 1 行「NOEQUALS」缺少 KEY=VALUE 格式',
    '第 2 行「=value」缺少键名',
    '键「KEY」重复出现',
  ]);
});

test('formats a record back into KEY=VALUE lines in key order', () => {
  // Act & Assert
  assert.equal(formatKeyValueLines({ B: '2', A: '1' }), 'A=1\nB=2');
  assert.equal(formatKeyValueLines({}), '');
});
