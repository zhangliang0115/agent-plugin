import assert from 'node:assert/strict';
import test from 'node:test';

import { pickRunFrame, scriptRunMatchesFrame } from '../src/lib/script-run-match.ts';

const run = { requestId: '42', execId: 'exec_1' };

test('matches by JSON-RPC id when the frame has no exec field', () => {
  assert.equal(
    scriptRunMatchesFrame(
      { id: 42, request: { method: 'tools/call' }, response: { ok: true } },
      run,
    ),
    true,
  );
});

test('matches when the frame exec equals the run exec', () => {
  assert.equal(
    scriptRunMatchesFrame({ id: '42', request: { exec: 'exec_1' }, response: null }, run),
    true,
  );
});

test('rejects when the frame exec differs from the run exec', () => {
  assert.equal(
    scriptRunMatchesFrame({ id: '42', request: { exec: 'exec_2' }, response: null }, run),
    false,
  );
});

test('rejects a run without requestId', () => {
  assert.equal(
    scriptRunMatchesFrame(
      { id: '42', request: null, response: null },
      { requestId: null, execId: 'exec_1' },
    ),
    false,
  );
});

test('matches by id when the run has no execId', () => {
  assert.equal(
    scriptRunMatchesFrame(
      { id: 42, request: { exec: 'exec_other' }, response: null },
      { requestId: '42', execId: null },
    ),
    true,
  );
});

test('rejects a different JSON-RPC id', () => {
  assert.equal(
    scriptRunMatchesFrame({ id: '43', request: null, response: null }, run),
    false,
  );
});

const settled = '2026-01-01T00:00:10.000Z';

test('picks the pair whose response is closest to createdAt', () => {
  const frames = [
    { id: '42', request: { ts: '2026-01-01T00:00:00.000Z' }, response: { ts: '2026-01-01T00:00:20.000Z' } },
    { id: '42', request: { ts: '2026-01-01T00:00:09.000Z' }, response: { ts: '2026-01-01T00:00:11.000Z' } },
    { id: '42', request: { ts: '2026-01-01T00:10:00.000Z' }, response: { ts: '2026-01-01T00:10:00.000Z' } },
  ];
  assert.equal(pickRunFrame(frames, run, settled), frames[1]);
});

test('returns the only matching pair (createdAt as epoch millis)', () => {
  const frames = [{ id: 42, request: { ts: '2026-01-01T00:00:09.000Z' }, response: null }];
  assert.equal(pickRunFrame(frames, run, Date.parse(settled)), frames[0]);
});

test('returns null when no pair matches', () => {
  assert.equal(pickRunFrame([], run, settled), null);
  assert.equal(pickRunFrame([{ id: '43', request: null, response: null }], run, settled), null);
});

test('returns the first candidate when createdAt is unparseable', () => {
  const frames = [
    { id: '42', request: null, response: { ts: '2020-01-01T00:00:00.000Z' } },
    { id: '42', request: null, response: { ts: '2026-01-01T00:00:10.000Z' } },
  ];
  assert.equal(pickRunFrame(frames, run, 'not-a-date'), frames[0]);
});

test('compares request.ts when the response is missing', () => {
  const frames = [
    { id: '42', request: { ts: '2026-01-01T00:00:09.000Z' }, response: null },
    { id: '42', request: { ts: '2026-01-01T00:00:00.000Z' }, response: { ts: '2026-01-01T00:20:00.000Z' } },
  ];
  assert.equal(pickRunFrame(frames, run, settled), frames[0]);
});
