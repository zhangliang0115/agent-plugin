import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePluginMeta, type Host } from '../lib/plugin-meta.ts';

const validPath = fileURLToPath(
  new URL('./fixtures/repo-ok/plugins/demo/plugin.meta.json', import.meta.url),
);

async function loadValid(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(validPath, 'utf8')) as Record<string, unknown>;
}

// 默认每个宿主都有 adapter 目录；个别用例会覆盖这个函数。
const allAdapters = (_host: Host): boolean => true;
const noAdapters = (_host: Host): boolean => false;

describe('validatePluginMeta', () => {
  it('accepts the valid fixture', async () => {
    const raw = await loadValid();
    const result = validatePluginMeta('demo', raw, allAdapters);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.meta.id, 'demo');
  });

  it('accepts unsupported hosts without adapter directories', async () => {
    const raw = await loadValid();
    raw.hosts = { pi: { status: 'unsupported', reason: '没有扩展点' } };
    const result = validatePluginMeta('demo', raw, noAdapters);
    assert.equal(result.ok, true);
  });

  it('rejects an id that is not kebab-case', async () => {
    for (const bad of ['Demo', 'de_mo', 'demo-', '-demo', 'de--mo', 'de mo']) {
      const raw = { ...(await loadValid()), id: bad };
      const result = validatePluginMeta(bad, raw, allAdapters);
      assert.equal(result.ok, false, `id ${JSON.stringify(bad)} should be rejected`);
      if (!result.ok) assert.match(result.errors.join('\n'), /kebab-case/);
    }
  });

  it('rejects an id that differs from the directory name', async () => {
    const raw = await loadValid();
    const result = validatePluginMeta('other', raw, allAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /目录名/);
  });

  it('rejects a host key outside claude-code, dsh, pi', async () => {
    const raw = await loadValid();
    raw.hosts = { codex: { status: 'unsupported', reason: 'x' } };
    const result = validatePluginMeta('demo', raw, allAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /codex/);
  });

  it('rejects a status outside supported, experimental, unsupported', async () => {
    const raw = await loadValid();
    raw.hosts = { dsh: { status: 'beta' } };
    const result = validatePluginMeta('demo', raw, allAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /beta/);
  });

  it('accepts components that is a string array', async () => {
    const raw = await loadValid();
    raw.hosts = { dsh: { status: 'supported', components: ['skill', 'tool'] } };
    const result = validatePluginMeta('demo', raw, allAdapters);
    assert.equal(result.ok, true);
  });

  it('rejects components that is a string instead of an array', async () => {
    const raw = await loadValid();
    raw.hosts = { dsh: { status: 'supported', components: 'tool' } };
    const result = validatePluginMeta('demo', raw, allAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /hosts\.dsh\.components/);
  });

  it('rejects components that is an array with non-string items', async () => {
    const raw = await loadValid();
    raw.hosts = { dsh: { status: 'supported', components: [1] } };
    const result = validatePluginMeta('demo', raw, allAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /hosts\.dsh\.components/);
  });

  it('rejects unsupported without a reason', async () => {
    for (const entry of [{ status: 'unsupported' }, { status: 'unsupported', reason: '' }]) {
      const raw = await loadValid();
      raw.hosts = { pi: entry };
      const result = validatePluginMeta('demo', raw, noAdapters);
      assert.equal(result.ok, false, JSON.stringify(entry));
      if (!result.ok) assert.match(result.errors.join('\n'), /reason/);
    }
  });

  it('rejects supported without an adapter directory', async () => {
    const raw = await loadValid();
    raw.hosts = { 'claude-code': { status: 'supported', components: ['skill'] } };
    const result = validatePluginMeta('demo', raw, noAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /claude-code/);
  });

  it('rejects experimental without an adapter directory', async () => {
    const raw = await loadValid();
    raw.hosts = { dsh: { status: 'experimental' } };
    const result = validatePluginMeta('demo', raw, noAdapters);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /dsh/);
  });

  it('rejects a missing version or description', async () => {
    for (const key of ['version', 'description']) {
      const raw = await loadValid();
      delete raw[key];
      const result = validatePluginMeta('demo', raw, allAdapters);
      assert.equal(result.ok, false, `missing ${key}`);
      if (!result.ok) assert.match(result.errors.join('\n'), new RegExp(key));
    }
  });

  it('rejects a non-object document', () => {
    const result = validatePluginMeta('demo', ['not', 'an', 'object'], allAdapters);
    assert.equal(result.ok, false);
  });
});
