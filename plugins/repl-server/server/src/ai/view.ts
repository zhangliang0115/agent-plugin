/** Admin-facing rendering of a server record without secret values (08 §3.5). @module */

import type { ServerRecord, ServerView } from '../admin/servers.ts';

function renderArg(arg: ServerRecord['args'][number]): string {
  return typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`;
}

/**
 * Mirrors `viewServer` for the AI routes: args keep `$secret` placeholders and
 * env/header values become key lists. Runtime state is not available here, so
 * the same fallback as the admin view is used.
 */
export function renderServerView(record: ServerRecord): ServerView {
  const fallback = record.enabled
    ? record.transport === 'builtin'
      ? 'ready'
      : 'idle'
    : 'disabled';
  return {
    id: record.id,
    label: record.label,
    transport: record.transport,
    command: record.command,
    args: record.args.map(renderArg),
    cwd: record.cwd,
    url: record.url,
    envKeys: Object.keys(record.env).sort(),
    headerKeys: Object.keys(record.headers).sort(),
    enabled: record.enabled,
    connectMode: record.connectMode,
    summary: record.summary,
    summarySource: record.summarySource,
    category: record.category,
    tags: [...record.tags],
    timeoutMs: record.timeoutMs,
    maxConcurrency: record.maxConcurrency,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    revision: record.revision,
    state: fallback,
  };
}
