import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeOutput, type OutputImage } from '../src/output/normalize.ts';

const image = (base64: string): OutputImage => ({ base64, mediaType: 'image/png' });

test('fields pass through and nothing is flagged', () => {
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

test('text output is never truncated', () => {
  const result = 'x'.repeat(1_000_000);
  const stdout = Array.from({ length: 5_000 }, (_value, index) => `line ${index}`).join('\n');
  const out = normalizeOutput({ result, stdout, stderr: 'e'.repeat(200_000) });
  assert.equal(out.result, result);
  assert.equal(out.stdout, stdout);
  assert.equal(out.stderr, 'e'.repeat(200_000));
  assert.deepEqual(out.truncated, {});
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
