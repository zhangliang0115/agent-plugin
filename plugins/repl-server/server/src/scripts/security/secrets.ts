/**
 * Secret scanning and redaction for archived scripts (design 10 §11, P4).
 *
 * `scanSecrets` locates credential-looking fragments so the caller can warn on
 * save and badge them in the UI. `redactSecrets` returns a copy safe for logs
 * and UI; the original code is never changed. Findings are advisory: callers
 * must not block execution or rewrite a script because of them.
 * @module
 */

export type SecretKind =
  | 'private_key'
  | 'provider_token'
  | 'jwt'
  | 'bearer_token'
  | 'credential_url'
  | 'env_assignment'
  | 'high_entropy';

export type SecretSeverity = 'high' | 'medium' | 'low';

export interface SecretFinding {
  readonly kind: SecretKind;
  readonly start: number;
  readonly end: number;
  /** Masked excerpt; safe to store and show. */
  readonly preview: string;
  readonly severity: SecretSeverity;
}

/**
 * Aggregated advisory finding: one entry per field/kind/severity with a count.
 * It carries no matched text, so it is safe in tool results, audits and UI.
 */
export interface SecretWarning {
  /** `code`, `exampleArgs` on save; `args` on execution. */
  readonly field: string;
  readonly kind: SecretKind;
  readonly severity: SecretSeverity;
  readonly count: number;
}

interface Rule {
  readonly kind: SecretKind;
  readonly severity: SecretSeverity;
  readonly pattern: RegExp;
}

/**
 * Rule order breaks ties when two rules match at the same offset: a specific
 * provider token wins over the generic high-entropy rule that also covers it.
 */
const RULES: readonly Rule[] = [
  {
    kind: 'private_key',
    severity: 'high',
    // An unterminated block is treated as secret material to the end of input.
    pattern:
      /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    kind: 'provider_token',
    severity: 'high',
    pattern:
      /(?<![A-Za-z0-9_-])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|sk-[A-Za-z0-9]{32,}|sk-(?:proj|ant|svcacct|admin)-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|(?:AKIA|ASIA)[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20,})(?![A-Za-z0-9_-])/g,
  },
  {
    kind: 'jwt',
    severity: 'high',
    pattern:
      /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
  },
  {
    kind: 'bearer_token',
    severity: 'high',
    // The `Bearer` word stays outside the match so redaction keeps the prefix.
    pattern: /(?<=[Bb]earer\s{1,8})[A-Za-z0-9._~+/=-]{12,}/g,
  },
  {
    kind: 'credential_url',
    severity: 'high',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s/?#]+/gi,
  },
  {
    kind: 'env_assignment',
    severity: 'medium',
    // The sensitive word must end the key so `max_tokens` / `password_hint`
    // do not match. Quoted JSON keys are included in the match.
    pattern:
      /(["']?)([A-Za-z0-9_.-]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIALS?|AUTHORIZATION))\1\s*[:=]\s*(?:"[^"\n]*"|'[^'\n]*'|(?:Bearer|Basic)\s+[^\s,;'"`]+|[^\s,;'"`]+)/gi,
  },
  {
    kind: 'high_entropy',
    severity: 'low',
    pattern: /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/=_-]{32,}(?![A-Za-z0-9+/=_-])/g,
  },
];

const UUID_ONLY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_ONLY = /^[0-9a-f]+$/i;
const NUMERIC_ONLY = /^[-+]?\d+(?:\.\d+)?$/;
const PLACEHOLDER_VALUE =
  /^(?:<secret:[^>]*>|<redacted[^>]*>|\$\{[^}]*\}|\$secret(?:\.\w+)?|process\.env\.[\w.]+)$/i;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

/**
 * Heuristic: random-looking mixed-case alphanumerics. UUIDs and file hashes
 * are explicitly excluded because they are identifiers, not credentials.
 */
function isHighEntropy(value: string): boolean {
  if (value.length < 32) return false;
  if (HEX_ONLY.test(value) || UUID_ONLY.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value)) return false;
  if ((value.match(/[0-9]/g)?.length ?? 0) < 2) return false;
  // shortcut: all-lowercase and base32 secrets are missed; upgrade when one leaks.
  return shannonEntropy(value) >= 4.5;
}

function assignmentValue(match: string): { value: string; quoted: boolean } {
  const separator = match.search(/[:=]/);
  if (separator < 0) return { value: '', quoted: false };
  let value = match.slice(separator + 1).trim();
  const quoted =
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")));
  if (quoted) value = value.slice(1, -1).trim();
  return { value, quoted };
}

/** Bare JS expressions in code such as `token = await loadToken()`. */
const CODE_EXPRESSION_VALUE = /^(?:await|new|this|process|require)$/i;
const NULLISH_VALUE = /^(?:null|undefined|true|false)$/i;

function isPlaceholderAssignment(value: string, quoted: boolean): boolean {
  if (value === '') return true;
  if (NULLISH_VALUE.test(value)) return true;
  if (!quoted && (CODE_EXPRESSION_VALUE.test(value) || value.includes('('))) return true;
  if (NUMERIC_ONLY.test(value)) return true;
  if (/^\*+$/.test(value)) return true;
  return PLACEHOLDER_VALUE.test(value);
}

/** Replaces the secret part of a finding, keeping readable context. */
function maskValue(kind: SecretKind, value: string): string {
  switch (kind) {
    case 'private_key':
      return '<redacted private key>';
    case 'env_assignment': {
      const separator = value.search(/[:=]/);
      if (separator < 0) return '<redacted>';
      const spacing = /^\s*/.exec(value.slice(separator + 1))?.[0] ?? '';
      return `${value.slice(0, separator + 1)}${spacing}<redacted>`;
    }
    case 'credential_url':
      return value.replace(/(^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:)[^\s/@]+@/i, '$1<redacted>@');
    case 'provider_token':
    case 'jwt':
    case 'bearer_token':
    case 'high_entropy':
      return '<redacted>';
  }
}

function previewOf(kind: SecretKind, value: string): string {
  if (kind === 'private_key') return '<private key>';
  if (kind === 'env_assignment' || kind === 'credential_url') return maskValue(kind, value);
  return `${value.slice(0, 4)}…`;
}

/**
 * Finds secret-looking fragments in `text`, sorted by offset and never
 * overlapping. Offsets are UTF-16 indexes into `text`.
 */
export function scanSecrets(text: string): SecretFinding[] {
  const candidates: Array<SecretFinding & { rank: number }> = [];

  for (const [rank, rule] of RULES.entries()) {
    // A fresh RegExp keeps `lastIndex` out of module state between calls.
    const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
    for (const match of text.matchAll(pattern)) {
      if (match.index === undefined || match[0].length === 0) continue;
      const value = match[0];
      if (rule.kind === 'env_assignment') {
        const assignment = assignmentValue(value);
        if (isPlaceholderAssignment(assignment.value, assignment.quoted)) continue;
      }
      if (rule.kind === 'high_entropy' && !isHighEntropy(value)) continue;
      candidates.push({
        kind: rule.kind,
        severity: rule.severity,
        start: match.index,
        end: match.index + value.length,
        preview: previewOf(rule.kind, value),
        rank,
      });
    }
  }

  candidates.sort((a, b) => a.start - b.start || a.rank - b.rank || b.end - a.end);

  const findings: SecretFinding[] = [];
  let lastEnd = -1;
  for (const candidate of candidates) {
    if (candidate.start < lastEnd) continue;
    findings.push({
      kind: candidate.kind,
      start: candidate.start,
      end: candidate.end,
      preview: candidate.preview,
      severity: candidate.severity,
    });
    lastEnd = candidate.end;
  }
  return findings;
}

/**
 * Returns a copy of `text` with every finding masked, for logs and UI.
 * The input string is untouched; callers keep the original code.
 */
export function redactSecrets(text: string): string {
  const findings = scanSecrets(text);
  let out = text;
  for (const finding of [...findings].reverse()) {
    const value = text.slice(finding.start, finding.end);
    out = `${out.slice(0, finding.start)}${maskValue(finding.kind, value)}${out.slice(finding.end)}`;
  }
  return out;
}

/** Counts findings by kind/severity for one field; never includes the matched text. */
export function secretWarningsOf(field: string, value: unknown): SecretWarning[] {
  if (value === undefined || value === null) return [];
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    return [];
  }
  if (text === '') return [];
  const grouped = new Map<string, SecretWarning>();
  for (const finding of scanSecrets(text)) {
    const key = `${finding.kind}\u0000${finding.severity}`;
    const existing = grouped.get(key);
    if (existing === undefined) {
      grouped.set(key, {
        field,
        kind: finding.kind,
        severity: finding.severity,
        count: 1,
      });
    } else {
      grouped.set(key, { ...existing, count: existing.count + 1 });
    }
  }
  return [...grouped.values()];
}
