import assert from 'node:assert/strict';
import test from 'node:test';

import { creatorLabel, creatorNamesFromClients } from '../src/lib/creator-name.ts';

const payload = {
  clients: [
    { id: 'cb_1', label: 'claude code' },
    { id: 'cb_2', label: '' },
  ],
  sessions: [
    { mcpSessionId: 'mcp_1', clientName: 'kiro', client: 'kiro' },
    { mcpSessionId: 'mcp_2', clientName: '', client: 'cursor' },
  ],
};

test('creatorNamesFromClients maps binding labels and session client names', () => {
  const names = creatorNamesFromClients(payload);
  assert.equal(names.get('cb_1'), 'claude code');
  assert.equal(names.get('cb_2'), undefined);
  assert.equal(names.get('mcp_1'), 'kiro');
  assert.equal(names.get('mcp_2'), 'cursor');
});

test('creatorNamesFromClients tolerates malformed payloads', () => {
  assert.equal(creatorNamesFromClients(null).size, 0);
  assert.equal(creatorNamesFromClients({ clients: 'bad', sessions: [null] }).size, 0);
});

test('creatorLabel prefers names and never shows the raw id', () => {
  const names = creatorNamesFromClients(payload);
  assert.equal(creatorLabel('cb_1', names), 'claude code');
  assert.equal(creatorLabel('mcp_1', names), 'kiro');
  assert.equal(creatorLabel('admin', names), '管理端');
  assert.equal(creatorLabel('cb_missing', names), '未知客户端');
  assert.equal(creatorLabel('', names), null);
  assert.equal(creatorLabel(null, names), null);
});
