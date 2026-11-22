// Bundles the server entry and the worker entry as standalone ESM files;
// esbuild keeps the server entry shebang. The dependency-free keeper script is
// copied beside them because keeperScriptPath() resolves it from the bundle.
import { copyFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { build } from 'esbuild';

await build({
  entryPoints: {
    index: 'src/index.ts',
    entry: '../core/src/worker/entry.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'info',
});

copyFileSync(resolve('../core/src/process/keeper.mjs'), resolve('dist/keeper.mjs'));
