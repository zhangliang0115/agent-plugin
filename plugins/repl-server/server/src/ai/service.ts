/**
 * AI service: config, proposal drafting and annotation preview/apply (08 §3–§5).
 *
 * The service owns the runner, the limiter, both in-memory caches and the
 * auto-preview bookkeeping. The admin handler is a thin route layer over this
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
import { getRevision } from '../db/meta.ts';
import { isSeedServer } from '../db/servers.ts';
import { systemClock, type Clock } from '../ports.ts';
import { createAnnotationStore, type PendingAnnotationView } from './annotation-store.ts';
import { applyAnnotation, UnknownToolError, type AnnotationPatch } from './apply.ts';
import {
  AI_AUTO_MIN_INTERVAL_MS,
  AI_INPUT_MAX_BYTES,
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
  /** Marks a server as created by this process so its first `tools/list` may auto-preview. */
  onServerCreated(serverId: string): void;
  /**
   * Called after a `tools/list` write. Returns when the background preview settles,
   * but production callers should not await it: the AI run is bounded by
   * `ai.timeoutMs` and must not block tool indexing.
   */
  onToolsIndexed(serverId: string, options?: { explicit?: boolean }): Promise<void>;
  /** PATCH/refresh/delete: a pending preview built from older metadata is stale. */
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
  log?: (line: string) => void;
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

/** Body shape accepted by `parseCreateServer` (env/header values stay as `$secret`). */
function serverToCreateBody(server: ProposalServer): Record<string, unknown> {
  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command,
    args: server.args,
    cwd: server.cwd,
    url: server.url,
    envKeys: server.envKeys,
    headerKeys: server.headerKeys,
    enabled: server.enabled,
    connectMode: server.connectMode,
    summary: server.summary,
    category: server.category,
    tags: server.tags,
  };
}

/** Prompt view of a server (08 §4.1): keys only, secret args as placeholders. */
function serverPromptView(record: ServerRecord, toolCount: number): Record<string, unknown> {
  return {
    id: record.id,
    label: record.label,
    transport: record.transport,
    command: record.command,
    args: record.args.map((arg) => (typeof arg === 'string' ? arg : `<secret:${arg.$secret}>`)),
    url: record.url,
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
  const createdThisProcess = new Set<string>();
  const lastAutoAt = new Map<string, number>();
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
      log(`ai audit hook failed: ${error instanceof Error ? error.message : String(error)}`);
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
      log(`ai ${input.kind} code=ok durationMs=${run.durationMs} bytes=${resultBytes}`);
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
      log(`ai ${input.kind} code=${code} durationMs=${durationMs} bytes=0`);
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
      log(`ai propose code=${errorCode(error)} durationMs=${run.durationMs} bytes=0`);
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
    // Servers created through this route also qualify for the first-tools-list
    // auto preview (08 §4.7 trigger list).
    createdThisProcess.add(server.id);
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

  async function buildAnnotationPreview(
    serverId: string,
    trigger: 'manual' | 'auto',
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
      );
    } catch (error) {
      emitSuccess(audit, null);
      log(`ai annotate code=${errorCode(error)} durationMs=${run.durationMs} bytes=0`);
      throw error;
    }

    const restricted = restrictAnnotationToDictionary(normalized, dictionaryKeys(dictionaries));
    const warnings = [...restricted.annotation.warnings, ...restricted.dropped];
    if (annotationIsEmpty(restricted.annotation)) {
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
      proposed: proposedView(restricted.annotation),
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
    if (restricted.dropped.length > 0) {
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
      })),
    };
  }

  // -- auto preview ---------------------------------------------------------

  function onServerCreated(serverId: string): void {
    createdThisProcess.add(serverId);
    annotations.deleteByServer(serverId);
    lastAutoAt.delete(serverId);
  }

  function onServerMutated(serverId: string): void {
    annotations.deleteByServer(serverId);
  }

  async function maybeAutoAnnotate(
    serverId: string,
    options: { explicit?: boolean } = {},
  ): Promise<void> {
    const ai = getAiSettings(deps.db);
    if (!ai.enabled || !ai.autoAnnotate) return;
    const explicit = options.explicit === true;
    if (!explicit && !createdThisProcess.has(serverId)) return;

    const record = await deps.servers.get(serverId);
    if (record === null || isBuiltinRecord(record)) return;
    // Only a fully annotated server is skipped: discovery-registered servers arrive
    // with a summary but no category/tags and still need a preview.
    if (
      !emptyText(record.summary) &&
      !emptyText(record.category) &&
      record.tags.length > 0
    ) {
      return;
    }

    const tools = await deps.tools.listByServer(serverId);
    if (tools.length === 0) return;

    const hash = hashTools(tools);
    const pending = annotations.get(serverId);
    if (pending !== null && pending.toolsHash !== hash) annotations.deleteByServer(serverId);
    if (annotations.get(serverId) !== null) return;

    const key = `${serverId}\u0000${hash}`;
    if (annotations.hasAttempt(key)) return;
    const last = lastAutoAt.get(serverId);
    if (last !== undefined && clock.now() - last < AI_AUTO_MIN_INTERVAL_MS) return;

    annotations.markAttempt(key);
    lastAutoAt.set(serverId, clock.now());
    try {
      const preview = await buildAnnotationPreview(serverId, 'auto');
      annotations.put({
        serverId,
        proposed: preview.proposed,
        warnings: preview.warnings,
        omittedTools: preview.omittedTools,
        createdAt: new Date(clock.now()).toISOString(),
        toolsHash: preview.toolsHash,
        meta: preview.meta,
      });
    } catch (error) {
      // Failures are logged and audited by `callModel`; never retried automatically.
      log(`ai annotate auto code=${errorCode(error)} server=${serverId}`);
    }
  }

  /**
   * Auto-preview is best-effort: a database or AI failure here must never break
   * the tool-indexing path that called it.
   */
  async function onToolsIndexed(
    serverId: string,
    options: { explicit?: boolean } = {},
  ): Promise<void> {
    try {
      await maybeAutoAnnotate(serverId, options);
    } catch (error) {
      log(`ai annotate auto skipped code=${errorCode(error)} server=${serverId}`);
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
        log(`ai close failed: ${error instanceof Error ? error.message : String(error)}`);
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
