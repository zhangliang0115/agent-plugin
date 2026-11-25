import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  backfill,
  mergeUsage,
  scanEventLines,
  type ScanResult,
  type UsageTotals,
} from '../scripts/backfill-tool-usage.ts';

const BUILTIN = '__builtin__';
const NAMES = [
  'run_script',
  'search_tools',
  'describe_tools',
  'wait_tasks',
  'report_problem',
  'save_script',
  'search_scripts',
];

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function protoIn(
  mcp: string,
  id: number,
  name: string,
  ts: string,
  preview = false,
): string {
  return event({
    event: 'proto_in',
    mcp,
    id,
    method: 'tools/call',
    ts,
    ...(preview
      ? { paramsPreview: `{"name":"${name}","arguments":{"code":"const x = 1;` }
      : { params: { name } }),
  });
}

function protoOut(
  mcp: string,
  id: number,
  options: { ok?: boolean; isError?: boolean; preview?: string },
): string {
  return event({
    event: 'proto_out',
    mcp,
    id,
    method: 'tools/call',
    ...(options.ok === undefined ? {} : { ok: options.ok }),
    ...(options.preview !== undefined
      ? { resultPreview: options.preview }
      : options.isError === undefined
        ? {}
        : { result: { resultType: 'complete', content: [], isError: options.isError } }),
  });
}

function usage(result: ScanResult, name: string): UsageTotals {
  return result.totals.get(name) ?? { callCount: 0, successCount: 0, lastCalledAt: null };
}

async function tempHome(t: TestContext): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'repl-backfill-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

test('scanEventLines pairs reused ids in order and applies the failure rules', () => {
  const lines = [
    // Same mcp + id reused sequentially: both calls must count.
    protoIn('m1', 1, 'search_tools', '2026-01-01T00:00:01.000Z'),
    protoOut('m1', 1, { ok: true, isError: false }),
    protoIn('m1', 1, 'run_script', '2026-01-01T00:00:02.000Z'),
    protoOut('m1', 1, { ok: true, isError: true }),
    // Protocol failure counts even without a result.
    protoIn('m1', 2, 'run_script', '2026-01-01T00:00:03.000Z'),
    protoOut('m1', 2, { ok: false }),
    // A truncated preview cannot show isError; it counts as success.
    protoIn('m1', 3, 'run_script', '2026-01-01T00:00:04.000Z'),
    protoOut('m1', 3, { ok: true, preview: '{"resultType":"complete","content":[{"type":"text"' }),
    // A parseable preview does show the tool failure.
    protoIn('m1', 4, 'run_script', '2026-01-01T00:00:05.000Z'),
    protoOut('m1', 4, {
      ok: true,
      preview: '{"resultType":"complete","content":[],"isError":true}',
    }),
    // No output: counted as a call, never as a success.
    protoIn('m1', 5, 'search_tools', '2026-01-01T00:00:06.000Z'),
    // Truncated paramsPreview still yields the tool name.
    protoIn('m2', 7, 'run_script', '2026-01-01T00:00:07.000Z', true),
    protoOut('m2', 7, { ok: true, isError: false }),
    // Third-party tools are outside the backfill.
    protoIn('m2', 8, 'elasticsearch.search_documents', '2026-01-01T00:00:08.000Z'),
    protoOut('m2', 8, { ok: true, isError: false }),
    '{"event":',
  ];

  const result = scanEventLines(lines, new Set(NAMES));

  assert.deepEqual(usage(result, 'search_tools'), {
    callCount: 2,
    successCount: 1,
    lastCalledAt: '2026-01-01T00:00:06.000Z',
  });
  assert.deepEqual(usage(result, 'run_script'), {
    callCount: 5,
    successCount: 2,
    lastCalledAt: '2026-01-01T00:00:07.000Z',
  });
  assert.equal(result.totals.has('elasticsearch.search_documents'), false);
  assert.deepEqual(result.stats, {
    lines: 16,
    invalidJson: 1,
    toolCallEvents: 8,
    ignoredCalls: 1,
    unattributedCalls: 0,
    keylessCalls: 0,
    matchedCalls: 6,
    unmatchedCalls: 1,
    orphanOutputs: 1,
  });
});

test('mergeUsage keeps the larger absolute total and the later timestamp', () => {
  const history = { callCount: 4, successCount: 1, lastCalledAt: '2026-01-01T00:00:00.000Z' };
  const newer = { callCount: 3, successCount: 2, lastCalledAt: '2026-01-02T00:00:00.000Z' };
  assert.deepEqual(mergeUsage('run_script', history, newer).wouldWrite, {
    callCount: 4,
    successCount: 1,
    lastCalledAt: '2026-01-02T00:00:00.000Z',
  });

  const fewerButNewer = {
    callCount: 1,
    successCount: 0,
    lastCalledAt: '2026-06-01T00:00:00.000Z',
  };
  const current = { callCount: 5, successCount: 5, lastCalledAt: '2026-01-02T00:00:00.000Z' };
  assert.deepEqual(mergeUsage('describe_tools', fewerButNewer, current).wouldWrite, {
    callCount: 5,
    successCount: 5,
    lastCalledAt: '2026-06-01T00:00:00.000Z',
  });
  assert.equal(
    mergeUsage('describe_tools', { ...fewerButNewer, lastCalledAt: current.lastCalledAt }, current)
      .wouldWrite,
    null,
  );
});

test('backfill is a dry-run until --apply, then idempotent', async (t) => {
  const home = await tempHome(t);
  const runDir = join(home, 'repl-server', 'run');
  const logDir = join(home, 'repl-server', 'log');
  await mkdir(runDir, { recursive: true });
  await mkdir(logDir, { recursive: true });
  const dbPath = join(runDir, 'state.db');

  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE tools (server_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (server_id, name));
    CREATE TABLE tool_usage (
      server_id TEXT NOT NULL,
      name TEXT NOT NULL,
      call_count INTEGER NOT NULL DEFAULT 0,
      success_count INTEGER NOT NULL DEFAULT 0,
      last_called_at TEXT NOT NULL,
      PRIMARY KEY (server_id, name)
    );
  `);
  const insertTool = db.prepare('INSERT INTO tools (server_id, name) VALUES (?, ?)');
  for (const name of NAMES) insertTool.run(BUILTIN, name);
  insertTool.run('elasticsearch', 'search_documents');
  const insertUsage = db.prepare(
    'INSERT INTO tool_usage (server_id, name, call_count, success_count, last_called_at) VALUES (?, ?, ?, ?, ?)',
  );
  insertUsage.run(BUILTIN, 'run_script', 3, 2, '2026-01-02T00:00:00.000Z');
  insertUsage.run(BUILTIN, 'describe_tools', 5, 5, '2026-03-01T00:00:00.000Z');
  db.close();

  const lines = [
    protoIn('m1', 1, 'search_tools', '2026-01-01T00:00:01.000Z'),
    protoOut('m1', 1, { ok: true, isError: false }),
    protoIn('m1', 2, 'search_tools', '2026-01-05T00:00:00.000Z'),
    protoOut('m1', 2, { ok: true, isError: true }),
    protoIn('m1', 3, 'run_script', '2026-01-01T00:00:02.000Z'),
    protoOut('m1', 3, { ok: true, isError: false }),
    protoIn('m1', 4, 'run_script', '2026-01-01T00:00:03.000Z'),
    protoOut('m1', 4, { ok: true, isError: true }),
    protoIn('m1', 5, 'run_script', '2026-01-01T00:00:04.000Z'),
    protoOut('m1', 5, { ok: false }),
    protoIn('m1', 6, 'run_script', '2026-01-01T00:00:05.000Z'),
    protoOut('m1', 6, { ok: true, isError: true }),
    protoIn('m1', 7, 'describe_tools', '2026-04-01T00:00:00.000Z'),
    protoOut('m1', 7, { ok: true, isError: true }),
    protoIn('m1', 8, 'elasticsearch.search_documents', '2026-05-01T00:00:00.000Z'),
    protoOut('m1', 8, { ok: true, isError: false }),
  ];
  await writeFile(join(logDir, 'events-2026-01-01.jsonl'), `${lines.join('\n')}\n`);

  const dryRun = backfill({ root: home });
  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.changed, 3);
  assert.equal(dryRun.backup, null);
  const rows = new Map(dryRun.builtinTools.map((row) => [row.name, row]));
  assert.deepEqual(rows.get('search_tools')?.wouldWrite, {
    callCount: 2,
    successCount: 1,
    lastCalledAt: '2026-01-05T00:00:00.000Z',
  });
  assert.deepEqual(rows.get('run_script')?.wouldWrite, {
    callCount: 4,
    successCount: 1,
    lastCalledAt: '2026-01-02T00:00:00.000Z',
  });
  assert.deepEqual(rows.get('describe_tools')?.wouldWrite, {
    callCount: 5,
    successCount: 5,
    lastCalledAt: '2026-04-01T00:00:00.000Z',
  });
  assert.equal(rows.get('wait_tasks')?.wouldWrite, null);

  const untouched = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(
      untouched
        .prepare('SELECT COUNT(*) AS count FROM tool_usage WHERE server_id = ? AND name = ?')
        .get(BUILTIN, 'search_tools')?.['count'],
      0,
    );
    assert.equal(
      untouched
        .prepare('SELECT call_count FROM tool_usage WHERE server_id = ? AND name = ?')
        .get(BUILTIN, 'run_script')?.['call_count'],
      3,
    );
  } finally {
    untouched.close();
  }

  const applied = backfill({ root: home, apply: true });
  assert.equal(applied.mode, 'apply');
  assert.equal(applied.changed, 3);
  assert.ok(applied.backup);
  assert.equal(existsSync(applied.backup), true);

  const read = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const readUsage = (name: string): Record<string, unknown> | undefined => {
      const row = read
        .prepare(
          'SELECT call_count, success_count, last_called_at FROM tool_usage WHERE server_id = ? AND name = ?',
        )
        .get(BUILTIN, name) as Record<string, unknown> | undefined;
      return row === undefined ? undefined : { ...row };
    };
    assert.deepEqual(readUsage('search_tools'), {
      call_count: 2,
      success_count: 1,
      last_called_at: '2026-01-05T00:00:00.000Z',
    });
    assert.deepEqual(readUsage('run_script'), {
      call_count: 4,
      success_count: 1,
      last_called_at: '2026-01-02T00:00:00.000Z',
    });
    assert.deepEqual(readUsage('describe_tools'), {
      call_count: 5,
      success_count: 5,
      last_called_at: '2026-04-01T00:00:00.000Z',
    });
    assert.equal(readUsage('wait_tasks'), undefined);
    assert.equal(
      (read
        .prepare(
          'SELECT COUNT(*) AS count FROM tool_usage WHERE server_id = ? AND name = ?',
        )
        .get('elasticsearch', 'search_documents') as Record<string, unknown>)['count'],
      0,
    );
  } finally {
    read.close();
  }

  const again = backfill({ root: home, apply: true });
  assert.equal(again.changed, 0);
  assert.equal(again.backup, null);
});
