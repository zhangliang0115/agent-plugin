/** AI run ledger and its startup-sweep branch. */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import {
  ProcessLedger,
  type AiRunEntry,
} from '../src/process/ledger.ts';
import { BOOT_MARKER, type ProcOps, type ProcRow } from '../src/process/residue.ts';
import { AI_RUN_DIR_MAX_AGE_MS, startupSweep } from '../src/process/sweep.ts';

const NOW = new Date('2026-11-18T06:00:00.000Z');
const NOW_ISO = NOW.toISOString();

interface FakeRow {
  pid: number;
  ppid: number;
  pgid: number;
  lstart: string;
  command: string;
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
      command: row.command,
    }));
  }

  signal(pid: number, signal: NodeJS.Signals): void {
    this.signals.push({ pid, signal });
    for (const row of [...this.rows.values()]) {
      if (pid < 0 ? row.pgid === -pid : row.pid === pid) {
        if (signal === 'SIGTERM' && row.ignoreTerm === true) continue;
        this.rows.delete(row.pid);
      }
    }
  }

  has(pid: number): boolean {
    return this.rows.has(pid);
  }
}

function tempDir(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'repl-ai-runs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function entry(overrides: Partial<AiRunEntry> = {}): AiRunEntry {
  return {
    runId: 'air_1',
    pid: null,
    pgid: null,
    lstart: null,
    state: 'spawning',
    bootId: 'b_prev',
    runDir: '/tmp/ai-run-x',
    startedAt: NOW_ISO,
    ...overrides,
  };
}

test('ai-runs.json round-trips atomically and supports upsert/patch/remove', (t) => {
  const root = tempDir(t);
  const ledger = new ProcessLedger({ root });
  assert.equal(ledger.aiRunsPath, join(root, 'ai-runs.json'));

  ledger.upsertAiRun(entry());
  assert.deepEqual(ledger.readAiRuns().entries, [entry()]);
  assert.equal(statSync(ledger.aiRunsPath).mode & 0o777, 0o600);

  ledger.patchAiRun('air_1', { pid: 500, pgid: 500, lstart: 'Mon Nov 17 14:31:58 2026', state: 'running' });
  assert.deepEqual(ledger.readAiRuns().entries, [
    entry({
      pid: 500,
      pgid: 500,
      lstart: 'Mon Nov 17 14:31:58 2026',
      state: 'running',
    }),
  ]);

  ledger.upsertAiRun(entry({ runId: 'air_2', runDir: '/tmp/ai-run-y' }));
  assert.equal(ledger.readAiRuns().entries.length, 2);

  ledger.removeAiRun('air_1');
  assert.deepEqual(
    ledger.readAiRuns().entries.map((item) => item.runId),
    ['air_2'],
  );
  ledger.removeAiRun('air_2');
  assert.deepEqual(ledger.readAiRuns().entries, []);
  assert.deepEqual(JSON.parse(readFileSync(ledger.aiRunsPath, 'utf8')), {
    bootId: 'b_prev',
    entries: [],
  });
});

test('startupSweep kills previous-boot AI runs and cleans their directories', (t) => {
  const root = tempDir(t);
  const ledger = new ProcessLedger({ root });
  ledger.writeState({ bootId: 'b_prev', pid: 4000, sessions: {} });

  const liveDir = join(root, 'ai-run-live');
  const mismatchDir = join(root, 'ai-run-mismatch');
  const spawningDir = join(root, 'ai-run-spawning');
  for (const dir of [liveDir, mismatchDir, spawningDir]) mkdirSync(dir);
  const oldDir = join(root, 'ai-run-old');
  const youngDir = join(root, 'ai-run-young');
  mkdirSync(oldDir);
  mkdirSync(youngDir);
  const oldTime = new Date(NOW.getTime() - AI_RUN_DIR_MAX_AGE_MS - 60_000);
  utimesSync(oldDir, oldTime, oldTime);

  ledger.writeAiRuns({
    bootId: 'b_prev',
    entries: [
      entry({
        runId: 'air_live',
        pid: 500,
        pgid: 500,
        lstart: 'Mon Nov 17 14:31:58 2026',
        state: 'running',
        runDir: liveDir,
      }),
      entry({
        runId: 'air_reused',
        pid: 501,
        pgid: 501,
        lstart: 'Mon Nov 17 14:31:58 2026',
        state: 'running',
        runDir: mismatchDir,
      }),
      entry({ runId: 'air_spawning', runDir: spawningDir }),
    ],
  });

  const ops = new FakeProcs();
  ops.add({
    pid: 500,
    ppid: 1,
    pgid: 500,
    lstart: 'Mon Nov 17 14:31:58 2026',
    command: 'claude -p',
  });
  ops.add({
    pid: 501,
    ppid: 1,
    pgid: 501,
    lstart: 'Tue Nov 18 09:00:00 2026',
    command: 'recycled',
  });

  const report = startupSweep({
    root,
    bootId: 'b_new',
    pid: 999,
    now: () => NOW,
    ops,
    sleep: () => undefined,
  });

  assert.deepEqual(
    report.killed.filter((record) => record.reason === 'ai-run').map((record) => record.pid),
    [500],
  );
  assert.ok(
    report.skipped.some(
      (record) => record.pid === 501 && record.reason === 'lstart_mismatch',
    ),
  );
  assert.ok(ops.signals.some((signal) => signal.pid === -500 && signal.signal === 'SIGTERM'));
  assert.equal(ops.has(501), true, 'a recycled PID must not be signalled');
  assert.ok(report.warnings.some((warning) => warning.includes('air_spawning')));

  assert.deepEqual(
    [...report.cleanedAiRuns].sort(),
    [liveDir, mismatchDir, spawningDir, oldDir].sort(),
  );
  for (const dir of [liveDir, mismatchDir, spawningDir, oldDir]) {
    assert.equal(existsSync(dir), false, `${dir} must be removed`);
  }
  assert.equal(existsSync(youngDir), true, 'a recent orphan directory stays for the next sweep');
  assert.equal(existsSync(join(root, 'ai-runs.json')), true, 'the ledger itself is kept');
});

test('the sweep leaves current-boot AI runs alone', (t) => {
  const root = tempDir(t);
  const ledger = new ProcessLedger({ root });
  ledger.writeState({ bootId: 'b_prev', pid: 4000, sessions: {} });
  const dir = join(root, 'ai-run-current');
  mkdirSync(dir);
  ledger.writeAiRuns({
    bootId: 'b_new',
    entries: [
      entry({
        runId: 'air_current',
        pid: 600,
        pgid: 600,
        lstart: 'Mon Nov 17 14:31:58 2026',
        state: 'running',
        bootId: 'b_new',
        runDir: dir,
      }),
    ],
  });

  const ops = new FakeProcs();
  ops.add({
    pid: 600,
    ppid: 1,
    pgid: 600,
    lstart: 'Mon Nov 17 14:31:58 2026',
    command: `claude -p ${BOOT_MARKER}=b_new`,
  });

  const report = startupSweep({
    root,
    bootId: 'b_new',
    pid: 999,
    now: () => NOW,
    ops,
    sleep: () => undefined,
  });

  assert.equal(report.killed.length, 0);
  assert.equal(ops.has(600), true);
  assert.equal(existsSync(dir), true);
});
