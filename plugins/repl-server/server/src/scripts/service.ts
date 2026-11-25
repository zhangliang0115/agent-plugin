/** Script archive, saving, search and execution resolution (design 10). @module */
import type { DatabaseSync } from 'node:sqlite';
import { Script as VmScript } from 'node:vm';

import { withTransaction } from '../db/migrate.ts';
import {
  activateScriptVersion,
  createScriptWithVersion,
  findScriptByName,
  getScript,
  getScriptRun,
  getScriptVersion,
  getScriptWithStats,
  insertScriptRun,
  insertScriptVersion,
  latestScriptVersion,
  listScriptRuns,
  listScripts,
  listScriptVersions,
  newScriptId,
  normalizeWorkspace,
  pruneScriptRuns,
  touchScriptUsage,
  updateScriptMeta,
  type EntryMode,
  type ScriptListQuery,
  type ScriptPatch,
  type ScriptRecord,
  type ScriptRunInput,
  type ScriptRunRecord,
  type ScriptStatus,
  type ScriptVersionRecord,
  type VersionMode,
  type VersionStatus,
} from '../db/scripts.ts';
import type { ScriptActor } from '../ports.ts';
import { bm25Expression, buildFtsMatch, tokenizeFts } from '../search/fts-kernel.ts';
import type { ToolDefinition, ToolInputSchema } from '../tools/registry.ts';
import { validateToolArguments } from '../tools/registry.ts';
import {
  secretWarningsOf,
  type SecretWarning,
} from './security/secrets.ts';

/**
 * The MCP and admin request bodies are capped at 1 MiB, so a larger script could
 * never be submitted whole; SQLite TEXT itself has no practical limit. Matching
 * that transport cap keeps one observable ceiling instead of inventing a smaller
 * arbitrary one (docs/protocol.md §4).
 */
export const SCRIPT_CODE_MAX_BYTES = 1 << 20;
/** Archive retention for `script_runs` (design 10 §5.1). */
export const SCRIPT_RUN_RETENTION_DAYS = 90;
/** Versioned test executions that succeed may be activated automatically. */
export const SCRIPT_NAME_MAX = 120;
export const SCRIPT_DESCRIPTION_MAX = 2000;
export const SCRIPT_TAGS_MAX = 10;

export type ScriptErrorCode =
  | 'INVALID_ARGUMENT'
  | 'SCRIPT_RUN_NOT_FOUND'
  | 'SCRIPT_RUN_NOT_SUCCESSFUL'
  | 'SCRIPT_RUN_EXPIRED'
  | 'SCRIPT_NOT_FOUND'
  | 'SCRIPT_VERSION_NOT_FOUND'
  | 'SCRIPT_VERSION_NOT_DRAFT'
  | 'SCRIPT_VERSION_CONFLICT'
  | 'SCRIPT_NAME_CONFLICT'
  | 'SCRIPT_ARGS_INVALID'
  | 'SCRIPT_DISABLED'
  | 'SCRIPT_ARCHIVED'
  | 'SCRIPT_MODE_CONFLICT'
  | 'SCRIPT_CODE_INVALID'
  | 'SCRIPT_CANDIDATE_NOT_FOUND'
  | 'SCRIPT_CANDIDATE_ALREADY_REVIEWED'
  | 'SCRIPT_CANDIDATE_INCOMPLETE'
  | 'SCRIPT_INPUT_SCHEMA_INVALID'
  | 'SCRIPT_NOT_ACTIVE'
  | 'SCRIPT_FORBIDDEN';

/** Tool- and admin-facing failure with one of the codes fixed in design 10 §7.5. */
export class ScriptError extends Error {
  readonly code: ScriptErrorCode;
  readonly details: unknown;

  constructor(code: ScriptErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'ScriptError';
    this.code = code;
    this.details = details;
  }
}

export interface ArchiveRunOptions {
  runId: string;
  createdAt: string;
  execId: string | null;
  evalId: number | null;
  requestId: string | number | null;
  binding: string | null;
  clientName: string;
  clientVersion: string;
  workspace: string;
  entryTool: string;
  entryMode: EntryMode;
  scriptId?: string | null;
  scriptVersion?: number | null;
  scriptMode?: VersionMode | null;
  args?: Record<string, unknown> | null;
  /** Redacted JSON summary of `args` for audit and details; at most 512 characters. */
  argsPreview?: string | null;
  code?: string | null;
  ok: boolean;
  error?: string | null;
  resultBytes: number;
  durationMs: number;
  toolsUsed: string[];
  purpose: 'run' | 'test';
  /** Owner/admin identity used for the conditional activation below. */
  actor?: ScriptActor;
  /** Set by `run_script` when the test asked to activate its draft on success. */
  activateOnSuccess?: boolean;
}

/** Outcome of one archive write; activation is conditional, so skip reasons travel back. */
export interface ArchiveRunResult {
  activated: boolean;
  /** Why activation was skipped: version/script state, a missing row, or ACL. */
  activationSkipped?: VersionStatus | ScriptStatus | 'missing' | 'forbidden';
}

export interface SaveScriptInput {
  runId?: string;
  scriptId?: string;
  baseVersion?: number;
  mode?: VersionMode;
  name?: string;
  description?: string;
  tags?: string[];
  code?: string;
  inputSchema?: Record<string, unknown>;
  exampleArgs?: Record<string, unknown> | null;
  changelog?: string;
}

export interface SaveScriptResult {
  /** Internal system id; the model-facing tool returns the script name instead. */
  scriptId: string;
  /** Current name after this save, including a rename. */
  name: string;
  version: number;
  status: ScriptStatus;
  activeVersion: number | null;
  mode: VersionMode;
  /** Advisory secret scan of `code` / `exampleArgs`; never blocks or rewrites the save. */
  warnings: SecretWarning[];
}

export interface SearchScriptsInput {
  query?: string;
  tags?: string[];
  limit?: number;
}

export interface ScriptSearchItem {
  scriptId: string;
  name: string;
  description: string;
  tags: string[];
  mode: VersionMode;
  activeVersion: number;
  inputSchema: Record<string, unknown>;
  exampleArgs: Record<string, unknown> | null;
  useCount: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface ResolvedExecution {
  script: ScriptRecord;
  version: ScriptVersionRecord;
  code: string;
  args: Record<string, unknown>;
  purpose: 'run' | 'test';
}

export interface ScriptDiffLine {
  type: 'same' | 'add' | 'del';
  text: string;
}

export interface ScriptVersionDiff {
  fromVersion: number;
  toVersion: number;
  lines: ScriptDiffLine[];
}

/**
 * Above this many DP cells the middle section becomes a block replace. Code is
 * capped at 1 MiB, so this only guards pathological line counts.
 * shortcut: block replace for >1M-cell middles; upgrade to Myers if admins hit it.
 */
const DIFF_MAX_CELLS = 1_000_000;

/** Plain line diff: common prefix/suffix trimmed, LCS on the middle, deletions first. */
export function diffLines(before: string, after: string): ScriptDiffLine[] {
  const left = before.split('\n');
  const right = after.split('\n');
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let endLeft = left.length;
  let endRight = right.length;
  while (endLeft > start && endRight > start && left[endLeft - 1] === right[endRight - 1]) {
    endLeft -= 1;
    endRight -= 1;
  }

  const lines: ScriptDiffLine[] = [];
  for (let index = 0; index < start; index += 1) {
    lines.push({ type: 'same', text: left[index] as string });
  }

  const middleLeft = left.slice(start, endLeft);
  const middleRight = right.slice(start, endRight);
  if (middleLeft.length * middleRight.length > DIFF_MAX_CELLS) {
    for (const text of middleLeft) lines.push({ type: 'del', text });
    for (const text of middleRight) lines.push({ type: 'add', text });
  } else {
    const rows = middleLeft.length;
    const cols = middleRight.length;
    const lengths: Int32Array[] = Array.from({ length: rows + 1 }, () => new Int32Array(cols + 1));
    for (let row = rows - 1; row >= 0; row -= 1) {
      const current = lengths[row] as Int32Array;
      const next = lengths[row + 1] as Int32Array;
      for (let col = cols - 1; col >= 0; col -= 1) {
        current[col] = middleLeft[row] === middleRight[col]
          ? (next[col + 1] as number) + 1
          : Math.max(next[col] as number, current[col + 1] as number);
      }
    }
    let row = 0;
    let col = 0;
    while (row < rows && col < cols) {
      if (middleLeft[row] === middleRight[col]) {
        lines.push({ type: 'same', text: middleLeft[row] as string });
        row += 1;
        col += 1;
      } else if (((lengths[row + 1] as Int32Array)[col] ?? 0) >= ((lengths[row] as Int32Array)[col + 1] ?? 0)) {
        lines.push({ type: 'del', text: middleLeft[row] as string });
        row += 1;
      } else {
        lines.push({ type: 'add', text: middleRight[col] as string });
        col += 1;
      }
    }
    while (row < rows) {
      lines.push({ type: 'del', text: middleLeft[row] as string });
      row += 1;
    }
    while (col < cols) {
      lines.push({ type: 'add', text: middleRight[col] as string });
      col += 1;
    }
  }

  for (let index = endLeft; index < left.length; index += 1) {
    lines.push({ type: 'same', text: left[index] as string });
  }
  return lines;
}

export type SaveScriptActor = ScriptActor;

/** Secret warnings for one stored version: `code` plus the optional `exampleArgs`. */
export function versionSecretWarnings(
  code: string,
  exampleArgs: Record<string, unknown> | null | undefined,
): SecretWarning[] {
  return [
    ...secretWarningsOf('code', code),
    ...secretWarningsOf('exampleArgs', exampleArgs),
  ];
}

function isoPlusDays(iso: string, days: number): string {
  return new Date(Date.parse(iso) + days * 86_400_000).toISOString();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const ROOT_SCHEMA_KEYS = new Set(['type', 'properties', 'required', 'additionalProperties', 'description']);
const PROPERTY_SCHEMA_KEYS = new Set([
  'type',
  'enum',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'items',
  'minLength',
  'maxLength',
  'additionalProperties',
  'default',
  'description',
]);
const PROPERTY_TYPES = new Set(['string', 'integer', 'boolean', 'object', 'array']);

function schemaInvalid(message: string, keyword?: string): ScriptError {
  return new ScriptError(
    'SCRIPT_INPUT_SCHEMA_INVALID',
    message,
    keyword === undefined ? undefined : { keyword },
  );
}

function validatePropertySchema(value: unknown, path: string): void {
  if (!isPlainObject(value)) {
    throw schemaInvalid(`${path} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!PROPERTY_SCHEMA_KEYS.has(key)) {
      throw schemaInvalid(`${path}.${key} is not supported by the P1 subset`, key);
    }
  }
  const type = value['type'];
  if (typeof type !== 'string' || !PROPERTY_TYPES.has(type)) {
    throw schemaInvalid(`${path}.type must be one of ${[...PROPERTY_TYPES].join(', ')}`, 'type');
  }
  if (value['enum'] !== undefined) {
    if (!Array.isArray(value['enum']) || value['enum'].length === 0) {
      throw schemaInvalid(`${path}.enum must be a non-empty array`, 'enum');
    }
    for (const entry of value['enum']) {
      if (!['string', 'number', 'boolean'].includes(typeof entry)) {
        throw schemaInvalid(`${path}.enum entries must be string, number or boolean`, 'enum');
      }
    }
  }
  for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    const limit = value[key];
    if (limit === undefined) continue;
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      throw schemaInvalid(`${path}.${key} must be a number`, key);
    }
    if (['minLength', 'maxLength', 'minItems', 'maxItems'].includes(key) && (!Number.isInteger(limit) || limit < 0)) {
      throw schemaInvalid(`${path}.${key} must be a non-negative integer`, key);
    }
  }
  if (value['items'] !== undefined) {
    if (type !== 'array') throw schemaInvalid(`${path}.items is only supported on arrays`, 'items');
    validatePropertySchema(value['items'], `${path}.items`);
  }
  if (value['additionalProperties'] !== undefined && typeof value['additionalProperties'] !== 'boolean') {
    throw schemaInvalid(`${path}.additionalProperties must be a boolean`, 'additionalProperties');
  }
}

/**
 * Checks the `inputSchema` subset from design 10 §4.3: root object, five
 * property types, the listed scalar bounds, and no nesting below `items`.
 */
export function validateInputSchema(schema: unknown): Record<string, unknown> {
  if (!isPlainObject(schema)) throw schemaInvalid('inputSchema must be an object');
  for (const key of Object.keys(schema)) {
    if (!ROOT_SCHEMA_KEYS.has(key)) {
      throw schemaInvalid(`inputSchema.${key} is not supported by the P1 subset`, key);
    }
  }
  if (schema['type'] !== 'object') {
    throw schemaInvalid('inputSchema.type must be "object"', 'type');
  }
  const properties = schema['properties'] ?? {};
  if (!isPlainObject(properties)) throw schemaInvalid('inputSchema.properties must be an object');
  for (const [name, property] of Object.entries(properties)) {
    validatePropertySchema(property, `inputSchema.properties.${name}`);
  }
  const required = schema['required'];
  if (required !== undefined) {
    if (!Array.isArray(required)) throw schemaInvalid('inputSchema.required must be an array', 'required');
    const seen = new Set<string>();
    for (const name of required) {
      if (typeof name !== 'string') throw schemaInvalid('inputSchema.required entries must be strings', 'required');
      if (!Object.hasOwn(properties, name)) {
        throw schemaInvalid(`inputSchema.required names ${JSON.stringify(name)} which is not declared`, 'required');
      }
      if (seen.has(name)) throw schemaInvalid(`inputSchema.required repeats ${JSON.stringify(name)}`, 'required');
      seen.add(name);
    }
  }
  if (schema['additionalProperties'] !== undefined && schema['additionalProperties'] !== false) {
    throw schemaInvalid('inputSchema.additionalProperties must be false when present', 'additionalProperties');
  }
  return {
    ...schema,
    properties,
    ...(required === undefined ? {} : { required }),
    additionalProperties: false,
  };
}

/** Compiles the async wrapper without executing it, so syntax errors surface at save. */
export function compileScriptCode(code: string): void {
  try {
    new VmScript(`(async function __savedScript(args) {\n${code}\n})`, {
      filename: 'saved-script.js',
    });
  } catch (error) {
    throw new ScriptError(
      'SCRIPT_CODE_INVALID',
      `script code does not compile: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function checkScriptCodeSize(code: string): void {
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > SCRIPT_CODE_MAX_BYTES) {
    throw new ScriptError(
      'SCRIPT_CODE_INVALID',
      `script code is ${bytes} bytes; the limit is ${SCRIPT_CODE_MAX_BYTES}`,
    );
  }
}

function buildArgumentDefinition(schema: Record<string, unknown>): ToolDefinition {
  return {
    name: 'run_script',
    description: '',
    inputSchema: schema as unknown as ToolInputSchema,
    _meta: { 'anthropic/alwaysLoad': true },
  };
}

/** Validates call arguments with the shared tool validator, remapping the error code. */
export function validateScriptArgs(
  schema: Record<string, unknown>,
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result = validateToolArguments('saved_script', args ?? {}, buildArgumentDefinition(schema));
  if (!result.ok) {
    throw new ScriptError('SCRIPT_ARGS_INVALID', result.message);
  }
  return result.value;
}

/** The runtime shape from design 10 §4.1; args travel as JSON, not interpolated JavaScript. */
export function buildParameterizedCode(code: string, args: Record<string, unknown>): string {
  const json = JSON.stringify(args);
  return `async function __savedScript(args) {\n${code}\n}\nreturn __savedScript(JSON.parse(${JSON.stringify(json)}));`;
}

function trimText(value: string, field: string, max: number): string {
  const text = value.trim();
  if (text === '') throw new ScriptError('INVALID_ARGUMENT', `${field} must not be empty`);
  if ([...text].length > max) {
    throw new ScriptError('INVALID_ARGUMENT', `${field} must be at most ${max} characters`);
  }
  return text;
}

function normalizeTags(tags: string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  if (tags.length > SCRIPT_TAGS_MAX) {
    throw new ScriptError('INVALID_ARGUMENT', `tags must have at most ${SCRIPT_TAGS_MAX} entries`);
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tag of tags) {
    const text = tag.trim();
    if (text === '') throw new ScriptError('INVALID_ARGUMENT', 'tags must not contain empty strings');
    if (!seen.has(text)) {
      seen.add(text);
      result.push(text);
    }
  }
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code.includes('CONSTRAINT_UNIQUE')) return true;
    return /UNIQUE constraint failed: scripts\./.test(error.message);
  }
  return false;
}

function requireMode(mode: VersionMode | undefined): VersionMode {
  if (mode !== 'exact' && mode !== 'parameterized') {
    throw new ScriptError('INVALID_ARGUMENT', 'mode must be "exact" or "parameterized"');
  }
  return mode;
}

function requireCode(code: string | undefined): string {
  if (typeof code !== 'string' || code.trim() === '') {
    throw new ScriptError('INVALID_ARGUMENT', 'code is required for this mode');
  }
  checkScriptCodeSize(code);
  return code;
}

/** BM25 weights in `scripts_fts` column order: script_id (unindexed), name, description, tags_json. */
const SCRIPT_BM25_WEIGHTS = [0, 3, 1, 2] as const;
const SCRIPT_QUERY_MAX_TERMS = 32;

/**
 * Builds an FTS5 MATCH expression from free text. Every token is quoted and
 * prefix-matched, so quotes/operators in the query stay literal; `null` means
 * the text had no indexable token and the caller should fall back to LIKE.
 */
export function buildScriptsFtsQuery(text: string): string | null {
  return buildFtsMatch(tokenizeFts(text, SCRIPT_QUERY_MAX_TERMS), 'AND');
}

function toSearchItem(row: Record<string, unknown>): ScriptSearchItem {
  const tags = JSON.parse(String(row['tags_json'] ?? '[]')) as string[];
  const inputSchema = JSON.parse(String(row['active_schema_json'] ?? '{}')) as Record<string, unknown>;
  const exampleJson = row['active_example_json'];
  return {
    scriptId: String(row['script_id']),
    name: String(row['name']),
    description: String(row['description']),
    tags,
    mode: String(row['mode']) as VersionMode,
    activeVersion: Number(row['active_version']),
    inputSchema,
    exampleArgs: typeof exampleJson === 'string' ? (JSON.parse(exampleJson) as Record<string, unknown>) : null,
    useCount: Number(row['use_count'] ?? 0),
    lastUsedAt: row['last_used_at'] === null ? null : String(row['last_used_at']),
    updatedAt: String(row['updated_at']),
  };
}

export interface ScriptServiceOptions {
  db: DatabaseSync;
  now?: () => number;
}

/** Minimal ACL from design 10 §8: owner or admin, nothing finer. */
function canManageScript(actor: ScriptActor, script: Pick<ScriptRecord, 'createdBy'>): boolean {
  return actor.isAdmin === true || (script.createdBy !== '' && script.createdBy === actor.createdBy);
}

function forbidden(scriptId: string): ScriptError {
  return new ScriptError(
    'SCRIPT_FORBIDDEN',
    `script ${scriptId} can only be managed by its owner or an admin`,
  );
}

export class ScriptService {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: ScriptServiceOptions) {
    this.db = options.db;
    this.now = options.now ?? Date.now;
  }

  /**
   * Writes one execution archive row and, when asked, activates its draft in the
   * same transaction. Activation is conditional: a version another operation
   * already activated/archived keeps its status and the run is still archived.
   */
  archiveRun(input: ArchiveRunOptions): ArchiveRunResult {
    const createdAt = input.createdAt;
    const record: ScriptRunInput = {
      runId: input.runId,
      createdAt,
      expiresAt: isoPlusDays(createdAt, SCRIPT_RUN_RETENTION_DAYS),
      execId: input.execId,
      evalId: input.evalId,
      requestId: input.requestId === null ? null : String(input.requestId),
      binding: input.binding,
      clientName: input.clientName,
      clientVersion: input.clientVersion,
      workspace: normalizeWorkspace(input.workspace),
      entryTool: input.entryTool,
      entryMode: input.entryMode,
      scriptId: input.scriptId ?? null,
      scriptVersion: input.scriptVersion ?? null,
      scriptMode: input.scriptMode ?? null,
      args: input.args ?? null,
      argsPreview: input.argsPreview ?? null,
      code: input.code ?? null,
      ok: input.ok,
      error: input.error ?? null,
      resultBytes: input.resultBytes,
      durationMs: input.durationMs,
      toolsUsed: input.toolsUsed,
      purpose: input.purpose,
    };
    const activation =
      input.activateOnSuccess === true
      && input.ok
      && input.entryMode === 'script'
      && typeof input.scriptId === 'string'
      && typeof input.scriptVersion === 'number'
        ? { scriptId: input.scriptId, version: input.scriptVersion }
        : null;

    return withTransaction(this.db, () => {
      insertScriptRun(this.db, record);
      if (activation === null) return { activated: false };
      const script = getScript(this.db, activation.scriptId);
      if (script === null) return { activated: false, activationSkipped: 'missing' };
      if (script.status === 'disabled' || script.status === 'archived') {
        return { activated: false, activationSkipped: script.status };
      }
      const target = getScriptVersion(this.db, activation.scriptId, activation.version);
      if (target === null) return { activated: false, activationSkipped: 'missing' };
      if (target.status !== 'draft') {
        return { activated: false, activationSkipped: target.status };
      }
      // Activation is a management action: the settling run's actor must own the
      // script or be an admin, otherwise the run still archives as successful.
      if (input.actor === undefined || !canManageScript(input.actor, script)) {
        return { activated: false, activationSkipped: 'forbidden' };
      }
      activateScriptVersion(this.db, activation.scriptId, activation.version, input.runId);
      return { activated: true };
    });
  }

  /** Deletes expired archive rows; returns the removed count. */
  pruneExpiredRuns(nowIso: string = new Date(this.now()).toISOString()): number {
    return pruneScriptRuns(this.db, nowIso);
  }

  getRun(runId: string): ScriptRunRecord | null {
    return getScriptRun(this.db, runId);
  }

  private requireRun(runId: string | undefined): ScriptRunRecord {
    if (typeof runId !== 'string' || runId === '') {
      throw new ScriptError('INVALID_ARGUMENT', 'runId is required');
    }
    const run = getScriptRun(this.db, runId);
    if (run === null) throw new ScriptError('SCRIPT_RUN_NOT_FOUND', `run ${runId} was not found`);
    if (Date.parse(run.expiresAt) <= this.now()) {
      throw new ScriptError('SCRIPT_RUN_EXPIRED', `run ${runId} expired`);
    }
    if (!run.ok) {
      throw new ScriptError('SCRIPT_RUN_NOT_SUCCESSFUL', `run ${runId} did not succeed`);
    }
    return run;
  }

  save(actor: SaveScriptActor, input: SaveScriptInput): SaveScriptResult {
    if (input.scriptId !== undefined) return this.update(actor, input);
    return this.create(actor, input);
  }

  private create(actor: SaveScriptActor, input: SaveScriptInput): SaveScriptResult {
    const mode = requireMode(input.mode);
    const name = trimText(input.name ?? '', 'name', SCRIPT_NAME_MAX);
    const description = trimText(input.description ?? '', 'description', SCRIPT_DESCRIPTION_MAX);
    const tags = normalizeTags(input.tags) ?? [];
    // exact proves itself through its mandatory source run; parameterized may be
    // written from scratch, where runId is only provenance (design 10 §6.2).
    const run =
      mode === 'exact'
        ? this.requireRun(input.runId)
        : input.runId === undefined || input.runId === ''
          ? null
          : this.requireRun(input.runId);
    if (findScriptByName(this.db, name) !== null) {
      throw new ScriptError('SCRIPT_NAME_CONFLICT', `a script named ${JSON.stringify(name)} already exists`);
    }

    let code: string;
    let inputSchema: Record<string, unknown>;
    let exampleArgs: Record<string, unknown> | null = null;
    let verifiedRunId: string | null = null;
    let activate: boolean;

    if (mode === 'exact') {
      if (input.code !== undefined) {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'exact mode takes its code from the source run; do not submit code',
        );
      }
      if (input.inputSchema !== undefined) {
        if (!isPlainObject(input.inputSchema)) {
          throw new ScriptError('INVALID_ARGUMENT', 'exact mode only accepts an empty inputSchema');
        }
        if (Object.keys(input.inputSchema).length > 0) {
          throw new ScriptError('INVALID_ARGUMENT', 'exact mode only accepts an empty inputSchema');
        }
      }
      if (
        input.exampleArgs !== undefined
        && input.exampleArgs !== null
        && (!isPlainObject(input.exampleArgs) || Object.keys(input.exampleArgs).length > 0)
      ) {
        throw new ScriptError('INVALID_ARGUMENT', 'exact mode does not accept exampleArgs');
      }
      if (run === null || run.entryMode !== 'code' || run.code === null || run.code.trim() === '') {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'exact mode requires a successful run_script run with saved code',
        );
      }
      code = run.code;
      checkScriptCodeSize(code);
      inputSchema = {};
      verifiedRunId = run.runId;
      activate = true;
    } else {
      code = requireCode(input.code);
      if (input.inputSchema === undefined) {
        throw new ScriptError('SCRIPT_INPUT_SCHEMA_INVALID', 'inputSchema is required for parameterized mode');
      }
      inputSchema = validateInputSchema(input.inputSchema);
      compileScriptCode(code);
      if (input.exampleArgs !== undefined && input.exampleArgs !== null) {
        if (!isPlainObject(input.exampleArgs)) {
          throw new ScriptError('SCRIPT_ARGS_INVALID', 'exampleArgs must be an object');
        }
        exampleArgs = validateScriptArgs(inputSchema, input.exampleArgs);
      }
      activate = false;
    }

    const now = new Date(this.now()).toISOString();
    const warnings = versionSecretWarnings(code, exampleArgs);
    try {
      const created = createScriptWithVersion(
        this.db,
        {
          scriptId: newScriptId(this.now()),
          name,
          description,
          tags,
          mode,
          createdBy: actor.createdBy,
          sourceRunId: run?.runId ?? null,
          now,
        },
        {
          mode,
          code,
          inputSchema,
          exampleArgs,
          changelog: input.changelog ?? null,
          createdBy: actor.createdBy,
          sourceRunId: run?.runId ?? null,
          verifiedRunId,
          now,
        },
        activate,
      );
      return {
        scriptId: created.script.scriptId,
        name,
        version: created.version.version,
        status: created.script.status,
        activeVersion: created.script.activeVersion,
        mode: created.version.mode,
        warnings,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScriptError('SCRIPT_NAME_CONFLICT', `a script named ${JSON.stringify(name)} already exists`);
      }
      throw error;
    }
  }

  private update(actor: SaveScriptActor, input: SaveScriptInput): SaveScriptResult {
    const scriptId = input.scriptId as string;
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    if (!canManageScript(actor, script)) throw forbidden(scriptId);

    const metadata: ScriptPatch = {};
    if (input.name !== undefined) metadata.name = trimText(input.name, 'name', SCRIPT_NAME_MAX);
    if (input.description !== undefined) {
      metadata.description = trimText(input.description, 'description', SCRIPT_DESCRIPTION_MAX);
    }
    if (input.tags !== undefined) metadata.tags = normalizeTags(input.tags) ?? [];
    const changesVersion =
      input.code !== undefined
      || input.inputSchema !== undefined
      || input.mode !== undefined
      || input.runId !== undefined;

    if (metadata.name !== undefined && metadata.name !== script.name) {
      const existing = findScriptByName(this.db, metadata.name);
      if (existing !== null && existing.scriptId !== scriptId) {
        throw new ScriptError(
          'SCRIPT_NAME_CONFLICT',
          `a script named ${JSON.stringify(metadata.name)} already exists`,
        );
      }
    }

    if (!changesVersion) {
      if (Object.keys(metadata).length === 0) {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'provide name, description, tags, or a code/inputSchema/mode update',
        );
      }
      try {
        updateScriptMeta(this.db, scriptId, metadata);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ScriptError(
            'SCRIPT_NAME_CONFLICT',
            `a script named ${JSON.stringify(metadata.name)} already exists`,
          );
        }
        throw error;
      }
      const latest = latestScriptVersion(this.db, scriptId);
      if (latest === null) throw new ScriptError('SCRIPT_VERSION_NOT_FOUND', `script ${scriptId} has no versions`);
      const current = getScript(this.db, scriptId);
      return {
        scriptId,
        name: current?.name ?? script.name,
        version: latest.version,
        status: current?.status ?? script.status,
        activeVersion: current?.activeVersion ?? script.activeVersion,
        mode: latest.mode,
        warnings: versionSecretWarnings(latest.code, latest.exampleArgs),
      };
    }

    const base = latestScriptVersion(this.db, scriptId);
    if (base === null) throw new ScriptError('SCRIPT_VERSION_NOT_FOUND', `script ${scriptId} has no versions`);
    // A script keeps one mode for life; converting it would silently change the
    // calling contract, so a different shape is a new script instead. The
    // script row is authoritative, not whichever version happens to be latest.
    const mode = input.mode ?? script.mode;
    if (mode !== script.mode) {
      throw new ScriptError(
        'SCRIPT_MODE_CONFLICT',
        `script ${scriptId} is ${script.mode}; create a new script to switch modes`,
        { scriptMode: script.mode, requestedMode: mode },
      );
    }
    if (input.baseVersion === undefined) {
      throw new ScriptError('INVALID_ARGUMENT', 'baseVersion is required when changing code or schema');
    }
    if (base.version !== input.baseVersion) {
      throw new ScriptError(
        'SCRIPT_VERSION_CONFLICT',
        `baseVersion ${input.baseVersion} does not match the latest version ${base.version}`,
        { baseVersion: input.baseVersion, latestVersion: base.version },
      );
    }

    let code: string;
    let inputSchema: Record<string, unknown>;
    let exampleArgs: Record<string, unknown> | null = null;
    let run: ScriptRunRecord | null;
    let verifiedRunId: string | null = null;
    if (mode === 'exact') {
      if (input.code !== undefined) {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'exact mode takes its code from the source run; do not submit code',
        );
      }
      if (input.inputSchema !== undefined) {
        if (!isPlainObject(input.inputSchema)) {
          throw new ScriptError('INVALID_ARGUMENT', 'exact mode only accepts an empty inputSchema');
        }
        if (Object.keys(input.inputSchema).length > 0) {
          throw new ScriptError('INVALID_ARGUMENT', 'exact mode only accepts an empty inputSchema');
        }
      }
      if (
        input.exampleArgs !== undefined
        && input.exampleArgs !== null
        && (!isPlainObject(input.exampleArgs) || Object.keys(input.exampleArgs).length > 0)
      ) {
        throw new ScriptError('INVALID_ARGUMENT', 'exact mode does not accept exampleArgs');
      }
      run = this.requireRun(input.runId);
      if (run.entryMode !== 'code' || run.code === null || run.code.trim() === '') {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'exact mode requires a successful run_script run with saved code',
        );
      }
      code = run.code;
      checkScriptCodeSize(code);
      inputSchema = {};
      verifiedRunId = run.runId;
    } else {
      code = requireCode(input.code);
      if (input.inputSchema === undefined) {
        throw new ScriptError('SCRIPT_INPUT_SCHEMA_INVALID', 'inputSchema is required for parameterized mode');
      }
      inputSchema = validateInputSchema(input.inputSchema);
      compileScriptCode(code);
      if (input.exampleArgs !== undefined && input.exampleArgs !== null) {
        if (!isPlainObject(input.exampleArgs)) {
          throw new ScriptError('SCRIPT_ARGS_INVALID', 'exampleArgs must be an object');
        }
        exampleArgs = validateScriptArgs(inputSchema, input.exampleArgs);
      }
      run = input.runId === undefined || input.runId === '' ? null : this.requireRun(input.runId);
    }

    const now = new Date(this.now()).toISOString();
    const warnings = versionSecretWarnings(code, exampleArgs);
    try {
      const created = withTransaction(this.db, () => {
        if (Object.keys(metadata).length > 0) updateScriptMeta(this.db, scriptId, metadata);
        return insertScriptVersion(this.db, scriptId, {
          mode,
          code,
          inputSchema,
          exampleArgs,
          changelog: input.changelog ?? null,
          createdBy: actor.createdBy,
          sourceRunId: run?.runId ?? null,
          verifiedRunId,
          now,
        });
      });
      const current = getScript(this.db, scriptId);
      return {
        scriptId,
        name: current?.name ?? script.name,
        version: created.version,
        status: current?.status ?? script.status,
        activeVersion: current?.activeVersion ?? script.activeVersion,
        mode: created.mode,
        warnings,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScriptError(
          'SCRIPT_NAME_CONFLICT',
          `a script named ${JSON.stringify(metadata.name)} already exists`,
        );
      }
      throw error;
    }
  }

  /** Global namespace: every active script is visible; drafts are not (design change). */
  search(input: SearchScriptsInput): ScriptSearchItem[] {
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
    const query = input.query?.trim() ?? '';
    const tags = input.tags ?? [];
    if (query !== '') {
      const match = buildScriptsFtsQuery(query);
      if (match !== null) {
        try {
          const hits = this.searchFts(match, tags, limit);
          // FTS5 tokenization is whole-token/prefix based, so a mid-token
          // substring (e.g. "脚本" in "加法脚本") misses; LIKE keeps P1 behavior.
          if (hits.length > 0) return hits;
        } catch {
          // A MATCH expression SQLite rejects must not become a 500; LIKE still works.
        }
      }
    }
    return this.searchLike(query, tags, limit);
  }

  /** BM25-ranked FTS5 search; filters stay in SQL so drafts never surface. */
  private searchFts(match: string, tags: string[], limit: number): ScriptSearchItem[] {
    const where = ['scripts_fts MATCH ?', "s.status = 'active'", 's.active_version IS NOT NULL'];
    const params: Array<string | number> = [match];
    for (const tag of tags) {
      where.push('s.tags_json LIKE ?');
      params.push(`%${JSON.stringify(tag)}%`);
    }
    params.push(limit);
    return this.db
      .prepare(`
        SELECT s.*, v.input_schema_json AS active_schema_json, v.example_args_json AS active_example_json
        FROM scripts_fts
        JOIN scripts s ON s.rowid = scripts_fts.rowid
        JOIN script_versions v ON v.script_id = s.script_id AND v.version = s.active_version
        WHERE ${where.join(' AND ')}
        ORDER BY ${bm25Expression('scripts_fts', SCRIPT_BM25_WEIGHTS)}, s.updated_at DESC, s.script_id DESC
        LIMIT ?
      `)
      .all(...params)
      .map((row) => toSearchItem(row as Record<string, unknown>));
  }

  private searchLike(query: string, tags: string[], limit: number): ScriptSearchItem[] {
    const where: string[] = ["s.status = 'active'", 's.active_version IS NOT NULL'];
    const params: Array<string | number> = [];
    if (query !== '') {
      where.push('(s.name LIKE ? OR s.description LIKE ? OR s.tags_json LIKE ?)');
      const like = `%${query}%`;
      params.push(like, like, like);
    }
    for (const tag of tags) {
      where.push('s.tags_json LIKE ?');
      params.push(`%${JSON.stringify(tag)}%`);
    }
    params.push(limit);
    return this.db
      .prepare(`
        SELECT s.*, v.input_schema_json AS active_schema_json, v.example_args_json AS active_example_json
        FROM scripts s
        JOIN script_versions v ON v.script_id = s.script_id AND v.version = s.active_version
        WHERE ${where.join(' AND ')}
        ORDER BY s.updated_at DESC, s.script_id DESC
        LIMIT ?
      `)
      .all(...params)
      .map((row) => toSearchItem(row as Record<string, unknown>));
  }

  /**
   * Maps a globally unique script name to its id for `run_script`; null when no
   * script has that name. Lifecycle, version and permission checks stay in
   * `resolveExecution`, so a resolved name cannot bypass them.
   */
  resolveIdByName(name: string): string | null {
    return findScriptByName(this.db, name)?.scriptId ?? null;
  }

  /**
   * Resolves a saved script for `run_script`: lifecycle, version and argument
   * checks, then produces the exact code the sandbox runs. Scripts are global;
   * the call's workspace only selects the execution session. Draft versions are
   * testable only by their owner or an admin; active versions are global.
   */
  resolveExecution(
    input: {
      scriptId: string;
      scriptVersion?: number;
      args?: Record<string, unknown>;
    },
    options: { purpose?: 'run' | 'test'; actor?: ScriptActor } = {},
  ): ResolvedExecution {
    const script = getScript(this.db, input.scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${input.scriptId} was not found`);
    if (script.status === 'disabled') throw new ScriptError('SCRIPT_DISABLED', `script ${input.scriptId} is disabled`);
    if (script.status === 'archived') throw new ScriptError('SCRIPT_ARCHIVED', `script ${input.scriptId} is archived`);

    const versionNumber = input.scriptVersion ?? script.activeVersion;
    if (versionNumber === null) {
      throw new ScriptError('SCRIPT_NOT_ACTIVE', `script ${input.scriptId} has no active version`);
    }
    const version = getScriptVersion(this.db, input.scriptId, versionNumber);
    if (version === null) {
      throw new ScriptError(
        'SCRIPT_VERSION_NOT_FOUND',
        `script ${input.scriptId} has no version ${versionNumber}`,
      );
    }
    if (version.status === 'archived') {
      throw new ScriptError('SCRIPT_ARCHIVED', `script ${input.scriptId} version ${versionNumber} is archived`);
    }
    // A draft is not a public contract yet: only its owner or an admin may run it.
    if (
      version.status === 'draft'
      && (options.actor === undefined || !canManageScript(options.actor, script))
    ) {
      throw forbidden(input.scriptId);
    }

    let args: Record<string, unknown> = {};
    if (version.mode === 'exact') {
      if (input.args !== undefined && Object.keys(input.args).length > 0) {
        throw new ScriptError('SCRIPT_ARGS_INVALID', 'an exact script takes no arguments');
      }
    } else {
      args = validateScriptArgs(version.inputSchema, input.args);
    }

    return {
      script,
      version,
      code: version.mode === 'exact' ? version.code : buildParameterizedCode(version.code, args),
      args,
      purpose: options.purpose ?? (version.status === 'draft' ? 'test' : 'run'),
    };
  }

  /** Activates a version after a successful test; used by `activateOnSuccess`. */
  activate(scriptId: string, version: number, runId: string | null, actor: SaveScriptActor): void {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    if (!canManageScript(actor, script)) throw forbidden(scriptId);
    const target = getScriptVersion(this.db, scriptId, version);
    if (target === null) {
      throw new ScriptError('SCRIPT_VERSION_NOT_FOUND', `script ${scriptId} has no version ${version}`);
    }
    withTransaction(this.db, () => {
      activateScriptVersion(this.db, scriptId, version, runId);
    });
  }

  /** Counts a successful non-test script execution; best effort. */
  noteUsage(scriptId: string): void {
    touchScriptUsage(this.db, scriptId, new Date(this.now()).toISOString());
  }

  list(query: ScriptListQuery): ReturnType<typeof listScripts> {
    return listScripts(this.db, query);
  }

  get(scriptId: string): ScriptRecord | null {
    return getScript(this.db, scriptId);
  }

  /** Admin detail: the script row plus run counts aggregated from `script_runs`. */
  getWithStats(scriptId: string): ScriptRecord | null {
    return getScriptWithStats(this.db, scriptId);
  }

  patch(scriptId: string, patch: ScriptPatch): ScriptRecord {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    try {
      const updated = updateScriptMeta(this.db, scriptId, patch);
      if (updated === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
      return updated;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ScriptError('SCRIPT_NAME_CONFLICT', 'a script with this name already exists');
      }
      throw error;
    }
  }

  versions(scriptId: string): ScriptVersionRecord[] {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    return listScriptVersions(this.db, scriptId);
  }

  version(scriptId: string, version: number): ScriptVersionRecord {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    const found = getScriptVersion(this.db, scriptId, version);
    if (found === null) {
      throw new ScriptError('SCRIPT_VERSION_NOT_FOUND', `script ${scriptId} has no version ${version}`);
    }
    return found;
  }

  /** Admin edit: validates like the agent path and always appends a draft. */
  createVersion(
    scriptId: string,
    input: {
      mode?: VersionMode;
      runId?: string;
      code?: string;
      inputSchema?: Record<string, unknown>;
      exampleArgs?: Record<string, unknown> | null;
      changelog?: string;
    },
  ): ScriptVersionRecord {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    if (script.status === 'archived') throw new ScriptError('SCRIPT_ARCHIVED', `script ${scriptId} is archived`);
    const latest = latestScriptVersion(this.db, scriptId);
    if (latest === null) throw new ScriptError('SCRIPT_VERSION_NOT_FOUND', `script ${scriptId} has no versions`);
    const mode = input.mode ?? script.mode;
    if (mode !== script.mode) {
      throw new ScriptError(
        'SCRIPT_MODE_CONFLICT',
        `script ${scriptId} is ${script.mode}; create a new script to switch modes`,
        { scriptMode: script.mode, requestedMode: mode },
      );
    }
    let code: string;
    let inputSchema: Record<string, unknown>;
    let exampleArgs: Record<string, unknown> | null = null;
    let run: ScriptRunRecord | null;
    let verifiedRunId: string | null = null;
    if (mode === 'exact') {
      // The exact contract matches save_script: the code comes from a successful
      // run, so an admin edit records that run as both source and verification.
      if (input.code !== undefined) {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'exact mode takes its code from the source run; do not submit code',
        );
      }
      if (input.inputSchema !== undefined) {
        if (!isPlainObject(input.inputSchema) || Object.keys(input.inputSchema).length > 0) {
          throw new ScriptError('INVALID_ARGUMENT', 'exact mode only accepts an empty inputSchema');
        }
      }
      if (
        input.exampleArgs !== undefined
        && input.exampleArgs !== null
        && (!isPlainObject(input.exampleArgs) || Object.keys(input.exampleArgs).length > 0)
      ) {
        throw new ScriptError('INVALID_ARGUMENT', 'exact mode does not accept exampleArgs');
      }
      run = this.requireRun(input.runId);
      if (run.entryMode !== 'code' || run.code === null || run.code.trim() === '') {
        throw new ScriptError(
          'INVALID_ARGUMENT',
          'exact mode requires a successful run_script run with saved code',
        );
      }
      code = run.code;
      checkScriptCodeSize(code);
      inputSchema = {};
      verifiedRunId = run.runId;
    } else {
      run = input.runId === undefined || input.runId === '' ? null : this.requireRun(input.runId);
      code = requireCode(input.code);
      if (input.inputSchema === undefined) {
        throw new ScriptError('SCRIPT_INPUT_SCHEMA_INVALID', 'inputSchema is required for parameterized mode');
      }
      inputSchema = validateInputSchema(input.inputSchema);
      compileScriptCode(code);
      if (input.exampleArgs !== undefined && input.exampleArgs !== null) {
        if (!isPlainObject(input.exampleArgs)) {
          throw new ScriptError('SCRIPT_ARGS_INVALID', 'exampleArgs must be an object');
        }
        exampleArgs = validateScriptArgs(inputSchema, input.exampleArgs);
      }
    }
    return withTransaction(this.db, () =>
      insertScriptVersion(this.db, scriptId, {
        mode,
        code,
        inputSchema,
        exampleArgs,
        changelog: input.changelog ?? null,
        createdBy: 'admin',
        sourceRunId: run?.runId ?? null,
        verifiedRunId,
        now: new Date(this.now()).toISOString(),
      }),
    );
  }

  /** Admin activation also serves rollback: any non-archived version may become active. */
  activateVersion(scriptId: string, version: number): ScriptVersionRecord {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    if (script.status === 'archived') throw new ScriptError('SCRIPT_ARCHIVED', `script ${scriptId} is archived`);
    const target = getScriptVersion(this.db, scriptId, version);
    if (target === null) {
      throw new ScriptError('SCRIPT_VERSION_NOT_FOUND', `script ${scriptId} has no version ${version}`);
    }
    if (target.status === 'archived') {
      throw new ScriptError('SCRIPT_ARCHIVED', `script ${scriptId} version ${version} is archived`);
    }
    // Activation is the only path that makes a version callable; an untested
    // draft could be broken, so it must succeed once through run_script first.
    if (target.verifiedRunId === null) {
      throw new ScriptError(
        'SCRIPT_VERSION_NOT_DRAFT',
        `script ${scriptId} version ${version} has no successful test run; run it with run_script before activating`,
      );
    }
    withTransaction(this.db, () => {
      activateScriptVersion(this.db, scriptId, version, target.verifiedRunId);
    });
    return this.version(scriptId, version);
  }

  /** Admin version diff; both versions must exist (design 10 §9.3). */
  diff(scriptId: string, version: number, baseVersion: number): ScriptVersionDiff {
    const from = this.version(scriptId, baseVersion);
    const to = this.version(scriptId, version);
    return {
      fromVersion: from.version,
      toVersion: to.version,
      lines: diffLines(from.code, to.code),
    };
  }

  runs(
    scriptId: string,
    query: { limit: number; cursor?: { createdAt: string; runId: string } | null },
  ): ReturnType<typeof listScriptRuns> {
    const script = getScript(this.db, scriptId);
    if (script === null) throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
    return listScriptRuns(this.db, { scriptId, limit: query.limit, cursor: query.cursor ?? null });
  }
}

/** Maps a script error to the admin HTTP statuses fixed in design 10 §9.3. */
export function scriptErrorStatus(code: ScriptErrorCode): number {
  switch (code) {
    case 'SCRIPT_NOT_FOUND':
    case 'SCRIPT_VERSION_NOT_FOUND':
    case 'SCRIPT_RUN_NOT_FOUND':
    case 'SCRIPT_RUN_EXPIRED':
    case 'SCRIPT_CANDIDATE_NOT_FOUND':
      return 404;
    case 'SCRIPT_VERSION_CONFLICT':
    case 'SCRIPT_NAME_CONFLICT':
    case 'SCRIPT_MODE_CONFLICT':
    case 'SCRIPT_VERSION_NOT_DRAFT':
    case 'SCRIPT_DISABLED':
    case 'SCRIPT_ARCHIVED':
    case 'SCRIPT_NOT_ACTIVE':
    case 'SCRIPT_RUN_NOT_SUCCESSFUL':
    case 'SCRIPT_CANDIDATE_ALREADY_REVIEWED':
      return 409;
    case 'SCRIPT_ARGS_INVALID':
    case 'SCRIPT_INPUT_SCHEMA_INVALID':
    case 'SCRIPT_CODE_INVALID':
    case 'SCRIPT_CANDIDATE_INCOMPLETE':
      return 422;
    case 'SCRIPT_FORBIDDEN':
      return 403;
    case 'INVALID_ARGUMENT':
      return 400;
    default:
      return 400;
  }
}
