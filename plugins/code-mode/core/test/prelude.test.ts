import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isGlobalToolName, globalToolNames } from '../src/prelude.ts';

test('valid identifiers become global tool functions', () => {
  assert.equal(isGlobalToolName('Read'), true);
  assert.equal(isGlobalToolName('read_file'), true);
  assert.equal(isGlobalToolName('$x'), true);
  assert.deepEqual(globalToolNames(['Read', 'write_file']), ['Read', 'write_file']);
});

test('invalid names and reserved names stay reachable only through tools[name]', () => {
  for (const name of ['bad-name', '1abc', 'class', 'self', 'console', 'preview', 'tools', 'require', 'process', 'import', 'Promise', 'JSON', 'globalThis']) {
    assert.equal(isGlobalToolName(name), false, name);
  }
  assert.deepEqual(globalToolNames(['bad-name', 'self', 'Read']), ['Read']);
});
