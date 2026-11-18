import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach, beforeEach } from 'node:test';

import {
  ProcessLedger,
  defaultLedgerRoot,
  evalKeyOf,
  writeJsonAtomic,
  type LedgerCorruption,
  type PoolFile,
  type ServeRecord,
  type SurvivorRecord,
  type SurvivorsFile,
} from '../src/process/ledger.ts';

const originalAgentsHome = process.env.AGENTS_HOME;
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'repl-ledger-'));
  process.env.AGENTS_HOME = home;
});

afterEach(() => {
  if (originalAgentsHome === undefined) delete process.env.AGENTS_HOME;
  else process.env.AGENTS_HOME = originalAgentsHome;
  rmSync(home, { recursive: true, force: true });
});

function dataRoot(): string {
  return join(home, 'repl-server');
}

function serveRecord(overrides: Partial<ServeRecord> = {}): ServeRecord {
  return {
    pid: 48_213,
    pgid: 48_213,
    keeperPid: 48_200,
    sessionId: 's_a1',
    bootId: 'b_boot',
    lstart: 'Mon Nov 17 14:31:58 2026',
    ...overrides,
  };
}

function survivorRecord(overrides: Partial<SurvivorRecord> = {}): SurvivorRecord {
  return {
    handle: 'p_1a2b3c4d',
    sessionId: 's_a1',
    evalKey: evalKeyOf('es_1', 12),
    pid: 4_312,
    ppid: 202,
    pgid: 202,
    startTime: 'Mon Nov 17 14:31:58 2026',
    cmd: 'npm run dev',
    firstSeen: '2026-11-17T14:31:58.000Z',
    leaseUntil: '2026-11-17T15:01:58.000Z',
    state: 'running',
    ...overrides,
  };
}

function tempFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.endsWith('.tmp'));
}

test('defaults the data root to $AGENTS_HOME/repl-server', () => {
  assert.equal(defaultLedgerRoot({ AGENTS_HOME: home }), dataRoot());
  assert.equal(defaultLedgerRoot({}), join(homedir(), '.agents', 'repl-server'));

  const ledger = new ProcessLedger();
  assert.equal(ledger.root, dataRoot());
  assert.equal(ledger.statePath, join(dataRoot(), 'state.json'));
  assert.equal(ledger.poolPath, join(dataRoot(), 'pool.json'));
  assert.equal(ledger.survivorsPath, join(dataRoot(), 'ledger', 'survivors.json'));
  assert.equal(ledger.servePath('s_a1'), join(dataRoot(), 'sessions', 's_a1', 'serve.json'));
});

test('round-trips state.json atomically with mode 0600', () => {
  const ledger = new ProcessLedger();
  const state = {
    bootId: 'b_boot',
    pid: 9_001,
    startedAt: '2026-11-18T06:00:00.000Z',
    sessions: {
      s_a1: { serve: serveRecord(), updatedAt: '2026-11-18T06:00:01.000Z' },
      s_b2: { serve: null },
    },
  };
  ledger.writeState(state);

  assert.deepEqual(ledger.readState(), state);
  assert.equal(statSync(ledger.statePath).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(ledger.statePath, 'utf8')), state);
  assert.deepEqual(tempFiles(dataRoot()), []);

  const second = { bootId: 'b_boot', pid: 9_002, sessions: {} };
  ledger.writeState(second);
  assert.deepEqual(ledger.readState(), second);
  assert.equal(statSync(ledger.statePath).mode & 0o777, 0o600);
});

test('round-trips sessions/<id>/serve.json and lists records', () => {
  const ledger = new ProcessLedger();
  const first = serveRecord({ sessionId: 's_b2' });
  const second = serveRecord({ sessionId: 's_a1', pid: 500, pgid: 500, keeperPid: 400 });
  ledger.writeServe(first);
  ledger.writeServe(second);

  assert.deepEqual(ledger.readServe('s_b2'), first);
  assert.equal(statSync(ledger.servePath('s_b2')).mode & 0o777, 0o600);
  assert.equal(statSync(ledger.servePath('s_b2')).isFile(), true);
  assert.deepEqual(ledger.listServeRecords().map((record) => record.sessionId), ['s_a1', 's_b2']);
  assert.equal(ledger.readServe('s_missing'), null);

  ledger.removeServe('s_b2');
  assert.equal(ledger.readServe('s_b2'), null);
  assert.deepEqual(ledger.listServeRecords().map((record) => record.sessionId), ['s_a1']);
  ledger.removeServe('s_b2');
});

test('keeps a serve record whose lstart was unknown when the keeper wrote it', () => {
  const ledger = new ProcessLedger();
  const unknownStart = serveRecord({ sessionId: 's_nostart', lstart: '' });
  ledger.writeServe(unknownStart);

  assert.deepEqual(ledger.readServe('s_nostart'), unknownStart);
  assert.deepEqual(ledger.corruptions, []);
});

test('round-trips pool.json including pre-spawn entries', () => {
  const ledger = new ProcessLedger();
  const pool: PoolFile = {
    bootId: 'b_boot',
    entries: [
      { serverId: 'pg', cfgVersion: 3, pid: null, pgid: null, lstart: null, state: 'spawning' },
      {
        serverId: 'fs',
        cfgVersion: 1,
        pid: 6_200,
        pgid: 6_200,
        lstart: 'Tue Nov 18 09:00:00 2026',
        state: 'running',
        bootId: 'b_boot',
        startedAt: '2026-11-18T09:00:00.000Z',
      },
    ],
  };
  ledger.writePool(pool);

  assert.deepEqual(ledger.readPool(), pool);
  assert.equal(statSync(ledger.poolPath).mode & 0o777, 0o600);
  assert.deepEqual(tempFiles(dataRoot()), []);
});

test('round-trips survivors.json keyed by execSessionId:evalId', () => {
  const ledger = new ProcessLedger();
  const survivors: SurvivorsFile = {
    records: [
      survivorRecord(),
      survivorRecord({
        handle: 'p_2',
        evalKey: evalKeyOf('es_2', 12),
        pid: 5_000,
        pgid: 5_000,
        state: 'gone',
      }),
      survivorRecord({
        handle: 'p_3',
        evalKey: evalKeyOf('es_2', 13),
        pid: 5_001,
        pgid: 5_001,
        state: 'killed',
      }),
    ],
  };
  ledger.writeSurvivors(survivors);

  assert.deepEqual(ledger.readSurvivors(), survivors);
  assert.equal(statSync(ledger.survivorsPath).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(ledger.survivorsPath, 'utf8')) as { records: SurvivorRecord[] };
  assert.deepEqual(raw.records.map((record) => record.evalKey), ['es_1:12', 'es_2:12', 'es_2:13']);
});

test('builds composite eval keys and rejects bad parts', () => {
  assert.equal(evalKeyOf('es_abc', 7), 'es_abc:7');
  assert.throws(() => evalKeyOf('', 1), TypeError);
  assert.throws(() => evalKeyOf('es:1', 1), TypeError);
  assert.throws(() => evalKeyOf('es_abc', 0), RangeError);
  assert.throws(() => evalKeyOf('es_abc', 1.5), RangeError);
});

test('missing files read as empty without recording corruption', () => {
  const ledger = new ProcessLedger();

  assert.deepEqual(ledger.readState(), { bootId: '', pid: 0, sessions: {} });
  assert.deepEqual(ledger.readPool(), { bootId: '', entries: [] });
  assert.deepEqual(ledger.readSurvivors(), { records: [] });
  assert.equal(ledger.readServe('s_none'), null);
  assert.deepEqual(ledger.listServeRecords(), []);
  assert.deepEqual(ledger.corruptions, []);
});

test('corrupt top-level files read as empty and are recorded', () => {
  const seen: LedgerCorruption[] = [];
  const ledger = new ProcessLedger({ onCorrupt: (issue) => seen.push(issue) });
  mkdirSync(join(dataRoot(), 'ledger'), { recursive: true });
  writeFileSync(ledger.statePath, '{ not json');
  writeFileSync(ledger.poolPath, JSON.stringify({ bootId: 'b_boot', entries: [{ serverId: 'pg' }] }));
  writeFileSync(ledger.survivorsPath, JSON.stringify([]));

  assert.deepEqual(ledger.readState(), { bootId: '', pid: 0, sessions: {} });
  assert.deepEqual(ledger.readPool(), { bootId: '', entries: [] });
  assert.deepEqual(ledger.readSurvivors(), { records: [] });

  assert.equal(ledger.corruptions.length, 3);
  assert.deepEqual(seen, ledger.corruptions);
  assert.deepEqual(
    ledger.corruptions.map((issue) => issue.path).sort(),
    [ledger.poolPath, ledger.statePath, ledger.survivorsPath].sort(),
  );
  assert.match(ledger.corruptions[0]?.reason ?? '', /invalid JSON/);
  assert.match(ledger.corruptions[1]?.reason ?? '', /invalid pool\.json shape/);
  assert.match(ledger.corruptions[2]?.reason ?? '', /invalid survivors\.json shape/);
});

test('a corrupt serve record reads as null and is recorded', () => {
  const seen: LedgerCorruption[] = [];
  const ledger = new ProcessLedger({ onCorrupt: (issue) => seen.push(issue) });
  const dir = join(dataRoot(), 'sessions', 's_bad');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'serve.json');
  writeFileSync(path, JSON.stringify({ pid: 'not-a-number' }));

  assert.equal(ledger.readServe('s_bad'), null);
  assert.equal(ledger.corruptions.length, 1);
  assert.equal(ledger.corruptions[0]?.path, path);
  assert.match(ledger.corruptions[0]?.reason ?? '', /invalid serve record/);
  assert.equal(seen.length, 1);
});

test('listServeRecords returns valid records and skips corrupt ones', () => {
  const ledger = new ProcessLedger();
  ledger.writeServe(serveRecord({ sessionId: 's_good' }));
  const badDir = join(dataRoot(), 'sessions', 's_bad');
  mkdirSync(badDir, { recursive: true });
  writeFileSync(join(badDir, 'serve.json'), 'garbage');

  assert.deepEqual(ledger.listServeRecords().map((record) => record.sessionId), ['s_good']);
  assert.equal(ledger.corruptions.length, 1);
  assert.equal(ledger.corruptions[0]?.path, join(badDir, 'serve.json'));
});

test('rejects unsafe session ids and malformed records on write', () => {
  const ledger = new ProcessLedger();

  assert.throws(() => ledger.writeServe(serveRecord({ sessionId: '../escape' })), TypeError);
  assert.throws(() => ledger.readServe('../escape'), TypeError);
  assert.throws(() => ledger.writeServe(serveRecord({ pid: 0 })), TypeError);
  assert.throws(() => ledger.writeServe(serveRecord({ bootId: '' })), TypeError);
  assert.throws(
    () => ledger.writePool({
      bootId: 'b_boot',
      entries: [{ serverId: 'pg', cfgVersion: 1, pid: 10, pgid: 10, lstart: null, state: 'running' }],
    }),
    TypeError,
  );
  assert.throws(
    () => ledger.writePool({
      bootId: 'b_boot',
      entries: [{ serverId: '', cfgVersion: 1, pid: null, pgid: null, lstart: null, state: 'spawning' }],
    }),
    TypeError,
  );
  assert.throws(
    () => ledger.writeSurvivors({ records: [survivorRecord({ evalKey: '12' })] }),
    TypeError,
  );
  assert.throws(
    () => ledger.writeSurvivors({ records: [survivorRecord({ state: 'zombie' as SurvivorRecord['state'] })] }),
    TypeError,
  );
  assert.throws(
    () => ledger.writeState({
      bootId: 'b_boot',
      pid: 1,
      sessions: { s_a1: { serve: serveRecord({ sessionId: 's_other' }) } },
    }),
    TypeError,
  );

  assert.deepEqual(ledger.corruptions, []);
  assert.equal(ledger.readServe('s_missing'), null);
});

test('a failed atomic write keeps the previous file and removes the temp file', () => {
  const ledger = new ProcessLedger();
  ledger.writeState({ bootId: 'b_boot', pid: 1, sessions: {} });
  const before = readFileSync(ledger.statePath, 'utf8');

  assert.throws(() => writeJsonAtomic(ledger.statePath, { big: 1n }), TypeError);

  assert.equal(readFileSync(ledger.statePath, 'utf8'), before);
  assert.deepEqual(tempFiles(dataRoot()), []);
});
