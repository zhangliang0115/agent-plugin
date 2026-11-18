import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import { ProcessLedger } from '../src/process/ledger.ts';
import {
  BOOT_MARKER,
  RESIDUE_HEARTBEAT_MS,
  RESIDUE_LEASE_MS,
  ResidueTracker,
  descendantsOf,
  markerValue,
  parsePsOutput,
  sameStart,
  type ProcOps,
  type ProcRow,
  type ResidueRecord,
} from '../src/process/residue.ts';

const T0 = new Date('2026-11-18T06:00:00.000Z');
const T0_PLUS_30M = new Date(T0.getTime() + RESIDUE_LEASE_MS);

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

  remove(pid: number): void {
    this.rows.delete(pid);
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
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'repl-residue-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const L = {
  serve: 'Mon Nov 17 14:31:58 2026',
  shell: 'Mon Nov 17 14:32:00 2026',
  npm: 'Mon Nov 17 14:32:01 2026',
  sleep: 'Mon Nov 17 14:32:02 2026',
  markerOld: 'Mon Nov 17 14:32:03 2026',
  markerNew: 'Mon Nov 17 14:32:04 2026',
  other: 'Mon Nov 17 14:40:00 2026',
  reused: 'Mon Nov 17 15:00:00 2026',
} as const;

test('parsePsOutput parses fake ps output and normalizes lstart padding', () => {
  const output = [
    '  100     1   100 Mon Nov 17 14:31:58 2026 claude mcp serve',
    '  101   100   100 Tue Nov  7 09:02:03 2026 npm run dev -- --flag',
    'not a ps line',
    '',
    '  102     1   102 Wed Nov 18 16:08:04 2026 sh -c echo hi',
  ].join('\n');

  const rows = parsePsOutput(output);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], {
    pid: 101,
    ppid: 100,
    pgid: 100,
    lstart: 'Tue Nov 7 09:02:03 2026',
    command: 'npm run dev -- --flag',
  });
});

test('markerValue reads the boot marker from a ps -E command column', () => {
  assert.equal(markerValue('sleep 300 REPL_SERVER_BOOT=b_1'), 'b_1');
  assert.equal(markerValue('REPL_SERVER_BOOT=b_2 sleep 300'), 'b_2');
  assert.equal(markerValue('sleep 300'), undefined);
});

test('sameStart ignores padding but never matches empty values', () => {
  assert.equal(sameStart('Mon Nov  7 09:02:03 2026', 'Mon Nov 7 09:02:03 2026'), true);
  assert.equal(sameStart('', ''), false);
});

test('descendantsOf walks the ppid tree without the root', () => {
  const rows: ProcRow[] = [
    { pid: 10, ppid: 1, pgid: 10, lstart: L.serve, command: 'serve' },
    { pid: 20, ppid: 10, pgid: 10, lstart: L.shell, command: 'shell' },
    { pid: 21, ppid: 20, pgid: 10, lstart: L.npm, command: 'npm' },
    { pid: 22, ppid: 10, pgid: 10, lstart: L.sleep, command: 'sleep' },
    { pid: 30, ppid: 1, pgid: 30, lstart: L.other, command: 'unrelated' },
  ];
  assert.deepEqual(
    descendantsOf(rows, 10).map((row) => row.pid),
    [20, 21, 22],
  );
});

test('endEval registers only descendants that appeared during the eval', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 500, ppid: 1, pgid: 500, lstart: L.serve, command: 'claude mcp serve' });
  ops.add({ pid: 501, ppid: 500, pgid: 500, lstart: L.shell, command: 'sh -c npm test' });
  let clock = T0;
  const flushes: ResidueRecord[][] = [];
  const tracker = new ResidueTracker({
    sessionId: 'es_abc',
    now: () => clock,
    ops,
    onFlush: (records) => flushes.push([...records]),
  });

  const baseline = tracker.beginEval('es_abc:1', 500);
  ops.add({ pid: 502, ppid: 501, pgid: 500, lstart: L.npm, command: 'npm run dev' });
  ops.add({ pid: 503, ppid: 500, pgid: 503, lstart: L.sleep, command: 'nohup sleep 300' });
  const result = tracker.endEval(baseline);

  assert.deepEqual(
    result.leftRunning.map((record) => record.pid).sort((a, b) => a - b),
    [502, 503],
  );
  const first = result.leftRunning.find((record) => record.pid === 502);
  assert.ok(first !== undefined);
  assert.match(first.handle, /^p_[0-9a-f]{32}$/);
  assert.equal(first.sessionId, 'es_abc');
  assert.equal(first.evalKey, 'es_abc:1');
  assert.equal(first.ppid, 501);
  assert.equal(first.pgid, 500);
  assert.equal(first.cmd, 'npm run dev');
  assert.equal(first.startTime, L.npm);
  assert.equal(first.firstSeen, T0.toISOString());
  assert.equal(first.leaseUntil, T0_PLUS_30M.toISOString());
  assert.equal(first.state, 'running');
  assert.equal(result.tracked.length, 2);
  assert.deepEqual(
    flushes.at(-1)?.map((record) => record.pid).sort((a, b) => a - b),
    [502, 503],
  );
});

test('boot markers attribute reparented processes and report other boots as escaped', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 500, ppid: 1, pgid: 500, lstart: L.serve, command: 'claude mcp serve' });
  ops.add({ pid: 501, ppid: 500, pgid: 500, lstart: L.shell, command: 'sh -c true' });
  ops.add({
    pid: 600,
    ppid: 1,
    pgid: 600,
    lstart: L.markerOld,
    command: 'sleep 600',
    marker: 'b_new',
  });
  const tracker = new ResidueTracker({ sessionId: 'es_abc', bootId: 'b_new', ops, now: () => T0 });

  const baseline = tracker.beginEval('es_abc:2', 500);
  ops.add({
    pid: 601,
    ppid: 1,
    pgid: 601,
    lstart: L.markerNew,
    command: 'sleep 601',
    marker: 'b_new',
  });
  ops.add({
    pid: 602,
    ppid: 1,
    pgid: 602,
    lstart: L.markerOld,
    command: 'sleep 602',
    marker: 'b_old',
  });
  const result = tracker.endEval(baseline);

  assert.deepEqual(
    result.leftRunning.map((record) => record.pid),
    [601],
  );
  assert.deepEqual(
    result.escaped.map((row) => row.pid),
    [602],
  );
});

test('a recycled pid gets a fresh handle and startTime', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 700, ppid: 1, pgid: 700, lstart: L.serve, command: 'serve' });
  ops.add({ pid: 701, ppid: 700, pgid: 700, lstart: L.other, command: 'old process' });
  const tracker = new ResidueTracker({ sessionId: 'es_abc', ops, now: () => T0 });

  const baseline1 = tracker.beginEval('es_abc:3', 700);
  ops.add({ pid: 702, ppid: 700, pgid: 700, lstart: L.npm, command: 'first' });
  const firstEval = tracker.endEval(baseline1);
  const original = firstEval.leftRunning.find((record) => record.pid === 702);
  assert.ok(original !== undefined);

  const baseline2 = tracker.beginEval('es_abc:4', 700);
  ops.remove(702);
  ops.add({ pid: 702, ppid: 700, pgid: 700, lstart: L.reused, command: 'second' });
  const secondEval = tracker.endEval(baseline2);

  const replacement = secondEval.leftRunning.find((record) => record.pid === 702);
  assert.ok(replacement !== undefined);
  assert.notEqual(replacement.handle, original.handle);
  assert.equal(replacement.startTime, L.reused);
  assert.equal(tracker.find(original.handle), undefined);
});

test('heartbeat extends leases and drops processes that vanished', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 800, ppid: 1, pgid: 800, lstart: L.serve, command: 'serve' });
  let clock = T0;
  const tracker = new ResidueTracker({ sessionId: 'es_hb', ops, now: () => clock });

  const baseline = tracker.beginEval('es_hb:1', 800);
  ops.add({ pid: 802, ppid: 800, pgid: 802, lstart: L.npm, command: 'keep' });
  ops.add({ pid: 803, ppid: 800, pgid: 803, lstart: L.sleep, command: 'gone' });
  const result = tracker.endEval(baseline);
  const goneHandle = result.leftRunning.find((record) => record.pid === 803)?.handle;
  assert.ok(goneHandle !== undefined);

  clock = new Date(T0.getTime() + 20 * 60 * 1000);
  ops.remove(803);
  const active = tracker.heartbeat();

  assert.deepEqual(
    active.map((record) => record.pid),
    [802],
  );
  assert.equal(
    active[0]?.leaseUntil,
    new Date(clock.getTime() + RESIDUE_LEASE_MS).toISOString(),
  );
  assert.equal(tracker.find(goneHandle), undefined);
});

test('kill validates session and lstart before signalling', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 900, ppid: 1, pgid: 900, lstart: L.serve, command: 'serve' });
  const tracker = new ResidueTracker({ sessionId: 'es_kill', ops, now: () => T0 });

  const baseline = tracker.beginEval('es_kill:1', 900);
  ops.add({ pid: 901, ppid: 900, pgid: 900, lstart: L.shell, command: 'member' });
  ops.add({ pid: 902, ppid: 900, pgid: 902, lstart: L.npm, command: 'leader' });
  ops.add({ pid: 903, ppid: 900, pgid: 903, lstart: L.sleep, command: 'gone' });
  const result = tracker.endEval(baseline);
  const member = result.leftRunning.find((record) => record.pid === 901);
  const leader = result.leftRunning.find((record) => record.pid === 902);
  const gone = result.leftRunning.find((record) => record.pid === 903);
  assert.ok(member !== undefined && leader !== undefined && gone !== undefined);

  const leaderOutcome = tracker.kill(leader.handle);
  assert.equal(leaderOutcome.status, 'killed');
  assert.deepEqual(ops.signals.at(-1), { pid: -902, signal: 'SIGTERM' });

  const memberOutcome = tracker.kill(member.handle);
  assert.equal(memberOutcome.status, 'killed');
  assert.deepEqual(ops.signals.at(-1), { pid: 901, signal: 'SIGTERM' });

  ops.remove(903);
  const signalCount = ops.signals.length;
  const goneOutcome = tracker.kill(gone.handle);
  assert.equal(goneOutcome.status, 'already_gone');
  assert.equal(ops.signals.length, signalCount);

  const otherSession = new ResidueTracker({ sessionId: 'es_other', ops, now: () => T0 });
  assert.deepEqual(otherSession.kill(leader.handle), {
    status: 'unknown_handle',
    handle: leader.handle,
  });
});

test('kill refuses a recycled pid without signalling it', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 910, ppid: 1, pgid: 910, lstart: L.serve, command: 'serve' });
  const tracker = new ResidueTracker({ sessionId: 'es_stale', ops, now: () => T0 });

  const baseline = tracker.beginEval('es_stale:1', 910);
  ops.add({ pid: 911, ppid: 910, pgid: 911, lstart: L.npm, command: 'tracked' });
  const result = tracker.endEval(baseline);
  const tracked = result.leftRunning.find((record) => record.pid === 911);
  assert.ok(tracked !== undefined);

  ops.remove(911);
  ops.add({ pid: 911, ppid: 910, pgid: 911, lstart: L.reused, command: 'someone else' });
  const signalCount = ops.signals.length;
  const outcome = tracker.kill(tracked.handle);

  assert.equal(outcome.status, 'stale');
  assert.equal(ops.signals.length, signalCount);
  assert.equal(ops.rows.get(911)?.command, 'someone else');
});

test('killAll escalates only processes that ignore SIGTERM', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 1000, ppid: 1, pgid: 1000, lstart: L.serve, command: 'serve' });
  const tracker = new ResidueTracker({ sessionId: 'es_all', ops, now: () => T0 });

  const baseline = tracker.beginEval('es_all:1', 1000);
  ops.add({ pid: 1001, ppid: 1000, pgid: 1001, lstart: L.npm, command: 'polite' });
  ops.add({
    pid: 1002,
    ppid: 1000,
    pgid: 1002,
    lstart: L.sleep,
    command: 'stubborn',
    ignoreTerm: true,
  });
  tracker.endEval(baseline);

  const sleeps: number[] = [];
  const result = tracker.killAll({ graceMs: 25, sleep: (ms) => sleeps.push(ms) });

  assert.deepEqual(sleeps, [25]);
  assert.ok(result.killed.some((record) => record.pid === 1001 && record.signal === 'SIGTERM'));
  assert.ok(result.killed.some((record) => record.pid === 1002 && record.signal === 'SIGKILL'));
  assert.deepEqual(result.remaining, []);
  assert.deepEqual(tracker.records(), []);
});

test('expired reports leases at or past their deadline', () => {
  const ops = new FakeProcs();
  ops.add({ pid: 1100, ppid: 1, pgid: 1100, lstart: L.serve, command: 'serve' });
  const tracker = new ResidueTracker({ sessionId: 'es_lease', ops, now: () => T0 });

  const baseline = tracker.beginEval('es_lease:1', 1100);
  ops.add({ pid: 1101, ppid: 1100, pgid: 1101, lstart: L.npm, command: 'leftover' });
  tracker.endEval(baseline);

  assert.deepEqual(tracker.expired(new Date(T0_PLUS_30M.getTime() - 1)), []);
  assert.deepEqual(
    tracker.expired(T0_PLUS_30M).map((record) => record.pid),
    [1101],
  );
});

test('startHeartbeat ticks on its interval and stops cleanly', async () => {
  const ops = new FakeProcs();
  let flushes = 0;
  const tracker = new ResidueTracker({
    sessionId: 'es_timer',
    ops,
    heartbeatMs: 10,
    onFlush: () => {
      flushes += 1;
    },
  });

  tracker.startHeartbeat();
  await new Promise<void>((resolve) => setTimeout(resolve, 60));
  tracker.stopHeartbeat();
  assert.ok(flushes >= 2, `expected at least two heartbeat flushes, saw ${flushes}`);

  const frozen = flushes;
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.equal(flushes, frozen);
});

test('flush records round-trip through the C11 survivors ledger', (t) => {
  const ops = new FakeProcs();
  ops.add({ pid: 1200, ppid: 1, pgid: 1200, lstart: L.serve, command: 'serve' });
  const tracker = new ResidueTracker({ sessionId: 'es_ledger', ops, now: () => T0 });

  const baseline = tracker.beginEval('es_ledger:1', 1200);
  ops.add({ pid: 1201, ppid: 1200, pgid: 1201, lstart: L.npm, command: 'leftover' });
  const result = tracker.endEval(baseline);

  const ledger = new ProcessLedger({ root: tempDir(t) });
  ledger.writeSurvivors({ records: result.tracked });
  assert.deepEqual(
    ledger.readSurvivors().records.map((record) => record.handle),
    result.tracked.map((record) => record.handle),
  );
  assert.deepEqual(ledger.corruptions, []);
});

test('default lease and heartbeat match the frozen values', () => {
  assert.equal(RESIDUE_LEASE_MS, 30 * 60 * 1000);
  assert.equal(RESIDUE_HEARTBEAT_MS, 15 * 1000);
});
