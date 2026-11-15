import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { HOSTS, loadPlugins, type HostEntry, type LoadedPlugin } from './lib/plugin-meta.ts';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

export const MATRIX_PATH = 'docs/capability-matrix.md';

const HEADER = [
  '# 能力矩阵',
  '',
  '> 生成物，不要手改。由 `pnpm matrix` 从 `plugins/*/plugin.meta.json` 生成；`pnpm matrix:check` 检查它与提交内容一致。',
  '',
  '',
].join('\n');

/** 表格单元格里不能出现裸的管道符和换行。 */
function cellText(text: string): string {
  return text.replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
}

function renderCell(entry: HostEntry | undefined): string {
  if (!entry) return '—';
  const detail = entry.status === 'unsupported' ? entry.reason : entry.components?.join(', ');
  return detail ? `${entry.status} (${detail})` : entry.status;
}

/** 把已校验的插件渲染成矩阵 Markdown。输出只依赖输入，顺序按目录名。 */
export function renderMatrix(plugins: LoadedPlugin[]): string {
  if (plugins.length === 0) return `${HEADER}暂无插件。\n`;

  const columns = ['插件', '版本', ...HOSTS];
  const rows = [...plugins]
    .sort((a, b) => a.dirName.localeCompare(b.dirName))
    .map((plugin) => [
      plugin.dirName,
      plugin.meta.version,
      ...HOSTS.map((host) => renderCell(plugin.meta.hosts[host])),
    ]);

  const lines = [
    `| ${columns.join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map((cells) => `| ${cells.map(cellText).join(' | ')} |`),
  ];
  return `${HEADER}${lines.join('\n')}\n`;
}

/**
 * 默认生成 docs/capability-matrix.md。`--check` 只比较，不一致时返回 1。
 * 元数据有错时两种模式都返回 1，不写文件。
 */
export async function main(argv: string[] = process.argv.slice(2), root: string = REPO_ROOT): Promise<number> {
  const unknown = argv.filter((arg) => arg !== '--check');
  if (unknown.length > 0) {
    console.error(`未知参数：${unknown.join(' ')}。用法：matrix [--check]`);
    return 2;
  }

  const { plugins, errors } = await loadPlugins(root);
  if (errors.length > 0) {
    for (const message of errors) console.error(`error: ${message}`);
    console.error('元数据校验失败，未生成矩阵');
    return 1;
  }

  const content = renderMatrix(plugins);
  const file = join(root, MATRIX_PATH);

  if (argv.includes('--check')) {
    const committed = await readFile(file, 'utf8').catch(() => null);
    if (committed !== content) {
      console.error(`error: ${MATRIX_PATH} 与 plugins/*/plugin.meta.json 的生成结果不一致，请运行 pnpm matrix 并提交结果`);
      return 1;
    }
    console.log(`${MATRIX_PATH} 与生成结果一致`);
    return 0;
  }

  await writeFile(file, content);
  console.log(`已生成 ${MATRIX_PATH}`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
