/**
 * Guards `docs/admin-api.md` against the admin routes the code actually serves.
 *
 * The comparison is at **root-segment granularity**: a documented path such as
 * `/servers/:id/tools` contributes the root `servers`, and every admin module that
 * dispatches on `segments[0]` contributes the same root. That catches the drift that
 * actually happens — a new module shipped without docs, or a module renamed/removed —
 * without pretending to model each handler's nested `if` structure. Field-level shapes
 * stay manual; §10 of the doc says so.
 *
 * Two failure modes are treated as real failures, not warnings: a documented endpoint
 * whose root no module serves, and a served root with no documented endpoint. An
 * explicit `PLANNED` list covers the one endpoint the design specifies before the code
 * does, so the guard stays honest instead of being loosened.
 *
 * Run: `node scripts/doc-admin.ts` (exit 1 on drift).
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../../docs/admin-api.md', import.meta.url));
const PROTOCOL = fileURLToPath(new URL('../../docs/protocol.md', import.meta.url));
const ADMIN_DIR = fileURLToPath(new URL('../src/admin/', import.meta.url));

/** Documented but intentionally not routed yet; keyed `METHOD /path`. */
const PLANNED: ReadonlyMap<string, string> = new Map([
  ['GET /operations/:id', 'RS-07：operation 查询端点尚未接线'],
]);

/** Path literals that are route aliases rather than API roots (servers.ts normalises them to `/`). */
const NON_ROOT_LITERALS = new Set(['api']);

interface Row {
  readonly method: string;
  readonly path: string;
  readonly line: number;
}

function rootOf(path: string): string {
  const first = path.split('/').filter((part) => part !== '')[0];
  return first ?? '';
}

/** Parses the endpoint tables, skipping fenced code so JSON samples are not read as tables. */
function parseDocumentedRows(text: string): Row[] {
  const rows: Row[] = [];
  let fence = false;
  text.split('\n').forEach((line, index) => {
    if (line.trimStart().startsWith('```')) {
      fence = !fence;
      return;
    }
    if (fence) return;
    const match = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/.exec(line);
    if (match === null) return;
    const [, method, path] = match as unknown as [string, string, string];
    rows.push({ method, path, line: index + 1 });
  });
  return rows;
}

interface CodeRoots {
  readonly roots: Map<string, string[]>;
  readonly files: number;
}

/** Collects root segments from the four dispatch shapes the admin modules use. */
async function collectCodeRoots(): Promise<CodeRoots> {
  const files = (await readdir(ADMIN_DIR)).filter((name) => name.endsWith('.ts'));
  const roots = new Map<string, string[]>();
  const add = (root: string, file: string): void => {
    if (root === '' || NON_ROOT_LITERALS.has(root)) return;
    const owners = roots.get(root) ?? [];
    if (!owners.includes(file)) owners.push(file);
    roots.set(root, owners);
  };

  for (const file of files) {
    const text = await readFile(`${ADMIN_DIR}${file}`, 'utf8');
    // `segments[0] !== 'servers'` guards, and `segments[0] === 'tools'` inline checks.
    for (const match of text.matchAll(/segments\[0\]\s*[!=]==\s*'([\w-]+)'/g)) {
      add(match[1] as string, file);
    }
    // `path === '/overview'` and `path === '/config/export'`.
    for (const match of text.matchAll(/path\s*===\s*'\/([\w-]+)/g)) {
      add(match[1] as string, file);
    }
    // Template literals built on the API root: `${ADMIN_API_ROOT}/csrf`.
    for (const match of text.matchAll(/ADMIN_API_ROOT\}\/([\w-]+)/g)) {
      add(match[1] as string, file);
    }
    // Regex constants: `const EVAL_CANCEL_PATH = /^\/evals\/…/`.
    for (const match of text.matchAll(/=\s*\/\^\\\/([\w-]+)\\\//g)) {
      add(match[1] as string, file);
    }
  }

  return { roots, files: files.length };
}

async function main(): Promise<number> {
  const docText = await readFile(DOC, 'utf8');
  const rows = parseDocumentedRows(docText);
  const failures: string[] = [];

  if (rows.length === 0) {
    console.error('FAIL 端点表为空：docs/admin-api.md 里没解析到任何端点行（检查点失效）');
    return 1;
  }

  // Duplicates are how the 03/06 split started drifting; keep them out.
  const seen = new Map<string, Row>();
  for (const row of rows) {
    const key = `${row.method} ${row.path}`;
    const previous = seen.get(key);
    if (previous !== undefined) {
      failures.push(`docs/admin-api.md:${row.line}  重复端点 ${key}（首次出现在 :${previous.line}）`);
      continue;
    }
    seen.set(key, row);
    if (!row.path.startsWith('/')) {
      failures.push(`docs/admin-api.md:${row.line}  路径必须以 / 开头：${row.path}`);
    }
  }

  const documentedRoots = new Map<string, Row>();
  for (const row of rows) {
    const root = rootOf(row.path);
    if (!documentedRoots.has(root)) documentedRoots.set(root, row);
  }

  const code = await collectCodeRoots();
  if (code.roots.size < 10) {
    console.error(`FAIL 只从 ${code.files} 个 admin 模块解析出 ${code.roots.size} 个根段，提取规则已失效`);
    return 1;
  }

  for (const [root, row] of documentedRoots) {
    if (code.roots.has(root)) continue;
    const planned = [...PLANNED.keys()].filter((key) => rootOf(key.split(' ')[1] as string) === root);
    if (planned.length > 0) {
      console.log(`note /${root} 尚未接线：${planned.map((key) => `${key}（${PLANNED.get(key)}）`).join('、')}`);
      continue;
    }
    failures.push(`docs/admin-api.md:${row.line}  文档有 /${root} 端点，但 server/src/admin 里没有模块匹配该根`);
  }

  for (const [root, owners] of code.roots) {
    if (!documentedRoots.has(root)) {
      failures.push(`server/src/admin/${owners.join(',')}  代码服务 /${root}，但 docs/admin-api.md 端点表里没有该根`);
    }
  }

  for (const key of PLANNED.keys()) {
    const [method, path] = key.split(' ') as [string, string];
    if (!rows.some((row) => row.method === method && row.path === path)) {
      failures.push(`PLANNED ${key} 已不在文档里，删掉这条豁免`);
    }
    if (code.roots.has(rootOf(path))) {
      failures.push(`PLANNED ${key} 的根已被代码服务，说明端点可能已接线：删掉这条豁免并补测试`);
    }
  }

  // protocol.md must point admin shapes at this doc, not at the L2 design docs.
  const protocol = await readFile(PROTOCOL, 'utf8');
  if (!protocol.includes('admin-api.md')) {
    failures.push('docs/protocol.md 没有指向 docs/admin-api.md（管理端契约的唯一出处）');
  }

  for (const failure of failures) console.error(`FAIL ${failure}`);
  if (failures.length > 0) {
    console.error(`管理 API 校验失败：${failures.length} 处`);
    return 1;
  }
  console.log(
    `管理 API 校验通过：${rows.length} 个端点 / ${documentedRoots.size} 个根段，代码 ${code.files} 个模块、${code.roots.size} 个根段一致`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
