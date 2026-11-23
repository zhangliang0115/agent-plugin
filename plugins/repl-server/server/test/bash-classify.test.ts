import assert from 'node:assert/strict';
import test from 'node:test';

import { bashConcurrency } from '../src/exec/bash-classify.ts';

test('plain readers run in parallel', () => {
  for (const command of [
    'ls -la',
    'cat package.json',
    'rg "useEffect" src',
    'git status --short',
    'git log --oneline -5',
    'wc -l src/index.ts',
    'ls && cat README.md',
    'grep -rn TODO src | head -20',
    'npm ls --depth=0',
  ]) {
    assert.equal(bashConcurrency({ command }), 'parallel', command);
  }
});

test('anything that can write is serial', () => {
  for (const command of [
    'rm -rf dist',
    'mv a b',
    'mkdir -p out',
    'echo hi > out.txt',
    'cat a >> b',
    'sed -i "" "s/a/b/" file.txt',
    'find . -name "*.tmp" -delete',
    'git commit -m x',
    'git checkout -b feature',
    'npm install',
    'node scripts/build.mjs',
    'cat $(echo file.txt)',
    'ls &',
    'FOO=1 ls',
    'unknown-binary --flag',
  ]) {
    assert.equal(bashConcurrency({ command }), 'serial', command);
  }
});

test('subcommands without a reader entry fall back to serial', () => {
  assert.equal(bashConcurrency({ command: 'git' }), 'serial');
  assert.equal(bashConcurrency({ command: 'npm run build' }), 'serial');
  assert.equal(bashConcurrency({ command: 'git log' }), 'parallel');
});

test('missing or non-string commands are serial', () => {
  assert.equal(bashConcurrency({}), 'serial');
  assert.equal(bashConcurrency({ command: '' }), 'serial');
  assert.equal(bashConcurrency({ command: '   ' }), 'serial');
  assert.equal(bashConcurrency({ command: 42 }), 'serial');
});
