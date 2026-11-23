import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  createLayout,
  legacyLeftovers,
  legacyRuntimeLeftovers,
  resolveLogRef,
} from '../src/layout.ts';

function home(): string {
  return mkdtempSync(join(tmpdir(), 'repl-layout-'));
}

test('every data path hangs off exactly one of the four domains', () => {
  const root = home();
  const layout = createLayout(root);

  assert.equal(layout.root, join(root, 'repl-server'));
  assert.equal(layout.stateDb, join(layout.run, 'state.db'));
  assert.equal(layout.lockPath, join(layout.run, 'state.db.lock'));
  assert.equal(layout.sessions, join(layout.run, 'sessions'));
  assert.equal(layout.eventsFile('2026-11-23'), join(layout.log, 'events-2026-11-23.jsonl'));
  assert.equal(layout.metricsFile('2026-11-23'), join(layout.log, 'metrics-2026-11-23.jsonl'));
  assert.equal(layout.payloadFrames('2026-11-23'), join(layout.log, 'payload', '2026-11-23', 'frames'));
  assert.equal(
    layout.payloadExec('2026-11-23', 'es_1'),
    join(layout.log, 'payload', '2026-11-23', 'es_1'),
  );

  for (const path of [layout.stateDb, layout.eventsFile('2026-11-23'), layout.payloadDay('2026-11-23')]) {
    const inRun = path.startsWith(`${layout.run}/`);
    const inLog = path.startsWith(`${layout.log}/`);
    assert.ok(inRun || inLog, `${path} escaped run/ and log/`);
  }
});

test('resolveLogRef keeps refs inside log/ and refuses escapes', () => {
  const layout = createLayout(home());
  const ref = 'payload/2026-11-23/es_1/6-1-Bash-call.json';

  assert.equal(resolveLogRef(layout.log, ref), join(layout.log, ref));
  for (const bad of [
    '',
    '..',
    '../state.db',
    'payload/../../state.db',
    '/etc/passwd',
    'payload\\2026-11-23\\x.json',
    'payload/\0/x.json',
    './payload/x.json',
  ]) {
    assert.equal(resolveLogRef(layout.log, bad), null, `expected ${JSON.stringify(bad)} to be refused`);
  }
});

test('legacy leftovers are detected by name, not by contents', () => {
  const root = home();
  const layout = createLayout(root);
  mkdirSync(layout.root, { recursive: true });
  mkdirSync(join(layout.root, 'audit'), { recursive: true });
  writeFileSync(join(layout.root, 'repl.db'), '');

  assert.deepEqual(legacyLeftovers(layout), ['audit', 'repl.db']);

  mkdirSync(layout.log, { recursive: true });
  writeFileSync(layout.eventsFile('2026-11-23'), '{}\n');
  // The log tree alone does not clear the warning: the legacy dirs must be gone.
  assert.deepEqual(legacyLeftovers(layout), ['audit', 'repl.db']);
});

test('root runtime state without run/state.db is reported as a data-loss risk', () => {
  const root = home();
  const layout = createLayout(root);
  mkdirSync(layout.root, { recursive: true });
  writeFileSync(join(layout.root, 'state.db'), '');
  writeFileSync(join(layout.root, 'secrets.json'), '{}');
  mkdirSync(join(layout.root, 'sessions'), { recursive: true });
  mkdirSync(join(layout.root, 'audit'), { recursive: true });

  // Both classes are surfaced in startup guard's message; runtime ones are the
  // ones that would otherwise be lost silently.
  assert.deepEqual(legacyRuntimeLeftovers(layout), ['state.db', 'secrets.json', 'sessions']);
  assert.deepEqual(legacyLeftovers(layout), ['audit']);
});

test('an already-switched root is not blocked by cosmetic strays', () => {
  const root = home();
  const layout = createLayout(root);
  mkdirSync(layout.run, { recursive: true });
  writeFileSync(layout.stateDb, '');
  writeFileSync(join(layout.root, 'pool.json'), '{}');

  assert.deepEqual(legacyRuntimeLeftovers(layout), []);
  assert.deepEqual(legacyLeftovers(layout), []);
});

test('a half-migrated root with only runtime state is still detected', () => {
  const root = home();
  const layout = createLayout(root);
  mkdirSync(layout.log, { recursive: true });
  mkdirSync(layout.root, { recursive: true });
  writeFileSync(join(layout.root, 'mcp-token'), 'token');

  // Someone deleted the four legacy dirs by hand: the old guard would have let
  // the server boot with an empty run/state.db.
  assert.deepEqual(legacyLeftovers(layout), []);
  assert.deepEqual(legacyRuntimeLeftovers(layout), ['mcp-token']);
});
