import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createToolsSource, type HostLike } from '../src/tools-source.ts';

function fakeHost(parts: { manager?: boolean; tools?: boolean } = { manager: true, tools: true }): HostLike & { fire(event: string): void; subscriptions(): number } {
  const handlers = new Map<string, Set<() => void>>();
  return {
    get(name: string): unknown {
      if (name === 'mcpManager' && parts.manager) return { list: () => [{ name: 'fs', configured: true, status: { state: 'connected', toolCount: 1 } }] };
      if (name === 'tools' && parts.tools) return { definitions: () => [{ name: 'mcp__fs__read', description: 'Read a file' }] };
      return undefined;
    },
    on(event: string, handler: () => void): () => void {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => { set.delete(handler); };
    },
    fire(event: string): void { for (const handler of [...(handlers.get(event) ?? [])]) handler(); },
    subscriptions: () => [...handlers.values()].reduce((sum, set) => sum + set.size, 0),
  };
}

test('reads servers from the manager and tools from the registry', () => {
  // Arrange
  const source = createToolsSource(fakeHost());

  // Act & Assert
  assert.deepEqual(source.list().map(view => view.name), ['fs']);
  assert.deepEqual(source.definitions().map(tool => tool.description), ['Read a file']);
});

test('reports nothing instead of throwing when the manager or the registry is absent', () => {
  // Arrange
  const source = createToolsSource(fakeHost({ manager: false, tools: false }));

  // Act & Assert
  assert.deepEqual(source.list(), []);
  assert.deepEqual(source.definitions(), []);
});

test('a manager status event and a tool change event both notify, and unsubscribing removes both', () => {
  // Arrange
  const host = fakeHost();
  const source = createToolsSource(host);
  let calls = 0;

  // Act
  const off = source.onChange(() => { calls += 1; });
  host.fire('mcp-manager/status');
  host.fire('tools/change');
  const during = host.subscriptions();
  off();

  // Assert
  assert.equal(calls, 2);
  assert.equal(during, 2);
  assert.equal(host.subscriptions(), 0);
});

test('a failing registry read yields an empty tool list rather than breaking the stream', () => {
  // Arrange
  const host = fakeHost();
  const broken: HostLike = { ...host, get: (name: string) => (name === 'tools' ? { definitions: () => { throw new Error('boom'); } } : host.get(name)) };

  // Act & Assert
  assert.deepEqual(createToolsSource(broken).definitions(), []);
});
