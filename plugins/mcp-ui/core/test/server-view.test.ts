import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildServerRows, maskValue, statusLabel } from '../src/server-view.ts';

test('masks plain secret values but keeps credential templates readable', () => {
  // Act & Assert
  assert.equal(maskValue('sk-live-123'), '••••••');
  assert.equal(maskValue('${credential:FS_TOKEN}'), '${credential:FS_TOKEN}');
  assert.equal(maskValue(''), '');
});

test('labels each connection state for display', () => {
  // Act & Assert
  assert.equal(statusLabel({ state: 'connected', toolCount: 3 } as never), '已连接 · 3 个工具');
  assert.equal(statusLabel({ state: 'connecting', attempt: 0 } as never), '连接中');
  assert.equal(statusLabel({ state: 'reconnecting', attempt: 2 } as never), '重连中（第 2 次）');
  assert.equal(statusLabel({ state: 'disabled' } as never), '已停用');
  assert.equal(statusLabel({ state: 'failed', reason: 'load', lastError: 'x' } as never), '加载失败');
  assert.equal(statusLabel({ state: 'failed', reason: 'cleanup' } as never), '清理失败，需重启 DSH');
  assert.equal(statusLabel({ state: 'failed', lastError: 'x' } as never), '连接失败');
  assert.equal(statusLabel({ state: 'waiting-credentials', lastError: 'x' } as never), '等待凭据');
  assert.equal(statusLabel({ state: 'closed' } as never), '已关闭');
});

test('merges configured entries with live views and keeps configured servers without a view', () => {
  // Arrange
  const entries = {
    git: { transport: 'stdio', enabled: true },
    fs: { transport: 'stdio', enabled: false },
  };
  const views = [
    { name: 'git', configured: true, status: { state: 'connected', toolCount: 4 } },
    { name: 'ghost', configured: false, status: { state: 'failed', reason: 'cleanup' } },
  ];

  // Act
  const rows = buildServerRows(entries as never, views as never);

  // Assert
  assert.deepEqual(rows.map(row => [row.name, row.configured, row.label]), [
    ['fs', true, '已停用'],
    ['git', true, '已连接 · 4 个工具'],
    ['ghost', false, '清理失败，需重启 DSH'],
  ]);
});

test('maps each live state to a display tone', async () => {
  // Arrange
  const { statusTone } = await import('../src/server-view.ts');

  // Act & Assert
  assert.equal(statusTone('connected'), 'ok');
  assert.equal(statusTone('connecting'), 'warn');
  assert.equal(statusTone('reconnecting'), 'warn');
  assert.equal(statusTone('waiting-credentials'), 'warn');
  assert.equal(statusTone('failed'), 'error');
  assert.equal(statusTone('disabled'), 'idle');
  assert.equal(statusTone('closed'), 'idle');
  assert.equal(statusTone(undefined), 'idle');
  assert.equal(statusTone('something-new'), 'idle');
});
