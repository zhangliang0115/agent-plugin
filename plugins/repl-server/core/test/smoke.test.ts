import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { VERSION } from '../src/index.ts';

test('core exposes the plugin version', () => {
  const pkg = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  assert.equal(VERSION, pkg.version);
});
