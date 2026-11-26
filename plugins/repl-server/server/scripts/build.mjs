// Bundles the server entry and the worker entry as standalone ESM files;
// esbuild keeps the server entry shebang. The dependency-free keeper script is
// copied beside them because keeperScriptPath() resolves it from the bundle,
// and the skill directory is copied so the Skills extension can serve it.
import { copyFileSync, cpSync, rmSync } from 'node:fs';
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
// Rebuild the copy so a file removed from the source skill cannot linger in dist
// and stay in the published manifest.
rmSync(resolve('dist/skills'), { recursive: true, force: true });
cpSync(resolve('../skills'), resolve('dist/skills'), { recursive: true });
