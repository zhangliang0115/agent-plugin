/**
 * Guards `docs/admin-api.md` against the admin routes the code actually serves.
 *
 * Two passes, both real failures:
 *
 * 1. **Root segments.** A documented path such as `/servers/:id/tools` contributes the
 *    root `servers`, and every module that dispatches on `segments[0]` contributes the
 *    same root. This catches a module shipped without docs, or one renamed/removed.
 * 2. **Second segments for families dispatched outside `src/admin/`.** `/logs/*` lives in
 *    `src/audit/runtime.ts` behind `matchesRoute(segments, ['logs', 'query'])`, so the
 *    root check alone only saw the SSE line in `http-adapter.ts` and would have stayed
 *    green if `/logs/payload` were deleted. Roots that the deep pass can see are now
 *    compared path-by-path in both directions.
 *
 * Field-level shapes stay manual; §10 of the doc says so. An explicit `PLANNED` list
 * covers the one endpoint the design specifies before the code does, so the guard stays
 * honest instead of being loosened.
 *
 * Run: `node scripts/doc-admin.ts` (exit 1 on drift).
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC = fileURLToPath(new URL('../../docs/admin-api.md', import.meta.url));
const PROTOCOL = fileURLToPath(new URL('../../docs/protocol.md', import.meta.url));
const ADMIN_DIR = fileURLToPath(new URL('../src/admin/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Route tables that live outside `src/admin/` because they are owned by a feature
 * module. `/logs/*` is the only one today; add a file here when a family moves.
 */
const EXTRA_ROUTE_SOURCES: readonly string[] = ['server/src/audit/runtime.ts'];

/**
 * Families compared second-segment-by-second-segment. Restricting the deep pass to an
 * explicit list keeps it honest: admin-dir families are dispatched by nested `if`s whose
 * literal second segment is not the API path (`/tools/:serverId` is served from a
 * `path === '/tools'` branch), so guessing there produces false failures.
 */
const DEEP_FAMILIES: ReadonlySet<string> = new Set(['logs']);

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

interface CodeRoutes {
  readonly roots: Map<string, string[]>;
  /** Two-segment paths, only for families whose route table the deep patterns see. */
  readonly deep: Map<string, string[]>;
  readonly files: number;
}

/**
 * Collects root segments from the four dispatch shapes the admin modules use, plus
 * two-segment paths from the explicit shapes a feature module writes. Dynamic second
 * segments (`${ADMIN_API_ROOT}/evals/${id}/cancel`) are deliberately not collected:
 * comparing them would need the parameter name, which the doc spells differently.
 */
async function collectCodeRoutes(): Promise<CodeRoutes> {
  const sources = (await readdir(ADMIN_DIR))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => ({ label: `server/src/admin/${name}`, path: `${ADMIN_DIR}${name}` }))
    .concat(EXTRA_ROUTE_SOURCES.map((rel) => ({ label: rel, path: `${REPO_ROOT}${rel}` })));

  const roots = new Map<string, string[]>();
  const deep = new Map<string, string[]>();
  const own = (map: Map<string, string[]>, key: string, file: string): void => {
    const owners = map.get(key) ?? [];
    if (!owners.includes(file)) owners.push(file);
    map.set(key, owners);
  };
  const addRoot = (root: string, file: string): void => {
    if (root === '' || NON_ROOT_LITERALS.has(root)) return;
    own(roots, root, file);
  };
  const addDeep = (parts: readonly string[], file: string): void => {
    const [root, second] = parts as [string, string];
    if (root === undefined || second === undefined) return;
    if (NON_ROOT_LITERALS.has(root)) return;
    addRoot(root, file);
    own(deep, `${root}/${second}`, file);
  };

  for (const source of sources) {
    const text = await readFile(source.path, 'utf8');
    // `segments[0] !== 'servers'` guards, and `segments[0] === 'tools'` inline checks.
    for (const match of text.matchAll(/segments\[0\]\s*[!=]==\s*'([\w-]+)'/g)) {
      addRoot(match[1] as string, source.label);
    }
    // `path === '/overview'` and `path === '/config/export'`.
    for (const match of text.matchAll(/path\s*===\s*'\/([\w-]+)/g)) {
      addRoot(match[1] as string, source.label);
    }
    // Template literals built on the API root: `${ADMIN_API_ROOT}/csrf`.
    for (const match of text.matchAll(/ADMIN_API_ROOT\}\/([\w-]+)/g)) {
      addRoot(match[1] as string, source.label);
    }
    // Regex constants: `const EVAL_CANCEL_PATH = /^\/evals\/…/`.
    for (const match of text.matchAll(/=\s*\/\^\\\/([\w-]+)\\\//g)) {
      addRoot(match[1] as string, source.label);
    }
    // Deep shapes, all with literal segments on both sides.
    for (const match of text.matchAll(/matchesRoute\(segments,\s*\[([^\]]+)\]/g)) {
      const parts = [...(match[1] as string).matchAll(/'([\w-]+)'/g)].map((hit) => hit[1] as string);
      if (parts.length === 2) addDeep(parts, source.label);
    }
    for (const match of text.matchAll(
      /segments\[0\]\s*===\s*'([\w-]+)'\s*&&\s*segments\[1\]\s*===\s*'([\w-]+)'/g,
    )) {
      addDeep([match[1] as string, match[2] as string], source.label);
    }
    for (const match of text.matchAll(/ADMIN_API_ROOT\}\/([\w-]+)\/([\w-]+)/g)) {
      addDeep([match[1] as string, match[2] as string], source.label);
    }
  }

  return { roots, deep, files: sources.length };
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
  const documentedDeep = new Map<string, Row>();
  for (const row of rows) {
    const parts = row.path.split('/').filter((part) => part !== '');
    const root = rootOf(row.path);
    if (!documentedRoots.has(root)) documentedRoots.set(root, row);
    if (parts.length >= 2) {
      const key = `${parts[0]}/${parts[1]}`;
      if (!documentedDeep.has(key)) documentedDeep.set(key, row);
    }
  }

  const code = await collectCodeRoutes();
  if (code.roots.size < 10) {
    console.error(`FAIL 只从 ${code.files} 个模块解析出 ${code.roots.size} 个根段，提取规则已失效`);
    return 1;
  }

  for (const [root, row] of documentedRoots) {
    if (code.roots.has(root)) continue;
    const planned = [...PLANNED.keys()].filter((key) => rootOf(key.split(' ')[1] as string) === root);
    if (planned.length > 0) {
      console.log(`note /${root} 尚未接线：${planned.map((key) => `${key}（${PLANNED.get(key)}）`).join('、')}`);
      continue;
    }
    failures.push(`docs/admin-api.md:${row.line}  文档有 /${root} 端点，但 server/src 里没有模块匹配该根`);
  }

  for (const [root, owners] of code.roots) {
    if (!documentedRoots.has(root)) {
      failures.push(`${owners.join(',')}  代码服务 /${root}，但 docs/admin-api.md 端点表里没有该根`);
    }
  }

  // Deep pass, restricted to `DEEP_FAMILIES`. A declared family with no code-side entry
  // means the route table was renamed or the extraction rules stopped matching.
  const inFamily = (key: string): boolean => DEEP_FAMILIES.has(key.split('/')[0] as string);
  const codeDeep = [...code.deep].filter(([key]) => inFamily(key));
  const docDeep = [...documentedDeep].filter(([key]) => inFamily(key));
  const codeKeys = new Set(codeDeep.map(([key]) => key));

  for (const family of DEEP_FAMILIES) {
    if (!codeDeep.some(([key]) => key.startsWith(`${family}/`))) {
      failures.push(`深度比对失效：${family} 族在代码里没有任何两段路径（检查 ${EXTRA_ROUTE_SOURCES.join(', ')}）`);
    }
  }
  for (const [key, owners] of codeDeep) {
    if (documentedDeep.has(key)) continue;
    failures.push(`${owners.join(',')}  代码服务 /${key}，但 docs/admin-api.md 端点表里没有该路径`);
  }
  for (const [key, row] of docDeep) {
    if (codeKeys.has(key)) continue;
    failures.push(`docs/admin-api.md:${row.line}  文档有 /${key} 端点，但代码里没有对应路由`);
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
    `管理 API 校验通过：${rows.length} 个端点 / ${documentedRoots.size} 个根段，代码 ${code.files} 个模块、${code.roots.size} 个根段一致；` +
      `深度比对 ${docDeep.length} 条（/${[...DEEP_FAMILIES].join('、/')}）`,
  );
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
