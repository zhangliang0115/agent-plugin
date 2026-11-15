// Bundles the DSH adapter and the host-independent core into dist/index.js.
// DSH's own packages and the runtime dependencies stay external; they are resolved from the profile.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['@deepseek-ai/*', 'cordis', 'quickjs-emscripten', 'acorn'],
  logLevel: 'info',
});
