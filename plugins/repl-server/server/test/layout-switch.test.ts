import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/layout-switch.mjs', import.meta.url));

function root(): string {
  const home = mkdtempSync(join(tmpdir(), 'repl-switch-'));
  const dir = join(home, 'repl-server');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runScript(rootDir: string, args: string[] = []) {
  const home = join(rootDir, '..');
  return spawnSync(process.execPath, [SCRIPT, ...args, home], { encoding: 'utf8' });
}

test('refuses to migrate while an instance is alive', () => {
  const dir = root();
  writeFileSync(join(dir, 'state.db'), 'legacy');
  writeFileSync(join(dir, 'secrets.json'), '{}');
  writeFileSync(join(dir, 'state.db.lock'), JSON.stringify({ pid: process.pid, bootId: 'b_test' }));

  const dry = runScript(dir);
  assert.notEqual(dry.status, 0);
  assert.match(dry.stderr, /refusing to touch a live instance/);

  const apply = runScript(dir, ['--apply']);
  assert.notEqual(apply.status, 0);
  // Nothing may have been moved: the live process still owns these paths.
  assert.ok(existsSync(join(dir, 'state.db')));
  assert.ok(existsSync(join(dir, 'secrets.json')));
  assert.equal(existsSync(join(dir, 'run', 'state.db')), false);
});

test('stale lock does not block the switch', () => {
  const dir = root();
  writeFileSync(join(dir, 'state.db'), 'legacy');
  // A PID far outside the valid range is guaranteed not to be alive.
  writeFileSync(join(dir, 'state.db.lock'), JSON.stringify({ pid: 2147483647, bootId: 'b_dead' }));

  const result = runScript(dir, ['--apply']);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(existsSync(join(dir, 'run', 'state.db')));
  assert.equal(existsSync(join(dir, 'state.db')), false);
});

test('re-running after a live instance rewrote root files archives the strays', () => {
  const dir = root();
  mkdirSync(join(dir, 'run'), { recursive: true });
  writeFileSync(join(dir, 'run', 'state.db'), 'live');
  writeFileSync(join(dir, 'pool.json'), '{"bootId":"b_old"}');
  writeFileSync(join(dir, 'server.pid'), '12345');

  const dry = runScript(dir);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /stray root entries: pool.json, server.pid/);
  // Dry run must not move anything.
  assert.ok(existsSync(join(dir, 'pool.json')));

  const apply = runScript(dir, ['--apply']);
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(existsSync(join(dir, 'pool.json')), false);
  assert.equal(existsSync(join(dir, 'server.pid')), false);
  assert.equal(readFileSync(join(dir, 'run', 'state.db'), 'utf8'), 'live');
  const archived = join(dir, 'backup', `strays-${new Date().toISOString().slice(0, 10)}`);
  assert.ok(existsSync(join(archived, 'pool.json')));
  assert.ok(existsSync(join(archived, 'server.pid')));
});
