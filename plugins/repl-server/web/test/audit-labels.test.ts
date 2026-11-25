/** Audit labels: prototype member names must pass through instead of resolving. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aiRunKindLabel,
  aiRunTriggerLabel,
  eventLabel,
  eventSubject,
} from '../src/lib/audit-labels.ts';

test('known names keep their Chinese labels', () => {
  assert.equal(eventLabel('tool_call'), '工具调用');
  assert.equal(aiRunKindLabel('annotate'), '生成标注');
  assert.equal(aiRunTriggerLabel('auto'), '自动');
  assert.equal(eventLabel('missing'), 'missing');
});

test('prototype member names pass through as plain strings', () => {
  for (const name of ['constructor', 'toString', '__proto__']) {
    assert.equal(eventLabel(name), name);
    assert.equal(aiRunKindLabel(name), name);
    assert.equal(aiRunTriggerLabel(name), name);
  }
  assert.equal(eventSubject({ event: 'constructor' }), 'constructor');
});
