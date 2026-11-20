import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import test from 'node:test';

import { killTarget, killTree, safeKill } from '../src/process/kill.ts';
import {
  BOOT_MARKER_ENV,
  aliveWithSameStart,
  findByMarker,
  parsePsLine,
  parsePsRows,
  parseResourceRows,
  psResourceRows,
  psRow,
  sameStartTime,
  snapshotTree,
  withBootMarker,
  type ProcessRow,
} from '../src/process/tree.ts';

/** Larger than `kern.maxproc` on macOS, so this pid can never be reused. */
const ABSENT_PID = 999_999;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, timeoutMs = 3_000, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
}

function pidOf(child: ChildProcess): number {
  const pid = child.pid;
  assert.ok(pid !== undefined, 'child has no pid');
  return pid;
}

function spawnShell(script: string, detached: boolean): ChildProcess {
  const child = spawn('/bin/sh', ['-c', script], { detached, stdio: 'ignore' });
  child.unref();
  return child;
}

async function waitForDescendants(rootPid: number, minimum: number): Promise<ProcessRow[]> {
  let tree: ProcessRow[] = [];
  const ready = await waitFor(() => {
    tree = snapshotTree(rootPid);
    return tree.length >= minimum;
  });
  assert.ok(ready, `expected at least ${minimum} descendants of ${rootPid}, saw ${tree.length}`);
  return tree;
}

async function cleanupTree(rootPid: number): Promise<void> {
  try {
    await killTree(rootPid, { graceMs: 200, pollMs: 20 });
  } catch {
    // Best effort: the assertion that failed is more useful than a cleanup error.
  }
}

test('parses ps rows, including padded lstart days and commands with spaces', () => {
  const stdout = [
    '    1     0     1 Fri Nov  6 08:31:26 2026     /sbin/launchd',
    ' 48213   202   202 Mon Nov 17 14:31:58 2026 /bin/sh -c echo hi',
    ' 48214 48213 48213 Tue Nov 18 06:00:00 2026 node script.js --flag value KEY=VAL',
    '',
    '  PID  PPID  PGID STARTED COMMAND',
  ].join('\n');

  const rows = parsePsRows(stdout);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    pid: 1,
    ppid: 0,
    pgid: 1,
    lstart: 'Fri Nov 6 08:31:26 2026',
    command: '/sbin/launchd',
  });
  assert.equal(rows[1]?.command, '/bin/sh -c echo hi');
  assert.equal(rows[2]?.lstart, 'Tue Nov 18 06:00:00 2026');
  assert.equal(rows[2]?.command, 'node script.js --flag value KEY=VAL');

  assert.equal(parsePsLine(''), null);
  assert.equal(parsePsLine('  PID  PPID  PGID STARTED COMMAND'), null);
  assert.equal(parsePsLine(' 10 20 30 not-a-start-time command'), null);
  // A row without a command is still a valid process row.
  assert.equal(parsePsLine('  10   1  10 Mon Nov 17 14:31:58 2026')?.command, '');
});

test('parses resource rows with rss in bytes and ps %cpu', () => {
  const rows = parseResourceRows(
    ['    1     0   1234  0.0', ' 48213   202  20480  1.5', '', 'pid ppid rss %cpu'].join('\n'),
  );
  assert.deepEqual(rows, [
    { pid: 1, ppid: 0, rssBytes: 1234 * 1024, cpuPercent: 0 },
    { pid: 48213, ppid: 202, rssBytes: 20480 * 1024, cpuPercent: 1.5 },
  ]);
  assert.deepEqual(parseResourceRows(' 10 1 not-a-number 1.0'), []);
});

test('psResourceRows includes the current process', () => {
  const self = psResourceRows().find((row) => row.pid === process.pid);
  assert.ok(self !== undefined, 'current process missing from ps output');
  assert.ok(self.rssBytes > 0);
  assert.ok(self.cpuPercent >= 0);
});

test('snapshotTree returns descendants only, sorted, and survives ppid cycles', () => {
  const rows = parsePsRows(
    [
      ' 10  1  10 Mon Nov 17 14:31:58 2026 root',
      ' 11 10  10 Mon Nov 17 14:31:58 2026 child-a',
      ' 12 11  11 Mon Nov 17 14:31:58 2026 grandchild',
      ' 13 10  10 Mon Nov 17 14:31:58 2026 child-c',
      ' 20  1  20 Mon Nov 17 14:31:58 2026 unrelated',
    ].join('\n'),
  );

  assert.deepEqual(
    snapshotTree(10, rows).map((row) => row.pid),
    [11, 12, 13],
  );
  assert.deepEqual(snapshotTree(99, rows), []);
  assert.deepEqual(snapshotTree(0, rows), []);

  const cyclic = parsePsRows(
    [
      ' 30 31 30 Mon Nov 17 14:31:58 2026 a',
      ' 31 30 30 Mon Nov 17 14:31:58 2026 b',
    ].join('\n'),
  );
  assert.deepEqual(
    snapshotTree(30, cyclic).map((row) => row.pid),
    [31],
  );
});

test('sameStartTime normalizes padding and rejects empty values', () => {
  assert.equal(sameStartTime('Fri Nov  6 08:31:26 2026', 'Fri Nov 6 08:31:26 2026'), true);
  assert.equal(sameStartTime(' Fri Nov 6 08:31:26 2026 ', 'Fri Nov 6 08:31:26 2026'), true);
  assert.equal(sameStartTime('Fri Nov 6 08:31:26 2026', 'Sat Nov 6 08:31:26 2026'), false);
  assert.equal(sameStartTime('', ''), false);
});

test('aliveWithSameStart requires both the pid and its start time', async () => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  child.unref();
  const pid = pidOf(child);
  try {
    assert.ok(await waitFor(() => psRow(pid) !== null, 2_000), 'sleep did not show up in ps');
    const row = psRow(pid);
    assert.ok(row !== null);
    assert.equal(aliveWithSameStart(pid, row.lstart), true);
    assert.equal(aliveWithSameStart(pid, 'Fri Nov  6 08:31:26 2026'), false);
  } finally {
    child.kill('SIGKILL');
    await waitFor(() => psRow(pid) === null, 2_000);
  }
  assert.equal(aliveWithSameStart(pid, 'Fri Nov  6 08:31:26 2026'), false);
});

test('withBootMarker injects the marker and findByMarker matches whole values only', async () => {
  const bootId = 'b_0123456789abcdef0123456789abcdef';
  const env = withBootMarker({ PATH: '/usr/bin' }, bootId);
  assert.equal(env[BOOT_MARKER_ENV], bootId);
  assert.equal(env.PATH, '/usr/bin');
  assert.throws(() => withBootMarker({}, ''), TypeError);
  assert.throws(() => findByMarker('', []), TypeError);

  // The marker also has to reach a real child.
  const child = spawn('/bin/sh', ['-c', `[ "$${BOOT_MARKER_ENV}" = "${bootId}" ]`], {
    env: withBootMarker(process.env, bootId),
    stdio: 'ignore',
  });
  const exitCode = await new Promise<number | null>((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 0);

  // Match against parsed rows: `ps -E` does not reliably expose the environment of freshly
  // spawned children on macOS, but the parser and filter are the same either way.
  const rows = parsePsRows(
    [
      ` 40  1  40 Mon Nov 17 14:31:58 2026 node keeper.js ${BOOT_MARKER_ENV}=${bootId} PATH=/usr/bin`,
      ` 41  1  41 Mon Nov 17 14:31:58 2026 node other ${BOOT_MARKER_ENV}=${bootId}ff HOME=/Users/x`,
      ' 42  1  42 Mon Nov 17 14:31:58 2026 node clean HOME=/Users/x',
    ].join('\n'),
  );
  assert.deepEqual(
    findByMarker(bootId, rows).map((row) => row.pid),
    [40],
  );
  assert.deepEqual(findByMarker('b_ffffffffffffffffffffffffffffffff', rows), []);
});

test('killTree kills a detached sh sleep tree and leaves a sibling alone', async () => {
  const root = spawnShell('sleep 30 & sh -c "sleep 30 & sleep 30 & wait" & wait', true);
  const rootPid = pidOf(root);
  const sibling = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  sibling.unref();
  const siblingPid = pidOf(sibling);

  try {
    const tree = await waitForDescendants(rootPid, 4);
    const siblingRow = psRow(siblingPid);
    assert.ok(siblingRow !== null, 'sibling sleep is not running');

    const result = await killTree(rootPid, { graceMs: 500, pollMs: 20 });
    assert.equal(result.rootPid, rootPid);
    assert.ok(result.descendants.length >= 4, 'snapshot lost descendants');
    assert.deepEqual(result.failures, []);
    assert.equal(result.escalated, false, 'a plain sleep tree should die on SIGTERM');
    assert.ok(result.signalled.some((record) => record.signal === 'SIGTERM'));

    const pids = [rootPid, ...tree.map((row) => row.pid)];
    const gone = await waitFor(() => pids.every((pid) => psRow(pid) === null), 3_000);
    assert.ok(gone, `survivors: ${pids.filter((pid) => psRow(pid) !== null).join(', ')}`);
    assert.deepEqual(result.remaining, []);

    // The unrelated process must still be running with its original start time.
    assert.equal(aliveWithSameStart(siblingPid, siblingRow.lstart), true);
  } finally {
    sibling.kill('SIGKILL');
    await cleanupTree(rootPid);
  }
});

test('killTree handles a root that is not a process-group leader', async () => {
  const root = spawnShell('sleep 30 & sleep 30 & wait', false);
  const rootPid = pidOf(root);

  try {
    const tree = await waitForDescendants(rootPid, 2);
    const result = await killTree(rootPid, { graceMs: 500, pollMs: 20 });
    assert.ok(result.descendants.length >= 2);

    const pids = [rootPid, ...tree.map((row) => row.pid)];
    assert.ok(await waitFor(() => pids.every((pid) => psRow(pid) === null), 3_000));
    // The test runner shares the root's process group; signalling it must not take us down.
    assert.doesNotThrow(() => process.kill(process.pid, 0));
  } finally {
    await cleanupTree(rootPid);
  }
});

test('killTree escalates to SIGKILL when SIGTERM is ignored', async () => {
  const root = spawnShell('trap "" TERM; sleep 30', true);
  const rootPid = pidOf(root);

  try {
    assert.ok(await waitFor(() => psRow(rootPid) !== null, 2_000), 'trap process did not start');
    const startedAt = Date.now();
    const result = await killTree(rootPid, { graceMs: 200, pollMs: 20 });
    const elapsed = Date.now() - startedAt;

    assert.equal(result.escalated, true);
    assert.deepEqual(result.failures, []);
    assert.ok(result.signalled.some((record) => record.signal === 'SIGKILL'));
    assert.ok(elapsed >= 150, `grace period was not respected (${elapsed}ms)`);
    assert.ok(await waitFor(() => psRow(rootPid) === null, 2_000), 'process survived SIGKILL');
  } finally {
    await cleanupTree(rootPid);
  }
});

test('killTree and safeKill ignore ESRCH and reject dangerous targets', async () => {
  assert.equal(safeKill(ABSENT_PID, 'SIGTERM'), false);
  assert.throws(() => safeKill(0, 'SIGTERM'), RangeError);
  assert.throws(() => safeKill(-1, 'SIGTERM'), RangeError);
  await assert.rejects(() => killTree(0), RangeError);

  const result = await killTree(ABSENT_PID, { graceMs: 50, pollMs: 10 });
  assert.deepEqual(result.descendants, []);
  assert.deepEqual(result.signalled, []);
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(result.failures, []);
  assert.equal(result.escalated, false);
});

test('killTarget only negates process-group leaders', () => {
  assert.equal(killTarget(42, 42), -42);
  assert.equal(killTarget(42, 7), 42);
  assert.throws(() => killTarget(0, 0), RangeError);
});
