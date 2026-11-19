import assert from 'node:assert/strict';
import test from 'node:test';

import {
  clientLabel,
  MAX_CLIENT_NAME_LENGTH,
  MAX_CLIENT_VERSION_LENGTH,
  parseClientInfo,
  splitClientLabel,
} from '../src/client-info.ts';

test('parseClientInfo reads modern _meta clientInfo', () => {
  const parsed = parseClientInfo({
    params: {
      _meta: {
        'io.modelcontextprotocol/clientInfo': { name: 'claude-code', version: '2.1.327' },
      },
    },
  });
  assert.deepEqual(parsed, {
    name: 'claude-code',
    version: '2.1.327',
    label: 'claude-code/2.1.327',
  });
});

test('parseClientInfo falls back to legacy params.clientInfo and allows a missing version', () => {
  const parsed = parseClientInfo({ params: { clientInfo: { name: 'probe' } } });
  assert.deepEqual(parsed, { name: 'probe', version: '', label: 'probe' });

  assert.deepEqual(parseClientInfo({ params: { clientInfo: { name: 'probe', version: '' } } }), {
    name: 'probe',
    version: '',
    label: 'probe',
  });
});

test('parseClientInfo ignores malformed input', () => {
  assert.deepEqual(parseClientInfo(null), { name: '', version: '', label: '' });
  assert.deepEqual(parseClientInfo({}), { name: '', version: '', label: '' });
  assert.deepEqual(parseClientInfo({ params: { clientInfo: { name: 42, version: '1' } } }), {
    name: '',
    version: '',
    label: '',
  });
  assert.deepEqual(parseClientInfo({ params: { clientInfo: { name: '   ', version: '1' } } }), {
    name: '',
    version: '',
    label: '',
  });
});

test('parseClientInfo trims, strips control characters and truncates long values', () => {
  const parsed = parseClientInfo({
    params: {
      clientInfo: {
        name: `  claude\ncode\u0000  `,
        version: ` 1.2.3\t `,
      },
    },
  });
  assert.deepEqual(parsed, { name: 'claudecode', version: '1.2.3', label: 'claudecode/1.2.3' });

  const long = parseClientInfo({
    params: {
      clientInfo: { name: 'n'.repeat(MAX_CLIENT_NAME_LENGTH + 50), version: 'v'.repeat(MAX_CLIENT_VERSION_LENGTH + 50) },
    },
  });
  assert.equal(long.name.length, MAX_CLIENT_NAME_LENGTH);
  assert.equal(long.version.length, MAX_CLIENT_VERSION_LENGTH);
});

test('parseClientInfo keeps special characters inside the name and version', () => {
  const parsed = parseClientInfo({
    params: { clientInfo: { name: 'my client (dev)', version: '1.0.0-beta+meta' } },
  });
  assert.equal(parsed.name, 'my client (dev)');
  assert.equal(parsed.version, '1.0.0-beta+meta');
  assert.equal(parsed.label, 'my client (dev)/1.0.0-beta+meta');
});

test('splitClientLabel splits at the first slash and tolerates missing parts', () => {
  assert.deepEqual(splitClientLabel('claude-code/2.1.327'), {
    name: 'claude-code',
    version: '2.1.327',
  });
  assert.deepEqual(splitClientLabel('probe'), { name: 'probe', version: '' });
  assert.deepEqual(splitClientLabel('name/1/2'), { name: 'name', version: '1/2' });
  assert.deepEqual(splitClientLabel('/leading'), { name: '/leading', version: '' });
  assert.deepEqual(splitClientLabel(''), { name: '', version: '' });
});

test('clientLabel joins only when a version exists', () => {
  assert.equal(clientLabel('probe', ''), 'probe');
  assert.equal(clientLabel('probe', '1.0'), 'probe/1.0');
});
