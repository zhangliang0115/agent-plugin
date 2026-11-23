/**
 * Guards the numbers `docs/protocol.md` quotes against the constants that own them.
 *
 * The protocol is the only normative doc, so every number it restates must equal the
 * code. Each fact declares a pattern and the values it must see; a pattern that stops
 * matching is a failure too, because a dead check reads as "all good".
 *
 * Run: `node scripts/doc-facts.ts` (exit 1 on drift).
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIMITS } from '../../core/src/constants.ts';
import {
  INLINE_MAX_BYTES,
  PAYLOAD_HEAD_BYTES,
  PAYLOAD_MAX_BYTES,
  PREVIEW_BYTES,
} from '../../core/src/audit/payload.ts';
import {
  LOG_MAX_TOTAL_BYTES,
  LOG_RETENTION_DAYS,
} from '../src/audit/retention.ts';
import { MAX_ASYNC_EVAL_MS, MAX_SYNC_EVAL_MS } from '../src/exec/gateway.ts';
import {
  TASK_POLL_INTERVAL_MS,
  TASK_TIMEOUT_THRESHOLD_MS,
  TASK_TTL_MS,
} from '../src/tasks/mcp-tasks.ts';
import { listTools } from '../src/tools/registry.ts';

const PROTOCOL = fileURLToPath(new URL('../../docs/protocol.md', import.meta.url));
const ADMIN_API = fileURLToPath(new URL('../../docs/admin-api.md', import.meta.url));

interface SchemaProperty {
  readonly minimum?: number;
  readonly maximum?: number;
  readonly default?: number;
}

const tools = listTools();
function timeoutSchema(toolName: string): SchemaProperty {
  const tool = tools.find((candidate) => candidate.name === toolName);
  if (tool === undefined) throw new Error(`registry 里没有 ${toolName}`);
  const properties = tool.inputSchema.properties as Record<string, SchemaProperty> | undefined;
  const schema = properties?.timeoutMs ?? properties?.timeout;
  if (schema === undefined) throw new Error(`${toolName} 的 schema 里没有 timeout`);
  return schema;
}

const runScriptTimeout = timeoutSchema('run_script');
const waitTimeout = timeoutSchema('wait_tasks');

interface Fact {
  readonly id: string;
  /** Which contract owns the sentence; each doc is read once. */
  readonly doc: 'protocol' | 'admin';
  readonly pattern: RegExp;
  readonly expected: readonly (string | number)[];
  readonly note: string;
}

const FACTS: readonly Fact[] = [
  {
    id: 'run_script.timeout.minimum',
    doc: 'protocol',
    pattern: /"timeout": \{ "type": "integer", "minimum": (\d+) \}/,
    expected: [runScriptTimeout.minimum ?? Number.NaN],
    note: 'run_script schema',
  },
  {
    id: 'wait_tasks.timeoutMs',
    doc: 'protocol',
    pattern: /"timeoutMs": \{ "type": "integer", "minimum": (\d+), "maximum": (\d+), "default": (\d+) \}/,
    expected: [waitTimeout.minimum ?? Number.NaN, waitTimeout.maximum ?? Number.NaN, waitTimeout.default ?? Number.NaN],
    note: 'wait_tasks schema',
  },
  {
    id: 'eval.l2.caps',
    doc: 'protocol',
    pattern: /同步 (\d+)，`async: true` (\d+)/,
    expected: [MAX_SYNC_EVAL_MS, MAX_ASYNC_EVAL_MS],
    note: 'L2 上限钳制',
  },
  {
    id: 'eval.l0.slice',
    doc: 'protocol',
    pattern: /L0（(\d+)s）/,
    expected: [LIMITS.syncMs / 1000],
    note: '同步执行切片',
  },
  {
    id: 'task.ttl.sample',
    doc: 'protocol',
    pattern: /"ttlMs": (\d+),\n {2}"pollIntervalMs": (\d+)/,
    expected: [TASK_TTL_MS, TASK_POLL_INTERVAL_MS],
    note: 'CreateTaskResult 示例',
  },
  {
    id: 'task.ttl.prose',
    doc: 'protocol',
    pattern: /进程安全保留期（(\d+) ms）/,
    expected: [TASK_TTL_MS],
    note: 'ttlMs 语义段',
  },
  {
    id: 'task.dispatch.threshold',
    doc: 'protocol',
    pattern: /timeout > (\d+)/,
    expected: [TASK_TIMEOUT_THRESHOLD_MS],
    note: 'task 化阈值',
  },
  {
    id: 'payload.inline',
    doc: 'admin',
    pattern: /≤ (\d+) KiB 内联/,
    expected: [INLINE_MAX_BYTES / 1024],
    note: '内联阈值',
  },
  {
    id: 'payload.preview',
    doc: 'admin',
    pattern: /留 (\d+) KiB 预览/,
    expected: [PREVIEW_BYTES / 1024],
    note: '预览阈值',
  },
  {
    id: 'payload.cap',
    doc: 'admin',
    pattern: /> (\d+) MiB 只留首尾各 (\d+) MiB/,
    expected: [PAYLOAD_MAX_BYTES / (1024 * 1024), PAYLOAD_HEAD_BYTES / (1024 * 1024)],
    note: '单条硬顶与首尾配额',
  },
  {
    id: 'log.retention',
    doc: 'admin',
    pattern: /保留 (\d+) 天 \/ (\d+) GiB/,
    expected: [LOG_RETENTION_DAYS, LOG_MAX_TOTAL_BYTES / (1024 ** 3)],
    note: 'log/ 保留预算',
  },
];

interface Failure {
  readonly id: string;
  readonly doc: string;
  readonly line: number;
  readonly detail: string;
}

function lineAt(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

async function main(): Promise<number> {
  const texts: Record<'protocol' | 'admin', { path: string; text: string }> = {
    protocol: { path: 'docs/protocol.md', text: await readFile(PROTOCOL, 'utf8') },
    admin: { path: 'docs/admin-api.md', text: await readFile(ADMIN_API, 'utf8') },
  };
  const failures: Failure[] = [];
  let checked = 0;

  for (const fact of FACTS) {
    const source = texts[fact.doc];
    const text = source.text;
    const global = new RegExp(fact.pattern.source, `${fact.pattern.flags.replace('g', '')}g`);
    const matches = [...text.matchAll(global)];
    if (matches.length === 0) {
      failures.push({
        id: fact.id,
        doc: source.path,
        line: 0,
        detail: `${source.path} 里没有匹配 ${fact.pattern} 的片段（检查点失效，需更新脚本）`,
      });
      continue;
    }
    for (const match of matches) {
      checked += 1;
      const seen = match.slice(1).map((value) => String(value));
      const wanted = fact.expected.map((value) => String(value));
      if (seen.join('/') !== wanted.join('/')) {
        failures.push({
          id: fact.id,
          doc: source.path,
          line: lineAt(source.text, match.index ?? 0),
          detail: `文档 ${seen.join('/')} ≠ 代码 ${wanted.join('/')}（${fact.note}）`,
        });
      }
    }
  }

  for (const failure of failures) {
    const where = failure.line === 0 ? failure.doc : `${failure.doc}:${failure.line}`;
    console.error(`FAIL ${failure.id.padEnd(24)} ${where}  ${failure.detail}`);
  }
  if (failures.length > 0) {
    console.error(`契约数值校验失败：${failures.length} 处`);
    return 1;
  }
  console.log(`契约数值校验通过：${checked} 个检查点 / ${FACTS.length} 类事实`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
