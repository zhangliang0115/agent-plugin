import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mcpSessionText,
  requestLocatorFields,
  type RequestLocatorField,
} from '../src/lib/request-meta.ts';
import { formatTimestamp } from '../src/lib/format.ts';

function valueOf(fields: readonly RequestLocatorField[], key: string): string | undefined {
  return fields.find((field) => field.key === key)?.value;
}

const fullPair = {
  mcp: 'mcp-main',
  id: 32,
  method: 'tools/call',
  request: {
    ts: '2026-11-20T10:00:00.000Z',
    bytes: 512,
    identity: 'bound',
    binding: 'cb_abc123',
    clientName: 'claude-code',
    clientVersion: '2.0.1',
    params: { name: 'run_script', arguments: { apiKey: 'SECRET_VALUE' } },
  },
  response: { ts: '2026-11-20T10:00:00.250Z', bytes: 4096, identity: 'bound', binding: 'cb_abc123' },
  durMs: 250,
  ok: true,
};

const fullEvents = [
  {},
  {
    exec: 'es_1',
    runId: '6f1c2a3e-1111-4222-8333-444455556666',
    evalId: 3,
    evalTaskId: 't_abc',
    scriptId: 's_1',
  },
];

test('requestLocatorFields covers frame and event locator keys in a fixed order', () => {
  const fields = requestLocatorFields(fullPair, fullEvents);
  assert.deepEqual(
    fields.map((field) => field.key),
    [
      'mcp',
      'id',
      'method',
      'tool',
      'requestTs',
      'responseTs',
      'status',
      'durMs',
      'bytes',
      'client',
      'binding',
      'exec',
      'runId',
      'evalId',
      'evalTaskId',
      'scriptId',
    ],
  );
  assert.equal(valueOf(fields, 'mcp'), 'mcp-main');
  assert.equal(valueOf(fields, 'id'), '32');
  assert.equal(valueOf(fields, 'method'), 'tools/call');
  assert.equal(valueOf(fields, 'tool'), 'run_script');
  assert.equal(valueOf(fields, 'requestTs'), formatTimestamp('2026-11-20T10:00:00.000Z'));
  assert.equal(valueOf(fields, 'responseTs'), formatTimestamp('2026-11-20T10:00:00.250Z'));
  assert.equal(valueOf(fields, 'status'), '正常');
  assert.equal(valueOf(fields, 'durMs'), '250 ms');
  assert.equal(valueOf(fields, 'bytes'), '512 B / 4.0 KB');
  assert.equal(valueOf(fields, 'client'), 'claude-code/2.0.1');
  assert.equal(valueOf(fields, 'binding'), 'cb_abc123');
  assert.equal(valueOf(fields, 'exec'), 'es_1');
  assert.equal(valueOf(fields, 'runId'), '6f1c2a3e-1111-4222-8333-444455556666');
  assert.equal(valueOf(fields, 'evalId'), '3');
  assert.equal(valueOf(fields, 'evalTaskId'), 't_abc');
  assert.equal(valueOf(fields, 'scriptId'), 's_1');
});

test('mcpSessionText copies nothing but the MCP session value', () => {
  const fields = requestLocatorFields(fullPair, fullEvents);
  const text = mcpSessionText(fields);
  assert.equal(text, 'mcp-main');
  for (const value of [
    '请求定位',
    'MCP 会话',
    'JSON-RPC ID',
    '请求时间',
    formatTimestamp('2026-11-20T10:00:00.000Z'),
    'tools/call',
    'run_script',
    'es_1',
    '6f1c2a3e-1111-4222-8333-444455556666',
    'evalId',
    '异步任务',
    '脚本 ID',
    'SECRET_VALUE',
  ]) {
    assert.ok(!text.includes(value), `${value} must not be copied`);
  }
  assert.ok(!text.includes('\n'), 'copy text is a single value');
});

test('a pair without a response reports 无响应 and omits response-only fields', () => {
  const fields = requestLocatorFields(
    {
      mcp: 'mcp-main',
      id: 'abc',
      method: 'tools/list',
      request: { ts: '2026-11-20T10:00:00.000Z', bytes: 80 },
      response: null,
    },
    null,
  );
  assert.equal(valueOf(fields, 'status'), '无响应');
  assert.equal(valueOf(fields, 'bytes'), '80 B / —');
  const keys = fields.map((field) => field.key);
  assert.ok(!keys.includes('responseTs'));
  assert.ok(!keys.includes('durMs'));
  assert.ok(!keys.includes('exec'));
  assert.ok(!keys.includes('tool'), 'tools/list has no tool name');
});

test('missing core fields render as — without throwing', () => {
  const fields = requestLocatorFields(
    { mcp: '', id: null, method: null, request: null, response: null },
    null,
  );
  assert.deepEqual(fields.map((field) => field.key), ['mcp', 'id', 'method', 'status']);
  assert.equal(valueOf(fields, 'mcp'), '—');
  assert.equal(valueOf(fields, 'id'), '—');
  assert.equal(valueOf(fields, 'method'), '—');
  assert.equal(valueOf(fields, 'status'), '无响应');
  assert.equal(mcpSessionText(fields), '—', 'a missing MCP session copies the placeholder');
});

test('event fields are omitted when events lack them', () => {
  const fields = requestLocatorFields(fullPair, [{}, { exec: '' }, { exec: 'es_late' }]);
  assert.equal(valueOf(fields, 'exec'), 'es_late');
  for (const key of ['runId', 'evalId', 'evalTaskId', 'scriptId']) {
    assert.ok(!fields.some((field) => field.key === key), `${key} should be omitted`);
  }
});

test('evalId is hidden without an exec session and the legacy client label is kept', () => {
  const fields = requestLocatorFields(
    {
      mcp: 'mcp-main',
      id: 7,
      method: 'tools/call',
      request: { ts: '2026-11-20T10:00:00.000Z', client: 'other-client/9.9' },
      response: { ts: '2026-11-20T10:00:01.000Z' },
      ok: false,
    },
    [{ evalId: 4 }],
  );
  assert.equal(valueOf(fields, 'client'), 'other-client/9.9');
  assert.equal(valueOf(fields, 'status'), '失败');
  assert.ok(!fields.some((field) => field.key === 'evalId'));
  assert.ok(!fields.some((field) => field.key === 'tool'), 'params are absent');
});
