// Bundles the admin UI. The server package serves the copied assets from its dist/web.
import { cp, mkdir } from 'node:fs/promises';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  logLevel: 'info',
});

await cp('src/styles.css', 'dist/styles.css');

await mkdir('../server/dist/web', { recursive: true });
await cp('index.html', '../server/dist/web/index.html');
await cp('dist/main.js', '../server/dist/web/main.js');
await cp('dist/styles.css', '../server/dist/web/styles.css');
