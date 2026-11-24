import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { openStateDb } from '../src/db/migrate.ts';
import { ScriptService } from '../src/scripts/service.ts';

/**
 * Relevance suite for `search_scripts` (FTS5 + bm25 weights 3/1/2 for
 * name/description/tags, prefix tokens, LIKE fallback). Expectations are
 * written from those rules, not from observed output. Fixture documents are
 * kept short so BM25 length normalisation does not flip the weight order.
 */
const NOW = Date.UTC(2026, 10, 24, 6, 0, 0);
const ACTOR = { createdBy: 'test' };

interface Fixture {
  db: DatabaseSync;
  service: ScriptService;
}

function fixture(t: TestContext): Fixture {
  const db = openStateDb(':memory:');
  t.after(() => db.close());
  // A per-save increasing clock makes updated_at a stable tie-break.
  let tick = NOW;
  const service = new ScriptService({ db, now: () => (tick += 1000) });
  return { db, service };
}

function archiveRun(service: ScriptService, runId: string): void {
  service.archiveRun({
    runId,
    createdAt: new Date(NOW).toISOString(),
    execId: `es_${runId}`,
    evalId: 1,
    requestId: 2,
    binding: 'cb_search',
    clientName: 'test-client',
    clientVersion: '1.0',
    workspace: 'default',
    entryTool: 'run_script',
    entryMode: 'code',
    args: null,
    scriptId: null,
    scriptVersion: null,
    scriptMode: null,
    code: 'return 41 + 1;',
    ok: true,
    error: null,
    resultBytes: 2,
    durationMs: 5,
    toolsUsed: ['Bash'],
    purpose: 'run',
  });
}

interface ScriptSeed {
  name: string;
  description: string;
  tags: string[];
  parameterized?: boolean;
}

/** 30 realistic scripts: four "report" probes, two "sentry" probes, Chinese
 *  probes, four GitLab/MR probes, one mid-token Chinese script and filler. */
const SCRIPTS: ScriptSeed[] = [
  { name: 'daily report', description: '生成 每日 邮件 摘要', tags: ['daily', 'summary'] },
  { name: 'report builder', description: 'Build a weekly status note from runs', tags: ['summary'] },
  { name: 'weekly digest', description: '汇总 本周 进展 并 发送 邮件', tags: ['report', 'weekly'] },
  { name: 'owner notify', description: 'Send a report link to the owner', tags: ['notify'] },
  { name: 'sentry issues by project', description: '列出 项目 的 错误 列表', tags: ['sentry', 'monitoring'] },
  { name: 'issue scanner', description: 'Fetch sentry issues for a project', tags: ['scanner'] },
  { name: '日志检索', description: '在 ES 中 按 关键字 搜索', tags: ['elasticsearch'] },
  { name: 'es log query', description: '查询 ES 日志 并 按 时间 过滤', tags: ['log'] },
  { name: 'gitlab mr list', description: '列出 项目 待评审 合并请求', tags: ['gitlab', 'review'] },
  { name: 'review queue', description: 'Fetch gitlab mr list for one project', tags: ['review'] },
  { name: 'gitlab pipeline status', description: '查看 流水线 状态', tags: ['ci'] },
  { name: 'merge request tracker', description: 'Track mr status', tags: ['review'] },
  { name: '加法脚本', description: '把 两 个 数 相加', tags: ['math'] },
  { name: 'daily digest', description: '汇总 每日 数据 并 生成 摘要', tags: ['daily'], parameterized: true },
  { name: 'digest mailer', description: 'Send the digest to a channel', tags: ['mail'] },
  { name: 'k8s pod restart', description: '重启 指定 命名空间 的 Pod', tags: ['kubernetes', 'ops'] },
  { name: 'mysql slow query', description: '列出 慢 SQL 并 按 耗时 排序', tags: ['mysql', 'sql'] },
  { name: 'redis key scan', description: '按 前缀 扫描 Redis 键', tags: ['redis'] },
  { name: 'jenkins build trigger', description: '触发 Jenkins 流水线 构建', tags: ['ci', 'jenkins'] },
  { name: 'jira ticket create', description: '新建 Jira 工单 并 指派 负责人', tags: ['jira', 'ticket'] },
  { name: 'slack notify', description: '向 Slack 频道 发送 消息', tags: ['slack', 'notify'] },
  { name: 'grafana dashboard snapshot', description: '导出 Grafana 面板 快照', tags: ['grafana', 'metrics'] },
  { name: 's3 bucket list', description: '列出 S3 存储桶 和 对象 数量', tags: ['aws', 's3'] },
  { name: 'ssh disk usage', description: '统计 远程 主机 磁盘 占用', tags: ['ssh', 'ops'] },
  { name: 'github release notes', description: '根据 提交 生成 发布 说明', tags: ['github', 'release'] },
  { name: 'npm version bump', description: '升级 npm 包 版本 并 打 tag', tags: ['npm', 'release'] },
  { name: 'postgres index check', description: '检查 索引 使用 情况', tags: ['postgres', 'sql'] },
  { name: 'kafka consumer lag', description: '查看 消费 延迟 指标', tags: ['kafka', 'metrics'] },
  { name: 'cron job pause', description: '暂停 定时 任务', tags: ['cron', 'ops'] },
  { name: 'docker image prune', description: '清理 无用 镜像', tags: ['docker', 'ops'] },
];

function seed(f: Fixture): void {
  SCRIPTS.forEach((script, index) => {
    if (script.parameterized === true) {
      const saved = f.service.save(ACTOR, {
        mode: 'parameterized',
        name: script.name,
        description: script.description,
        tags: script.tags,
        code: 'return 1;',
        inputSchema: { type: 'object', properties: {} },
      });
      f.service.activate(saved.scriptId, 1, `run_verified_${index}`, ACTOR);
      return;
    }
    const runId = `run_search_${index}`;
    archiveRun(f.service, runId);
    f.service.save(ACTOR, {
      runId,
      mode: 'exact',
      name: script.name,
      description: script.description,
      tags: script.tags,
    });
  });
}

function searchNames(f: Fixture, input: Parameters<ScriptService['search']>[0]): string[] {
  return f.service.search(input).map((item) => item.name);
}

test('name hits rank above tags-only hits, which rank above description-only hits', (t) => {
  const f = fixture(t);
  seed(f);

  // name weight 3 > tags weight 2 > description weight 1; same term, similar
  // document lengths, so BM25 must preserve the weight order.
  assert.deepEqual(searchNames(f, { query: 'report' }), [
    'daily report', // name hit, shortest document
    'report builder', // name hit
    'weekly digest', // tags = ["report", "weekly"], no name/description hit
    'owner notify', // description hit only
  ]);
});

test('English prefix query matches whole tokens and ranks the name hit first', (t) => {
  const f = fixture(t);
  seed(f);

  assert.deepEqual(searchNames(f, { query: 'sentr' }), [
    'sentry issues by project', // name token "sentry"
    'issue scanner', // description token "sentry"
  ]);
});

test('Chinese prefix query matches a longer Chinese token and keeps the name hit first', (t) => {
  const f = fixture(t);
  seed(f);

  // The tokenizer treats a contiguous Han run as one token: "日志" is a
  // prefix of the name token "日志检索" and an exact description token in the
  // second script.
  assert.deepEqual(searchNames(f, { query: '日志' }), ['日志检索', 'es log query']);
  assert.deepEqual(searchNames(f, { query: '加法' }), ['加法脚本']);
});

test('multi-keyword queries AND every term and drop partial matches', (t) => {
  const f = fixture(t);
  seed(f);

  const names = searchNames(f, { query: 'gitlab mr' });
  assert.deepEqual(names, [
    'gitlab mr list', // both terms in the name
    'review queue', // both terms in the description
  ]);
  assert.ok(!names.includes('gitlab pipeline status'), 'gitlab without mr must not match');
  assert.ok(!names.includes('merge request tracker'), 'mr without gitlab must not match');
});

test('FTS zero-hit falls back to a LIKE substring match', (t) => {
  const f = fixture(t);
  seed(f);

  // No token starts with "脚本", so MATCH misses and LIKE finds the
  // mid-token substring in the name "加法脚本".
  assert.deepEqual(searchNames(f, { query: '脚本' }), ['加法脚本']);
});

test('known limitation: an FTS hit suppresses LIKE substring results', (t) => {
  const f = fixture(t);
  seed(f);
  archiveRun(f.service, 'run_script_runner');
  f.service.save(ACTOR, {
    runId: 'run_script_runner',
    mode: 'exact',
    name: '脚本运行器',
    description: '运行 任意 代码 并 返回 输出',
    tags: ['runner'],
  });

  // The FTS hit makes search() return early instead of merging LIKE results,
  // so "加法脚本" (mid-token substring) is dropped.
  // known limitation: FTS 有命中时不合并 LIKE 子串结果
  const names = searchNames(f, { query: '脚本' });
  assert.deepEqual(names, ['脚本运行器']);
  assert.ok(!names.includes('加法脚本'));
});

test('search results carry the mode of their active version', (t) => {
  const f = fixture(t);
  seed(f);

  const modes = Object.fromEntries(
    f.service.search({ query: 'digest' }).map((item) => [item.name, item.mode]),
  );
  assert.deepEqual(modes, {
    'weekly digest': 'exact',
    'daily digest': 'parameterized',
    'digest mailer': 'exact',
  });
});

test('limit caps results and repeated searches keep a stable order', (t) => {
  const f = fixture(t);
  seed(f);

  const all = searchNames(f, { query: 'report' });
  assert.deepEqual(all, ['daily report', 'report builder', 'weekly digest', 'owner notify']);
  assert.deepEqual(searchNames(f, { query: 'report', limit: 1 }), all.slice(0, 1));
  assert.deepEqual(searchNames(f, { query: 'report', limit: 2 }), all.slice(0, 2));
  assert.deepEqual(
    searchNames(f, { query: 'report', limit: 2 }),
    searchNames(f, { query: 'report', limit: 2 }),
    'the ranking must not change between identical calls',
  );
  assert.deepEqual(searchNames(f, { query: 'report', limit: 999 }), all);
});
