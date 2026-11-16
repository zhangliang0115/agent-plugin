import { test } from 'node:test';
import assert from 'node:assert/strict';

import { watchTools, type ToolsSource } from '../src/tools-watch.ts';

interface FakeSource extends ToolsSource {
  setServers(names: string[]): void;
  setDefinitions(names: string[]): void;
  emit(): void;
  listenerCount(): number;
}

function fakeSource(): FakeSource {
  let servers: string[] = ['fs'];
  let definitions: string[] = [];
  const listeners = new Set<() => void>();
  return {
    list: () => servers.map(name => ({ name, configured: true, status: { state: 'connected', toolCount: 1 } })),
    definitions: () => definitions.map(name => ({ name, description: 'd' })),
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setServers(names) { servers = names; },
    setDefinitions(names) { definitions = names; },
    emit() { for (const listener of [...listeners]) listener(); },
    listenerCount: () => listeners.size,
  };
}

async function take<T>(iterator: AsyncIterator<T>, count: number): Promise<T[]> {
  const values: T[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = await iterator.next();
    if (next.done === true) break;
    values.push(next.value);
  }
  return values;
}

test('yields the current list first, reflecting the tools registered for each server', async () => {
  // Arrange
  const source = fakeSource();
  source.setDefinitions(['mcp__fs__read']);
  const controller = new AbortController();
  const stream = watchTools(source, controller.signal, 1)[Symbol.asyncIterator]();

  // Act
  const [first] = await take(stream, 1);
  controller.abort();

  // Assert
  assert.deepEqual(first?.[0]?.tools.map(tool => tool.rawName), ['read']);
});

test('coalesces a burst of changes into one further list', async () => {
  // Arrange
  const source = fakeSource();
  const controller = new AbortController();
  const stream = watchTools(source, controller.signal, 5)[Symbol.asyncIterator]();
  await take(stream, 1);

  // Act
  source.setDefinitions(['mcp__fs__a']);
  source.emit();
  source.setDefinitions(['mcp__fs__a', 'mcp__fs__b']);
  source.emit();
  source.emit();
  const [next] = await take(stream, 1);
  controller.abort();

  // Assert
  assert.deepEqual(next?.[0]?.tools.map(tool => tool.rawName), ['a', 'b']);
});

test('pushes a new list when a server changes status', async () => {
  // Arrange
  const source = fakeSource();
  const controller = new AbortController();
  const stream = watchTools(source, controller.signal, 1)[Symbol.asyncIterator]();
  await take(stream, 1);

  // Act
  source.setServers(['fs', 'echo']);
  source.emit();
  const [next] = await take(stream, 1);
  controller.abort();

  // Assert
  assert.deepEqual(next?.map(server => server.name), ['fs', 'echo']);
});

test('stops the stream and withdraws its listener when the signal aborts', async () => {
  // Arrange
  const source = fakeSource();
  const controller = new AbortController();
  const stream = watchTools(source, controller.signal, 1)[Symbol.asyncIterator]();
  await take(stream, 1);

  // Act
  controller.abort();
  const after = await stream.next();

  // Assert
  assert.equal(after.done, true);
  assert.equal(source.listenerCount(), 0);
});
