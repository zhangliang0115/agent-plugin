import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatReadContent,
  normalizeContent,
  normalizeEditResult,
  normalizeMcpResult,
  normalizeOfficialResult,
  normalizeReadResult,
  parseJsonText,
  textOf,
} from '../src/bridge/normalize-result.ts';

const textResult = (text: string, isError?: boolean) => ({
  content: [{ type: 'text' as const, text }],
  ...(isError === true ? { isError: true } : {}),
});

test('textOf joins text blocks and ignores media', () => {
  assert.equal(
    textOf({
      content: [
        { type: 'text', text: 'first' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
        { type: 'text', text: 'second' },
      ],
    }),
    'first\nsecond',
  );
});

test('normalizeContent flattens images, PDFs and resource text', () => {
  assert.deepEqual(
    normalizeContent([
      { type: 'text', text: 'first' },
      { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      { type: 'image', data: 'cGRm', mimeType: 'application/pdf' },
      { type: 'resource', resource: { text: 'second' } },
      { type: 'resource', resource: { mimeType: 'application/pdf', blob: 'cmVz' } },
      { type: 'audio', data: 'YXVkaW8', mimeType: 'audio/mpeg' },
    ]),
    {
      text: 'first\nsecond',
      images: [{ base64: 'aW1n', mediaType: 'image/png' }],
      documents: [{ base64: 'cGRm' }, { base64: 'cmVz' }],
    },
  );
});

test('official error results become { error } without throwing', () => {
  assert.deepEqual(normalizeOfficialResult('Read', textResult('missing file', true)), {
    error: 'missing file',
  });
  assert.deepEqual(normalizeOfficialResult('Read', { content: [], isError: true }), {
    error: 'Read failed',
  });
});

test('official JSON is parsed and non-JSON falls back to raw text', () => {
  assert.deepEqual(normalizeOfficialResult('Write', textResult('{"filePath":"/a","ok":true}')), {
    filePath: '/a',
    ok: true,
  });
  assert.equal(normalizeOfficialResult('Write', textResult('not json')), 'not json');
  assert.deepEqual(parseJsonText('null'), { ok: true, value: null });
  assert.deepEqual(parseJsonText('{'), { ok: false });
});

test('Read output uses six-column line numbers and an arrow', () => {
  assert.equal(formatReadContent('a\nb\n'), '     1→a\n     2→b\n');
  assert.equal(formatReadContent('a\nb'), '     1→a\n     2→b\n');
  assert.equal(formatReadContent('', 1), '');
  assert.equal(formatReadContent('\n', 1), '     1→\n');
  assert.equal(formatReadContent('a\n', 10), '    10→a\n');
});

test('normalizeReadResult honors startLine and derives numLines when absent', () => {
  assert.deepEqual(
    normalizeReadResult({ file: { filePath: '/a.txt', content: 'x\ny\n', startLine: 10 } }),
    {
      content: '    10→x\n    11→y\n',
      file_path: '/a.txt',
      numLines: 2,
      startLine: 10,
    },
  );
  assert.equal(normalizeReadResult({ file: { content: 1 } }), undefined);
  assert.equal(normalizeReadResult('nope'), undefined);
});

test('Edit output carries path, summary and the structured patch', () => {
  const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }];
  assert.deepEqual(
    normalizeEditResult({
      filePath: '/a.ts',
      oldString: 'a',
      newString: 'b',
      originalFile: 'a',
      structuredPatch: patch,
      replaceAll: false,
    }),
    { file_path: '/a.ts', ok: true, summary: 'replaced 1 occurrence', patch },
  );
});

test('Edit replaceAll counts every occurrence', () => {
  assert.deepEqual(
    normalizeEditResult({
      filePath: '/a.ts',
      oldString: 'x',
      newString: 'y',
      originalFile: 'x x x',
      replaceAll: true,
    }),
    { file_path: '/a.ts', ok: true, summary: 'replaced 3 occurrences' },
  );
  assert.equal(normalizeEditResult({ oldString: 'a' }), undefined);
});

test('official media is attached without discarding the parsed payload', () => {
  assert.deepEqual(
    normalizeOfficialResult('Read', {
      content: [
        { type: 'text', text: JSON.stringify({ file: { filePath: '/a', content: 'x\n', numLines: 1, startLine: 1 } }) },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
    }),
    {
      content: '     1→x\n',
      file_path: '/a',
      numLines: 1,
      startLine: 1,
      images: [{ base64: 'aW1n', mediaType: 'image/png' }],
    },
  );
});

test('MCP success keeps text and media in separate fields', () => {
  assert.deepEqual(
    normalizeMcpResult({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'aW1n', mimeType: 'image/png' },
      ],
    }),
    {
      text: 'hello',
      images: [{ base64: 'aW1n', mediaType: 'image/png' }],
      documents: [],
    },
  );
});
