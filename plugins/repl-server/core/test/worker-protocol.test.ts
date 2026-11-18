import assert from 'node:assert/strict';
import test from 'node:test';

import {
  callMessage,
  callResultError,
  callResultOk,
  cancelMessage,
  doneMessage,
  errorMessage,
  evalMessage,
  isHostToWorkerMessage,
  isWorkerToHostMessage,
  logMessage,
  procsResultError,
  procsResultOk,
  readyMessage,
  snapshotReply,
  snapshotRequest,
} from '../src/worker/protocol.ts';

test('host → worker builders produce the frozen shapes', () => {
  assert.deepEqual(evalMessage(3, 2, 'return 1', 5_000), {
    t: 'eval',
    evalId: 3,
    epoch: 2,
    code: 'return 1',
    syncMs: 5_000,
  });
  assert.deepEqual(cancelMessage(3), { t: 'cancel', evalId: 3 });
  assert.deepEqual(snapshotRequest(3), { t: 'snapshot', evalId: 3 });
  assert.deepEqual(callResultOk(3, 4, { echoed: 1 }), {
    t: 'call-result',
    evalId: 3,
    callSeq: 4,
    ok: true,
    value: { echoed: 1 },
  });
  assert.deepEqual(callResultError(3, 4, 'boom'), {
    t: 'call-result',
    evalId: 3,
    callSeq: 4,
    ok: false,
    error: 'boom',
  });
  assert.deepEqual(procsResultOk(3, 9, ['p_a']), {
    t: 'procs-result',
    evalId: 3,
    reqSeq: 9,
    ok: true,
    value: ['p_a'],
  });
  assert.deepEqual(procsResultError(3, 9, 'nope'), {
    t: 'procs-result',
    evalId: 3,
    reqSeq: 9,
    ok: false,
    error: 'nope',
  });
});

test('worker → host builders produce the frozen shapes', () => {
  assert.deepEqual(readyMessage(2), { t: 'ready', epoch: 2 });
  assert.deepEqual(callMessage({ evalId: 1, epoch: 2, callSeq: 3, tool: 'Bash', args: { command: 'ls' } }), {
    t: 'call',
    evalId: 1,
    epoch: 2,
    callSeq: 3,
    tool: 'Bash',
    args: { command: 'ls' },
  });
  assert.deepEqual(
    callMessage({ evalId: 1, epoch: 2, callSeq: 4, tool: 'query', server: 'pg', args: {} }),
    { t: 'call', evalId: 1, epoch: 2, callSeq: 4, tool: 'query', server: 'pg', args: {} },
  );
  assert.deepEqual(logMessage(1, 'console', 'hi\n'), { t: 'log', evalId: 1, stream: 'console', text: 'hi\n' });
  assert.deepEqual(doneMessage(1, { result: 2, stdout: 'o', stderr: 'e', ms: 5 }), {
    t: 'done',
    evalId: 1,
    result: 2,
    stdout: 'o',
    stderr: 'e',
    ms: 5,
    truncated: {},
  });
  assert.deepEqual(errorMessage(1, 'boom', { layer: 'sync', stack: 'at x' }), {
    t: 'error',
    evalId: 1,
    message: 'boom',
    layer: 'sync',
    stack: 'at x',
  });
});

test('snapshot replies mark empty or skipped payloads', () => {
  const buf = new Uint8Array([1, 2, 3]).buffer;
  const plain = snapshotReply(7, buf);
  assert.equal(plain.t, 'snapshot');
  assert.equal(plain.evalId, 7);
  assert.equal(plain.buf, buf);
  assert.equal(plain.skipped, undefined);

  const skipped = snapshotReply(7, new ArrayBuffer(0), 'too-large');
  assert.equal(skipped.skipped, 'too-large');
  assert.equal(skipped.buf.byteLength, 0);
});

test('worker → host guard accepts every valid message', () => {
  const messages = [
    readyMessage(1),
    callMessage({ evalId: 1, epoch: 1, callSeq: 1, tool: 'Read', args: { file_path: '/tmp/x' } }),
    callMessage({ evalId: 1, epoch: 1, callSeq: 2, tool: 'query', server: 'pg', args: {} }),
    logMessage(1, 'stdout', 'line\n'),
    doneMessage(1, { stdout: '', stderr: '', ms: 1 }),
    errorMessage(1, 'boom'),
    snapshotReply(1, new ArrayBuffer(8)),
    snapshotReply(1, new ArrayBuffer(0), 'serialize'),
    { t: 'procs', evalId: 1, reqSeq: 1, op: 'list' },
    { t: 'procs', evalId: 1, reqSeq: 2, op: 'kill', handle: 'p_abc' },
  ];
  for (const message of messages) {
    assert.equal(isWorkerToHostMessage(message), true, `rejected ${JSON.stringify(message)}`);
  }
});

test('worker → host guard rejects malformed messages', () => {
  const messages: unknown[] = [
    null,
    'ready',
    {},
    { t: 'nope' },
    { t: 'ready' },
    { t: 'ready', epoch: '1' },
    { t: 'call', evalId: 1, epoch: 1, callSeq: 1, tool: 'Read', args: null },
    { t: 'call', evalId: 1, epoch: 1, callSeq: 1, tool: 42, args: {} },
    { t: 'log', evalId: 1, stream: 'stdin', text: 'x' },
    { t: 'done', evalId: 1, stdout: 1, stderr: '', ms: 1, truncated: {} },
    { t: 'done', evalId: 1, stdout: '', stderr: '', ms: 1, truncated: { result: 'yes' } },
    { t: 'error', evalId: 1, message: 'x', layer: 'nope' },
    { t: 'snapshot', evalId: 1, buf: 'nope' },
    { t: 'snapshot', evalId: 1, buf: new ArrayBuffer(1), skipped: 'nope' },
    { t: 'procs', evalId: 1, reqSeq: 1, op: 'wait' },
    { t: 'procs', evalId: 1, reqSeq: 1, op: 'kill', handle: 5 },
  ];
  for (const message of messages) {
    assert.equal(isWorkerToHostMessage(message), false, `accepted ${JSON.stringify(message)}`);
  }
});

test('host → worker guard accepts host messages and rejects the rest', () => {
  const valid: unknown[] = [
    evalMessage(1, 1, 'return 1', 5_000),
    cancelMessage(1),
    snapshotRequest(1),
    callResultOk(1, 1),
    callResultOk(1, 1, { any: ['value'] }),
    callResultError(1, 1, 'boom'),
    procsResultOk(1, 1),
    procsResultError(1, 1, 'boom'),
  ];
  for (const message of valid) {
    assert.equal(isHostToWorkerMessage(message), true, `rejected ${JSON.stringify(message)}`);
  }

  const invalid: unknown[] = [
    null,
    { t: 'ready', epoch: 1 },
    { t: 'call', evalId: 1, epoch: 1, callSeq: 1, tool: 'Read', args: {} },
    { t: 'log', evalId: 1, stream: 'console', text: 'x' },
    { t: 'done', evalId: 1, stdout: '', stderr: '', ms: 1, truncated: {} },
    { t: 'eval', evalId: 1, epoch: 1, code: 42, syncMs: 1 },
    { t: 'call-result', evalId: 1, callSeq: 1, ok: false },
    { t: 'call-result', evalId: 1, callSeq: 1, ok: 'yes' },
    { t: 'snapshot', evalId: 1, buf: new ArrayBuffer(1) },
  ];
  for (const message of invalid) {
    assert.equal(isHostToWorkerMessage(message), false, `accepted ${JSON.stringify(message)}`);
  }
});
