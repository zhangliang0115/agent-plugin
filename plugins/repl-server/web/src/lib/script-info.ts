/** Script identity on `run_script` requests and eval audit events (10 §7.4). */

/** Advisory secret-scan summary from an eval event; never contains the matched text. */
export interface ScriptSecretWarning {
  field: string | null;
  kind: string;
  severity: string | null;
  count: number | null;
}

export interface ScriptInfo {
  /** `code` for an ad-hoc run, `script` when a saved script was executed. */
  entryMode: string | null;
  scriptId: string | null;
  scriptName: string | null;
  scriptVersion: number | null;
  /** `exact` / `parameterized`; only eval events carry it (P2). */
  scriptMode: string | null;
  argsPreview: string | null;
  /** Present only when the scan found something (P4). */
  secretWarnings?: ScriptSecretWarning[];
}

function warningList(value: unknown): ScriptSecretWarning[] {
  if (!Array.isArray(value)) return [];
  const out: ScriptSecretWarning[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    const kind = text(row['kind']);
    if (kind === null) continue;
    out.push({
      field: text(row['field']),
      kind,
      severity: text(row['severity']),
      count: typeof row['count'] === 'number' && row['count'] > 0 ? row['count'] : null,
    });
  }
  return out;
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function versionNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

/** Truncated JSON for a table cell; the server also sends `argsPrefix` already short. */
export function argsSummary(value: unknown, maxLength = 200): string | null {
  if (value === undefined || value === null) return null;
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    return null;
  }
  if (json === undefined) return null;
  return json.length <= maxLength ? json : `${json.slice(0, maxLength)}…`;
}

/** Reads `entryMode` / `scriptId` / `scriptVersion` / `argsPrefix` from an audit event. */
export function scriptInfoFromEvent(
  event: Record<string, unknown> | null | undefined,
): ScriptInfo | null {
  if (event === null || event === undefined) return null;
  const scriptId = text(event['scriptId']);
  const entryMode = text(event['entryMode']);
  if (scriptId === null && entryMode === null) return null;
  // Eval events use `secretWarnings`; `script_saved` audits use `warnings` (same shape).
  const secretWarnings = warningList(event['secretWarnings'] ?? event['warnings']);
  return {
    entryMode,
    scriptId,
    scriptName: text(event['scriptName']),
    scriptVersion: versionNumber(event['scriptVersion']),
    scriptMode: text(event['scriptMode']),
    argsPreview: text(event['argsPrefix']) ?? text(event['argsPreview']),
    ...(secretWarnings.length === 0 ? {} : { secretWarnings }),
  };
}

/** Reads a `tools/call` frame's `params.arguments` (name `run_script`) before events load. */
export function scriptInfoFromRequest(request: unknown): ScriptInfo | null {
  if (typeof request !== 'object' || request === null) return null;
  const params = (request as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return null;
  const call = params as { name?: unknown; arguments?: unknown };
  if (call.name !== 'run_script') return null;
  const args =
    typeof call.arguments === 'object' && call.arguments !== null
      ? (call.arguments as Record<string, unknown>)
      : {};
  const scriptId = text(args['scriptId']);
  return {
    entryMode: scriptId === null ? 'code' : 'script',
    scriptId,
    scriptName: null,
    scriptVersion: versionNumber(args['scriptVersion']),
    scriptMode: null,
    argsPreview: argsSummary(args['args']),
  };
}

/** Inline `code` of an ad-hoc `run_script` call; `null` when params is another shape. */
export function scriptCodeFromParams(params: unknown): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const call = params as { name?: unknown; arguments?: unknown };
  if (call.name !== 'run_script') return null;
  if (typeof call.arguments !== 'object' || call.arguments === null) return null;
  const code = (call.arguments as Record<string, unknown>)['code'];
  return typeof code === 'string' && code !== '' ? code : null;
}

/** `code` from a request frame; externalised params carry no inline body. */
export function scriptCodeFromRequest(request: unknown): string | null {
  if (typeof request !== 'object' || request === null) return null;
  return scriptCodeFromParams((request as { params?: unknown }).params);
}

/**
 * Whether a 2 KiB params preview belongs to `run_script`. Externalised params
 * keep no tool name of their own, so the preview is the only signal available
 * before fetching; this is a pre-check, the loaded body is checked again.
 */
export function isRunScriptParamsPreview(preview: unknown): boolean {
  return typeof preview === 'string' && preview !== '' && /"name"\s*:\s*"run_script"/u.test(preview);
}

/** First event carrying a script id; `eval_start` arrives before `tool_call` rows. */
export function scriptInfoFromEvents(
  events: readonly Record<string, unknown>[] | null | undefined,
): ScriptInfo | null {
  if (events === null || events === undefined) return null;
  let fallback: ScriptInfo | null = null;
  for (const event of events) {
    const info = scriptInfoFromEvent(event);
    if (info === null) continue;
    if (info.scriptId !== null) return info;
    fallback ??= info;
  }
  return fallback;
}

/** Fills each field from the first source that has it (request frame, then events). */
export function mergeScriptInfo(
  ...sources: Array<ScriptInfo | null | undefined>
): ScriptInfo | null {
  let merged: ScriptInfo | null = null;
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    if (merged === null) {
      merged = { ...source };
      continue;
    }
    merged = {
      entryMode: merged.entryMode ?? source.entryMode,
      scriptId: merged.scriptId ?? source.scriptId,
      scriptName: merged.scriptName ?? source.scriptName,
      scriptVersion: merged.scriptVersion ?? source.scriptVersion,
      scriptMode: merged.scriptMode ?? source.scriptMode,
      argsPreview: merged.argsPreview ?? source.argsPreview,
      secretWarnings: merged.secretWarnings ?? source.secretWarnings,
    };
  }
  return merged;
}
