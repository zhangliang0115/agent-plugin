/** Admin-facing rendering of a server record without secret values (08 §3.5). @module */

import type { SecretValue, ServerRecord, ServerView } from '../admin/servers.ts';
import { isSecretRef } from '../secrets/resolve.ts';

function renderArg(arg: ServerRecord['args'][number]): string {
  return typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`;
}

function secretRefs(values: Record<string, SecretValue>): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (isSecretRef(value)) refs[key] = value.$secret;
  }
  return refs;
}

function literalValues(values: Record<string, SecretValue>): Record<string, string> {
  const literals: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string') literals[key] = value;
  }
  return literals;
}

/**
 * Mirrors `viewServer` for the AI routes: args keep `$secret` placeholders,
 * secret env/header values become key lists, literals stay readable as plain
 * config. Runtime state is not available here, so the same fallback as the
 * admin view is used.
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
    envSecrets: secretRefs(record.env),
    headerSecrets: secretRefs(record.headers),
    envLiterals: literalValues(record.env),
    headerLiterals: literalValues(record.headers),
    secretArgs: record.args.flatMap((arg, index) =>
      isSecretRef(arg) ? [{ index, secret: arg.$secret }] : [],
    ),
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
