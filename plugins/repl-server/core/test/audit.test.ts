// hook-allow: this test deliberately builds dummy credential strings to prove redaction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { redactDeep, redactValue, stripUrlQuery } from '../src/audit/redact.ts';
import { boundedJson, summarizeArgs } from '../src/audit/summarize.ts';
import { AuditWriter, type AuditIdentity } from '../src/audit/writer.ts';

const IDENTITY: AuditIdentity = {
  identity: 'bound',
  binding: 'cb_0123456789abcdef0123456789abcdef',
  client: 'claude-code/2.1.327',
  mcp: 'mcp_0123456789abcdef0123456789abcdef',
  exec: 'es_0123456789abcdef0123456789abcdef',
};

async function readEvents(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8');
  return text
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'repl-audit-'));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('redacts credential values while keeping their key names', () => {
  const apiKey = ['sk', 'test', 'abcdefghijklmnop'].join('-');
  const bearerToken = ['dummy', 'bearer', 'token', '9f2c'].join('-');
  const queryToken = ['query', 'token', 'ab12'].join('-');
  const jwt = ['a'.repeat(20), 'b'.repeat(24), 'c'.repeat(43)].join('.');

  const text = [
    `export OPENAI_API_KEY=${apiKey}`,
    `curl -H 'Authorization: Bearer ${bearerToken}'`,
    `curl -H 'Bearer ${bearerToken}'`,
    'GITHUB_TOKEN=ghp_abcdefghijklmnop',
    `curl 'https://example.com/run?keep=1&token=${queryToken}'`,
    `jwt ${jwt}`,
  ].join('\n');

  const redacted = redactValue(text);
  for (const secret of [apiKey, bearerToken, queryToken, jwt, 'ghp_abcdefghijklmnop']) {
    assert.ok(!redacted.includes(secret), `redacted text leaked ${secret}`);
  }
  assert.match(redacted, /OPENAI_API_KEY=<redacted>/);
  assert.match(redacted, /Authorization: <redacted>/);
  assert.match(redacted, /Bearer <redacted>/);
  assert.match(redacted, /\?keep=1&token=<redacted>/);
});

test('redacts bearer tokens regardless of case', () => {
  const token = ['lower', 'case', 'bearer', '0123456789'].join('-');
  const redacted = redactValue(`curl -H 'bearer ${token}'`);

  assert.ok(!redacted.includes(token));
  assert.match(redacted, /Bearer <redacted>/);
});

test('redacts URL userinfo and fragments but leaves plain text alone', () => {
  const password = ['hunter', '2', 'dummy'].join('-');
  const fragmentToken = ['oauth', 'fragment', '7f3a'].join('-');
  const text = [
    `git clone https://user:${password}@github.com/org/repo.git`,
    `open https://x.test/cb#access_token=${fragmentToken}`,
  ].join('\n');

  const redacted = redactValue(text);
  assert.ok(!redacted.includes(password));
  assert.ok(!redacted.includes(fragmentToken));
  assert.match(redacted, /https:\/\/<redacted>@github\.com\/org\/repo\.git/);
  assert.match(redacted, /https:\/\/x\.test\/cb#<redacted>/);

  const prose = 'see example.com/#/faq or mail dev@example.com';
  assert.equal(redactValue(prose), prose, 'only scheme:// URLs are rewritten');
});

test('redacts quoted JSON credential keys while keeping the key', () => {
  const passwordKey = ['pass', 'word'].join('');
  const tokenValue = ['abc', '123', 'def'].join('-');
  const passwordValue = ['hunter', '2', 'dummy'].join('-');
  const redacted = redactValue(`{"token": "${tokenValue}", '${passwordKey}': '${passwordValue}'}`);

  assert.ok(!redacted.includes(tokenValue));
  assert.ok(!redacted.includes(passwordValue));
  assert.match(redacted, /"token":\s*<redacted>/);
  assert.ok(redacted.includes(`'${passwordKey}':<redacted>`));
});

test('descriptive token keys keep their values; secret-bearing names are redacted', () => {
  const out = redactDeep({
    tokenCount: 3,
    tokenLength: 128,
    secretType: 'oauth',
    accessToken: 'abc',
    api_key: 'def',
    authorization: 'Bearer xyz',
  }) as Record<string, unknown>;

  assert.equal(out.tokenCount, 3);
  assert.equal(out.tokenLength, 128);
  assert.equal(out.secretType, 'oauth');
  assert.equal(out.accessToken, '<redacted>');
  assert.equal(out.api_key, '<redacted>');
  assert.equal(out.authorization, '<redacted>');
});

test('a __proto__ key stays inert data and does not pollute Object.prototype', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"format":"json"}') as Record<string, unknown>;
  const out = redactDeep(payload) as Record<string, unknown>;

  assert.equal(Object.getPrototypeOf(out), null);
  assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(out, '__proto__'), true);
  assert.deepEqual(JSON.parse(JSON.stringify(out)), payload);
});

test('strips URL query strings', () => {
  assert.equal(stripUrlQuery('https://example.com/x?token=abc&y=1'), 'https://example.com/x');
  assert.equal(stripUrlQuery('/relative/path?token=abc'), '/relative/path');
  assert.equal(stripUrlQuery('https://example.com/x'), 'https://example.com/x');
});

test('redactDeep keeps a 9-level query structure intact', () => {
  const fields = {
    tool: 'mcp__elasticsearch__search',
    args: {
      body: {
        query: {
          bool: {
            filter: [{ range: { '@timestamp': { gte: '2026-11-24T00:00:00Z' } } }],
          },
        },
      },
    },
  };

  assert.deepEqual(JSON.parse(JSON.stringify(redactDeep(fields))), fields);
});

test('redactDeep replaces content past 16 levels with [max-depth]', () => {
  let value: Record<string, unknown> = {};
  for (let level = 0; level < 17; level += 1) {
    value = { [`level${level}`]: value };
  }

  let cursor: unknown = redactDeep(value);
  let objects = 0;
  while (typeof cursor === 'object' && cursor !== null) {
    objects += 1;
    cursor = Object.values(cursor)[0];
  }

  // Sixteen containers are kept; the seventeenth becomes a marker string.
  assert.equal(objects, 16);
  assert.equal(cursor, '[max-depth]');
});

test('redactDeep truncates a circular reference at 16 levels without throwing', () => {
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;

  let cursor: unknown = redactDeep(cyclic);
  let objects = 0;
  while (typeof cursor === 'object' && cursor !== null) {
    objects += 1;
    cursor = (cursor as Record<string, unknown>).self;
  }

  assert.equal(objects, 16);
  assert.equal(cursor, '[max-depth]');
});

test('redactDeep still redacts secrets within the depth limit', () => {
  let value: Record<string, unknown> = {
    password: 'hunter2',
    note: 'GITHUB_TOKEN=ghp_abcdefghijklmnop',
  };
  for (let level = 0; level < 10; level += 1) {
    value = { [`level${level}`]: value };
  }

  const text = JSON.stringify(redactDeep(value));
  assert.ok(!text.includes('hunter2'), text);
  assert.ok(!text.includes('ghp_abcdefghijklmnop'), text);
  assert.ok(text.includes('"password":"<redacted>"'), text);
  assert.ok(text.includes('GITHUB_TOKEN=<redacted>'), text);
});

test('summarizes Bash by redacting and truncating the command', () => {
  const args = { command: `export API_KEY=sk-${'a'.repeat(600)}`, timeout: 120_000 };
  const summary = summarizeArgs('Bash', args);
  const command = summary.command;

  assert.equal(typeof command, 'string');
  assert.ok((command as string).length <= 500);
  assert.ok(!(command as string).includes('sk-aaaa'));
  assert.match(command as string, /API_KEY=<redacted>/);
  assert.equal(summary.timeout, 120_000);
});

test('summarizes Read with path, offset and limit', () => {
  assert.deepEqual(summarizeArgs('Read', { file_path: '/tmp/a.ts', offset: 10, limit: 20 }), {
    file_path: '/tmp/a.ts',
    offset: 10,
    limit: 20,
  });
});

test('summarizes Edit with a redacted head and byte counts', () => {
  const oldString = `OPENAI_API_KEY=${'b'.repeat(200)}`;
  const newString = 'replacement';
  const summary = summarizeArgs('Edit', {
    file_path: '/tmp/a.ts',
    old_string: oldString,
    new_string: newString,
  });

  assert.equal(summary.file_path, '/tmp/a.ts');
  assert.equal(typeof summary.oldHead, 'string');
  assert.ok((summary.oldHead as string).length <= 100);
  assert.ok(!(summary.oldHead as string).includes('b'.repeat(40)));
  assert.match(summary.oldHead as string, /<redacted>/);
  assert.equal(summary.oldBytes, Buffer.byteLength(oldString, 'utf8'));
  assert.equal(summary.newBytes, Buffer.byteLength(newString, 'utf8'));
});

test('bounds unknown tool arguments to 2KB and depth 2', () => {
  const blob = 'z'.repeat(10_000);
  const summary = summarizeArgs('Other', {
    password: 'hunter2',
    blob,
    nested: { level1: { level2: { level3: true } } },
  });

  const json = JSON.stringify(summary);
  assert.ok(Buffer.byteLength(json, 'utf8') <= 2048);
  assert.ok(!json.includes(blob));
  assert.equal(summary.password, '<redacted>');
  assert.deepEqual(summary.nested, { level1: '[max-depth]' });
});

test('boundedJson falls back when the value cannot fit', () => {
  const value = { items: Array.from({ length: 200 }, () => 'abcdefghij') };
  const bounded = boundedJson(value, { maxBytes: 512, depth: 2 }) as Record<string, unknown>;

  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded), 'utf8') <= 512);
});

test('summarizes UTF-8 byte counts, not UTF-16 code units', () => {
  const text = '中文内容'; // 4 characters, 12 UTF-8 bytes
  const edit = summarizeArgs('Edit', { file_path: '/tmp/a.ts', old_string: text, new_string: text });
  assert.equal(edit.oldBytes, 12);
  assert.equal(edit.newBytes, 12);

  const write = summarizeArgs('Write', { file_path: '/tmp/a.ts', content: text });
  assert.equal(write.contentBytes, 12);
});

test('truncated strings hash their redacted text, never the original', () => {
  const secret = ['dummy', 'token', 'value', '42'].join('-');
  const text = `${'x'.repeat(300)} token=${secret}`;
  const bounded = boundedJson(text) as Record<string, unknown>;

  assert.equal(typeof bounded.sha256, 'string');
  assert.equal(typeof bounded.len, 'number');
  assert.equal(bounded.sha256, createHash('sha256').update(redactValue(text)).digest('hex'));
  assert.notEqual(bounded.sha256, createHash('sha256').update(text).digest('hex'));
});

test('wide containers keep 100 entries and mark the rest', () => {
  const wide: Record<string, number> = {};
  for (let index = 0; index < 150; index += 1) wide[`k${index}`] = index;

  const bounded = boundedJson({ wide }) as { wide: Record<string, unknown> };
  assert.equal(Object.keys(bounded.wide).length, 101);
  assert.equal(bounded.wide['[+50 more]'], true);
  assert.equal(bounded.wide['k99'], 99);
  assert.equal('k100' in bounded.wide, false);

  const listed = boundedJson({ list: Array.from({ length: 150 }, (_, index) => index) }) as {
    list: unknown[];
  };
  assert.equal(listed.list.length, 101);
  assert.equal(listed.list[100], '[+50 more]');
});

test('splits files at UTC midnight and creates them with 0600', async () => {
  await withTempDir(async (dir) => {
    let now = Date.parse('2026-11-17T23:59:59.500Z');
    const writer = new AuditWriter({ dir, identity: IDENTITY, now: () => now });

    writer.write('eval_start', { evalId: 7, codePrefix: 'const a = 1' });
    now = Date.parse('2026-11-18T00:00:00.500Z');
    writer.write('eval_end', { evalId: 7, outcome: 'ok' });
    await writer.close();

    const dayOne = await readEvents(join(dir, 'events-2026-11-17.jsonl'));
    const dayTwo = await readEvents(join(dir, 'events-2026-11-18.jsonl'));
    assert.equal(dayOne.length, 1);
    assert.equal(dayTwo.length, 1);
    assert.equal(dayOne[0]?.event, 'eval_start');
    assert.equal(dayTwo[0]?.event, 'eval_end');

    const first = dayOne[0];
    assert.ok(first !== undefined);
    assert.equal(first.v, 2);
    assert.equal(first.ts, '2026-11-17T23:59:59.500Z');
    assert.equal(first.identity, 'bound');
    assert.equal(first.binding, IDENTITY.binding);
    assert.equal(first.client, IDENTITY.client);
    assert.equal(first.mcp, IDENTITY.mcp);
    assert.equal(first.exec, IDENTITY.exec);

    const mode = (await stat(join(dir, 'events-2026-11-17.jsonl'))).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('exported events never contain secret originals', async () => {
  await withTempDir(async (dir) => {
    const apiKey = ['sk', 'test', 'abcdefghijklmnop'].join('-');
    const bearerToken = ['dummy', 'bearer', 'token', '9f2c'].join('-');
    const writer = new AuditWriter({
      dir,
      identity: IDENTITY,
      now: () => Date.parse('2026-11-18T08:00:00.000Z'),
    });

    writer.write('tool_call', {
      tool: 'Bash',
      args: summarizeArgs('Bash', {
        command: `export OPENAI_API_KEY=${apiKey} && curl -H 'Authorization: Bearer ${bearerToken}' https://x.test/?token=${bearerToken}`,
      }),
    });
    // Raw fields also pass through the writer's redaction on the way out.
    writer.write('tool_call', { tool: 'Bash', args: { command: `export GITHUB_TOKEN=${bearerToken}` } });
    writer.writeEvent({ event: 'eval_end', evalId: 3, outcome: 'ok' });
    await writer.close();

    const text = await readFile(join(dir, 'events-2026-11-18.jsonl'), 'utf8');
    assert.ok(!text.includes(apiKey));
    assert.ok(!text.includes(bearerToken));
    assert.ok(text.includes('<redacted>'));
    assert.ok(text.includes('"event":"eval_end"'));
  });
});

test('queue pressure drops detail events and records audit_dropped', async () => {
  await withTempDir(async (dir) => {
    const writer = new AuditWriter({
      dir,
      identity: IDENTITY,
      now: () => Date.parse('2026-11-18T09:00:00.000Z'),
      maxQueueBytes: 256,
    });

    for (let seq = 0; seq < 60; seq += 1) {
      writer.write('tool_call', {
        seq,
        tool: 'Read',
        args: { file_path: `/tmp/f${seq}`, padding: 'p'.repeat(160) },
      });
    }
    writer.write('eval_end', { evalId: 1, outcome: 'ok' });
    await writer.close();

    const events = await readEvents(join(dir, 'events-2026-11-18.jsonl'));
    const calls = events.filter((event) => event.event === 'tool_call');
    assert.ok(calls.length >= 1);
    assert.ok(calls.length < 60, `expected dropped details, kept ${calls.length}`);

    const control = events.find((event) => event.event === 'eval_end');
    assert.ok(control !== undefined, 'control events must survive queue pressure');

    const dropped = events.find((event) => event.event === 'audit_dropped');
    assert.ok(dropped !== undefined, 'a dropped window must be reported');
    assert.equal(typeof dropped.count, 'number');
    assert.ok((dropped.count as number) > 0);
    assert.equal(typeof dropped.windowMs, 'number');
  });
});

test('prune honours the retention window and total size cap', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'events-2020-01-01.jsonl'), 'x'.repeat(80));
    await writeFile(join(dir, 'events-2026-11-16.jsonl'), 'x'.repeat(80));
    await writeFile(join(dir, 'events-2026-11-17.jsonl'), 'x'.repeat(80));
    await writeFile(join(dir, 'events-2026-11-18.jsonl'), 'x'.repeat(80));
    await writeFile(join(dir, 'notes.txt'), 'keep me');

    const writer = new AuditWriter({
      dir,
      now: () => Date.parse('2026-11-18T12:00:00.000Z'),
      retentionDays: 14,
      maxTotalBytes: 100,
    });
    const removed = await writer.prune();
    await writer.close();

    assert.ok(removed.includes('events-2020-01-01.jsonl'));
    assert.ok(removed.includes('events-2026-11-16.jsonl'));
    assert.ok(removed.includes('events-2026-11-17.jsonl'));
    assert.ok(!removed.includes('events-2026-11-18.jsonl'));
    assert.deepEqual((await readdir(dir)).sort(), ['events-2026-11-18.jsonl', 'notes.txt']);
  });
});

test('filePrefix writes to its own daily file', async () => {
  await withTempDir(async (dir) => {
    const writer = new AuditWriter({
      dir,
      filePrefix: 'protocol',
      now: () => Date.parse('2026-11-18T12:00:00.000Z'),
    });
    writer.write('proto_in', { id: 1, method: 'tools/list' });
    await writer.close();

    assert.deepEqual(await readdir(dir), ['protocol-2026-11-18.jsonl']);
    const events = await readEvents(join(dir, 'protocol-2026-11-18.jsonl'));
    assert.equal(events.length, 1);
    assert.equal(events[0]?.event, 'proto_in');
  });
});

test('prune only touches files with the writer prefix', async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, 'audit-2020-01-01.jsonl'), 'x');
    await writeFile(join(dir, 'protocol-2020-01-01.jsonl'), 'x');
    await writeFile(join(dir, 'protocol-2026-11-18.jsonl'), 'x');

    const writer = new AuditWriter({
      dir,
      filePrefix: 'protocol',
      now: () => Date.parse('2026-11-18T12:00:00.000Z'),
      retentionDays: 14,
    });
    const removed = await writer.prune();
    await writer.close();

    assert.deepEqual(removed, ['protocol-2020-01-01.jsonl']);
    assert.deepEqual((await readdir(dir)).sort(), [
      'audit-2020-01-01.jsonl',
      'protocol-2026-11-18.jsonl',
    ]);
  });
});

test('event fields cannot override writer-supplied attribution', async () => {
  await withTempDir(async (dir) => {
    const writer = new AuditWriter({
      dir,
      identity: IDENTITY,
      now: () => Date.parse('2026-11-18T10:00:00.000Z'),
    });

    writer.write('eval_start', {
      mcp: 'mcp_forged',
      binding: 'cb_forged',
      identity: 'unbound',
      client: 'forged/0',
      exec: 'es_forged',
      v: 99,
      ts: '1999-01-01T00:00:00.000Z',
      evalId: 5,
    });
    await writer.close();

    const [event] = await readEvents(join(dir, 'events-2026-11-18.jsonl'));
    assert.ok(event !== undefined);
    assert.equal(event.mcp, IDENTITY.mcp);
    assert.equal(event.binding, IDENTITY.binding);
    assert.equal(event.identity, 'bound');
    assert.equal(event.client, IDENTITY.client);
    assert.equal(event.exec, IDENTITY.exec);
    assert.equal(event.v, 2);
    assert.equal(event.ts, '2026-11-18T10:00:00.000Z');
    assert.equal(event.evalId, 5);
  });
});

test('without a writer identity, event fields still carry attribution', async () => {
  await withTempDir(async (dir) => {
    const writer = new AuditWriter({ dir, now: () => Date.parse('2026-11-18T10:30:00.000Z') });

    writer.write('tool_call', { tool: 'Bash', mcp: 'mcp_row', binding: 'cb_row', identity: 'bound' });
    await writer.close();

    const [event] = await readEvents(join(dir, 'events-2026-11-18.jsonl'));
    assert.ok(event !== undefined);
    assert.equal(event.mcp, 'mcp_row');
    assert.equal(event.binding, 'cb_row');
    assert.equal(event.tool, 'Bash');
  });
});

test('flush rejects after a write has failed', async () => {
  await withTempDir(async (dir) => {
    const writer = new AuditWriter({ dir, now: () => Date.parse('2026-11-18T11:00:00.000Z') });

    writer.write('eval_start', { evalId: 1, unserializable: 1n });
    assert.equal(writer.healthy, false);
    await assert.rejects(() => writer.flush(), /serialize/u);
    await writer.close();
  });
});

test('rejects an invalid filePrefix', () => {
  for (const filePrefix of ['', 'Protocol', '../escape', 'a_b', '1st', 'a/b']) {
    assert.throws(
      () => new AuditWriter({ dir: '/tmp/repl-audit-ignored', filePrefix }),
      RangeError,
      `expected ${JSON.stringify(filePrefix)} to be rejected`,
    );
  }
});
