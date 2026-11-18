import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import test from 'node:test';

import { createTempDir, createTempHome } from './temp.ts';

test('createTempHome exposes a real-path AGENTS_HOME and cleans up', async () => {
  const home = await createTempHome();
  assert.ok(existsSync(home.path));
  assert.deepEqual({ ...home.env }, { AGENTS_HOME: home.path });
  await writeFile(join(home.path, 'probe.txt'), 'probe');
  await home.cleanup();
  assert.equal(existsSync(home.path), false);
  await home.cleanup();
});

test('createTempDir keeps the caller prefix', async () => {
  const dir = await createTempDir('repl-check-');
  try {
    assert.match(basename(dir.path), /^repl-check-/);
  } finally {
    await dir.cleanup();
  }
});

test('createTempDir rejects path separators in the prefix', async () => {
  await assert.rejects(() => createTempDir('../escape'), TypeError);
});
