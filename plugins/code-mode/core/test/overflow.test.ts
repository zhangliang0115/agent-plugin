import { test } from 'node:test';
import assert from 'node:assert/strict';
import { newMode, noTools, parseEnvelope } from './helpers.ts';

const signal = () => new AbortController().signal;
const big = '"x".repeat(60000)';

test('F6 an oversized result calls onResultOverflow with the full text and shows its detail in the marker', async () => {
  const seen: string[] = [];
  const out = parseEnvelope(await newMode({ resultChars: 10_000 }).run({}, {
    code: big, ...noTools, signal: signal(),
    onResultOverflow: async (text: string) => { seen.push(text); return 'Full result stored at: /x/run_code.txt'; },
  } as never));
  assert.equal(seen.length, 1);
  assert.equal(seen[0]!.length, 60_000);
  assert.ok(out.result!.startsWith('x'.repeat(10_000)));
  assert.ok(out.result!.endsWith('[truncated: 50000 more characters. Full result stored at: /x/run_code.txt]'), out.result!.slice(-120));
});

test('F6 a result within the limit never calls the callback', async () => {
  let calls = 0;
  await newMode().run({}, { code: '"small"', ...noTools, signal: signal(), onResultOverflow: async () => { calls++; return 'x'; } } as never);
  assert.equal(calls, 0);
});

test('F6 a callback that returns undefined or throws keeps the default marker', async () => {
  for (const onResultOverflow of [async () => undefined, async () => { throw new Error('disk full'); }]) {
    const out = parseEnvelope(await newMode({ resultChars: 10_000 }).run({}, { code: big, ...noTools, signal: signal(), onResultOverflow } as never));
    assert.ok(out.result!.endsWith('\n[truncated: 50000 more characters]'), out.result!.slice(-80));
  }
});

test('F6 a result that only exceeds the limit after escaping is still spilled', async () => {
  const seen: string[] = [];
  const out = parseEnvelope(await newMode({ resultChars: 10_000 }).run({}, {
    code: '"&".repeat(6000)', ...noTools, signal: signal(),
    onResultOverflow: async (text: string) => { seen.push(text); return 'Full result stored at: /x/run_code.txt'; },
  } as never));
  assert.equal(seen.length, 1, 'the full raw text is saved even though only the escaped text is too long');
  assert.equal(seen[0]!.length, 6_000);
  assert.match(out.result!, /Full result stored at: \/x\/run_code\.txt/, out.result!.slice(-120));
});
