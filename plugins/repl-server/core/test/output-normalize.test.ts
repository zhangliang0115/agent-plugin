import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOutput, type OutputImage } from '../src/output/normalize.ts';
import { estimateTokens } from '../src/output/tokens.ts';

const image = (base64: string): OutputImage => ({ base64, mediaType: 'image/png' });

test('estimateTokens divides ASCII by four and counts non-ASCII as one', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcde'), 2);
  assert.equal(estimateTokens('中文'), 2);
  assert.equal(estimateTokens('ab中'), 2);
  assert.equal(estimateTokens('a'.repeat(20_000)), 5_000);
  assert.equal(estimateTokens('a'.repeat(100) + '中'.repeat(100)), 125);
});

test('estimateTokens counts an astral character once', () => {
  assert.equal(estimateTokens('😀'), 1);
  assert.equal(estimateTokens('a😀'), 2);
  assert.equal(estimateTokens('😀😀'), 2);
});

test('short fields pass through and nothing is flagged', () => {
  const out = normalizeOutput({
    result: 'ok',
    stdout: 'out',
    stderr: '',
    images: [],
    documents: [],
  });
  assert.equal(out.result, 'ok');
  assert.equal(out.stdout, 'out');
  assert.equal(out.stderr, '');
  assert.deepEqual(out.images, []);
  assert.deepEqual(out.documents, []);
  assert.equal(out.imagesOmitted, 0);
  assert.equal(out.documentsOmitted, 0);
  assert.deepEqual(out.truncated, {});
});

test('absent streams default to empty strings and absent media to empty lists', () => {
  const out = normalizeOutput({ result: 'ok' });
  assert.equal(out.stdout, '');
  assert.equal(out.stderr, '');
  assert.deepEqual(out.images, []);
  assert.deepEqual(out.documents, []);
});

test('renders non-string results as text', () => {
  assert.equal(normalizeOutput({ result: { a: 1 } }).result, '{"a":1}');
  assert.equal(normalizeOutput({ result: [1, 'two'] }).result, '[1,"two"]');
  assert.equal(normalizeOutput({ result: 42 }).result, '42');
  assert.equal(normalizeOutput({ result: null }).result, 'null');
  assert.equal(normalizeOutput({ result: 10n }).result, '10');
  assert.equal(normalizeOutput({ result: '' }).result, '');
  assert.equal(normalizeOutput({}).result, undefined);
});

test('falls back to String for values JSON cannot serialize', () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(normalizeOutput({ result: circular }).result, '[object Object]');
  assert.match(String(normalizeOutput({ result: () => 1 }).result), /^\(\) =>/);
});

test('caps result at the field limit, keeping the head', () => {
  const out = normalizeOutput({ result: 'abcdefghijklmno' }, { resultChars: 10 });
  assert.equal(out.result, 'abcdefghij');
  assert.deepEqual(out.truncated, { result: true });
});

test('caps each log stream at the field limit, keeping the tail', () => {
  const out = normalizeOutput(
    { stdout: '0123456789abcdef', stderr: 'abcdefghijklmnop' },
    { resultChars: 8 },
  );
  assert.equal(out.stdout, '89abcdef');
  assert.equal(out.stderr, 'ijklmnop');
  assert.deepEqual(out.truncated, { stdout: true, stderr: true });
});

test('keeps the last log lines and flags the stream', () => {
  const out = normalizeOutput({ stdout: 'l1\nl2\nl3\nl4\nl5\n' }, { logLines: 3 });
  assert.equal(out.stdout, 'l3\nl4\nl5\n');
  assert.deepEqual(out.truncated, { stdout: true });
});

test('a trailing newline does not invent a line', () => {
  assert.equal(normalizeOutput({ stdout: 'a\nb\nc\n' }, { logLines: 3 }).stdout, 'a\nb\nc\n');
  assert.deepEqual(normalizeOutput({ stdout: 'a\nb\nc\n' }, { logLines: 3 }).truncated, {});
  assert.equal(normalizeOutput({ stdout: 'a\nb\nc' }, { logLines: 3 }).stdout, 'a\nb\nc');
  assert.equal(normalizeOutput({ stdout: 'a\nb\nc' }, { logLines: 2 }).stdout, 'b\nc');
});

test('applies the line cap before the character cap', () => {
  const out = normalizeOutput({ stdout: 'aaaa\nbbbb\ncccc' }, { logLines: 2, resultChars: 4 });
  assert.equal(out.stdout, 'cccc');
  assert.deepEqual(out.truncated, { stdout: true });
});

test('flags every field that was cut', () => {
  const out = normalizeOutput(
    { result: 'r'.repeat(20), stdout: 'a\nb\nc\nd\n', stderr: 'e'.repeat(20) },
    { resultChars: 10, logLines: 2 },
  );
  assert.equal(out.result, 'r'.repeat(10));
  assert.equal(out.stdout, 'c\nd\n');
  assert.equal(out.stderr, 'e'.repeat(10));
  assert.deepEqual(out.truncated, { result: true, stdout: true, stderr: true });
});

test('trims result to the token budget left by the logs', () => {
  const out = normalizeOutput(
    { result: 'r'.repeat(400), stdout: 's'.repeat(40) },
    { resultChars: 1_000, logLines: 100, estimatedTokens: 50 },
  );
  // stdout is 10 tokens; the result gets 40 tokens, i.e. 160 ASCII characters.
  assert.equal(out.stdout, 's'.repeat(40));
  assert.equal(out.result, 'r'.repeat(160));
  assert.deepEqual(out.truncated, { result: true });
});

test('empties result before cutting logs', () => {
  const out = normalizeOutput(
    { result: 'r'.repeat(400), stdout: 's'.repeat(40) },
    { resultChars: 1_000, logLines: 100, estimatedTokens: 10 },
  );
  assert.equal(out.result, '');
  assert.equal(out.stdout, 's'.repeat(40));
  assert.deepEqual(out.truncated, { result: true });
});

test('keeps stderr and the tail of stdout when logs alone exceed the budget', () => {
  const out = normalizeOutput(
    { stdout: 'o'.repeat(400), stderr: 'e'.repeat(40) },
    { resultChars: 1_000, logLines: 100, estimatedTokens: 20 },
  );
  // stderr (10 tokens) survives whole; stdout keeps its last 10 tokens (40 characters).
  assert.equal(out.stderr, 'e'.repeat(40));
  assert.equal(out.stdout, 'o'.repeat(40));
  assert.deepEqual(out.truncated, { stdout: true });
});

test('uses the non-ASCII estimate so Chinese results stop at the token limit', () => {
  const out = normalizeOutput({ result: '中'.repeat(60_000) });
  assert.equal(out.result, '中'.repeat(20_000));
  assert.deepEqual(out.truncated, { result: true });
});

test('default limits cap each text field at 30k characters', () => {
  const out = normalizeOutput({ result: 'x'.repeat(30_001) });
  assert.equal(out.result, 'x'.repeat(30_000));
  assert.equal(out.truncated.result, true);
});

test('default limits keep the last 1000 log lines', () => {
  const stdout = Array.from({ length: 1_001 }, (_value, index) => `line ${index}`).join('\n');
  const out = normalizeOutput({ stdout });
  const lines = out.stdout.split('\n');
  assert.equal(lines.length, 1_000);
  assert.equal(lines[0], 'line 1');
  assert.equal(lines.at(-1), 'line 1000');
  assert.equal(out.truncated.stdout, true);
});

test('never splits a surrogate pair when cutting', () => {
  assert.equal(normalizeOutput({ result: 'a😀b' }, { resultChars: 2 }).result, 'a');
  assert.equal(normalizeOutput({ result: 'a😀b' }, { resultChars: 3 }).result, 'a😀');
  assert.equal(normalizeOutput({ stdout: 'a😀b' }, { resultChars: 2 }).stdout, 'b');
});

test('caps images at eight and counts the rest as omitted', () => {
  const images = Array.from({ length: 9 }, () => image('AAAA'));
  const out = normalizeOutput({ images });
  assert.equal(out.images.length, 8);
  assert.equal(out.imagesOmitted, 1);
  assert.deepEqual(out.truncated, {});
});

test('caps documents at four and counts the rest as omitted', () => {
  const documents = Array.from({ length: 5 }, () => ({ base64: 'AAAA' }));
  const out = normalizeOutput({ documents });
  assert.equal(out.documents.length, 4);
  assert.equal(out.documentsOmitted, 1);
});

test('drops media blocks above the byte limit and counts them', () => {
  const fourBytes = image('AAAAAA=='); // 4 decoded bytes
  const fiveBytes = image('AAAAAAA='); // 5 decoded bytes
  const out = normalizeOutput({ images: [fourBytes, fiveBytes] }, { mediaBytes: 4 });
  assert.deepEqual(out.images, [fourBytes]);
  assert.equal(out.imagesOmitted, 1);

  const docs = normalizeOutput(
    { documents: [{ base64: 'AAAAAAA=' }, { base64: 'AAAA' }] },
    { mediaBytes: 4 },
  );
  assert.deepEqual(docs.documents, [{ base64: 'AAAA' }]);
  assert.equal(docs.documentsOmitted, 1);
});

test('an oversized block does not consume the media quota', () => {
  const big = image('AAAAAAA='); // 5 bytes > 4
  const small = image('AAAA');
  const out = normalizeOutput(
    { images: [big, small, small, small] },
    { images: 2, mediaBytes: 4 },
  );
  assert.equal(out.images.length, 2);
  assert.equal(out.imagesOmitted, 2); // the oversized block and the third small one
});

test('default media limit is five megabytes per block', () => {
  const oversized = image('A'.repeat(7 * 1024 * 1024)); // ~5.25MB decoded
  const out = normalizeOutput({ images: [oversized, image('AAAA')] });
  assert.equal(out.images.length, 1);
  assert.equal(out.imagesOmitted, 1);
});
