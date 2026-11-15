import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { loadPlugins } from './lib/plugin-meta.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 校验 `<root>/plugins/<id>/plugin.meta.json`。通过返回 0，否则返回 1。 */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const { plugins, errors } = await loadPlugins(root);

  if (errors.length > 0) {
    for (const message of errors) console.error(`error: ${message}`);
    console.error(`校验失败：${errors.length} 个错误`);
    return 1;
  }

  console.log(`校验通过：${plugins.length} 个插件`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
