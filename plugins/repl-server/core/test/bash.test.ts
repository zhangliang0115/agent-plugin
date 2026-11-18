import assert from 'node:assert/strict';
import test from 'node:test';

import { clampBashArgs, parseBashResult } from '../src/bridge/bash.ts';
import { NoTimeLeftError } from '../src/errors.ts';

/** A far-away deadline so only the requested value decides the timeout. */
const FAR = 10_000_000;

function textResult(text: string, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

test('clampBashArgs defaults the timeout to 120000 when omitted', () => {
  const clamped = clampBashArgs({ command: 'ls -la' }, FAR, 0);
  assert.equal(clamped.timeout, 120_000);
  assert.equal(clamped.command, 'ls -la');
});

test('clampBashArgs defaults a null timeout the same way', () => {
  assert.equal(clampBashArgs({ timeout: null }, FAR, 0).timeout, 120_000);
});

test('clampBashArgs raises requests below 250 to the floor', () => {
  assert.equal(clampBashArgs({ timeout: 10 }, FAR, 0).timeout, 250);
});

test('clampBashArgs caps requests above 600000', () => {
  assert.equal(clampBashArgs({ timeout: 900_000 }, FAR, 0).timeout, 600_000);
});

test('clampBashArgs narrows to the deadline minus the 500ms reserve', () => {
  // usable = 21000 - 1000 - 500 = 19500
  assert.equal(clampBashArgs({ timeout: 900_000 }, 21_000, 1_000).timeout, 19_500);
});

test('clampBashArgs leaves a request that already fits untouched', () => {
  assert.equal(clampBashArgs({ timeout: 30_000 }, 100_000, 0).timeout, 30_000);
});

test('clampBashArgs accepts the exact 250ms floor at the boundary', () => {
  // usable = 750 - 0 - 500 = 250
  assert.equal(clampBashArgs({ timeout: 5_000 }, 750, 0).timeout, 250);
});

test('clampBashArgs throws NoTimeLeftError when the floor does not fit', () => {
  // usable = 749 - 0 - 500 = 249
  assert.throws(
    () => clampBashArgs({ command: 'ls' }, 749, 0),
    (error: unknown) => {
      assert.ok(error instanceof NoTimeLeftError);
      assert.equal((error as NoTimeLeftError).code, 'NO_TIME_LEFT');
      return true;
    },
  );
});

test('clampBashArgs does not mutate the caller args', () => {
  const args = { command: 'ls', timeout: 5_000 };
  clampBashArgs(args, FAR, 0);
  assert.equal(args.timeout, 5_000);
});

test('clampBashArgs coerces a numeric string and falls back on garbage', () => {
  assert.equal(clampBashArgs({ timeout: '5000' }, FAR, 0).timeout, 5_000);
  assert.equal(clampBashArgs({ timeout: 'soon' }, FAR, 0).timeout, 120_000);
});

test('parseBashResult maps a success payload to exitCode 0', () => {
  const res = textResult(
    JSON.stringify({
      stdout: 'hi\n',
      stderr: 'warn\n',
      interrupted: false,
      isImage: false,
      noOutputExpected: false,
    }),
  );
  assert.deepEqual(parseBashResult(res), {
    stdout: 'hi\n',
    stderr: 'warn\n',
    exitCode: 0,
    interrupted: false,
    isImage: false,
    noOutputExpected: false,
  });
});

test('parseBashResult keeps returnCodeInterpretation and sets exitCode null', () => {
  const res = textResult(
    JSON.stringify({
      stdout: '',
      stderr: '',
      interrupted: false,
      isImage: false,
      noOutputExpected: true,
      returnCodeInterpretation: 'No matches found',
    }),
  );
  const parsed = parseBashResult(res);
  assert.equal(parsed.exitCode, null);
  assert.equal(parsed.returnCodeInterpretation, 'No matches found');
  assert.equal(parsed.noOutputExpected, true);
});

test('parseBashResult reads a nonzero exit from Exit code N without throwing', () => {
  const text = 'Exit code 2\nboom\n';
  const parsed = parseBashResult(textResult(text, true));
  assert.deepEqual(parsed, { stdout: text, stderr: '', exitCode: 2 });
});

test('parseBashResult falls back to raw text when isError has no Exit code', () => {
  const text = 'permission denied';
  assert.deepEqual(parseBashResult(textResult(text, true)), {
    stdout: text,
    stderr: '',
    exitCode: null,
  });
});

test('parseBashResult falls back to raw text when the body is not JSON', () => {
  assert.deepEqual(parseBashResult(textResult('plain text')), {
    stdout: 'plain text',
    stderr: '',
    exitCode: null,
  });
});

test('parseBashResult passes interrupted and isImage through', () => {
  const res = textResult(
    JSON.stringify({
      stdout: 'aW1n',
      stderr: '',
      interrupted: true,
      isImage: true,
      noOutputExpected: false,
    }),
  );
  const parsed = parseBashResult(res);
  assert.equal(parsed.exitCode, 0);
  assert.equal(parsed.interrupted, true);
  assert.equal(parsed.isImage, true);
});

test('parseBashResult falls back on an empty result', () => {
  assert.deepEqual(parseBashResult({}), { stdout: '', stderr: '', exitCode: null });
});
