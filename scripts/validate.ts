import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { loadPlugins, type LoadedPlugin } from './lib/plugin-meta.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * server/web 是同一插件的发布产物，版本必须与 plugin.meta.json 一致（ADR 0007）。
 * 只有对应目录存在时才检查，兼容没有这两类包的插件。
 */
export async function checkPackageVersions(root: string, plugins: readonly LoadedPlugin[]): Promise<string[]> {
  const errors: string[] = [];
  for (const { dirName, meta } of plugins) {
    for (const kind of ['server', 'web'] as const) {
      const path = join(root, 'plugins', dirName, kind, 'package.json');
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      let version: unknown;
      try {
        version = (JSON.parse(text) as { version?: unknown }).version;
      } catch (error) {
        errors.push(`plugins/${dirName}/${kind}/package.json: JSON 解析失败：${(error as Error).message}`);
        continue;
      }
      if (version !== meta.version) {
        errors.push(
          `plugins/${dirName}/${kind}/package.json: version ${JSON.stringify(version)} 必须等于 plugin.meta.json 的 ${JSON.stringify(meta.version)}`,
        );
      }
    }
  }
  return errors;
}

/** 校验 `<root>/plugins/<id>/plugin.meta.json`。通过返回 0，否则返回 1。 */
export async function main(root: string = REPO_ROOT): Promise<number> {
  const { plugins, errors: metaErrors } = await loadPlugins(root);
  const errors = [...metaErrors, ...(await checkPackageVersions(root, plugins))];

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
