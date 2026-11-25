/**
 * Admin script-library payload readers (`10 §9.3`).
 *
 * The endpoint shapes are `{ items }` / `{ script }` / `{ version }`; every reader
 * tolerates a missing field so an older or partially implemented backend shows an
 * empty state instead of crashing the page.
 * @module
 */

export interface ScriptSummary {
  scriptId: string;
  name: string | null;
  description: string | null;
  tags: string[];
  mode: string | null;
  status: string | null;
  activeVersion: number | null;
  createdBy: string | null;
  useCount: number | null;
  lastUsedAt: string | null;
  updatedAt: string | null;
  /** Optional P2 aggregates over `script_runs`; absent on older backends. */
  runCount: number | null;
  successCount: number | null;
  successRate: number | null;
}

export interface ScriptDetail extends ScriptSummary {
  createdAt: string | null;
  sourceRunId: string | null;
}

export interface ScriptVersionSummary {
  version: number;
  mode: string | null;
  status: string | null;
  sourceRunId: string | null;
  verifiedRunId: string | null;
  changelog: string | null;
  codeBytes: number | null;
  codeSha256: string | null;
  createdAt: string | null;
  activatedAt: string | null;
}

export interface ScriptVersionDetail extends ScriptVersionSummary {
  code: string | null;
  inputSchema: unknown;
  exampleArgs: unknown;
  /** Advisory secret scan from the server; empty on older backends. */
  warnings: SecretWarningView[];
}

/** One aggregated secret finding; no matched text, safe to render. */
export interface SecretWarningView {
  field: string | null;
  kind: string | null;
  severity: string | null;
  count: number | null;
}

export interface ScriptRun {
  runId: string;
  createdAt: string | null;
  execId: string | null;
  requestId: string | null;
  evalId: number | null;
  scriptVersion: number | null;
  scriptMode: string | null;
  entryMode: string | null;
  purpose: string | null;
  ok: boolean;
  error: string | null;
  durationMs: number | null;
  /** Redacted JSON summary; the server no longer returns the plaintext args. */
  argsPreview: string | null;
  /** Legacy field; absent once the server strips plaintext args. */
  args: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function asTextList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    : [];
}

function warningItem(value: unknown): SecretWarningView | null {
  const row = asRecord(value);
  if (row === null) return null;
  const kind = asText(row['kind']);
  if (kind === null) return null;
  return {
    field: asText(row['field']),
    kind,
    severity: asText(row['severity']),
    count: asCount(row['count']),
  };
}

/** `warnings` / `secretWarnings` arrays on save, test and version responses. */
export function secretWarningsFrom(value: unknown): SecretWarningView[] {
  const row = asRecord(value);
  if (row === null) return [];
  const list = Array.isArray(row['warnings'])
    ? row['warnings']
    : Array.isArray(row['secretWarnings'])
      ? row['secretWarnings']
      : [];
  return list
    .map(warningItem)
    .filter((entry): entry is SecretWarningView => entry !== null);
}

function scriptBase(value: unknown): ScriptSummary | null {
  const row = asRecord(value);
  if (row === null) return null;
  const scriptId = asText(row['scriptId']);
  if (scriptId === null) return null;
  return {
    scriptId,
    name: asText(row['name']),
    description: asText(row['description']),
    tags: asTextList(row['tags']),
    mode: asText(row['mode']),
    status: asText(row['status']),
    activeVersion: asInteger(row['activeVersion']),
    createdBy: asText(row['createdBy']),
    useCount: asCount(row['useCount']),
    lastUsedAt: asText(row['lastUsedAt']),
    updatedAt: asText(row['updatedAt']),
    runCount: asCount(row['runCount']),
    successCount: asCount(row['successCount']),
    successRate: asCount(row['successRate']),
  };
}

function itemList(payload: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = asRecord(payload);
  if (root === null) return [];
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

/** `GET /scripts` items; accepts `{ items }`, `{ scripts }` or a bare array. */
export function scriptsFrom(payload: unknown): ScriptSummary[] {
  return itemList(payload, ['items', 'scripts'])
    .map(scriptBase)
    .filter((entry): entry is ScriptSummary => entry !== null);
}

/** `GET /scripts/:id`; accepts `{ script }` or the record itself. */
export function scriptDetailFrom(payload: unknown): ScriptDetail | null {
  const root = asRecord(payload);
  const candidate = root?.['script'] ?? payload;
  const base = scriptBase(candidate);
  if (base === null) return null;
  const row = asRecord(candidate) ?? {};
  return {
    ...base,
    createdAt: asText(row['createdAt']),
    sourceRunId: asText(row['sourceRunId']),
  };
}

function versionBase(value: unknown): ScriptVersionSummary | null {
  const row = asRecord(value);
  if (row === null) return null;
  const version = asInteger(row['version']);
  if (version === null) return null;
  return {
    version,
    mode: asText(row['mode']),
    status: asText(row['status']),
    sourceRunId: asText(row['sourceRunId']),
    verifiedRunId: asText(row['verifiedRunId']),
    changelog: asText(row['changelog']),
    codeBytes: asCount(row['codeBytes']),
    codeSha256: asText(row['codeSha256']),
    createdAt: asText(row['createdAt']),
    activatedAt: asText(row['activatedAt']),
  };
}

/** `GET /scripts/:id/versions`; code is intentionally absent from the list. */
export function versionsFrom(payload: unknown): ScriptVersionSummary[] {
  return itemList(payload, ['items', 'versions'])
    .map(versionBase)
    .filter((entry): entry is ScriptVersionSummary => entry !== null);
}

/** `GET /scripts/:id/versions/:version`; accepts `{ version }` or the record itself. */
export function versionDetailFrom(payload: unknown): ScriptVersionDetail | null {
  const root = asRecord(payload);
  const nested = asRecord(root?.['version']);
  const candidate = nested ?? payload;
  const base = versionBase(candidate);
  if (base === null) return null;
  const row = asRecord(candidate) ?? {};
  const nestedWarnings = secretWarningsFrom(root?.['version']);
  return {
    ...base,
    code: asText(row['code']),
    inputSchema: row['inputSchema'],
    exampleArgs: row['exampleArgs'],
    warnings: nestedWarnings.length > 0 ? nestedWarnings : secretWarningsFrom(root),
  };
}

/** `{ version }` returned by an admin edit, for selecting the new draft. */
export function createdVersion(payload: unknown): number | null {
  const root = asRecord(payload);
  const nested = asRecord(root?.['version']);
  return asInteger(nested?.['version'] ?? root?.['version'] ?? payload);
}

/** `GET /scripts/:id/runs` items. */
export function runsFrom(payload: unknown): ScriptRun[] {
  return itemList(payload, ['items', 'runs'])
    .map((value): ScriptRun | null => {
      const row = asRecord(value);
      if (row === null) return null;
      const runId = asText(row['runId']);
      if (runId === null) return null;
      return {
        runId,
        createdAt: asText(row['createdAt']),
        execId: asText(row['execId']),
        requestId: asText(row['requestId']),
        evalId: asInteger(row['evalId']),
        scriptVersion: asInteger(row['scriptVersion']),
        scriptMode: asText(row['scriptMode']),
        entryMode: asText(row['entryMode']),
        purpose: asText(row['purpose']),
        ok: row['ok'] === true,
        error: asText(row['error']),
        durationMs: asCount(row['durationMs']),
        argsPreview: asText(row['argsPreview']),
        args: row['args'],
      };
    })
    .filter((entry): entry is ScriptRun => entry !== null);
}

/**
 * Only runs with an MCP `requestId` can open the shared request drawer; test
 * runs are invoked by the admin API and have none. `purpose` picks the message,
 * never clickability, so it is deliberately absent from the input type.
 */
export function runHasRequestDetail(run: Pick<ScriptRun, 'requestId'>): boolean {
  return run.requestId !== null;
}

/**
 * P2 aggregates are optional. `successRate` may arrive as a `0..1` ratio or a
 * `0..100` percentage; anything outside both ranges is treated as missing.
 */
export function successRateFraction(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  if (value <= 1) return value;
  return value <= 100 ? value / 100 : null;
}

/** `runCount - successCount` in `script_runs`; `null` when either aggregate is absent. */
export function failedRunCount(
  summary: Pick<ScriptSummary, 'runCount' | 'successCount'>,
): number | null {
  if (summary.runCount === null || summary.successCount === null) return null;
  return Math.max(0, summary.runCount - summary.successCount);
}

export type ScriptDiffLineType = 'same' | 'add' | 'del';

export interface ScriptDiffLine {
  type: ScriptDiffLineType;
  text: string;
}

export interface ScriptVersionDiff {
  fromVersion: number | null;
  toVersion: number | null;
  lines: ScriptDiffLine[];
}

function diffLine(value: unknown): ScriptDiffLine | null {
  const row = asRecord(value);
  if (row === null) return null;
  const kind = asText(row['type'])?.toLowerCase() ?? null;
  const text = asText(row['text']) ?? asText(row['line']) ?? asText(row['value']);
  if (kind === null && text === null) return null;
  const type: ScriptDiffLineType =
    kind === 'add' || kind === 'added' || kind === 'insert'
      ? 'add'
      : kind === 'del'
          || kind === 'delete'
          || kind === 'deleted'
          || kind === 'remove'
          || kind === 'removed'
        ? 'del'
        : 'same';
  return { type, text: text ?? '' };
}

/**
 * `GET /scripts/:id/versions/:version/diff` reader. Returns `null` when the
 * payload has no line array at all, so an unimplemented endpoint (or a plain
 * error body) can show an empty state instead of a fabricated diff.
 */
export function diffFrom(payload: unknown): ScriptVersionDiff | null {
  const root = asRecord(payload);
  if (root === null) return null;
  const candidate = asRecord(root['diff']) ?? root;
  const rawLines = candidate['lines'] ?? candidate['items'];
  if (!Array.isArray(rawLines)) return null;
  return {
    fromVersion: asInteger(candidate['fromVersion']),
    toVersion: asInteger(candidate['toVersion']),
    lines: rawLines
      .map(diffLine)
      .filter((line): line is ScriptDiffLine => line !== null),
  };
}

export interface ScriptCandidate {
  id: string;
  status: string | null;
  score: number | null;
  runCount: number | null;
  sessionCount: number | null;
  codeSha256: string | null;
  sourceRunIds: string[];
  suggestedName: string | null;
  suggestedDescription: string | null;
  suggestedTags: string[];
  suggestedInputSchema: unknown;
  suggestedCode: string | null;
  code: string | null;
  toolsUsed: string[];
  firstSeenAt: string | null;
  lastSeenAt: string | null;
}

function candidateFrom(value: unknown): ScriptCandidate | null {
  const row = asRecord(value);
  if (row === null) return null;
  const id = asText(row['candidateId']) ?? asText(row['id']);
  if (id === null) return null;
  const sourceRunIds = asTextList(row['sourceRunIds']);
  return {
    id,
    status: asText(row['status']),
    score: asCount(row['score']),
    runCount: asCount(row['runCount']) ?? (sourceRunIds.length > 0 ? sourceRunIds.length : null),
    sessionCount: asCount(row['sessionCount']),
    codeSha256: asText(row['codeSha256']),
    sourceRunIds,
    suggestedName: asText(row['suggestedName']),
    suggestedDescription: asText(row['suggestedDescription']),
    suggestedTags: asTextList(row['suggestedTags']),
    suggestedInputSchema: row['suggestedInputSchema'],
    suggestedCode: asText(row['suggestedCode']),
    code: asText(row['code']),
    toolsUsed: asTextList(row['toolsUsed']),
    firstSeenAt: asText(row['firstSeenAt']),
    lastSeenAt: asText(row['lastSeenAt']),
  };
}

/** `GET /script-candidates` items; accepts `{ items }`, `{ candidates }` or an array. */
export function candidatesFrom(payload: unknown): ScriptCandidate[] {
  return itemList(payload, ['items', 'candidates'])
    .map(candidateFrom)
    .filter((entry): entry is ScriptCandidate => entry !== null);
}

/** `nextCursor` from a paged candidate list, or `null`. */
export function nextCursorFrom(payload: unknown): string | null {
  const root = asRecord(payload);
  return root === null ? null : asText(root['nextCursor']);
}

export interface CandidateScanResult {
  scanned: number | null;
  created: number | null;
  updated: number | null;
}

/** `POST /script-candidates/scan` counters; `null` fields stay unknown. */
export function scanResultFrom(payload: unknown): CandidateScanResult {
  const root = asRecord(payload) ?? {};
  const nested = asRecord(root['result']) ?? asRecord(root['scan']) ?? root;
  return {
    scanned: asCount(nested['scanned']),
    created: asCount(nested['created']),
    updated: asCount(nested['updated']),
  };
}

export interface CandidateAcceptResult {
  scriptId: string | null;
  version: number | null;
  status: string | null;
  /** Secret scan warnings raised while saving the generated draft. */
  warnings: SecretWarningView[];
}

/** `POST /script-candidates/:id/accept` result: the generated draft script/version. */
export function candidateAcceptFrom(payload: unknown): CandidateAcceptResult {
  const root = asRecord(payload) ?? {};
  const script = asRecord(root['script']);
  const version = asRecord(root['version']);
  return {
    scriptId: asText(root['scriptId']) ?? asText(script?.['scriptId']) ?? null,
    version:
      asInteger(root['version']) ??
      asInteger(version?.['version']) ??
      createdVersion(payload),
    status: asText(root['status']) ?? asText(version?.['status']) ?? asText(script?.['status']),
    warnings: secretWarningsFrom(script),
  };
}

export interface ScriptTestResult {
  runId: string | null;
  ok: boolean | null;
  durationMs: number | null;
  output: unknown;
  error: string | null;
  activated: boolean | null;
  status: string | null;
  /** Secret scan warnings on the tested args; advisory only. */
  secretWarnings: SecretWarningView[];
}

/** `POST /scripts/:id/test` result; a nested `{ run }` wrapper is accepted. */
export function testResultFrom(payload: unknown): ScriptTestResult | null {
  const root = asRecord(payload);
  if (root === null) return null;
  const run = asRecord(root['run']) ?? {};
  const rawOutput = root['output'] ?? root['result'] ?? run['output'] ?? run['result'];
  const outputRow = asRecord(rawOutput);
  // A `result` that looks like a run record is a wrapper, not the test output.
  const output =
    outputRow !== null && (outputRow['runId'] !== undefined || outputRow['ok'] !== undefined)
      ? undefined
      : rawOutput;
  const version = asRecord(root['version']);
  const rootWarnings = secretWarningsFrom(root);
  return {
    runId: asText(root['runId']) ?? asText(run['runId']),
    ok:
      typeof root['ok'] === 'boolean'
        ? root['ok']
        : typeof run['ok'] === 'boolean'
          ? run['ok']
          : null,
    durationMs: asCount(root['durationMs']) ?? asCount(run['durationMs']),
    output,
    error: asText(root['error']) ?? asText(run['error']),
    activated: typeof root['activated'] === 'boolean' ? root['activated'] : null,
    status: asText(root['status']) ?? asText(version?.['status']),
    secretWarnings: rootWarnings.length > 0 ? rootWarnings : secretWarningsFrom(run),
  };
}
