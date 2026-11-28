import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clampLine,
  diffFromArgs,
  highlightParts,
  lineDiff,
  matchLineIndices,
  MAX_LINE_CHARS,
  RENDER_MAX_BYTES,
  shouldRenderBody,
  textLines,
  VIRTUAL_BUFFER,
  virtualWindow,
} from '../src/lib/text-view.ts';

function kinds(lines: { kind: string }[]): string[] {
  return lines.map((line) => line.kind);
}

test('lineDiff marks a replacement as delete + add around shared context', () => {
  const lines = lineDiff('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(
    lines.map((line) => `${line.kind}:${line.text}`),
    ['ctx:a', 'del:b', 'add:x', 'ctx:c'],
  );
});

test('lineDiff handles pure insertion and pure deletion', () => {
  assert.deepEqual(
    lineDiff('a\nc', 'a\nb\nc').map((line) => line.kind),
    ['ctx', 'add', 'ctx'],
  );
  assert.deepEqual(
    lineDiff('a\nb\nc', 'a\nc').map((line) => line.kind),
    ['ctx', 'del', 'ctx'],
  );
});

test('lineDiff with an empty old side shows every line as an addition', () => {
  const lines = lineDiff('', 'one\ntwo');
  assert.deepEqual(kinds(lines), ['add', 'add']);
  assert.deepEqual(
    lines.map((line) => line.text),
    ['one', 'two'],
  );
});

test('lineDiff degrades honestly instead of blowing memory on huge inputs', () => {
  const big = `${'x\n'.repeat(3000)}`;
  const lines = lineDiff(big, `${big}\nextra`);
  assert.ok(lines.some((line) => line.text.includes('行数过大')));
  assert.equal(lines[0]?.kind, 'del');
  assert.equal(lines[lines.length - 1]?.kind, 'add');
});

test('virtualWindow keeps the mounted row count below the 5000-row ceiling', () => {
  const viewport = 320;
  const row = 18;
  const rows = Math.ceil(viewport / row) + 2 * VIRTUAL_BUFFER;
  assert.ok(rows < 5000);

  // Tiny body: one window covers everything.
  assert.deepEqual(virtualWindow(0, viewport, row, 5), { start: 0, end: 5 });

  // Scrolled deep into a large body.
  const mid = virtualWindow(100 * row, viewport, row, 100000);
  assert.ok(mid.start >= 0);
  assert.equal(mid.end - mid.start, rows);
  assert.ok(mid.end <= 100000);

  // Overscrolled clamps to the tail instead of an empty window.
  const tail = virtualWindow(999999 * row, viewport, row, 100);
  assert.deepEqual(tail, { start: Math.max(0, 100 - rows), end: 100 });
});

test('highlightParts is case-insensitive and reports every hit', () => {
  assert.deepEqual(highlightParts('aBc abc', 'abc'), [
    { text: 'aBc', hit: true },
    { text: ' ', hit: false },
    { text: 'abc', hit: true },
  ]);
  assert.deepEqual(highlightParts('plain', ''), [{ text: 'plain', hit: false }]);
  assert.deepEqual(highlightParts('', 'q'), [{ text: '', hit: false }]);
});

test('matchLineIndices counts matching lines, not occurrences', () => {
  const lines = textLines('alpha\nbeta alpha\ngamma');
  assert.deepEqual(matchLineIndices(lines, 'alpha'), [0, 1]);
  assert.deepEqual(matchLineIndices(lines, ''), []);
});

test('clampLine caps mega-lines so virtualisation cannot be defeated', () => {
  const long = 'x'.repeat(MAX_LINE_CHARS + 500);
  const clamped = clampLine(long);
  assert.ok(clamped.length < long.length);
  assert.ok(clamped.includes('已截断显示'));
  assert.equal(clampLine('short'), 'short');
});

test('diffFromArgs builds diffs for the write-family tools only', () => {
  const edit = diffFromArgs('Edit', {
    file_path: '/src/a.ts',
    old_string: 'a\nb',
    new_string: 'a\nc',
  });
  assert.ok(edit !== null);
  assert.equal(edit.title, '/src/a.ts');
  assert.deepEqual(kinds(edit.lines), ['ctx', 'del', 'add']);

  const multi = diffFromArgs('MultiEdit', {
    file_path: '/src/b.ts',
    edits: [
      { old_string: 'x', new_string: 'y' },
      { old_string: 'p', new_string: 'q' },
    ],
  });
  assert.ok(multi !== null);
  assert.ok(multi.lines.some((line) => line.text.includes('后续修改')));
  assert.equal(multi.lines.filter((line) => line.kind === 'add').length, 2);

  const write = diffFromArgs('Write', { file_path: '/new.txt', content: 'hello' });
  assert.ok(write !== null);
  assert.deepEqual(kinds(write.lines), ['add']);

  // Not a write tool, or nothing to show: no diff.
  assert.equal(diffFromArgs('Bash', { command: 'ls' }), null);
  assert.equal(diffFromArgs('Edit', { old_string: '', new_string: '' }), null);
  assert.equal(diffFromArgs(null, {}), null);
  assert.equal(diffFromArgs('Write', 'not-a-record'), null);
});

test('bodies over the render cap are downloads, not DOM', () => {
  assert.equal(shouldRenderBody(RENDER_MAX_BYTES), true);
  assert.equal(shouldRenderBody(RENDER_MAX_BYTES + 1), false);
  assert.equal(shouldRenderBody(null), true);
});

test('bodies up to 1 MiB load without a click, larger or unknown sizes wait', async () => {
  const { AUTO_LOAD_BYTES, shouldAutoLoad } = await import('../src/lib/text-view.ts');
  assert.equal(AUTO_LOAD_BYTES, 1024 * 1024);
  assert.equal(shouldAutoLoad(5000), true);
  assert.equal(shouldAutoLoad(AUTO_LOAD_BYTES), true);
  assert.equal(shouldAutoLoad(AUTO_LOAD_BYTES + 1), false);
  assert.equal(shouldAutoLoad(null), false);
});
