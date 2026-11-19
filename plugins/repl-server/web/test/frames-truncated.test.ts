/** Frame drawer truncation notice: shown only when the backend scan stopped early. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { framesTruncatedNotice } from '../src/lib/api.ts';

test('reports the truncation notice when the frames scan stopped early', () => {
  assert.equal(
    framesTruncatedNotice({ truncated: true }),
    '扫描已截断（仅覆盖最早 100k 行），请缩小时间范围',
  );
});

test('stays silent when the response is complete or absent', () => {
  assert.equal(framesTruncatedNotice({ truncated: false }), null);
  assert.equal(framesTruncatedNotice({}), null);
  assert.equal(framesTruncatedNotice(null), null);
  assert.equal(framesTruncatedNotice(undefined), null);
});
