import { test } from 'node:test';
import assert from 'node:assert/strict';

import { draftFromEntry, draftToForm, emptyDraft } from '../src/client/draft.ts';

test('an empty draft is a stdio server with the manager default startup budget', () => {
  // Act
  const draft = emptyDraft();

  // Assert
  assert.equal(draft.transport, 'stdio');
  assert.equal(draft.startupText, '30000');
  assert.equal(draft.enabled, true);
});

test('converts a complete stdio draft into a valid form', () => {
  // Arrange
  const draft = {
    ...emptyDraft(),
    name: 'fs',
    command: 'npx',
    argsText: '-y\n@scope/fs\n/tmp',
    envText: 'TOKEN=${credential:FS_TOKEN}',
  };

  // Act
  const result = draftToForm(draft);

  // Assert
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.form.args, ['-y', '@scope/fs', '/tmp']);
  assert.deepEqual(result.form.env, { TOKEN: '${credential:FS_TOKEN}' });
  assert.equal(result.form.toolCallTimeoutMs, undefined);
});

test('collects env and timeout problems in one list', () => {
  // Arrange
  const draft = { ...emptyDraft(), name: 'bad name', command: '', envText: 'NOEQUALS', startupText: 'abc' };

  // Act
  const result = draftToForm(draft);

  // Assert
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.errors.join('\n'), /服务器名/);
  assert.match(result.errors.join('\n'), /command/);
  assert.match(result.errors.join('\n'), /KEY=VALUE/);
  assert.match(result.errors.join('\n'), /启动超时/);
});

test('reads an empty tool-call timeout as unset and a number as milliseconds', () => {
  // Act
  const unset = draftToForm({ ...emptyDraft(), name: 'fs', command: 'npx', toolCallText: '' });
  const set = draftToForm({ ...emptyDraft(), name: 'fs', command: 'npx', toolCallText: '60000' });

  // Assert
  assert.equal(unset.ok && unset.form.toolCallTimeoutMs, undefined);
  assert.equal(set.ok && set.form.toolCallTimeoutMs, 60000);
});

test('turns a stored entry back into editable text, sorted by key', () => {
  // Arrange
  const entry = {
    transport: 'streamable-http' as const,
    command: '',
    args: [],
    env: {},
    cwd: '',
    url: 'https://mcp.example.com/mcp',
    headers: { Authorization: 'Bearer ${credential:MCP_TOKEN}', Accept: 'text/event-stream' },
    enabled: false,
    startupTimeoutMs: 15000,
    closeTimeoutMs: 5000,
  };

  // Act
  const draft = draftFromEntry('remote', entry);

  // Assert
  assert.equal(draft.name, 'remote');
  assert.equal(draft.transport, 'streamable-http');
  assert.equal(draft.headersText, 'Accept=text/event-stream\nAuthorization=Bearer ${credential:MCP_TOKEN}');
  assert.equal(draft.startupText, '15000');
  assert.equal(draft.toolCallText, '');
  assert.equal(draft.closeText, '5000');
  assert.equal(draft.enabled, false);
});
