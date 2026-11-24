import assert from 'node:assert/strict';
import test from 'node:test';

import {
  argsSummary,
  isRunScriptParamsPreview,
  mergeScriptInfo,
  scriptCodeFromParams,
  scriptCodeFromRequest,
  scriptInfoFromEvent,
  scriptInfoFromEvents,
  scriptInfoFromRequest,
} from '../src/lib/script-info.ts';

const toolCall = (name: string, args: Record<string, unknown>) => ({
  event: 'proto_in',
  params: { name, arguments: args },
});

test('scriptInfoFromRequest tells code runs from script runs', () => {
  assert.deepEqual(scriptInfoFromRequest(toolCall('run_script', { code: 'return 1' })), {
    entryMode: 'code',
    scriptId: null,
    scriptName: null,
    scriptVersion: null,
    scriptMode: null,
    argsPreview: null,
  });
  assert.deepEqual(
    scriptInfoFromRequest(
      toolCall('run_script', { scriptId: 's_1', scriptVersion: 2, args: { x: 1 } }),
    ),
    {
      entryMode: 'script',
      scriptId: 's_1',
      scriptName: null,
      scriptVersion: 2,
      scriptMode: null,
      argsPreview: '{"x":1}',
    },
  );
  assert.equal(scriptInfoFromRequest(toolCall('search_tools', {})), null);
  assert.equal(scriptInfoFromRequest({ event: 'proto_in' }), null);
});

test('scriptInfoFromEvent reads the entry fields and the args prefix', () => {
  assert.deepEqual(
    scriptInfoFromEvent({
      event: 'eval_start',
      entryMode: 'script',
      scriptId: 's_1',
      scriptVersion: 3,
      scriptMode: 'parameterized',
      argsPrefix: '{"q":"x"}',
    }),
    {
      entryMode: 'script',
      scriptId: 's_1',
      scriptName: null,
      scriptVersion: 3,
      scriptMode: 'parameterized',
      argsPreview: '{"q":"x"}',
    },
  );
  assert.equal(scriptInfoFromEvent({ event: 'eval_start' }), null);
  assert.equal(scriptInfoFromEvent({ event: 'tool_call', argsPreview: '{}' }), null);
  assert.deepEqual(
    scriptInfoFromEvent({
      event: 'eval_start',
      entryMode: 'script',
      scriptId: 's_2',
      secretWarnings: [{ field: 'args', kind: 'provider_token', severity: 'high', count: 1 }],
    })?.secretWarnings,
    [{ field: 'args', kind: 'provider_token', severity: 'high', count: 1 }],
  );
  assert.equal(
    scriptInfoFromEvent({ event: 'eval_start', entryMode: 'code' })?.secretWarnings,
    undefined,
    'no warnings key on a clean event',
  );
});

test('script_saved auditing reads the warnings fallback', () => {
  const warning = { field: 'code', kind: 'provider_token', severity: 'high', count: 1 };
  const saved = scriptInfoFromEvent({
    event: 'script_saved',
    ok: true,
    scriptId: 's_saved',
    version: 2,
    mode: 'parameterized',
    warnings: [warning],
  });
  assert.equal(saved?.scriptId, 's_saved');
  assert.equal(saved?.entryMode, null);
  assert.deepEqual(saved?.secretWarnings, [warning]);

  const preferred = scriptInfoFromEvent({
    event: 'script_saved',
    scriptId: 's_saved',
    secretWarnings: [{ field: 'args', kind: 'jwt', severity: 'high', count: 2 }],
    warnings: [warning],
  });
  assert.deepEqual(preferred?.secretWarnings, [{ field: 'args', kind: 'jwt', severity: 'high', count: 2 }]);
});

test('scriptInfoFromEvents prefers the event carrying a scriptId', () => {
  const events = [
    { event: 'eval_start', entryMode: 'code' },
    { event: 'tool_call', entryMode: 'script', scriptId: 's_2', scriptVersion: 1 },
  ];
  assert.equal(scriptInfoFromEvents(events)?.scriptId, 's_2');
  assert.equal(scriptInfoFromEvents([{ event: 'eval_start', entryMode: 'code' }])?.entryMode, 'code');
  assert.equal(scriptInfoFromEvents([]), null);
});

test('mergeScriptInfo fills fields from later sources without overwriting', () => {
  const merged = mergeScriptInfo(
    {
      entryMode: 'script',
      scriptId: 's_1',
      scriptName: null,
      scriptVersion: null,
      scriptMode: null,
      argsPreview: null,
    },
    {
      entryMode: 'script',
      scriptId: 's_1',
      scriptName: 'demo',
      scriptVersion: 4,
      scriptMode: 'exact',
      argsPreview: '{"a":1}',
    },
  );
  assert.equal(merged?.scriptName, 'demo');
  assert.equal(merged?.scriptVersion, 4);
  assert.equal(merged?.scriptMode, 'exact');
  assert.equal(merged?.argsPreview, '{"a":1}');
  assert.equal(mergeScriptInfo(null, undefined), null);
});

test('scriptCodeFromParams reads only the inline code of a run_script call', () => {
  const params = { name: 'run_script', arguments: { code: 'return 1;\n' } };
  assert.equal(scriptCodeFromParams(params), 'return 1;\n');
  assert.equal(scriptCodeFromRequest({ params }), 'return 1;\n');
  assert.equal(scriptCodeFromParams({ name: 'run_script', arguments: { scriptId: 's_1' } }), null);
  assert.equal(scriptCodeFromParams({ name: 'run_script', arguments: { code: '' } }), null);
  assert.equal(scriptCodeFromParams({ name: 'run_script', arguments: 'code' }), null);
  assert.equal(scriptCodeFromParams({ name: 'search_tools', arguments: { code: 'x' } }), null);
  assert.equal(scriptCodeFromParams(null), null);
  assert.equal(scriptCodeFromRequest(null), null);
  assert.equal(scriptCodeFromRequest({}), null);
  assert.equal(scriptCodeFromRequest({ params: null }), null);
});

test('isRunScriptParamsPreview gates the external params card', () => {
  assert.equal(isRunScriptParamsPreview('{"name":"run_script","arguments":{'), true);
  assert.equal(isRunScriptParamsPreview('{"name": "run_script", "arguments": {}}'), true);
  assert.equal(isRunScriptParamsPreview('{"name":"search_tools","arguments":{}}'), false);
  assert.equal(isRunScriptParamsPreview('{"name":"run_script_extra","arguments":{}}'), false);
  assert.equal(isRunScriptParamsPreview('{"name":"run_scr'), false);
  assert.equal(isRunScriptParamsPreview(''), false);
  assert.equal(isRunScriptParamsPreview('   '), false);
  assert.equal(isRunScriptParamsPreview(null), false);
  assert.equal(isRunScriptParamsPreview(undefined), false);
  assert.equal(isRunScriptParamsPreview({ name: 'run_script' }), false);
});

test('argsSummary truncates long values', () => {
  assert.equal(argsSummary({ a: 1 }), '{"a":1}');
  assert.equal(argsSummary(undefined), null);
  assert.equal(argsSummary({ text: 'x'.repeat(20) }, 10)?.endsWith('…'), true);
});
