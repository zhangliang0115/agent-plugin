import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FORBIDDEN = /^(@deepseek-ai\/|cordis$|cordis\/)/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
}

test('core package.json declares no host SDK dependency', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as Record<string, Record<string, string>>;
  const declared = [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ];
  assert.deepEqual(declared.filter((name) => FORBIDDEN.test(name)), []);
});

test('core src imports no host SDK and reads no host config', () => {
  const offenders: string[] = [];
  for (const file of sourceFiles(join(root, 'src'))) {
    const text = readFileSync(file, 'utf8');
    const imports = [...text.matchAll(/(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]/g)];
    for (const match of imports) {
      const spec = match[1] ?? match[2] ?? '';
      if (FORBIDDEN.test(spec)) offenders.push(`${file}: ${spec}`);
    }
    if (/process\.env|DSH_HOME|\.dsh\//.test(text)) offenders.push(`${file}: reads host configuration`);
  }
  assert.deepEqual(offenders, []);
});
