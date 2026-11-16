// Builds two single-file bundles. dist/index.js is the host half (Node, loaded by DSH).
// dist/client.js is the browser half, a plain script that registers itself with the page's module loader.
// DSH's own packages and the Cordis and schemastery runtime stay external and resolve from the profile.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*', 'cordis', 'schemastery'],
  logLevel: 'info',
});

// Host face of the mcpTools remote (`./typert`). zod is bundled: the profile does not expose it to this package.
await build({
  entryPoints: ['src/typert.ts'],
  outfile: 'dist/typert.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*'],
  logLevel: 'info',
});

await build({
  entryPoints: ['src/client/entry.ts'],
  outfile: 'dist/client.js',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  logLevel: 'info',
});
