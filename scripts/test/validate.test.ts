import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugins } from '../lib/plugin-meta.ts';
import { checkPackageVersions, main as validateMain } from '../validate.ts';

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

describe('checkPackageVersions', () => {
  it('reports a server package whose version drifts from plugin.meta.json', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-plugin-version-'));
    try {
      await mkdir(join(root, 'plugins', 'demo', 'server'), { recursive: true });
      await writeFile(
        join(root, 'plugins', 'demo', 'plugin.meta.json'),
        JSON.stringify({ id: 'demo', version: '1.0.0', description: 'demo', hosts: {} }),
      );
      await writeFile(
        join(root, 'plugins', 'demo', 'server', 'package.json'),
        JSON.stringify({ name: '@scope/demo', version: '0.9.0' }),
      );
      const { plugins } = await loadPlugins(root);
      const errors = await checkPackageVersions(root, plugins);
      assert.equal(errors.length, 1);
      assert.match(errors[0] ?? '', /version/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('validate main', () => {  let emptyRoot: string;

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
