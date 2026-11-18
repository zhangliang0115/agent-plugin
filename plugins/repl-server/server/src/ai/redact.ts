/**
 * AI-text redaction shared by the runner and the validators.
 *
 * The core audit redactor strips bearer headers, credential assignments, JWT
 * and URL userinfo. It does not know provider token prefixes yet
 * (`core/src/audit/redact.ts` is outside this change's file scope), so those
 * rules live here and `validate.ts` scans with the same objects.
 * @module
 */

import { redactValue } from '@zhangliang0115/repl-server-core';

/** Provider token prefixes that must never reach details, logs or responses. */
export const PROVIDER_TOKEN_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

/** Replaces every provider token occurrence with `<redacted>`. */
export function redactProviderTokens(text: string): string {
  let out = text;
  for (const rule of PROVIDER_TOKEN_RULES) {
    // Build a fresh global regex so repeated calls cannot share `lastIndex`.
    out = out.replace(new RegExp(rule.pattern.source, `${rule.pattern.flags}g`), '<redacted>');
  }
  return out;
}

/** Full redaction for any AI-originated text that leaves the runner. */
export function redactAiText(text: string): string {
  return redactProviderTokens(redactValue(text));
}
