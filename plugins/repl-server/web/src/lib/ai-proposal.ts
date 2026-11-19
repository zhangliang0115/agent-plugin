/** Pure helpers for the AI "one sentence → MCP server config" drawer.
 *
 * The draft returned by `POST /ai/propose` is only a suggestion: the drawer edits
 * it and resubmits it to `POST /ai/propose/apply`, so the conversion back to the
 * wire shape lives here and stays free of React.
 * @module
 */

import { formatNumber } from './format.ts';

/** Mirrors `AI_INPUT_MAX_BYTES` in `server/src/ai/constants.ts`. */
export const AI_INPUT_MAX_BYTES = 16_384;

export type ProposalArg = string | { $secret: string };

/** `ProposalServer` in `server/src/ai/validate.ts`. */
export interface ProposalServerDraft {
  id: string;
  label: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: ProposalArg[];
  cwd: string | null;
  url: string | null;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  connectMode: 'lazy' | 'eager';
  tags: string[];
  category: string | null;
  summary: string | null;
}

/** Editable subset of `POST /ai/propose` shown to the user. */
export interface ProposalResponse {
  proposalId: string | null;
  server: ProposalServerDraft | null;
  explanation: string;
  warnings: string[];
  idConflict: boolean;
  inputWarning?: boolean;
}

/** Draft form values; text fields mirror the manual server form. */
export interface ProposalDraftValues {
  id: string;
  label?: string;
  transport: 'stdio' | 'http';
  command?: string;
  args?: string;
  cwd?: string;
  url?: string;
  envKeys?: string;
  headerKeys?: string;
  enabled: boolean;
  connectMode: 'lazy' | 'eager';
  category?: string;
  tags?: string[];
  summary?: string;
}

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Local pre-check mirroring `readProposeInput`; returns a user-facing problem. */
export function proposalInputError(value: string): string | null {
  if (value.trim() === '') return '输入不能为空。';
  const bytes = utf8ByteLength(value);
  if (bytes > AI_INPUT_MAX_BYTES) {
    return `输入为 ${formatNumber(bytes)} 字节，超过上限 ${formatNumber(AI_INPUT_MAX_BYTES)} 字节。`;
  }
  return null;
}

/** Renders `$secret` args back into the `<secret:NAME>` editing syntax. */
export function argsForEditing(args: readonly ProposalArg[]): string {
  return args.map((arg) => (typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`)).join('\n');
}

export function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export function parseArgs(value: string | undefined): ProposalArg[] {
  return splitList(value).map((line) => {
    const match = /^<secret:(.+)>$/.exec(line);
    return match === null || match[1] === undefined || match[1] === ''
      ? line
      : { $secret: match[1] };
  });
}

export function nullIfEmpty(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/** Wire body for `POST /ai/propose/apply`, with the edited draft in full. */
export function buildProposalApplyBody(
  proposalId: string,
  values: ProposalDraftValues,
): Record<string, unknown> {
  const id = values.id.trim();
  const label = (values.label ?? '').trim();
  const stdio = values.transport === 'stdio';
  const body: Record<string, unknown> = {
    proposalId,
    server: {
      id,
      label: label === '' ? id : label,
      transport: values.transport,
      command: stdio ? nullIfEmpty(values.command) : null,
      args: stdio ? parseArgs(values.args) : [],
      cwd: stdio ? nullIfEmpty(values.cwd) : null,
      url: stdio ? null : nullIfEmpty(values.url),
      envKeys: splitList(values.envKeys),
      headerKeys: splitList(values.headerKeys),
      enabled: values.enabled,
      connectMode: values.connectMode,
      category: nullIfEmpty(values.category),
      tags: values.tags ?? [],
      summary: nullIfEmpty(values.summary),
    },
  };
  // stdio executes an arbitrary command; the backend rejects the apply without it.
  if (stdio) body['confirmStdio'] = true;
  return body;
}
