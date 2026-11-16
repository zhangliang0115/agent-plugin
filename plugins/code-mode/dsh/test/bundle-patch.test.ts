import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), 'utf8');

function lines(name: string): string[] {
  return read(name).split('\n');
}

test('the bundle patch declares a preset instead of replacing the deployment executors', () => {
  const text = read('cordis.patch.yml');
  assert.match(text, /id: preset-code-mode/, 'declares the code-mode preset');
  assert.match(text, /name: '@deepseek-ai\/dsh-agent-preset'/, 'uses the agent-preset package');
  assert.doesNotMatch(text, /id: tool-executor-native\s*\n\s*disabled:\s*true/, 'does not disable the native executor');
  assert.doesNotMatch(text, /id: tool-executor-ptc\s*\n\s*disabled:\s*true/, 'does not disable the PTC executor');
});

test('the plugin row sits inside the preset plugin list, so its executor registers in agent scope', () => {
  const found = lines('cordis.patch.yml');
  const pluginRow = found.findIndex((line) => /^\s+- id: code-mode-dsh$/.test(line));
  assert.notEqual(pluginRow, -1, 'mounts the plugin');
  const rowLine: string = found[pluginRow] ?? '';
  const indent = /^(\s*)/.exec(rowLine)?.[1]?.length ?? 0;
  let pluginsOwner = -1;
  for (let index = pluginRow; index >= 0; index--) {
    const line: string = found[index] ?? '';
    if (/^\s*plugins:\s*$/.test(line) && (/^(\s*)/.exec(line)?.[1]?.length ?? 0) < indent) {
      pluginsOwner = index;
      break;
    }
  }
  assert.notEqual(pluginsOwner, -1, 'the row is a child of a preset plugins list');
});

test('the headless overlay is the only form that disables the deployment executors', () => {
  const text = read('cordis.headless.patch.yml');
  assert.match(text, /id: tool-executor-native\s*\n\s*disabled:\s*true/, 'disables the native executor');
  assert.match(text, /id: tool-executor-ptc\s*\n\s*disabled:\s*true/, 'disables the PTC executor');
  assert.match(text, /- id: code-mode-dsh/, 'mounts the plugin at deployment scope');
});

test('both patch files ship in the package', () => {
  const manifest = JSON.parse(read('package.json')) as { files: string[]; exports: Record<string, string> };
  assert.ok(manifest.files.includes('cordis.patch.yml'));
  assert.ok(manifest.files.includes('cordis.headless.patch.yml'), 'the headless overlay is published');
  assert.equal(manifest.exports['./cordis.headless.patch.yml'], './cordis.headless.patch.yml');
});
