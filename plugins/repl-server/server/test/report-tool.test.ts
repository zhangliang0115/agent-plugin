import assert from 'node:assert/strict';
import test from 'node:test';

import type { RequestIdentity } from '../src/ports.ts';
import {
  ReportRateLimitError,
  ReportValidationError,
  type ReportService,
} from '../src/reports/service.ts';
import type { ReportInput, StoredReport } from '../src/reports/types.ts';
import { McpTaskStore } from '../src/tasks/mcp-tasks.ts';
import { callTool, type ToolCallContext } from '../src/tools/call.ts';
import type { CallToolResult } from '../src/tools/registry.ts';
import { getToolDefinition, listTools, validateToolArguments } from '../src/tools/registry.ts';

const BOUND: RequestIdentity = {
  identity: 'bound',
  binding: 'cb_1',
  client: 'claude-code/2.1.327',
  clientName: 'claude-code',
  clientVersion: '2.1.327',
  mcp: 'mcp_1',
};

const UNBOUND: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'probe/1.0',
  clientName: 'probe',
  clientVersion: '1.0',
  mcp: 'mcp_2',
};

function stored(overrides: Partial<StoredReport> = {}): StoredReport {
  return {
    id: 'rep_0123456789abcdef0123456789abcdef',
    createdAt: '2026-11-18T06:00:00.000Z',
    updatedAt: '2026-11-18T06:00:00.000Z',
    source: 'mcp',
    binding: 'cb_1',
    client: 'claude-code/2.1.327',
    clientName: 'claude-code',
    clientVersion: '2.1.327',
    mcp: 'mcp_1',
    exec: null,
    evalId: null,
    ownerKey: 'cb_1',
    severity: 'high',
    title: 'Bash hangs',
    detail: 'npm test never returns',
    context: null,
    fingerprint: 'a'.repeat(64),
    status: 'open',
    alertState: 'pending',
    alertError: null,
    alertAttempts: 0,
    alertUpdatedAt: null,
    alertedAt: null,
    ...overrides,
  };
}

class FakeReports implements ReportService {
  readonly calls: ReportInput[] = [];
  duplicate = false;
  error: unknown = null;

  async create(input: ReportInput): Promise<{ report: StoredReport; duplicate: boolean }> {
    this.calls.push(input);
    if (this.error !== null) throw this.error;
    return { report: stored(), duplicate: this.duplicate };
  }

  async get(): Promise<StoredReport | null> {
    return null;
  }

  async list(): Promise<{ items: StoredReport[]; nextCursor: string | null }> {
    return { items: [], nextCursor: null };
  }

  async patchStatus(): Promise<StoredReport> {
    return stored();
  }

  async retryAlert(): Promise<StoredReport> {
    return stored();
  }
}

function harness(reports: ReportService | undefined): ToolCallContext {
  const ctx: ToolCallContext = {
    identity: BOUND,
    gateway: undefined as never,
    catalog: { snapshot: () => ({ revision: 0, tools: [] }) },
    tasks: new McpTaskStore(),
  };
  if (reports !== undefined) ctx.reports = reports;
  return ctx;
}

function parseText(result: CallToolResult): unknown {
  const block = result.content[0];
  assert.ok(block !== undefined);
  assert.equal(block.type, 'text');
  if (block.type !== 'text') throw new Error('unreachable');
  return JSON.parse(block.text);
}

/** `report_problem` is always synchronous, so the task-result branch cannot occur. */
async function callReport(
  name: string,
  input: unknown,
  ctx: ToolCallContext,
): Promise<CallToolResult> {
  assert.equal(name, 'report_problem');
  return (await callTool(name, input, ctx)) as CallToolResult;
}

function failure(tool: string, input: unknown): string {
  const result = validateToolArguments(tool, input);
  assert.equal(result.ok, false);
  if (result.ok) throw new Error('unreachable');
  return result.message;
}

test('report_problem is the fifth and last tool with a frozen, always-load schema', () => {
  const names = listTools().map((tool) => tool.name);
  assert.equal(names[names.length - 1], 'report_problem');
  const tool = getToolDefinition('report_problem');
  assert.ok(tool !== undefined);
  assert.equal(tool._meta['anthropic/alwaysLoad'], true);
  assert.equal(tool.annotations, undefined);
  assert.ok(Buffer.byteLength(tool.description, 'utf8') <= 500);
  assert.match(tool.description, /Never include credentials/);
  assert.deepEqual(tool.inputSchema, {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 1, maxLength: 200 },
      detail: { type: 'string', minLength: 1, maxLength: 20000 },
      severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
      context: { type: 'object', additionalProperties: true },
    },
    required: ['title', 'detail', 'severity'],
    additionalProperties: false,
  });
});

test('report_problem argument validation enforces lengths, enum and object shape', () => {
  assert.match(failure('report_problem', {}), /title is required/);
  assert.match(
    failure('report_problem', { title: '', detail: 'd', severity: 'low' }),
    /at least 1 character/,
  );
  assert.match(
    failure('report_problem', { title: 't'.repeat(201), detail: 'd', severity: 'low' }),
    /at most 200 character/,
  );
  assert.match(
    failure('report_problem', { title: 't', detail: 'd'.repeat(20_001), severity: 'low' }),
    /at most 20000 character/,
  );
  assert.match(
    failure('report_problem', { title: 't', detail: 'd', severity: 'urgent' }),
    /must be one of "low", "medium", "high", "critical"/,
  );
  assert.match(
    failure('report_problem', { title: 't', detail: 'd', severity: 'low', context: [] }),
    /context must be an object/,
  );
  assert.match(
    failure('report_problem', {
      title: 't',
      detail: 'd',
      severity: 'low',
      extra: 1,
    }),
    /does not accept the argument "extra"/,
  );
});

test('report_problem maps the request identity and returns reportId', async () => {
  const reports = new FakeReports();
  const result = await callReport(
    'report_problem',
    {
      title: 'Bash hangs',
      detail: 'npm test never returns',
      severity: 'high',
      context: { tool: 'Bash' },
    },
    harness(reports),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(parseText(result), {
    ok: true,
    reportId: 'rep_0123456789abcdef0123456789abcdef',
    duplicate: false,
  });

  const sent = reports.calls[0];
  assert.ok(sent !== undefined);
  assert.equal(sent.source, 'mcp');
  assert.equal(sent.binding, 'cb_1');
  assert.equal(sent.client, 'claude-code/2.1.327');
  assert.equal(sent.clientName, 'claude-code');
  assert.equal(sent.clientVersion, '2.1.327');
  assert.equal(sent.mcp, 'mcp_1');
  assert.equal(sent.ownerKey, 'cb_1');
  assert.equal(sent.exec, null);
  assert.equal(sent.evalId, null);
  assert.deepEqual(sent.context, { tool: 'Bash' });
});

test('unbound clients are keyed by the transport session id', async () => {
  const reports = new FakeReports();
  const ctx = harness(reports);
  ctx.identity = UNBOUND;
  await callReport('report_problem', { title: 't', detail: 'd', severity: 'low' }, ctx);
  assert.equal(reports.calls[0]?.ownerKey, 'mcp_2');
});

test('duplicates return the existing id with duplicate:true and no error', async () => {
  const reports = new FakeReports();
  reports.duplicate = true;
  const result = await callReport(
    'report_problem',
    { title: 't', detail: 'd', severity: 'low' },
    harness(reports),
  );
  assert.equal(result.isError, false);
  assert.deepEqual(parseText(result), {
    ok: true,
    reportId: 'rep_0123456789abcdef0123456789abcdef',
    duplicate: true,
  });
});

test('rate limits surface REPORT_RATE_LIMITED with retryAfterMs', async () => {
  const reports = new FakeReports();
  reports.error = new ReportRateLimitError(123_456);
  const result = await callReport(
    'report_problem',
    { title: 't', detail: 'd', severity: 'low' },
    harness(reports),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(parseText(result), {
    ok: false,
    error: {
      code: 'REPORT_RATE_LIMITED',
      message: 'report rate limit exceeded; retry later',
      retryAfterMs: 123_456,
    },
  });
});

test('service validation failures become INVALID_ARGUMENT', async () => {
  const reports = new FakeReports();
  reports.error = new ReportValidationError('title must not be empty', 'title');
  const result = await callReport(
    'report_problem',
    { title: '   ', detail: 'd', severity: 'low' },
    harness(reports),
  );
  assert.equal(result.isError, true);
  assert.deepEqual(parseText(result), {
    ok: false,
    error: { code: 'INVALID_ARGUMENT', message: 'title must not be empty' },
  });
});

test('unwired and storage failures use the frozen tool error codes', async () => {
  const unavailable = await callReport(
    'report_problem',
    { title: 't', detail: 'd', severity: 'low' },
    harness(undefined),
  );
  assert.equal(unavailable.isError, true);
  assert.deepEqual(parseText(unavailable), {
    ok: false,
    error: { code: 'REPORT_UNAVAILABLE', message: 'report service is not wired' },
  });

  const reports = new FakeReports();
  reports.error = new Error('disk full');
  const failed = await callReport(
    'report_problem',
    { title: 't', detail: 'd', severity: 'low' },
    harness(reports),
  );
  assert.equal(failed.isError, true);
  assert.deepEqual(parseText(failed), {
    ok: false,
    error: { code: 'REPORT_FAILED', message: 'disk full' },
  });
});
