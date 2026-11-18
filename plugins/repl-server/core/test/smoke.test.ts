import assert from 'node:assert/strict';
import test from 'node:test';

import { VERSION } from '../src/index.ts';

test('core exposes the plugin version', () => {
  assert.equal(VERSION, '0.1.0');
});
