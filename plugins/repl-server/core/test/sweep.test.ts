import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ProcessLedger, type SurvivorRecord } from '../src/process/ledger.ts';
import { BOOT_MARKER, type ProcOps, type ProcRow } from '../src/process/residue.ts';
import {
  RECONCILE_INTERVAL_MS,
  acquireInstanceLock,
  orphansReportPath,
  reconcileSurvivors,
  releaseInstanceLock,
  startReconcileTimer,
  startupSweep,
} from '../src/process/sweep.ts';

const NOW = new Date('2026-11-18T06:00:00.000Z');
const NOW_ISO = NOW.toISOString();

/** Deterministic `ps` replacement: a mutable table plus a signal log. Never touches the OS. */
interface FakeRow {
  pid: number;
  ppid: number;
  pgid: number;
  lstart: string;
  command: string;
  marker?: string;
  ignoreTerm?: boolean;
}

class FakeProcs implements ProcOps {
  readonly rows = new Map<number, FakeRow>();
  readonly signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];

  add(row: FakeRow): FakeRow {
    this.rows.set(row.pid, row);
    return row;
  }

  snapshot(): ProcRow[] {
    return [...this.rows.values()].map((row) => ({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      lstart: row.lstart,
      command: row.marker === undefined ? row.command : `${row.command} ${BOOT_MARKER}=${row.marker}`,
    }));
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
    const targets =
      pid < 0
        ? [...this.rows.values()].filter((row) => row.pgid === -pid)
        : [...this.rows.values()].filter((row) => row.pid === pid);
    for (const row of targets) {
      if (signal === 'SIGTERM' && row.ignoreTerm === true) continue;
      this.rows.delete(row.pid);
    }
  }

  has(pid: number): boolean {
    return this.rows.has(pid);
  }
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'repl-sweep-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const L = {
  s100: 'Mon Nov 17 14:31:58 2026',
  s101: 'Mon Nov 17 14:31:59 2026',
  s102: 'Mon Nov 17 14:32:00 2026',
  s103: 'Mon Nov 17 14:32:01 2026',
  s104: 'Mon Nov 17 14:32:02 2026',
  s105: 'Mon Nov 17 14:32:03 2026',
  s106: 'Mon Nov 17 14:32:04 2026',
  s107: 'Mon Nov 17 14:32:05 2026',
  s108: 'Mon Nov 17 14:32:06 2026',
  s109: 'Mon Nov 17 14:32:07 2026',
  s110: 'Mon Nov 17 14:32:08 2026',
  s111: 'Mon Nov 17 14:32:09 2026',
  s120: 'Mon Nov 17 14:32:10 2026',
  mismatched: 'Tue Nov 18 09:00:00 2026',
  reused: 'Wed Nov 18 10:00:00 2026',
  reconcile: 'Mon Nov 17 15:00:00 2026',
} as const;

test('the O_EXCL lock stores pid/startedAt/bootId and replaces dead holders', (t) => {
  const root = tempDir(t);
  const lockPath = join(root, 'state.db.lock');

  const first = acquireInstanceLock({
    lockPath,
    pid: 4242,
    bootId: 'b_1',
    startedAt: NOW_ISO,
    pidAlive: () => false,
  });
  assert.equal(first.acquired, true);
  if (!first.acquired) return;
  assert.deepEqual(first.record, { pid: 4242, startedAt: NOW_ISO, bootId: 'b_1' });
  assert.deepEqual(JSON.parse(readFileSync(lockPath, 'utf8')), first.record);
  assert.equal(statSync(lockPath).mode & 0o777, 0o600);

  const held = acquireInstanceLock({
    lockPath,
    pid: 5555,
    pidAlive: () => true,
    isReplServer: () => true,
  });
  assert.equal(held.acquired, false);
  if (held.acquired) return;
  assert.equal(held.holder?.pid, 4242);

  const stale = acquireInstanceLock({ lockPath, pid: 6666, pidAlive: () => false });
  assert.equal(stale.acquired, true);
  if (!stale.acquired) return;
  assert.equal(stale.replaced?.pid, 4242);
});

test('a live non-repl-server holder is stale; an uninspectable holder is kept', (t) => {
  const root = tempDir(t);
  const lockPath = join(root, 'state.db.lock');
  const write = (pid: number): void => {
    writeFileSync(lockPath, `${JSON.stringify({ pid, startedAt: NOW_ISO })}\n`);
  };

  write(777);
  const replaced = acquireInstanceLock({
    lockPath,
    pid: 888,
    pidAlive: () => true,
    isReplServer: () => false,
  });
  assert.equal(replaced.acquired, true);
  if (!replaced.acquired) return;
  assert.equal(replaced.replaced?.pid, 777);

  write(777);
  const kept = acquireInstanceLock({
    lockPath,
    pid: 888,
    pidAlive: () => true,
    isReplServer: () => undefined,
  });
  assert.equal(kept.acquired, false);

  writeFileSync(lockPath, 'not json\n');
  const malformed = acquireInstanceLock({ lockPath, pid: 888, pidAlive: () => false });
  assert.equal(malformed.acquired, true);
  if (!malformed.acquired) return;
  assert.equal(malformed.replaced, null);

  assert.equal(releaseInstanceLock(lockPath, 999), false);
  assert.equal(releaseInstanceLock(lockPath, 888), true);
  assert.equal(existsSync(lockPath), false);
});

test('startupSweep kills every ledger and marker source from the previous boot', (t) => {
  const root = tempDir(t);
  const ledger = new ProcessLedger({ root });

  ledger.writeState({
    bootId: 'b_prev',
    pid: 4242,
    sessions: {
      s_a: {
        serve: {
          pid: 100,
          pgid: 100,
          keeperPid: 90,
          sessionId: 's_a',
          bootId: 'b_prev',
          lstart: L.s100,
        },
      },
      s_b: {
        serve: {
          pid: 101,
          pgid: 101,
          keeperPid: 91,
          sessionId: 's_b',
          bootId: 'b_prev',
          lstart: L.s101,
        },
      },
      s_gone: {
        serve: {
          pid: 121,
          pgid: 121,
          keeperPid: 92,
          sessionId: 's_gone',
          bootId: 'b_prev',
          lstart: L.mismatched,
        },
      },
      s_reuse: {
        serve: {
          pid: 111,
          pgid: 111,
          keeperPid: 93,
          sessionId: 's_reuse',
          bootId: 'b_prev',
          lstart: L.mismatched,
        },
      },
    },
  });
  ledger.writeServe({
    pid: 102,
    pgid: 102,
    keeperPid: 94,
    sessionId: 's_c',
    bootId: 'b_prev',
    lstart: L.s102,
  });
  ledger.writeServe({
    pid: 103,
    pgid: 103,
    keeperPid: 95,
    sessionId: 's_d',
    bootId: 'b_new',
    lstart: L.s103,
  });
  ledger.writePool({
    bootId: 'b_prev',
    entries: [
      { serverId: 'pg', cfgVersion: 1, pid: 104, pgid: 104, lstart: L.s104, state: 'running' },
      { serverId: 'spawning', cfgVersion: 1, pid: null, pgid: null, lstart: null, state: 'spawning' },
      { serverId: 'no-lstart', cfgVersion: 1, pid: 105, pgid: 105, lstart: '', state: 'running' },
    ],
  });
  ledger.writeSurvivors({
    records: [
      {
        handle: 'p_s1',
        sessionId: 's_a',
        evalKey: 'es_x:1',
        pid: 106,
        ppid: 1,
        pgid: 106,
        startTime: L.s106,
        cmd: 'sleep 300',
        firstSeen: NOW_ISO,
        leaseUntil: NOW_ISO,
        state: 'running',
      },
      {
        handle: 'p_s2',
        sessionId: 's_a',
        evalKey: 'es_x:2',
        pid: 107,
        ppid: 1,
        pgid: 107,
        startTime: L.s107,
        cmd: 'long job',
        firstSeen: NOW_ISO,
        leaseUntil: NOW_ISO,
        state: 'running',
      },
    ],
  });

  const ops = new FakeProcs();
  ops.add({ pid: 100, ppid: 1, pgid: 100, lstart: L.s100, command: 'serve a' });
  ops.add({ pid: 101, ppid: 1, pgid: 101, lstart: L.s101, command: 'serve b' });
  ops.add({ pid: 102, ppid: 1, pgid: 102, lstart: L.s102, command: 'serve c' });
  ops.add({ pid: 103, ppid: 1, pgid: 103, lstart: L.s103, command: 'serve d' });
  ops.add({ pid: 104, ppid: 1, pgid: 104, lstart: L.s104, command: 'mcp stdio' });
  ops.add({ pid: 105, ppid: 1, pgid: 105, lstart: L.s105, command: 'no lstart' });
  ops.add({ pid: 106, ppid: 1, pgid: 106, lstart: L.s106, command: 'sleep 300' });
  ops.add({
    pid: 107,
    ppid: 1,
    pgid: 107,
    lstart: L.s107,
    command: 'long job',
    ignoreTerm: true,
  });
  ops.add({ pid: 108, ppid: 1, pgid: 108, lstart: L.s108, command: 'escaped', marker: 'b_prev' });
  ops.add({ pid: 109, ppid: 1, pgid: 109, lstart: L.s109, command: 'current', marker: 'b_new' });
  ops.add({ pid: 110, ppid: 1, pgid: 110, lstart: L.s110, command: 'unrelated' });
  ops.add({ pid: 111, ppid: 1, pgid: 111, lstart: L.s111, command: 'reused pid' });
  ops.add({ pid: 112, ppid: 1, pgid: 112, lstart: L.s108, command: 'foreign', marker: 'b_other' });
  ops.add({ pid: 120, ppid: 100, pgid: 100, lstart: L.s120, command: 'child of a' });
  ops.add({ pid: 4242, ppid: 1, pgid: 4242, lstart: L.s110, command: 'self', marker: 'b_prev' });

  const sleeps: number[] = [];
  const report = startupSweep({
    root,
    bootId: 'b_new',
    pid: 4242,
    now: () => NOW,
    ops,
    sleep: (ms) => sleeps.push(ms),
  });

  assert.equal(report.status, 'swept');
  assert.equal(report.acquired, true);
  assert.equal(report.previousBootId, 'b_prev');
  assert.deepEqual(sleeps, [2000]);

  const termPids = report.killed
    .filter((record) => record.signal === 'SIGTERM')
    .map((record) => record.pid)
    .sort((a, b) => a - b);
  assert.deepEqual(termPids, [100, 101, 102, 104, 106, 107, 108, 120]);

  const killPids = report.killed
    .filter((record) => record.signal === 'SIGKILL')
    .map((record) => record.pid);
  assert.deepEqual(killPids, [107]);
  assert.deepEqual(report.alreadyGone, [121]);
  assert.deepEqual(
    report.skipped.map((entry) => entry.pid).sort((a, b) => a - b),
    [105, 111, 112],
  );
  assert.ok(
    report.skipped.some(
      (entry) => entry.pid === 112 && entry.reason === 'unowned_boot_marker',
    ),
  );
  assert.deepEqual(report.remaining, []);

  assert.equal(ops.has(100), false);
  assert.equal(ops.has(101), false);
  assert.equal(ops.has(102), false);
  assert.equal(ops.has(104), false);
  assert.equal(ops.has(106), false);
  assert.equal(ops.has(107), false);
  assert.equal(ops.has(108), false);
  assert.equal(ops.has(120), false);
  assert.equal(ops.has(103), true);
  assert.equal(ops.has(105), true);
  assert.equal(ops.has(109), true);
  assert.equal(ops.has(110), true);
  assert.equal(ops.has(112), true);
  assert.equal(ops.has(4242), true);
  assert.ok(report.warnings.some((warning) => warning.includes('own pid 4242')));
  assert.ok(ops.signals.some((signal) => signal.pid === -100 && signal.signal === 'SIGTERM'));
  assert.ok(ops.signals.some((signal) => signal.pid === -107 && signal.signal === 'SIGKILL'));

  const state = ledger.readState();
  assert.equal(state.bootId, 'b_new');
  assert.equal(state.pid, 4242);
  assert.deepEqual(state.sessions, {});

  const reportPath = join(root, 'ledger', 'orphans-b_new.json');
  assert.equal(report.reportPath, reportPath);
  assert.ok(existsSync(reportPath));
  const payload = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    previousBootId: string;
    killed: Array<{ pid: number }>;
  };
  assert.equal(payload.previousBootId, 'b_prev');
  assert.ok(payload.killed.some((record) => record.pid === 100));

  const lock = JSON.parse(readFileSync(join(root, 'state.db.lock'), 'utf8')) as {
    pid: number;
    bootId: string;
  };
  assert.equal(lock.pid, 4242);
  assert.equal(lock.bootId, 'b_new');
});

test('startupSweep refuses to run while a live instance holds the lock', (t) => {
  const root = tempDir(t);
  const ledger = new ProcessLedger({ root });
  ledger.writeState({
    bootId: 'b_prev',
    pid: 4242,
    sessions: {
      s_a: {
        serve: {
          pid: 200,
          pgid: 200,
          keeperPid: 1,
          sessionId: 's_a',
          bootId: 'b_prev',
          lstart: L.s100,
        },
      },
    },
  });
  writeFileSync(
    join(root, 'state.db.lock'),
    `${JSON.stringify({ pid: 777, startedAt: NOW_ISO })}\n`,
  );

  const ops = new FakeProcs();
  ops.add({ pid: 200, ppid: 1, pgid: 200, lstart: L.s100, command: 'serve' });
  const report = startupSweep({
    root,
    bootId: 'b_new',
    pid: 4242,
    ops,
    pidAlive: () => true,
    isReplServer: () => true,
  });

  assert.equal(report.status, 'locked');
  assert.equal(report.acquired, false);
  assert.equal(report.lockHolder?.pid, 777);
  assert.deepEqual(report.killed, []);
  assert.deepEqual(ops.signals, []);
  assert.equal(ops.has(200), true);
  assert.equal(existsSync(join(root, 'ledger', 'orphans-b_new.json')), false);
  assert.equal(ledger.readState().bootId, 'b_prev');
});

test('startupSweep skips when state.json already belongs to this boot', (t) => {
  const root = tempDir(t);
  const ledger = new ProcessLedger({ root });
  ledger.writeState({
    bootId: 'b_new',
    pid: 4242,
    sessions: {
      s_a: {
        serve: {
          pid: 200,
          pgid: 200,
          keeperPid: 1,
          sessionId: 's_a',
          bootId: 'b_new',
          lstart: L.s100,
        },
      },
    },
  });

  const ops = new FakeProcs();
  ops.add({ pid: 200, ppid: 1, pgid: 200, lstart: L.s100, command: 'serve' });
  const report = startupSweep({ root, bootId: 'b_new', pid: 5555, ops, pidAlive: () => false });

  assert.equal(report.status, 'same-boot');
  assert.deepEqual(report.killed, []);
  assert.equal(ops.has(200), true);
  assert.equal(ledger.readState().pid, 4242);
});

test('reconcile drops vanished records and kills dead sessions or expired leases', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 200, ppid: 1, pgid: 200, lstart: L.s100, command: 'kept' });
  ops.add({ pid: 201, ppid: 1, pgid: 201, lstart: L.s101, command: 'expired' });
  ops.add({ pid: 202, ppid: 1, pgid: 202, lstart: L.s102, command: 'session gone' });
  ops.add({ pid: 204, ppid: 1, pgid: 204, lstart: L.reused, command: 'pid reused' });
  ops.add({
    pid: 205,
    ppid: 1,
    pgid: 205,
    lstart: L.reconcile,
    command: 'stubborn',
    ignoreTerm: true,
  });

  const lease = new Date(NOW.getTime() + 30 * 60 * 1000).toISOString();
  const expired = new Date(NOW.getTime() - 60 * 1000).toISOString();
  const record = (overrides: Partial<SurvivorRecord> & Pick<SurvivorRecord, 'pid'>): SurvivorRecord => {
    const { pid, ...rest } = overrides;
    return {
      handle: `p_${pid}`,
      sessionId: 's_live',
      evalKey: 'es_live:1',
      pid,
      ppid: 1,
      pgid: pid,
      startTime: L.reconcile,
      cmd: 'job',
      firstSeen: NOW_ISO,
      leaseUntil: lease,
      state: 'running',
      ...rest,
    };
  };

  const records: SurvivorRecord[] = [
    record({ pid: 200, startTime: L.s100 }),
    record({ pid: 201, startTime: L.s101, leaseUntil: expired }),
    record({ pid: 202, startTime: L.s102, sessionId: 's_dead' }),
    record({ pid: 203, startTime: L.s103 }),
    record({ pid: 204, startTime: L.reconcile }),
    record({ pid: 205, startTime: L.reconcile, leaseUntil: expired }),
    record({ pid: 206, startTime: L.s106, state: 'gone' }),
  ];

  const sleeps: number[] = [];
  const result = reconcileSurvivors({
    records,
    liveSessionIds: new Set(['s_live']),
    now: NOW,
    ops,
    graceMs: 10,
    sleep: (ms) => sleeps.push(ms),
  });

  assert.deepEqual(
    result.kept.map((entry) => entry.pid),
    [200],
  );
  assert.deepEqual(
    result.removed.map((entry) => entry.pid).sort((a, b) => a - b),
    [203, 204, 206],
  );
  assert.ok(result.removed.some((entry) => entry.pid === 203 && entry.reason === 'gone'));
  assert.ok(result.removed.some((entry) => entry.pid === 204 && entry.reason === 'lstart_mismatch'));
  assert.ok(result.removed.some((entry) => entry.pid === 206 && entry.reason === 'state_gone'));
  assert.deepEqual(sleeps, [10]);
  assert.ok(result.killed.some((entry) => entry.pid === 201 && entry.reason === 'lease_expired'));
  assert.ok(result.killed.some((entry) => entry.pid === 202 && entry.reason === 'session_gone'));
  assert.ok(result.killed.some((entry) => entry.pid === 205 && entry.signal === 'SIGKILL'));
  assert.deepEqual(result.remaining, []);
  assert.equal(ops.has(200), true);
});

test('the reconcile timer runs on its interval and stops cleanly', async () => {
  let ticks = 0;
  const stop = startReconcileTimer(() => {
    ticks += 1;
  }, 10);

  await new Promise<void>((resolve) => setTimeout(resolve, 55));
  stop();
  assert.ok(ticks >= 2, `expected at least two reconcile ticks, saw ${ticks}`);

  const frozen = ticks;
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(ticks, frozen);
});

test('orphans report path keeps the boot id as a single file name', (t) => {
  const root = tempDir(t);
  assert.equal(RECONCILE_INTERVAL_MS, 15_000);
  assert.equal(orphansReportPath(root, 'b_new'), join(root, 'ledger', 'orphans-b_new.json'));
  assert.equal(orphansReportPath(root, 'b/../x'), join(root, 'ledger', 'orphans-b_.._x.json'));
});
