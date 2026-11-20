import assert from 'node:assert/strict';
import test from 'node:test';

import { createResourceMonitor, type ResourceSample } from '../src/admin/resources.ts';
import type { LogFields } from '../src/log.ts';

const MB = 1024 * 1024;

test('aggregates descendants and computes the self CPU delta', () => {
  const root = process.pid;
  const rows = [
    { pid: root + 1, ppid: root, rssBytes: 10 * MB, cpuPercent: 1.5 },
    { pid: root + 2, ppid: root + 1, rssBytes: 5 * MB, cpuPercent: 2.5 },
    { pid: 1, ppid: 0, rssBytes: 99 * MB, cpuPercent: 50 },
  ];
  let ts = 1_000_000;
  let cpu = { user: 0, system: 0 };
  const logs: string[] = [];
  const monitor = createResourceMonitor({
    log: (message) => logs.push(message),
    intervalMs: 1_000,
    historyMs: 3_000,
    now: () => ts,
    memoryUsage: () => ({ rss: 20 * MB }),
    cpuUsage: () => cpu,
    readRows: () => rows,
  });

  for (let index = 0; index < 5; index += 1) {
    monitor.start();
    monitor.stop();
    ts += 1_000;
    cpu = { user: cpu.user + 50_000, system: cpu.system + 50_000 };
  }

  const snapshot = monitor.snapshot();
  assert.equal(snapshot.intervalMs, 1_000);
  assert.equal(snapshot.series.length, 3, 'history keeps ceil(3000/1000) samples');
  const current = snapshot.current;
  assert.ok(current !== null);
  assert.equal(current.selfRssBytes, 20 * MB);
  assert.equal(current.childRssBytes, 15 * MB);
  assert.equal(current.childCount, 2);
  assert.equal(current.totalRssBytes, 35 * MB);
  assert.equal(current.selfCpuPercent, 10);
  assert.equal(current.childCpuPercent, 4);
  assert.equal(current.totalCpuPercent, 14);
  assert.ok(logs.some((line) => line.includes('rss=35MB') && line.includes('processes=2')));
});

test('reports every sample to the persistence sink', () => {
  const samples: ResourceSample[] = [];
  let ts = 1_000_000;
  const monitor = createResourceMonitor({
    log: () => undefined,
    intervalMs: 1_000,
    now: () => ts,
    memoryUsage: () => ({ rss: 1 * MB }),
    cpuUsage: () => ({ user: 0, system: 0 }),
    readRows: () => [],
    onSample: (sample) => samples.push(sample),
  });

  monitor.start();
  monitor.stop();
  ts += 1_000;
  monitor.start();
  monitor.stop();

  assert.equal(samples.length, 2);
  assert.equal(samples[0]?.totalRssBytes, 1 * MB);
  assert.equal(samples[1]?.ts, ts);
});

test('reuses the last child values when ps fails and warns at most once a minute', () => {
  const root = process.pid;
  const rows = [
    { pid: root + 1, ppid: root, rssBytes: 10 * MB, cpuPercent: 1.5 },
    { pid: root + 2, ppid: root, rssBytes: 5 * MB, cpuPercent: 2.5 },
  ];
  let ts = 1_000_000;
  let failing = false;
  const warnings: string[] = [];
  const monitor = createResourceMonitor({
    log: (message, fields?: LogFields) => {
      if (fields?.level === 'warn') warnings.push(message);
    },
    intervalMs: 1_000,
    historyMs: 10_000,
    now: () => ts,
    memoryUsage: () => ({ rss: 1 * MB }),
    cpuUsage: () => ({ user: 0, system: 0 }),
    readRows: () => {
      if (failing) throw new Error('ps down');
      return rows;
    },
  });

  monitor.start();
  monitor.stop();
  assert.equal(monitor.snapshot().current?.childRssBytes, 15 * MB);

  failing = true;
  ts += 1_000;
  monitor.start();
  monitor.stop();
  const current = monitor.snapshot().current;
  assert.equal(current?.childRssBytes, 15 * MB, 'previous child values are reused');
  assert.equal(current?.childCount, 2);
  assert.equal(warnings.length, 1);

  ts += 1_000;
  monitor.start();
  monitor.stop();
  assert.equal(warnings.length, 1, 'warn is throttled');

  ts += 60_000;
  monitor.start();
  monitor.stop();
  assert.equal(warnings.length, 2, 'a new warn is allowed after a minute');
});
