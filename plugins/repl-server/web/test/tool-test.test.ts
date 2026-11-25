/** Reading `POST /tools/:serverId/:name/test` payloads. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { toolTestResultFrom } from '../src/lib/tool-test.ts';

test('reads a successful tool test result', () => {
  assert.deepEqual(
    toolTestResultFrom({
      ok: true,
      result: { items: [1] },
      durationMs: 42,
      testedAt: '2026-11-25T08:00:00.000Z',
      resultBytes: 11,
      truncated: true,
    }),
    {
      ok: true,
      result: { items: [1] },
      resultPreview: null,
      error: null,
      durationMs: 42,
      testedAt: '2026-11-25T08:00:00.000Z',
      resultBytes: 11,
      truncated: true,
    },
  );
});

test('reads the truncated result preview', () => {
  const result = toolTestResultFrom({
    ok: true,
    resultPreview: '{"items":[1,2',
    durationMs: 42,
    testedAt: '2026-11-25T08:00:00.000Z',
    resultBytes: 4096,
    truncated: true,
  });
  assert.equal(result?.resultPreview, '{"items":[1,2');
  assert.equal(result?.truncated, true);
  assert.equal(result?.result, undefined);
});

test('reads a tool execution failure with its error code', () => {
  const result = toolTestResultFrom({
    ok: false,
    error: { code: 'TOOL_TIMEOUT', message: 'tool timed out' },
    durationMs: 10_000,
    testedAt: '2026-11-25T08:00:00.000Z',
  });
  assert.equal(result?.ok, false);
  assert.deepEqual(result?.error, { code: 'TOOL_TIMEOUT', message: 'tool timed out' });
  assert.equal(result?.resultBytes, null);
  assert.equal(result?.truncated, false);
});

test('malformed payloads return null instead of a half-filled result', () => {
  for (const payload of [null, undefined, 'text', 42, [], {}, { ok: 'true' }]) {
    assert.equal(toolTestResultFrom(payload), null);
  }
});
