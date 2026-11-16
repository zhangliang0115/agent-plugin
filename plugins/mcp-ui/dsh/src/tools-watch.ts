/**
 * The stream behind the page: the full list of servers with their tools, pushed first when a
 * client subscribes and again after every change in manager status or in the registered tools.
 * Pure of DSH imports so it can be tested with a fake source. @module
 */
import { joinServerTools, type ServerToolsView, type ServerViewLike, type ToolDefinitionLike } from '@zhangliang0115/mcp-ui-core';

/** What the stream reads from the host. */
export interface ToolsSource {
  list(): readonly ServerViewLike[];
  definitions(): readonly ToolDefinitionLike[];
  /** Subscribe to "something changed". Returns the unsubscribe function. */
  onChange(listener: () => void): () => void;
}

/** Wait this long after a change before pushing, so a burst of changes becomes one list. */
export const COALESCE_MS = 50;

const snapshot = (source: ToolsSource): ServerToolsView[] => joinServerTools(source.list(), source.definitions());

/**
 * @param source - the host side.
 * @param signal - ends the stream and removes the listener.
 * @param coalesceMs - quiet time after a change before the next list is pushed.
 */
export async function* watchTools(
  source: ToolsSource,
  signal: AbortSignal,
  coalesceMs: number = COALESCE_MS,
): AsyncGenerator<ServerToolsView[]> {
  let wake: (() => void) | undefined;
  let changed = false;
  const off = source.onChange(() => {
    changed = true;
    wake?.();
  });
  const onAbort = (): void => wake?.();
  signal.addEventListener('abort', onAbort);
  try {
    yield snapshot(source);
    while (!signal.aborted) {
      if (!changed) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      if (signal.aborted) break;
      // Let a burst settle, then push once.
      await new Promise<void>((resolve) => setTimeout(resolve, coalesceMs));
      if (signal.aborted) break;
      changed = false;
      yield snapshot(source);
    }
  } finally {
    off();
    signal.removeEventListener('abort', onAbort);
  }
}
