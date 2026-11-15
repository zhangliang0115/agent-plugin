import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugins } from '../lib/plugin-meta.ts';
import { main as validateMain } from '../validate.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const repoOk = join(fixtures, 'repo-ok');
const repoBad = join(fixtures, 'repo-bad');

describe('loadPlugins', () => {
  it('loads the valid demo plugin without errors', async () => {
    const { plugins, errors } = await loadPlugins(repoOk);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      plugins.map((p) => p.dirName),
      ['demo'],
    );
  });

  it('reports every broken plugin in a bad repo', async () => {
    const { plugins, errors } = await loadPlugins(repoBad);
    const text = errors.join('\n');
    assert.deepEqual(
      plugins.map((p) => p.dirName),
      [],
    );
    assert.match(text, /wrong-dir.*目录名/);
    assert.match(text, /wrong-dir.*reason/);
    assert.match(text, /wrong-dir.*dsh/);
    assert.match(text, /broken-json/);
    assert.match(text, /no-meta.*plugin\.meta\.json/);
  });

  it('returns no plugins when the plugins directory is absent', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'agent-plugin-empty-'));
    try {
      const result = await loadPlugins(empty);
      assert.deepEqual(result, { plugins: [], errors: [] });
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  });
});

describe('validate main', () => {
  let emptyRoot: string;

  before(async () => {
    emptyRoot = await mkdtemp(join(tmpdir(), 'agent-plugin-validate-'));
  });

  after(async () => {
    await rm(emptyRoot, { recursive: true, force: true });
  });

  it('exits 0 when there are no plugins', async () => {
    assert.equal(await validateMain(emptyRoot), 0);
  });

  it('exits 0 for the valid fixture repo', async () => {
    assert.equal(await validateMain(repoOk), 0);
  });

  it('exits 1 for the bad fixture repo', async () => {
    assert.equal(await validateMain(repoBad), 1);
  });
});
