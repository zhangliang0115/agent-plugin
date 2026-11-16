import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServerEntry, validateServerEntry, type ServerForm } from '../src/server-entry.ts';

const STDIO_FORM: ServerForm = {
  name: 'fs',
  transport: 'stdio',
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
  env: { TOKEN: '${credential:FS_TOKEN}' },
  cwd: '',
  url: '',
  headers: {},
  enabled: true,
  startupTimeoutMs: 30000,
};

const HTTP_FORM: ServerForm = {
  name: 'remote',
  transport: 'streamable-http',
  command: '',
  args: [],
  env: {},
  cwd: '',
  url: 'https://mcp.example.com/mcp',
  headers: { Authorization: 'Bearer ${credential:MCP_TOKEN}' },
  enabled: true,
  startupTimeoutMs: 30000,
};

test('accepts a valid stdio form', () => {
  // Act & Assert
  assert.deepEqual(validateServerEntry(STDIO_FORM), []);
});

test('accepts a valid streamable-http form', () => {
  // Act & Assert
  assert.deepEqual(validateServerEntry(HTTP_FORM), []);
});

test('rejects a server name outside the manager pattern', () => {
  // Act & Assert
  assert.match(validateServerEntry({ ...STDIO_FORM, name: 'bad name' }).join('\n'), /服务器名/);
  assert.match(validateServerEntry({ ...STDIO_FORM, name: 'a'.repeat(33) }).join('\n'), /服务器名/);
  assert.deepEqual(validateServerEntry({ ...STDIO_FORM, name: 'a'.repeat(32) }), []);
});

test('rejects a double underscore in the server name', () => {
  // Arrange: `mcp__fs__*` would also match the tools of a server named `fs__x`.
  // Act & Assert
  assert.match(validateServerEntry({ ...STDIO_FORM, name: 'fs__x' }).join('\n'), /双下划线/);
});

test('requires a command for stdio and rejects http-only fields on stdio', () => {
  // Act
  const missing = validateServerEntry({ ...STDIO_FORM, command: '' });
  const mixed = validateServerEntry({ ...STDIO_FORM, url: 'https://x.test/mcp' });

  // Assert
  assert.match(missing.join('\n'), /command/);
  assert.match(mixed.join('\n'), /url/);
});

test('requires a url for streamable-http and rejects stdio-only fields on it', () => {
  // Act
  const missing = validateServerEntry({ ...HTTP_FORM, url: '' });
  const mixed = validateServerEntry({ ...HTTP_FORM, command: 'node' });

  // Assert
  assert.match(missing.join('\n'), /url/);
  assert.match(mixed.join('\n'), /command/);
});

test('accepts only well-formed credential templates in templated fields', () => {
  // Act
  const bad = validateServerEntry({ ...STDIO_FORM, env: { TOKEN: '${FS_TOKEN}' } });
  const badRef = validateServerEntry({ ...STDIO_FORM, env: { TOKEN: '${credential:bad-ref}' } });

  // Assert
  assert.match(bad.join('\n'), /模板/);
  assert.match(badRef.join('\n'), /模板/);
  assert.deepEqual(validateServerEntry({ ...STDIO_FORM, env: { TOKEN: '${credential:FS_TOKEN}' } }), []);
});

test('bounds the startup timeout to the timer range', () => {
  // Act & Assert
  assert.match(validateServerEntry({ ...HTTP_FORM, startupTimeoutMs: 0 }).join('\n'), /启动超时/);
  assert.match(validateServerEntry({ ...HTTP_FORM, startupTimeoutMs: 2147483648 }).join('\n'), /启动超时/);
});

test('builds a stored entry with the transport fields it owns and no undefined keys', () => {
  // Act
  const entry = buildServerEntry(STDIO_FORM);

  // Assert
  assert.deepEqual(entry, {
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
    env: { TOKEN: '${credential:FS_TOKEN}' },
    cwd: '',
    url: '',
    headers: {},
    enabled: true,
    startupTimeoutMs: 30000,
  });
  assert.equal('toolCallTimeoutMs' in entry, false);
});

test('builds an http entry without stdio fields', () => {
  // Act
  const entry = buildServerEntry({ ...HTTP_FORM, toolCallTimeoutMs: 60000, closeTimeoutMs: 5000 });

  // Assert
  assert.equal(entry.transport, 'streamable-http');
  assert.equal(entry.command, '');
  assert.deepEqual(entry.args, []);
  assert.equal(entry.toolCallTimeoutMs, 60000);
  assert.equal(entry.closeTimeoutMs, 5000);
});
