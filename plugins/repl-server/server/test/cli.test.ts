/** CLI option validation: bad values must fail before any state is touched. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ENTRY = fileURLToPath(new URL('../src/index.ts', import.meta.url));

test('--frame-mode rejects an unknown value before starting the server', () => {
  const result = spawnSync(process.execPath, [ENTRY, '--frame-mode', 'bogus', '--port', '0'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid frame mode "bogus"/);
  assert.match(result.stderr, /off\|summary\|full/);
});

test('REPL_FRAME_MODE is validated too', () => {
  const result = spawnSync(process.execPath, [ENTRY, '--port', '0'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, REPL_FRAME_MODE: 'loud' },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /invalid frame mode "loud"/);
});
