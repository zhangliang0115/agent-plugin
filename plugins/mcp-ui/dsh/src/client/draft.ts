/**
 * The add/edit server form as the user types it: text fields in, a validated
 * form or a list of Chinese messages out. Pure, so the page's state logic runs under node:test. @module
 */
import {
  buildServerEntry,
  formatKeyValueLines,
  parseKeyValueLines,
  parseLines,
  validateServerEntry,
  type ServerEntry,
  type ServerForm,
  type ServerTransport,
} from '@zhangliang0115/mcp-ui-core';

/** Text fields of the form. Numbers stay as text until validation. */
export interface ServerDraft {
  readonly name: string;
  readonly transport: ServerTransport;
  readonly command: string;
  readonly argsText: string;
  readonly envText: string;
  readonly cwd: string;
  readonly url: string;
  readonly headersText: string;
  readonly enabled: boolean;
  readonly startupText: string;
  readonly toolCallText: string;
  readonly closeText: string;
}

/** Manager default for the startup budget, in milliseconds. */
const DEFAULT_STARTUP_MS = '30000';

/** A new stdio server with no values set. */
export function emptyDraft(): ServerDraft {
  return {
    name: '',
    transport: 'stdio',
    command: '',
    argsText: '',
    envText: '',
    cwd: '',
    url: '',
    headersText: '',
    enabled: true,
    startupText: DEFAULT_STARTUP_MS,
    toolCallText: '',
    closeText: '',
  };
}

/** Parse optional numeric text: blank means unset, anything else is read as a number. */
function optionalNumber(text: string): number | undefined {
  return text.trim() === '' ? undefined : Number(text.trim());
}

/**
 * Turn the draft into a form. Problems from every field are collected, so one
 * attempt reports them all.
 * @param draft - the text fields.
 */
export function draftToForm(draft: ServerDraft): { ok: true; form: ServerForm } | { ok: false; errors: string[] } {
  const env = parseKeyValueLines(draft.envText);
  const headers = parseKeyValueLines(draft.headersText);
  const toolCallTimeoutMs = optionalNumber(draft.toolCallText);
  const closeTimeoutMs = optionalNumber(draft.closeText);
  const form: ServerForm = {
    name: draft.name.trim(),
    transport: draft.transport,
    command: draft.command.trim(),
    args: parseLines(draft.argsText),
    env: env.value,
    cwd: draft.cwd.trim(),
    url: draft.url.trim(),
    headers: headers.value,
    enabled: draft.enabled,
    startupTimeoutMs: Number(draft.startupText.trim()),
    ...toolCallTimeoutMs === undefined ? {} : { toolCallTimeoutMs },
    ...closeTimeoutMs === undefined ? {} : { closeTimeoutMs },
  };
  const errors = [...env.errors, ...headers.errors, ...validateServerEntry(form)];
  return errors.length === 0 ? { ok: true, form } : { ok: false, errors };
}

/**
 * The stored entry for a valid draft.
 * @param form - a form that passed {@link draftToForm}.
 */
export function entryForForm(form: ServerForm): ServerEntry {
  return buildServerEntry(form);
}

/**
 * Load a stored entry into editable text.
 * @param name - the server key, kept as the draft name.
 * @param entry - the stored entry.
 */
export function draftFromEntry(name: string, entry: ServerEntry): ServerDraft {
  return {
    name,
    transport: entry.transport,
    command: entry.command,
    argsText: entry.args.join('\n'),
    envText: formatKeyValueLines(entry.env),
    cwd: entry.cwd,
    url: entry.url,
    headersText: formatKeyValueLines(entry.headers),
    enabled: entry.enabled,
    startupText: String(entry.startupTimeoutMs),
    toolCallText: entry.toolCallTimeoutMs === undefined ? '' : String(entry.toolCallTimeoutMs),
    closeText: entry.closeTimeoutMs === undefined ? '' : String(entry.closeTimeoutMs),
  };
}
