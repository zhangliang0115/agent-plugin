import type { LogFn } from '../log.ts';
/**
 * AI service: config, proposal drafting and annotation preview/apply (08 §3–§5).
 *
 * The service owns the runner, the limiter, both in-memory caches and the
 * auto-annotation bookkeeping. The admin handler is a thin route layer over this
 * object; assembly injects the stores and the audit sink.
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';

import { readCategoryDictionary, type CategoryDefinition } from '../admin/categories.ts';
import {
  AdminApiError,
  invalidField,
  isPlainObject,
  rejectUnknownFields,
  type ServerConfig,
  type ServerRecord,
  type ServerStore,
  type ServerView,
} from '../admin/servers.ts';
import type { SettingsStore } from '../admin/settings.ts';
import { readTagDictionary, type TagDefinition } from '../admin/tags.ts';
import type { ToolRecord, ToolStore } from '../admin/tools.ts';
import { evaluateTagPolicy } from '../catalog/tag-policy.ts';
import { getRevision } from '../db/meta.ts';
import { isSeedServer } from '../db/servers.ts';
import { systemClock, type Clock } from '../ports.ts';
import {
  createAnnotationStore,
  type PendingAnnotationError,
  type PendingAnnotationMeta,
  type PendingAnnotationView,
} from './annotation-store.ts';
import { applyAnnotation, UnknownToolError, type AnnotationPatch } from './apply.ts';
import { repairAnnotationTags } from './tag-preview.ts';
import {
  AI_AUTO_MIN_INTERVAL_MS,
  AI_INPUT_MAX_BYTES,
  AI_PROMPT_MAX_BYTES,
} from './constants.ts';
import { AiRunnerError } from './errors.ts';
import { createAiLimiter } from './limiter.ts';
import {
  buildAnnotatePrompt,
  buildProposePrompt,
  createPromptNonce,
  PROMPT_VERSION,
} from './prompts.ts';
import { createProposalStore } from './proposal-store.ts';
import { createAiRunner, type AiRunResult, type AiRunner, type SpawnFn } from './runner.ts';
import {
  effectiveAiSettings,
  getAiSettings,
  parseAiSettingsBody,
  putAiSettings,
  type AiSettings,
  type EffectiveAiSettings,
} from './settings.ts';
import { buildToolPromptViews, hashTools } from './tool-view.ts';
import {
  annotationIsEmpty,
  normalizeAnnotation,
  normalizeProposal,
  normalizeProposalServer,
  restrictAnnotationToDictionary,
  scanSecretLiterals,
  toServerConfig,
  type AnnotationDictionaryKeys,
  type DictionarySuggestion,
  type NormalizedAnnotation,
  type NormalizedToolOverride,
  type ProposalServer,
} from './validate.ts';
import { renderServerView } from './view.ts';

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface AiRunAuditEvent {
  event: 'ai_run';
  ts: string;
  identity: 'unbound';
  binding: null;
  client: 'admin';
  clientName: 'admin';
  clientVersion: '';
  mcp: 'admin';
  kind: 'propose' | 'annotate';
  trigger: 'manual' | 'auto';
  serverId: string | null;
  template: 'propose' | 'annotate';
  promptVersion: number;
  promptBytes: number;
  model: string | null;
  durationMs: number;
  outcome: 'ok' | 'error';
  code: string | null;
  resultBytes: number;
  costUsd: number | null;
  proposalId: string | null;
}

/** The subset of `CatalogService` used here; keeps tests free of a full catalog. */
export interface AiCatalog {
  rebuild(changedServers?: readonly string[]): unknown;
}

/**
 * Optional injection point for the admin layer's `parseCreateServer`.
 * `admin/servers.ts` currently keeps it module-private; exporting it (08 §3.6)
 * and passing it here makes apply use the exact manual-registration gate. When
 * absent, the normalized draft is converted with the same field rules.
 */
export type AiParseCreateServer = (
  body: Record<string, unknown>,
  options: { summarySource: 'ai' | 'manual' },
) => ServerConfig;

export interface AiConfigResponse {
  ai: EffectiveAiSettings;
  prompts: { propose: number; annotate: number };
  revision: number;
}

export interface AiConfigWriteResponse {
  ai: EffectiveAiSettings;
  revision: number;
}

export interface ProposeMeta {
  model: string | null;
  durationMs: number;
  promptVersion: number;
  costUsd: number | null;
  expiresAt: string | null;
}

export interface ProposeResponse {
  proposalId: string | null;
  server: ProposalServer | null;
  explanation: string;
  warnings: string[];
  idConflict: boolean;
  inputWarning?: boolean;
  meta: ProposeMeta;
}

export interface AnnotationCurrent {
  summary: string | null;
  summarySource: string | null;
  category: string | null;
  tags: string[];
}

export interface AnnotationProposedView {
  summary: string | null;
  category: string | null;
  categorySuggestion: DictionarySuggestion | null;
  tags: string[];
  tagSuggestions: DictionarySuggestion[];
  toolOverrides: NormalizedToolOverride[];
}

export interface AnnotationPreviewResponse {
  serverId: string;
  current: AnnotationCurrent;
  proposed: AnnotationProposedView;
  warnings: string[];
  omittedTools: number;
  meta: Omit<ProposeMeta, 'expiresAt'>;
}

export interface AnnotationApplyResponse {
  server: ServerView;
  tools: Array<{ name: string; descriptionOverride: string | null; tags: string[] }>;
  revision: number;
  changed: string[];
  /** Values dropped because the dictionary changed since the proposal was made. */
  warnings: string[];
}

export interface AiService {
  getConfig(): Promise<AiConfigResponse>;
  putConfig(body: unknown, expectedRevision: number): Promise<AiConfigWriteResponse>;
  propose(body: unknown): Promise<ProposeResponse>;
  applyProposal(body: unknown): Promise<{ server: ServerView; revision: number }>;
  annotatePreview(serverId: string): Promise<AnnotationPreviewResponse>;
  annotateApply(
    serverId: string,
    applyBody: unknown,
    expectedRevision: number,
  ): Promise<AnnotationApplyResponse>;
  pendingAnnotations(): Promise<{ items: PendingAnnotationView[] }>;
  /** Marks a server as created by this process so its first `tools/list` may auto-annotate. */
  onServerCreated(serverId: string): void;
  /**
   * Called after a `tools/list` write. Returns when the background annotation
   * and apply settle, but production callers should not await it: the AI run is
   * bounded by `ai.timeoutMs` and must not block tool indexing.
   */
  onToolsIndexed(serverId: string): Promise<void>;
  /** PATCH/refresh/delete: a failed auto annotation built from older metadata is stale. */
  onServerMutated(serverId: string): void;
  /**
   * Shuts the AI subsystem down: queued runs are rejected, in-flight
   * `claude -p` process groups are terminated and their run directories are
   * removed. Idempotent; callers may await it more than once.
   */
  close(): Promise<void>;
}

export interface AiServiceDeps {
  db: DatabaseSync;
  servers: ServerStore;
  tools: ToolStore;
  catalog: AiCatalog;
  settings: SettingsStore;
  spawn?: SpawnFn;
  clock?: Clock;
  log?: LogFn;
  dataDir?: string;
  /** Test seam only; never passed by assembly. */
  extraEnv?: Readonly<Record<string, string>>;
  onAiRun?: (event: AiRunAuditEvent) => void;
  /** Test seam; production uses the default 2/4/30s limiter. */
  runner?: AiRunner;
  /** Production wiring: the exported `parseCreateServer` from `admin/servers.ts`. */
  parseCreateServer?: AiParseCreateServer;
  /**
   * Boot id recorded in the AI run ledger. Assembly should pass the same id as
   * the startup sweep; when absent the runner uses one id per server process.
   */
  bootId?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyText(value: string | null): boolean {
  return value === null || value.trim() === '';
}

function isBuiltinRecord(record: ServerRecord): boolean {
  return record.transport === 'builtin' || isSeedServer(record.id);
}

function errorCode(error: unknown): string {
  if (error instanceof AdminApiError) return error.code;
  if (error instanceof AiRunnerError) return error.code;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : 'INTERNAL_ERROR';
}

function toAdminError(error: unknown): Error {
  if (error instanceof AiRunnerError) {
    return new AdminApiError(error.status, error.code, error.message, error.details);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function proposedView(annotation: NormalizedAnnotation): AnnotationProposedView {
  return {
    summary: annotation.summary ?? null,
    category: annotation.category ?? null,
    categorySuggestion: annotation.categorySuggestion ?? null,
    tags: [...(annotation.tags ?? [])],
    tagSuggestions: [...(annotation.tagSuggestions ?? [])],
    toolOverrides: [...(annotation.toolOverrides ?? [])],
  };
}

function toAnnotationPatch(annotation: NormalizedAnnotation): AnnotationPatch {
  const patch: AnnotationPatch = {};
  if (annotation.summary !== undefined) patch.summary = annotation.summary;
  if (annotation.category !== undefined) patch.category = annotation.category;
  if (annotation.categorySuggestion !== undefined) {
    patch.categorySuggestion = annotation.categorySuggestion;
  }
  if (annotation.tags !== undefined) patch.tags = annotation.tags;
  if (annotation.tagSuggestions !== undefined) patch.tagSuggestions = annotation.tagSuggestions;
  if (annotation.toolOverrides !== undefined) patch.toolOverrides = annotation.toolOverrides;
  return patch;
}

function emptyProposed(): AnnotationProposedView {
  return {
    summary: null,
    category: null,
    categorySuggestion: null,
    tags: [],
    tagSuggestions: [],
    toolOverrides: [],
  };
}

/**
 * Automatic apply body (08 §4.5): only missing server fields are filled, so an
 * existing manual summary/category is never overwritten; nulls mean "the model
 * proposed nothing". Suggestions never write the dictionaries, and tool tags
 * may only reference keys that already exist.
 */
function buildAutoApplyBody(
  proposed: AnnotationProposedView,
  current: { summary: string | null; category: string | null },
  dictionaryTags: ReadonlySet<string>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (emptyText(current.summary) && proposed.summary !== null && proposed.summary.trim() !== '') {
    body['summary'] = proposed.summary;
  }
  if (emptyText(current.category) && proposed.category !== null && proposed.category.trim() !== '') {
    body['category'] = proposed.category;
  }
  const tags = proposed.tags.filter((tag) => dictionaryTags.has(tag));
  if (tags.length > 0) body['tags'] = tags;
  const overrides: Array<{ name: string; tags: string[] }> = [];
  for (const override of proposed.toolOverrides) {
    const overrideTags = (override.tags ?? []).filter((tag) => dictionaryTags.has(tag));
    if (overrideTags.length > 0) overrides.push({ name: override.name, tags: overrideTags });
  }
  if (overrides.length > 0) body['toolOverrides'] = overrides;
  return body;
}

const FAILURE_MESSAGE_MAX = 1000;

function annotationFailure(error: unknown): PendingAnnotationError {
  const base = error instanceof Error ? error.message : String(error);
  const details = error instanceof AdminApiError && isPlainObject(error.details) ? error.details : null;
  const detailErrors: string[] = [];
  if (details !== null && Array.isArray(details['errors'])) {
    detailErrors.push(
      ...details['errors'].filter((entry): entry is string => typeof entry === 'string'),
    );
  }
  if (details !== null && Array.isArray(details['tools'])) {
    for (const entry of details['tools']) {
      if (!isPlainObject(entry)) continue;
      const name = typeof entry['name'] === 'string' ? entry['name'] : '?';
      const errors = Array.isArray(entry['errors'])
        ? entry['errors'].filter((value): value is string => typeof value === 'string')
        : [];
      if (errors.length > 0) detailErrors.push(`${name}: ${errors.join('; ')}`);
    }
  }
  const message = detailErrors.length === 0 ? base : `${base}: ${detailErrors.join('; ')}`;
  return {
    code: errorCode(error),
    message:
      message.length > FAILURE_MESSAGE_MAX ? `${message.slice(0, FAILURE_MESSAGE_MAX)}…` : message,
  };
}

interface AnnotationDictionaries {
  categories: CategoryDefinition[];
  tags: TagDefinition[];
}

function dictionaryKeys(dictionaries: AnnotationDictionaries): AnnotationDictionaryKeys {
  return {
    categories: new Set(dictionaries.categories.map((entry) => entry.key)),
    tags: new Set(dictionaries.tags.map((entry) => entry.key)),
  };
}

/** Body shape accepted by `parseCreateServer`; literal env/header values pass through. */
function serverToCreateBody(server: ProposalServer): Record<string, unknown> {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    env: server.env,
    headers: server.headers,
    envKeys: server.envKeys,
    headerKeys: server.headerKeys,
    enabled: server.enabled,
    connectMode: server.connectMode,
    summary: server.summary,
    category: server.category,
    tags: server.tags,
  };
}

/**
 * URL for the prompt (08 §4.1): query and fragment values can carry credentials
 * (e.g. `?token=…`), so only origin, path and parameter names are kept. A URL
 * that cannot be parsed is hidden outright.
 */
function redactUrlForPrompt(value: string | null): string | null {
  if (value === null) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return '<redacted-url>';
  }
  // Only http(s) is a valid transport url; anything else may hide a token in its path.
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return '<redacted-url>';
  const query = [...url.searchParams.keys()]
    .map((name) => `${encodeURIComponent(name)}=<redacted>`)
    .join('&');
  const search = query === '' ? '' : `?${query}`;
  const hash = url.hash === '' ? '' : '#<redacted>';
  return `${url.origin}${url.pathname}${search}${hash}`;
}

/**
 * Prompt view of a server (08 §4.1): keys only. Every literal arg is replaced by
 * `<literal>` so tokens without a known prefix never reach the model; `$secret`
 * refs keep only the name. `argCount` preserves the argument shape.
 */
function serverPromptView(record: ServerRecord, toolCount: number): Record<string, unknown> {
  return {
    id: record.id,
    label: record.label,
    transport: record.transport,
    command: record.command,
    args: record.args.map((arg) =>
      typeof arg === 'string' ? '<literal>' : `<secret:${arg.$secret}>`,
    ),
    argCount: record.args.length,
    url: redactUrlForPrompt(record.url),
    cwd: record.cwd,
    envKeys: Object.keys(record.env).sort(),
    headerKeys: Object.keys(record.headers).sort(),
    category: record.category,
    tags: [...record.tags],
    summary: record.summary,
    summarySource: record.summarySource,
    toolCount,
  };
}

function readProposeInput(body: unknown): string {
  if (!isPlainObject(body)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  rejectUnknownFields(body, new Set(['input']));
  const input = body['input'];
  if (typeof input !== 'string') throw invalidField('input', 'must be a string');
  if (input.trim() === '') {
    throw new AdminApiError(422, 'AI_INPUT_EMPTY', 'input is empty', { field: 'input' });
  }
  const actualBytes = Buffer.byteLength(input, 'utf8');
  if (actualBytes > AI_INPUT_MAX_BYTES) {
    throw new AdminApiError(422, 'AI_INPUT_TOO_LARGE', 'input exceeds the byte limit', {
      maxBytes: AI_INPUT_MAX_BYTES,
      actualBytes,
    });
  }
  return input;
}

function readProposalId(body: Record<string, unknown>): string {
  const id = body['proposalId'];
  if (id === null || id === undefined) {
    throw new AdminApiError(422, 'AI_PROPOSAL_INVALID', 'proposalId is null or missing', {
      errors: ['proposalId is null or missing'],
      fields: ['proposalId'],
    });
  }
  if (typeof id !== 'string') throw invalidField('proposalId', 'must be a string');
  return id;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAiService(deps: AiServiceDeps): AiService {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? ((): void => undefined);
  const runner =
    deps.runner ??
    createAiRunner({
      ...(deps.dataDir === undefined ? {} : { dataDir: deps.dataDir }),
      ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      ...(deps.extraEnv === undefined ? {} : { extraEnv: deps.extraEnv }),
      ...(deps.bootId === undefined ? {} : { bootId: deps.bootId }),
      clock,
      log,
    });
  const limiter = createAiLimiter();
  const proposals = createProposalStore({ clock });
  const annotations = createAnnotationStore({ clock });
  const lastAutoAt = new Map<string, number>();
  /** `(serverId, toolsHash)` keys with a preview between precheck and model run. */
  const autoInFlight = new Set<string>();
  let closePromise: Promise<void> | null = null;

  function ensureEnabled(): AiSettings {
    const ai = getAiSettings(deps.db);
    if (!ai.enabled) {
      throw new AdminApiError(409, 'AI_DISABLED', 'AI is disabled', {
        hint: 'enable AI in the AI configuration tab',
      });
    }
    return ai;
  }

  function auditRun(input: {
    kind: 'propose' | 'annotate';
    trigger: 'manual' | 'auto';
    serverId: string | null;
    promptBytes: number;
    model: string | null;
    durationMs: number;
    outcome: 'ok' | 'error';
    code: string | null;
    resultBytes: number;
    costUsd: number | null;
    proposalId: string | null;
  }): void {
    if (deps.onAiRun === undefined) return;
    const event: AiRunAuditEvent = {
      event: 'ai_run',
      ts: new Date(clock.now()).toISOString(),
      identity: 'unbound',
      binding: null,
      client: 'admin',
      clientName: 'admin',
      clientVersion: '',
      mcp: 'admin',
      kind: input.kind,
      trigger: input.trigger,
      serverId: input.serverId,
      template: input.kind,
      promptVersion: PROMPT_VERSION,
      promptBytes: input.promptBytes,
      model: input.model,
      durationMs: input.durationMs,
      outcome: input.outcome,
      code: input.code,
      resultBytes: input.resultBytes,
      costUsd: input.costUsd,
      proposalId: input.proposalId,
    };
    try {
      deps.onAiRun(event);
    } catch (error) {
      log(`ai audit hook failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error', scope: 'ai' });
    }
  }

  interface AuditBase {
    kind: 'propose' | 'annotate';
    trigger: 'manual' | 'auto';
    serverId: string | null;
    promptBytes: number;
    model: string | null;
    durationMs: number;
    resultBytes: number;
    costUsd: number | null;
  }

  function emitSuccess(base: AuditBase, proposalId: string | null): void {
    auditRun({ ...base, outcome: 'ok', code: null, proposalId });
  }

  /**
   * Runs one model call through the limiter and maps runner failures to admin
   * errors. Success is audited by the caller once the proposal id is known, so
   * exactly one `ai_run` event is written per run.
   */
  async function callModel(input: {
    kind: 'propose' | 'annotate';
    trigger: 'manual' | 'auto';
    serverId: string | null;
    prompt: string;
    ai: AiSettings;
  }): Promise<{ run: AiRunResult; audit: AuditBase }> {
    const started = clock.now();
    const effective = effectiveAiSettings(input.ai);
    const promptBytes = Buffer.byteLength(input.prompt, 'utf8');
    try {
      const run = await limiter.run(() =>
        runner.run(input.prompt, {
          claudeBin: effective.effectiveClaudeBin,
          model: input.ai.model,
          timeoutMs: input.ai.timeoutMs,
        }),
      );
      const resultBytes = Buffer.byteLength(run.resultText, 'utf8');
      log('ai run finished', { scope: 'ai', kind: input.kind, code: 'ok', durMs: run.durationMs, bytes: resultBytes });
      return {
        run,
        audit: {
          kind: input.kind,
          trigger: input.trigger,
          serverId: input.serverId,
          promptBytes,
          model: run.model,
          durationMs: run.durationMs,
          resultBytes,
          costUsd: run.costUsd,
        },
      };
    } catch (error) {
      const mapped = toAdminError(error);
      const durationMs = Math.max(0, clock.now() - started);
      const code = errorCode(mapped);
      auditRun({
        kind: input.kind,
        trigger: input.trigger,
        serverId: input.serverId,
        promptBytes,
        model: input.ai.model,
        durationMs,
        outcome: 'error',
        code,
        resultBytes: 0,
        costUsd: null,
        proposalId: null,
      });
      log('ai run failed', { level: 'error', scope: 'ai', kind: input.kind, code, durMs: durationMs, bytes: 0 });
      throw mapped;
    }
  }

  // -- config ---------------------------------------------------------------

  async function getConfig(): Promise<AiConfigResponse> {
    const ai = getAiSettings(deps.db);
    let revision: number;
    try {
      revision = (await deps.settings.read()).revision;
    } catch {
      // A corrupt sibling settings row must not break GET /ai/config.
      revision = getRevision(deps.db);
    }
    return {
      ai: effectiveAiSettings(ai),
      prompts: { propose: PROMPT_VERSION, annotate: PROMPT_VERSION },
      revision,
    };
  }

  async function putConfig(
    body: unknown,
    expectedRevision: number,
  ): Promise<AiConfigWriteResponse> {
    const input = parseAiSettingsBody(body);
    const { ai, revision } = putAiSettings(deps.db, input, expectedRevision);
    return { ai: effectiveAiSettings(ai), revision };
  }

  // -- proposal -------------------------------------------------------------

  async function propose(body: unknown): Promise<ProposeResponse> {
    const ai = ensureEnabled();
    const inputText = readProposeInput(body);
    const dictionaries = await annotationDictionaries();
    const prompt = buildProposePrompt(inputText, dictionaries, createPromptNonce());
    const { run, audit } = await callModel({
      kind: 'propose',
      trigger: 'manual',
      serverId: null,
      prompt,
      ai,
    });

    let normalized;
    try {
      normalized = normalizeProposal(run.payload);
    } catch (error) {
      emitSuccess(audit, null);
      log('ai proposal rejected', { level: 'error', scope: 'ai', kind: 'propose', code: errorCode(error), durMs: run.durationMs });
      throw error;
    }

    const warnings = [...normalized.warnings];
    const inputWarning = scanSecretLiterals(inputText).length > 0;
    if (inputWarning) {
      warnings.push('输入可能包含字面密钥，已发送给模型；建议改用 $secret');
    }

    let proposalId: string | null = null;
    let expiresAt: string | null = null;
    let idConflict = false;
    if (normalized.server !== null) {
      idConflict = (await deps.servers.get(normalized.server.id)) !== null;
      const stored = proposals.put({
        server: normalized.server,
        explanation: normalized.explanation,
        warnings,
      });
      proposalId = stored.id;
      expiresAt = new Date(stored.expiresAt).toISOString();
    }

    const response: ProposeResponse = {
      proposalId,
      server: normalized.server,
      explanation: normalized.explanation,
      warnings,
      idConflict,
      meta: {
        model: run.model,
        durationMs: run.durationMs,
        promptVersion: PROMPT_VERSION,
        costUsd: run.costUsd,
        expiresAt,
      },
    };
    emitSuccess(audit, proposalId);
    if (inputWarning) response.inputWarning = true;
    return response;
  }

  async function applyProposal(
    body: unknown,
  ): Promise<{ server: ServerView; revision: number }> {
    ensureEnabled();
    if (!isPlainObject(body)) {
      throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
    }
    rejectUnknownFields(body, new Set(['proposalId', 'server', 'confirmStdio']));
    const proposalId = readProposalId(body);

    const lookup = proposals.lookup(proposalId);
    if (lookup.kind === 'missing') {
      throw new AdminApiError(404, 'AI_PROPOSAL_NOT_FOUND', 'proposal not found', {
        proposalId,
      });
    }
    if (lookup.kind === 'expired') {
      throw new AdminApiError(409, 'AI_PROPOSAL_EXPIRED', 'proposal has expired', {
        expiresAt: new Date(lookup.proposal.expiresAt).toISOString(),
      });
    }

    // Re-run the same validation even for a cached draft: the client may edit it.
    const submitted = body['server'];
    const server =
      submitted === undefined || submitted === null
        ? normalizeProposalServer(lookup.proposal.server)
        : normalizeProposalServer(submitted);

    if (server.transport === 'stdio' && body['confirmStdio'] !== true) {
      throw new AdminApiError(
        422,
        'STDIO_CONFIRM_REQUIRED',
        'stdio servers execute a command; confirmStdio must be true',
        { command: server.command, argCount: server.args.length },
      );
    }

    if ((await deps.servers.get(server.id)) !== null) {
      throw new AdminApiError(409, 'SERVER_EXISTS', `server ${server.id} already exists`, {
        serverId: server.id,
      });
    }

    let created;
    try {
      const config: ServerConfig =
        deps.parseCreateServer === undefined
          ? toServerConfig(server)
          : deps.parseCreateServer(serverToCreateBody(server), { summarySource: 'ai' });
      created = await deps.servers.create(config);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'CONFLICT') {
        throw new AdminApiError(409, 'SERVER_EXISTS', `server ${server.id} already exists`, {
          serverId: server.id,
        });
      }
      throw error;
    }

    proposals.take(proposalId);
    deps.catalog.rebuild([server.id]);
    return { server: renderServerView(created.server), revision: created.revision };
  }

  // -- annotation -----------------------------------------------------------

  async function annotationDictionaries(): Promise<AnnotationDictionaries> {
    const { settings } = await deps.settings.read();
    return {
      categories: readCategoryDictionary(settings),
      tags: readTagDictionary(settings),
    };
  }

  async function loadAnnotatable(
    serverId: string,
  ): Promise<{ record: ServerRecord; tools: ToolRecord[] }> {
    const record = await deps.servers.get(serverId);
    if (record === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${serverId} does not exist`, {
        serverId,
      });
    }
    if (isBuiltinRecord(record)) {
      throw new AdminApiError(422, 'SERVER_NOT_ANNOTATABLE', `server ${serverId} is built in`, {
        serverId,
      });
    }
    return { record, tools: await deps.tools.listByServer(serverId) };
  }

  /**
   * Builds the annotate prompt and runs the model. `onPrecheckPassed` fires once
   * the size cap passed and right before the model call; automatic runs use it to
   * claim the `(serverId, toolsHash)` attempt without burning it on a 422.
   */
  async function buildAnnotationPreview(
    serverId: string,
    trigger: 'manual' | 'auto',
    onPrecheckPassed?: () => void,
  ): Promise<AnnotationPreviewResponse & { toolsHash: string }> {
    const ai = ensureEnabled();
    const { record, tools } = await loadAnnotatable(serverId);
    const dictionaries = await annotationDictionaries();
    const views = buildToolPromptViews(tools);
    const promptResult = buildAnnotatePrompt(
      serverPromptView(record, tools.length),
      views,
      dictionaries,
      createPromptNonce(),
    );
    // The server view alone can exceed the cap when the 64 KiB trim has no tools
    // left to drop; reject before spending a model call and never echo the view.
    const actualBytes = Buffer.byteLength(promptResult.prompt, 'utf8');
    if (actualBytes > AI_PROMPT_MAX_BYTES) {
      throw new AdminApiError(422, 'AI_PROMPT_TOO_LARGE', 'annotate prompt exceeds the byte limit', {
        limitBytes: AI_PROMPT_MAX_BYTES,
        actualBytes,
      });
    }
    onPrecheckPassed?.();
    const { run, audit } = await callModel({
      kind: 'annotate',
      trigger,
      serverId,
      prompt: promptResult.prompt,
      ai,
    });

    let normalized: NormalizedAnnotation;
    try {
      normalized = normalizeAnnotation(
        run.payload,
        tools.map((tool) => tool.name),
        { truncateTagCounts: true },
      );
    } catch (error) {
      emitSuccess(audit, null);
      log('ai annotation rejected', { level: 'error', scope: 'ai', kind: 'annotate', code: errorCode(error), durMs: run.durationMs });
      throw error;
    }

    const restricted = restrictAnnotationToDictionary(normalized, dictionaryKeys(dictionaries));
    const repaired = repairAnnotationTags(
      restricted.annotation,
      record.tags,
      new Map(tools.map((tool) => [tool.name, tool.tags])),
    );
    const warnings = [
      ...repaired.annotation.warnings,
      ...restricted.dropped,
      ...repaired.warnings,
    ];
    if (annotationIsEmpty(repaired.annotation)) {
      warnings.push('AI 未给出可应用的标注');
    }
    emitSuccess(audit, null);

    return {
      serverId,
      current: {
        summary: record.summary,
        summarySource: record.summarySource,
        category: record.category,
        tags: [...record.tags],
      },
      proposed: proposedView(repaired.annotation),
      warnings,
      omittedTools: promptResult.omittedTools,
      meta: {
        model: run.model,
        durationMs: run.durationMs,
        promptVersion: PROMPT_VERSION,
        costUsd: run.costUsd,
      },
      toolsHash: hashTools(tools),
    };
  }

  async function annotatePreview(serverId: string): Promise<AnnotationPreviewResponse> {
    const preview = await buildAnnotationPreview(serverId, 'manual');
    const { toolsHash: _toolsHash, ...response } = preview;
    return response;
  }

  async function annotateApply(
    serverId: string,
    applyBody: unknown,
    expectedRevision: number,
  ): Promise<AnnotationApplyResponse> {
    ensureEnabled();
    await loadAnnotatable(serverId);

    if (!isPlainObject(applyBody)) throw invalidField('apply', 'must be an object');
    if (Object.keys(applyBody).length === 0) {
      throw new AdminApiError(422, 'EMPTY_PATCH', 'apply does not change anything');
    }

    const tools = await deps.tools.listByServer(serverId);
    const normalized = normalizeAnnotation(
      applyBody,
      tools.map((tool) => tool.name),
    );
    const dictionaries = await annotationDictionaries();
    const restricted = restrictAnnotationToDictionary(normalized, dictionaryKeys(dictionaries));
    // The dictionary may have changed after the preview was generated (entries
    // deleted). Apply the remaining values and report the drops, exactly like
    // the preview does; only reject when nothing is left to write.
    if (restricted.dropped.length > 0 && annotationIsEmpty(restricted.annotation)) {
      throw new AdminApiError(
        422,
        'AI_ANNOTATION_INVALID',
        restricted.dropped.join('; '),
        { errors: restricted.dropped },
      );
    }

    let result;
    try {
      result = applyAnnotation(
        deps.db,
        { serverId, patch: toAnnotationPatch(restricted.annotation) },
        expectedRevision,
      );
    } catch (error) {
      if (error instanceof UnknownToolError) {
        throw new AdminApiError(422, 'AI_UNKNOWN_TOOL', 'annotation references unknown tools', {
          names: error.names,
        });
      }
      throw error;
    }

    if (result.changed.length > 0) deps.catalog.rebuild([serverId]);
    annotations.deleteByServer(serverId);

    const updated = await deps.servers.get(serverId);
    if (updated === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${serverId} does not exist`, {
        serverId,
      });
    }
    const updatedTools = await deps.tools.listByServer(serverId);
    return {
      server: renderServerView(updated),
      tools: updatedTools.map((tool) => ({
        name: tool.name,
        descriptionOverride: tool.descriptionOverride,
        tags: [...tool.tags],
      })),
      revision: result.revision,
      changed: result.changed,
      warnings: [...restricted.dropped, ...result.warnings],
    };
  }

  async function pendingAnnotations(): Promise<{ items: PendingAnnotationView[] }> {
    return {
      items: annotations.list().map((entry) => ({
        serverId: entry.serverId,
        proposed: entry.proposed,
        warnings: entry.warnings,
        omittedTools: entry.omittedTools,
        createdAt: entry.createdAt,
        error: entry.error,
      })),
    };
  }

  // -- auto annotation ------------------------------------------------------

  function onServerCreated(serverId: string): void {
    annotations.deleteByServer(serverId);
    lastAutoAt.delete(serverId);
  }

  function onServerMutated(serverId: string): void {
    annotations.deleteByServer(serverId);
  }

  function recordAutoFailure(input: {
    serverId: string;
    proposed: AnnotationProposedView;
    warnings: string[];
    omittedTools: number;
    toolsHash: string;
    meta: PendingAnnotationMeta;
    error: unknown;
  }): void {
    const failure = annotationFailure(input.error);
    annotations.put({
      serverId: input.serverId,
      // A retry goes through the manual apply endpoint; drop the dictionary
      // suggestions so it cannot add new keys that only the automatic path skipped.
      proposed: {
        ...input.proposed,
        categorySuggestion: null,
        tagSuggestions: [],
      },
      warnings: input.warnings,
      omittedTools: input.omittedTools,
      createdAt: new Date(clock.now()).toISOString(),
      toolsHash: input.toolsHash,
      meta: input.meta,
      error: failure,
    });
    log('ai auto annotation queued as failed', {
      level: 'warn',
      scope: 'ai',
      kind: 'annotate',
      server: input.serverId,
      source: 'auto',
      code: failure.code,
    });
  }

  /**
   * Applies an auto annotation through the same transaction and validation as
   * the manual endpoint. The server row is re-read before each attempt so a
   * concurrent edit to summary/category is never overwritten, and the revision
   * is read immediately before the transaction; one conflict is retried.
   * Returns null when there is nothing left to fill.
   */
  async function applyAutoAnnotation(
    serverId: string,
    buildBody: (current: { summary: string | null; category: string | null }) => Record<string, unknown>,
  ): Promise<AnnotationApplyResponse | null> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const current = await deps.servers.get(serverId);
      if (current === null) {
        throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${serverId} does not exist`, {
          serverId,
        });
      }
      const body = buildBody({ summary: current.summary, category: current.category });
      if (Object.keys(body).length === 0) return null;
      try {
        return await annotateApply(serverId, body, getRevision(deps.db));
      } catch (error) {
        lastError = error;
        if (errorCode(error) !== 'REVISION_CONFLICT') throw error;
      }
    }
    throw lastError;
  }

  async function maybeAutoAnnotate(serverId: string): Promise<void> {
    const ai = getAiSettings(deps.db);
    if (!ai.enabled || !ai.autoAnnotate) return;

    const record = await deps.servers.get(serverId);
    if (record === null || isBuiltinRecord(record)) return;

    const tools = await deps.tools.listByServer(serverId);
    if (tools.length === 0) return;

    // Server tags may be empty: completeness is judged by each enabled tool's
    // effective tags (server ∪ tool) against the shared tag policy. A server that
    // only needs its migrated tags to stay empty is therefore skipped.
    if (
      !emptyText(record.summary) &&
      !emptyText(record.category) &&
      tools.every(
        (tool) => !tool.enabled || evaluateTagPolicy(record.tags, tool.tags).issues.length === 0,
      )
    ) {
      return;
    }

    const hash = hashTools(tools);
    const pending = annotations.get(serverId);
    if (pending !== null && pending.toolsHash !== hash) annotations.deleteByServer(serverId);
    if (annotations.get(serverId) !== null) return;

    const key = `${serverId}\u0000${hash}`;
    if (annotations.hasAttempt(key) || autoInFlight.has(key)) return;
    const last = lastAutoAt.get(serverId);
    if (last !== undefined && clock.now() - last < AI_AUTO_MIN_INTERVAL_MS) return;

    // `markAttempt` is the cross-run budget, so it is claimed only after the
    // precheck passes; `autoInFlight` is the concurrency lock that keeps two
    // simultaneous `tools/list` calls from both reaching the model.
    autoInFlight.add(key);
    lastAutoAt.set(serverId, clock.now());
    let attemptClaimed = false;
    try {
      const preview = await buildAnnotationPreview(serverId, 'auto', () => {
        annotations.markAttempt(key);
        attemptClaimed = true;
      });
      const dictionaries = await annotationDictionaries();
      const dictionaryTags = dictionaryKeys(dictionaries).tags;
      try {
        const applied = await applyAutoAnnotation(serverId, (current) =>
          buildAutoApplyBody(preview.proposed, current, dictionaryTags),
        );
        if (applied === null) {
          log('ai auto annotation has nothing to apply', {
            scope: 'ai',
            kind: 'annotate',
            server: serverId,
            source: 'auto',
          });
          return;
        }
        log('ai auto annotation applied', {
          scope: 'ai',
          kind: 'annotate',
          server: serverId,
          source: 'auto',
          changed: applied.changed.join(',') || 'none',
          warnings: applied.warnings.join('; ') || 'none',
        });
      } catch (error) {
        recordAutoFailure({
          serverId,
          proposed: preview.proposed,
          warnings: preview.warnings,
          omittedTools: preview.omittedTools,
          toolsHash: preview.toolsHash,
          meta: preview.meta,
          error,
        });
      }
    } catch (error) {
      // Precheck failures leave no attempt behind, so they retry on the next
      // tools/list. Failures after the attempt claim are queued instead: the
      // attempt set would prevent an automatic retry anyway.
      if (attemptClaimed) {
        recordAutoFailure({
          serverId,
          proposed: emptyProposed(),
          warnings: [],
          omittedTools: 0,
          toolsHash: hash,
          meta: {
            model: null,
            durationMs: 0,
            promptVersion: PROMPT_VERSION,
            costUsd: null,
          },
          error,
        });
      } else {
        log('ai auto annotate failed', {
          level: 'warn',
          scope: 'ai',
          kind: 'annotate',
          server: serverId,
          code: errorCode(error),
        });
      }
    } finally {
      autoInFlight.delete(key);
    }
  }

  /**
   * Auto-preview is best-effort: a database or AI failure here must never break
   * the tool-indexing path that called it.
   */
  async function onToolsIndexed(serverId: string): Promise<void> {
    try {
      await maybeAutoAnnotate(serverId);
    } catch (error) {
      log('ai auto annotate skipped', { level: 'warn', scope: 'ai', kind: 'annotate', server: serverId, code: errorCode(error) });
    }
  }

  function close(): Promise<void> {
    if (closePromise !== null) return closePromise;
    // Reject queued runs first so no new `claude -p` spawns while the runner
    // terminates the ones already in flight.
    limiter.close();
    closePromise = Promise.resolve()
      .then(() => runner.close())
      .catch((error: unknown) => {
        log(`ai close failed: ${error instanceof Error ? error.message : String(error)}`, { level: 'error', scope: 'ai' });
      });
    return closePromise;
  }

  return {
    getConfig,
    putConfig,
    propose,
    applyProposal,
    annotatePreview,
    annotateApply,
    pendingAnnotations,
    onServerCreated,
    onToolsIndexed,
    onServerMutated,
    close,
  };
}
