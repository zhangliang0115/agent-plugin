import assert from 'node:assert/strict';
import test from 'node:test';

import { createLog, formatLogLine } from '../src/log.ts';

const NOON = new Date(2026, 10, 20, 13, 5, 6, 7);

test('stamps local time, level, pid/thread and ordered context fields', () => {
  const line = formatLogLine(
    'hello',
    {
      level: 'warn',
      scope: 'mcp',
      mcp: 's1',
      client: 'Claude Code/1.0',
      binding: null,
      method: 'tools/call',
      status: 200,
      durMs: 12,
    },
    NOON,
    42,
    0,
  );
  assert.equal(
    line,
    '2026-11-20 13:05:06.007 WARN  pid=42 thread=0 scope=mcp mcp=s1 client="Claude Code/1.0" binding=null method=tools/call status=200 durMs=12 hello',
  );
});

test('defaults to info, drops undefined fields and keeps extra context', () => {
  const line = formatLogLine('boot', { scope: 'server', bytes: 9, reason: undefined }, NOON, 1, 0);
  assert.equal(line, '2026-11-20 13:05:06.007 INFO  pid=1 thread=0 scope=server bytes=9 boot');
});

test('createLog formats every line through the sink', () => {
  const lines: string[] = [];
  const log = createLog((line) => lines.push(line), { pid: 7, threadId: 3, now: () => NOON });
  log('started', { scope: 'server' });
  log('failed', { level: 'error', scope: 'audit' });
  assert.equal(lines[0], '2026-11-20 13:05:06.007 INFO  pid=7 thread=3 scope=server started');
  assert.equal(lines[1], '2026-11-20 13:05:06.007 ERROR pid=7 thread=3 scope=audit failed');
});
