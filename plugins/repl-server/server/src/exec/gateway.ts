import { createLog, type LogFn } from '../log.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';

import {
  DEFAULT_TASK_CAPACITY,
  ExecSession,
  KeyedGate,
  LIMITS,
  McpToolError,
  TaskStore,
  clampBashArgs,
  formatUserError,
  hardStop,
  newId,
  normalizeOutput,
  ReplError,
  renderEnvelope,
  resolveEvalTimeout,
  runEval,
  Sandbox,
  type EvalExecutor,
  type EvalSettlement,
  type ConcurrencyPolicy,
  type OutputDocument,
  type OutputImage,
  type OutputLimits,
  type StructuredToolError,
  type ToolCallRequest,
} from '@zhangliang0115/repl-server-core';

import type {
  Catalog,
  CatalogTool,
  Clock,
  ExecutionGateway,
  InFlightEvalView,
  InFlightEvalsView,
  RequestIdentity,
  ScriptOutcome,
  ScriptRequest,
  TaskSnapshot,
  ToolCallObservation,
  ToolWaitReason,
} from '../ports.ts';
import { resolveWorkspace, type WorkspaceFileSystem } from '../sessions/workspace.ts';
import { canonicalToolName as catalogToolName } from '../tools/registry.ts';
import { type CapacityLimits } from './capacity.ts';
import { bashConcurrency } from './bash-classify.ts';
import type { ArchiveRunOptions } from '../scripts/service.ts';
import { redactSecrets, secretWarningsOf } from '../scripts/security/secrets.ts';
import {
  ExecSessionRegistry,
  type ExecSession as ExecSessionRecord,
  type SessionRemovalReason,
} from './exec-sessions.ts';

/** Official tools that can write the workspace, keyed by their target path. */
const FILE_WRITERS: ReadonlySet<string> = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/** L1 per-call defaults (design 02 §1.1): file-class and other official tools, Bash, MCP. */
export interface ToolCallTimeouts {
  officialMs: number;
  bashMs: number;
  mcpMs: number;
}

export const DEFAULT_TOOL_CALL_TIMEOUTS: Readonly<ToolCallTimeouts> = Object.freeze({
  officialMs: 30_000,
  bashMs: 120_000,
  mcpMs: 60_000,
});

/**
 * One tool call's exit into the transport. `signal` is the call-level abort
 * (eval cancellation, L1 deadline); `deadline` is the absolute epoch-ms budget.
 * `observation` lets a transport report where the call waited, since the pool's
 * gates sit below this layer.
 */
export type CallToolTransport = (
  call: ToolCallRequest,
  workspace?: string,
  binding?: string | null,
  signal?: AbortSignal,
  deadline?: number,
  execSessionId?: string,
  observation?: ToolCallObservation,
) => Promise<unknown>;

/** The gone execution session handed to {@link ExecGatewayOptions.onSessionClosed}. */
export interface ClosedExecutionSession {
  readonly id: string;
  readonly mcpSessionId: string;
  readonly binding: string | null;
  readonly workspace: string;
}

/** Idle thresholds from design 03 §2.3. Tests shrink them. */
export const EXEC_IDLE_HIBERNATE_MS = 10 * 60_000;
export const EXEC_IDLE_RECYCLE_MS = 60 * 60_000;
export const SERVE_IDLE_RELEASE_MS = 15 * 60_000;

export interface IdleSweepOptions {
  /** Terminate the worker, keep the session and its last snapshot. */
  hibernateMs?: number;
  /** Dispose worker/serve and drop the session; the task table stays. */
  recycleMs?: number;
  /** Release the serve handle; the next tool call re-acquires it. */
  releaseServeMs?: number;
}

export interface IdleSweepResult {
  hibernated: number;
  recycled: number;
  serveReleased: number;
}

/** Process-wide task retention that follows the capacity model. */
export function taskCapacityFor(limits: CapacityLimits): number {
  return Math.max(DEFAULT_TASK_CAPACITY, limits.maxExecSessions * limits.maxInFlightEvalsPerExecSession);
}

/** Per-owner task retention that follows the capacity model (4 × 8 = 32 by default). */
export function taskOwnerCapacityFor(limits: CapacityLimits): number {
  return Math.max(1, limits.maxExecSessionsPerBinding * limits.maxInFlightEvalsPerExecSession);
}

/**
 * Serve health/restart seam, resolved per execution session. The assembly
 * implements it over the `ServeRuntime` entry that belongs to that session.
 */
export interface ServeHealthHooks {
  healthy(execSessionId: string): boolean;
  restart(execSessionId: string): Promise<void> | void;
}

export interface ExecGatewayOptions {
  /** Executes one tool call from inside a script. `workspace` is the realpath exec-session key. */
  callTool: CallToolTransport;
  /**
   * Catalog snapshot used to resolve `excludeTags`. When omitted, an eval that
   * asks for tag exclusions fails instead of silently exposing every tool.
   */
  catalog?: Catalog;
  /** Optional healthy/restart hooks for the serve process, keyed by execution session. */
  serve?: ServeHealthHooks;
  /** Audit sink for eval and tool-call events; failures must never break an eval. */
  onAudit?: (event: Record<string, unknown> & { event: string }) => void;
  /**
   * Called when an execution session is torn down, and when an idle session's
   * serve handle is released (the session itself stays). `session` identifies
   * the exact execution session whose handle must go.
   */
  onSessionClosed?: (
    workspace: string,
    session?: ClosedExecutionSession,
  ) => Promise<void> | void;
  now?: () => number;
  /** Clock for quota/idle bookkeeping; defaults to `now`. */
  clock?: Clock;
  /** Task retention; defaults to `LIMITS.taskTtlMs` (9,000,000 ms). */
  ttlMs?: number;
  /** Legacy alias for `limits.maxInFlightEvalsPerExecSession`. */
  maxInFlight?: number;
  /** Capacity overrides (design 03 §2.6); tests shrink them. */
  limits?: Partial<CapacityLimits>;
  /** realpath/stat seam for workspace resolution; tests inject a fake. */
  workspaceFs?: WorkspaceFileSystem;
  /** L1 defaults; tests shrink them. */
  toolTimeouts?: Partial<ToolCallTimeouts>;
  /**
   * Wall applied when `timeout` is omitted, so a script that awaits forever
   * cannot hold an eval slot indefinitely. 0 disables it. Defaults to
   * `REPL_DEFAULT_MAX_EVAL_MS`, or 0 (no wall) when that is unset.
   */
  defaultMaxEvalMs?: number;
  /** L5 overrides; tests shrink the media caps. */
  outputLimits?: Partial<OutputLimits>;
  /** Task table injection; defaults to a private store using `ttlMs`. */
  taskStore?: TaskStore;
  /** Structured log sink; defaults to `console.warn` for the few diagnostics here. */
  log?: LogFn;
  /**
   * Execution archive sink (design 10 §6.1). Called once per settled eval; a
   * throw is logged and never changes the eval result.
   */
  onScriptRun?: (record: ArchiveRunOptions) => void;
}

/** The narrowing carried by one `run_script` call into the eval it starts. */
interface PendingEvalFilter {
  /** Canonical names allowed; `undefined` disables name narrowing. */
  readonly visible: ReadonlySet<string> | undefined;
  readonly excludeTags: ReadonlySet<string>;
}

/** One eval's resolved filter: tag exclusions are expanded against the catalog. */
interface EvalToolFilter {
  readonly visible: ReadonlySet<string> | undefined;
  readonly excludedByTag: ReadonlySet<string>;
}

/** One eval's media, deduplicated and later capped by `normalizeOutput`. */
interface EvalMedia {
  readonly images: OutputImage[];
  readonly documents: OutputDocument[];
  /** Base64 payloads already seen; the strings are shared, not copied. */
  readonly seenImages: Set<string>;
  readonly seenDocuments: Set<string>;
}

/** What `filteredExecutor` reads from the ALS around one `runEval` call. */
interface EvalDispatchContext {
  readonly filter: PendingEvalFilter | undefined;
  readonly binding: string | null;
  /** Absolute epoch-ms deadline, used as the L1 upper bound; absent when the eval has none. */
  readonly deadline?: number;
  /** Correlation id shared by the eval events and every tool call inside this eval. */
  readonly runId?: string;
}

/** One execution session plus the per-eval context of the evals running in it. */
interface SessionRuntime {
  readonly record: ExecSessionRecord<SessionRuntime, unknown>;
  session: ExecSession;
  readonly filters: Map<number, EvalToolFilter>;
  /** Binding id of the client that owns each running eval; `null` when unbound. */
  readonly bindings: Map<number, string | null>;
  readonly deadlines: Map<number, number>;
  /** Correlation id of each running eval, stamped into its tool events. */
  readonly runIds: Map<number, string>;
  readonly media: Map<number, EvalMedia>;
  /** Canonical tool names each eval called; archived as `tools_used_json`. */
  readonly toolsUsed: Map<number, Set<string>>;
  /** Set once the idle sweep hibernated this runtime; reset when the next eval begins. */
  hibernated: boolean;
  /** Set once the idle sweep released this runtime's serve handle; reset with `hibernated`. */
  serveReleased: boolean;
}

interface TaskLink {
  readonly sessionId: string;
  readonly owner: string;
}

function canonicalToolName(call: ToolCallRequest): string {
  return call.server === undefined ? call.tool : `${call.server}.${call.tool}`;
}

/** Catalog server id for the official Claude Code tools; their calls carry no `server`. */
const OFFICIAL_TOOL_SERVER = '__official__';

function toolServer(call: ToolCallRequest): string {
  return call.server ?? OFFICIAL_TOOL_SERVER;
}

/** Error texts that mean the model sent the wrong argument shape (docs/triage-log.md). */
const ARGUMENT_ERROR_PATTERN =
  /validation error|missing required argument|unexpected keyword argument|invalid arguments|no argument is passed|required parameter|requires explicit/i;

const ARGUMENT_HINT_PREFIX = '[repl-server] expected arguments for';

/**
 * Names the tool's catalog fields inside an argument-shape failure, so the model
 * can correct the call in the same turn instead of guessing again. Names only,
 * never the schema; anything else (timeout, cancel, transport, no schema) is
 * returned untouched. Appending the prefix once keeps a rethrow from doubling it.
 */
function annotateArgumentError(
  catalog: Catalog | undefined,
  call: ToolCallRequest,
  error: unknown,
): unknown {
  if (call.server === undefined || !(error instanceof McpToolError)) return error;
  if (!ARGUMENT_ERROR_PATTERN.test(error.message)) return error;
  if (error.message.includes(ARGUMENT_HINT_PREFIX)) return error;
  const tool = catalog
    ?.snapshot()
    .tools.find((item) => catalogToolName(item) === canonicalToolName(call));
  const schema = tool?.inputSchema;
  if (!isRecord(schema)) return error;
  const properties = schema['properties'];
  if (!isRecord(properties)) return error;
  const available = Object.keys(properties);
  if (available.length === 0) return error;
  const requiredValue = schema['required'];
  const required = Array.isArray(requiredValue)
    ? requiredValue.filter((item): item is string => typeof item === 'string')
    : [];
  const requiredText = required.length === 0 ? 'none' : required.join(', ');
  error.message =
    `${error.message}\n${ARGUMENT_HINT_PREFIX} ${call.server}.${call.tool}: ` +
    `required: ${requiredText}; available: ${available.join(', ')}`;
  return error;
}

/** Correlation and identity fields shared by the tool events of one eval. */
function runFields(runtime: SessionRuntime, evalId: number): Record<string, unknown> {
  const runId = runtime.runIds.get(evalId);
  const record = runtime.record;
  return {
    exec: record.id,
    mcp: record.mcpSessionId,
    binding: record.binding,
    ...(record.clientLabel === '' ? {} : { client: record.clientLabel }),
    ...(runId === undefined ? {} : { runId }),
  };
}

/** Serialized byte length for audit metadata; never throws on hostile values. */
function jsonBytes(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text === undefined ? undefined : Buffer.byteLength(text, 'utf8');
  } catch {
    return undefined;
  }
}

/** Script args summary shared by audit events, task views and `script_runs.args_preview`. */
const SCRIPT_ARGS_PREVIEW_MAX = 512;

/**
 * Redaction runs before truncation so a cut never leaves a partial credential
 * that the scanner can no longer recognize. The full `args_json` stays raw.
 */
function argsPreviewOf(args: Record<string, unknown> | undefined): string | undefined {
  if (args === undefined) return undefined;
  try {
    const json = JSON.stringify(args);
    if (json === undefined) return undefined;
    return redactSecrets(json).slice(0, SCRIPT_ARGS_PREVIEW_MAX);
  } catch {
    return undefined;
  }
}

/** Machine-readable error code when the thrown value carries one. */
function errorCodeOf(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && code !== '') return code;
  }
  return undefined;
}

/** Age at which the oldest in-flight eval is reported as stuck. */
export const STUCK_EVAL_WARN_MS = 30 * 60_000;

/** Grace for a cooperative eval cancel before its worker is forcibly stopped. */
export const EVAL_CANCEL_GRACE_MS = 2_000;

/**
 * The oldest eval in `items` once its age reaches `thresholdMs`, otherwise
 * `null`. Pure so the watchdog threshold is testable without timers.
 */
export function stuckEvalOf(
  items: readonly InFlightEvalView[],
  thresholdMs: number = STUCK_EVAL_WARN_MS,
): InFlightEvalView | null {
  let oldest: InFlightEvalView | undefined;
  for (const item of items) {
    if (oldest === undefined || item.startedAt < oldest.startedAt) oldest = item;
  }
  return oldest !== undefined && oldest.ageMs >= thresholdMs ? oldest : null;
}

/** Every eval in `items` whose age reaches `thresholdMs`, in the given order. */
export function stuckEvalsOf(
  items: readonly InFlightEvalView[],
  thresholdMs: number = STUCK_EVAL_WARN_MS,
): InFlightEvalView[] {
  return items.filter((item) => item.ageMs >= thresholdMs);
}

/** Default wall for evals that omit `timeout`; 0 means no wall. */
const DEFAULT_MAX_EVAL_MS = 0;

/**
 * L2 ceilings (design 02 §1.1). An explicit `timeout` above the ceiling is
 * clamped, not rejected: the wall is a safety bound, so a client asking for a
 * 27-hour sync eval still gets a usable answer instead of an argument error.
 * Sync and async differ because only an async eval survives a transport close.
 */
export const MAX_SYNC_EVAL_MS = 600_000;
export const MAX_ASYNC_EVAL_MS = 7_200_000;

/** Resolves the optional wall from an explicit option or `REPL_DEFAULT_MAX_EVAL_MS`. */
export function resolveDefaultMaxEvalMs(explicit?: number): number {
  const raw = explicit ?? process.env['REPL_DEFAULT_MAX_EVAL_MS'];
  if (raw === undefined || raw === '') return DEFAULT_MAX_EVAL_MS;
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError('defaultMaxEvalMs must be an integer >= 0');
  }
  return value;
}

/** Applies the L2 ceiling; `undefined` stays "no wall". */
export function clampEvalTimeout(
  timeoutMs: number | undefined,
  async: boolean,
): number | undefined {
  if (timeoutMs === undefined) return undefined;
  return Math.min(timeoutMs, async ? MAX_ASYNC_EVAL_MS : MAX_SYNC_EVAL_MS);
}

/** Applies the default wall only when the request omitted `timeout`. */
export function resolveDefaultEvalTimeout(
  explicit: number | undefined,
  defaultMaxEvalMs: number,
): number | undefined {
  if (explicit !== undefined) return explicit;
  return defaultMaxEvalMs > 0 ? defaultMaxEvalMs : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Wraps one Sandbox as the session's executor so the filter, binding and
 * deadline of the `runEval` call that started an eval are bound to the
 * `evalId` the session allocated. The entries are dropped when the eval
 * settles, so later evals start clean.
 */
function filteredExecutor(
  sandbox: Sandbox,
  runtime: SessionRuntime,
  scope: AsyncLocalStorage<EvalDispatchContext>,
  resolve: (pending: PendingEvalFilter) => EvalToolFilter,
): EvalExecutor {
  return {
    get epoch(): number {
      return sandbox.epoch;
    },
    start: () => sandbox.start(),
    eval: (code, options) => {
      const pending = scope.getStore();
      if (pending?.filter !== undefined) {
        runtime.filters.set(options.evalId, resolve(pending.filter));
      }
      runtime.bindings.set(options.evalId, pending?.binding ?? null);
      if (pending?.runId !== undefined) runtime.runIds.set(options.evalId, pending.runId);
      // `runEval` has already registered the eval, so its authoritative deadline
      // is available here; the dispatch-time estimate is only a fallback.
      const deadline = runtime.session.activeEvals.get(options.evalId)?.deadline ?? pending?.deadline;
      if (deadline !== undefined) runtime.deadlines.set(options.evalId, deadline);
      const outcome = sandbox.eval(code, options);
      const clear = (): void => {
        runtime.filters.delete(options.evalId);
        runtime.bindings.delete(options.evalId);
        runtime.deadlines.delete(options.evalId);
        runtime.runIds.delete(options.evalId);
      };
      void outcome.then(clear, clear);
      return outcome;
    },
    cancel: (evalId) => sandbox.cancel(evalId),
    terminate: () => sandbox.terminate(),
  };
}

/** One script outcome plus how many media blocks the L5 caps dropped. */
export interface ScriptOutcomeWithOmitted extends ScriptOutcome {
  imagesOmitted?: number;
  documentsOmitted?: number;
}

/** Builds the `<repl-output>` text plus media for one settled eval. */
function outcomeOf(
  settlement: EvalSettlement,
  media: EvalMedia | undefined,
  outputLimits: Partial<OutputLimits>,
  runId?: string,
): ScriptOutcomeWithOmitted {
  if (settlement.asyncDispatched === true) {
    return {
      content: renderEnvelope({
        evalId: settlement.evalId,
        ...(runId === undefined ? {} : { runId }),
        async: true,
        evalTaskId: settlement.evalTaskId,
        reset: settlement.contextReset,
        restored: settlement.stateRestored === 'lastGood' ? 'lastGood' : undefined,
      }),
      isError: false,
    };
  }

  const normalized = normalizeOutput(
    {
      result: withoutMedia(settlement.result),
      stdout: settlement.stdout,
      stderr: settlement.stderr,
      images: media?.images,
      documents: media?.documents,
    },
    outputLimits,
  );
  const log = [normalized.stdout, normalized.stderr].filter((part) => part !== '').join('\n');
  const truncated =
    Object.keys(normalized.truncated).length > 0 ||
    Object.values(settlement.truncated).some(Boolean);
  const outcome: ScriptOutcomeWithOmitted = {
    content: renderEnvelope({
      evalId: settlement.evalId,
      ...(runId === undefined ? {} : { runId }),
      log,
      result: normalized.result,
      error: settlement.ok
        ? undefined
        : formatUserError(settlement.error ?? settlement.outcome, settlement.stack),
      reset: settlement.contextReset,
      restored: settlement.stateRestored === 'lastGood' ? 'lastGood' : undefined,
      truncated,
    }),
    isError: !settlement.ok,
  };
  if (normalized.images.length > 0) outcome.images = normalized.images;
  if (normalized.documents.length > 0) outcome.documents = normalized.documents;
  if (normalized.imagesOmitted > 0) outcome.imagesOmitted = normalized.imagesOmitted;
  if (normalized.documentsOmitted > 0) outcome.documentsOmitted = normalized.documentsOmitted;
  return outcome;
}

/** Extracts top-level media from a tool result or a script return value. */
function mediaOf(value: unknown): { images: OutputImage[]; documents: OutputDocument[] } | undefined {
  if (!isRecord(value)) return undefined;
  const images: OutputImage[] = [];
  const documents: OutputDocument[] = [];
  if (Array.isArray(value.images)) {
    for (const item of value.images) {
      if (!isRecord(item) || typeof item.base64 !== 'string') continue;
      const mediaType = typeof item.mediaType === 'string' ? item.mediaType : 'application/octet-stream';
      images.push({ base64: item.base64, mediaType });
    }
  }
  if (Array.isArray(value.documents)) {
    for (const item of value.documents) {
      if (!isRecord(item) || typeof item.base64 !== 'string') continue;
      documents.push({ base64: item.base64 });
    }
  }
  if (images.length === 0 && documents.length === 0) return undefined;
  return { images, documents };
}

/**
 * Drops the media arrays that {@link mediaOf} collected, so base64 payloads
 * travel only as content blocks and never through the JSON-serialized result.
 */
function withoutMedia(value: unknown): unknown {
  if (mediaOf(value) === undefined) return value;
  const { images: _images, documents: _documents, ...rest } = value as Record<string, unknown>;
  return rest;
}

function taskErrorOf(settlement: EvalSettlement): StructuredToolError {
  const code =
    settlement.outcome === 'timeout'
      ? 'EVAL_TIMEOUT'
      : settlement.outcome === 'worker_dead'
        ? 'WORKER_KILLED'
        : 'EVAL_ERROR';
  return {
    code,
    retryable: false,
    detail: {
      message: settlement.error ?? settlement.outcome,
      outcome: settlement.outcome,
      ...(settlement.layer === undefined ? {} : { layer: settlement.layer }),
    },
  };
}

/** Rejection raced against a call-level signal so a silent transport still obeys L1. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? callCancelled());
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      void promise.catch(() => undefined);
      reject(signal.reason ?? callCancelled());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

function callCancelled(): ReplError {
  return new ReplError('TOOL_CANCELLED', 'the tool call was cancelled');
}

/** Minimal ExecutionGateway backed by the core ExecSession/Sandbox. */
export class ExecGateway implements ExecutionGateway {
  private readonly callTool: ExecGatewayOptions['callTool'];
  private readonly catalog: ExecGatewayOptions['catalog'];
  private readonly serve: ExecGatewayOptions['serve'];
  private readonly log: LogFn;
  private readonly audit: ((event: Record<string, unknown> & { event: string }) => void) | undefined;
  private readonly onSessionClosed:
    | ((workspace: string, session?: ClosedExecutionSession) => Promise<void> | void)
    | undefined;
  private readonly now: () => number;
  private readonly clock: Clock;
  private readonly toolTimeouts: ToolCallTimeouts;
  /**
   * Official-tool gate. One slot per lane, lanes keyed by resource, so a
   * same-file `Edit` queue is real and two independent reads still overlap.
   */
  private readonly toolGate = new KeyedGate();
  private readonly defaultMaxEvalMs: number;
  private readonly outputLimits: Partial<OutputLimits>;
  private readonly workspaceFs: WorkspaceFileSystem | undefined;
  private readonly tasks: TaskStore;
  private readonly onScriptRun: ((record: ArchiveRunOptions) => void) | undefined;
  private readonly execSessions: ExecSessionRegistry<SessionRuntime, unknown>;
  private readonly runtimes = new Map<string, SessionRuntime>();
  /** Teardown promise of every removed exec session, keyed by session id. */
  private readonly teardowns = new Map<string, Promise<void>>();
  /** Task → owning exec session, for the DELETE cascade. */
  private readonly taskLinks = new Map<string, TaskLink>();
  /** Media kept for `tasks/get` after the eval result text was stored. */
  private readonly taskMedia = new Map<string, { images: OutputImage[]; documents: OutputDocument[] }>();
  /**
   * Carries a `run_script` filter/binding/deadline into the executor call for
   * the evalId that `runEval` allocates internally, without relying on
   * dispatch ordering.
   */
  private readonly evalScope = new AsyncLocalStorage<EvalDispatchContext>();
  private disposed = false;

  constructor(options: ExecGatewayOptions) {
    this.callTool = options.callTool;
    this.catalog = options.catalog;
    this.serve = options.serve;
    this.log = options.log ?? createLog((line) => console.warn(line));
    this.audit = options.onAudit;
    this.onSessionClosed = options.onSessionClosed;
    this.now = options.now ?? (() => Date.now());
    this.clock = options.clock ?? { now: this.now };
    this.workspaceFs = options.workspaceFs;
    this.onScriptRun = options.onScriptRun;
    this.toolTimeouts = { ...DEFAULT_TOOL_CALL_TIMEOUTS, ...options.toolTimeouts };
    this.defaultMaxEvalMs = resolveDefaultMaxEvalMs(options.defaultMaxEvalMs);
    this.outputLimits = options.outputLimits ?? {};
    const limits: Partial<CapacityLimits> = { ...options.limits };
    if (options.maxInFlight !== undefined) limits.maxInFlightEvalsPerExecSession = options.maxInFlight;
    this.execSessions = new ExecSessionRegistry<SessionRuntime, unknown>({
      clock: this.clock,
      limits,
      onRemove: (record, reason) => this.handleRemoved(record, reason),
    });
    this.tasks =
      options.taskStore ??
      new TaskStore({
        clock: this.clock,
        ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
        capacity: taskCapacityFor(this.execSessions.limits),
        ownerCapacity: taskOwnerCapacityFor(this.execSessions.limits),
      });
  }

  /** Live execution-session registry; exposed so the assembly can inspect capacity. */
  get sessions(): ExecSessionRegistry<SessionRuntime, unknown> {
    return this.execSessions;
  }

  /** Hot-applies capacity settings: registry quotas plus the derived task-table
   * limits. TTLs and per-worker limits are fixed at session creation.
   */
  updateLimits(limits: Partial<CapacityLimits>): CapacityLimits {
    const next = this.execSessions.updateLimits(limits);
    this.tasks.updateLimits({
      capacity: taskCapacityFor(next),
      ownerCapacity: taskOwnerCapacityFor(next),
    });
    // Live sessions enforce a second in-flight check at the core layer.
    for (const runtime of this.runtimes.values()) {
      runtime.session.updateLimits({ inFlightLimit: next.maxInFlightEvalsPerExecSession });
    }
    return next;
  }

  /** Current task-table retention limits; the admin view and tests read them. */
  get taskLimits(): { capacity: number; ownerCapacity: number } {
    return this.tasks.limits;
  }

  /** Resolves the explicit workspace (realpath) or falls back to the cwd marker. */
  private async resolveWorkspaceFor(request: ScriptRequest): Promise<string> {
    const explicit = request.workspace?.trim();
    if (explicit === undefined || explicit === '') return '.';
    const deps = this.workspaceFs === undefined ? {} : { fs: this.workspaceFs };
    const resolved = await resolveWorkspace({ explicit }, deps);
    return resolved.path;
  }

  /**
   * Reserves one in-flight slot and returns the session runtime. Quotas and
   * idle LRU eviction live in `ExecSessionRegistry`.
   */
  private async runtimeFor(
    request: ScriptRequest,
  ): Promise<{ runtime: SessionRuntime; record: ExecSessionRecord<SessionRuntime, unknown> }> {
    const workspace = await this.resolveWorkspaceFor(request);
    const record = this.execSessions.beginEval({
      mcpSessionId: request.identity.mcp,
      workspace,
      binding: request.identity.binding,
      clientLabel: request.identity.client,
    });
    const existing = this.runtimes.get(record.id);
    if (existing !== undefined) {
      existing.hibernated = false;
      existing.serveReleased = false;
      return { runtime: existing, record };
    }
    try {
      return { runtime: this.createRuntime(record), record };
    } catch (error) {
      this.execSessions.endEval(record);
      throw error;
    }
  }

  private createRuntime(record: ExecSessionRecord<SessionRuntime, unknown>): SessionRuntime {
    const runtime: SessionRuntime = {
      record,
      session: null as unknown as ExecSession,
      filters: new Map(),
      bindings: new Map(),
      deadlines: new Map(),
      runIds: new Map(),
      media: new Map(),
      toolsUsed: new Map(),
      hibernated: false,
      serveReleased: false,
    };
    const scope = this.evalScope;
    const resolve = (pending: PendingEvalFilter): EvalToolFilter => this.resolveFilter(pending);
    const serveHooks = this.serve;
    const session = new ExecSession({
      id: record.id,
      workspace: record.workspace,
      // The core default (8) must not cap a configured per-session quota.
      limits: { inFlightLimit: this.execSessions.limits.maxInFlightEvalsPerExecSession },
      ...(serveHooks === undefined
        ? {}
        : {
            serve: {
              healthy: () => serveHooks.healthy(record.id),
              restart: () => serveHooks.restart(record.id),
            },
          }),
      now: this.now,
      createExecutor: () => {
        const sandbox = new Sandbox({
          sessionId: record.id,
          onToolCall: (call) =>
            session.handleToolCall(call, (accepted) => this.callToolFor(runtime, call, accepted.signal)),
        });
        return filteredExecutor(sandbox, runtime, scope, resolve);
      },
    });
    runtime.session = session;
    this.runtimes.set(record.id, runtime);
    this.emitAudit({ event: 'exec_start', execId: record.id, workspace: record.workspace });
    return runtime;
  }

  /** Turns the request's narrowing into the filter for one eval. */
  private filterFor(request: ScriptRequest): PendingEvalFilter | undefined {
    const visible = request.visibleTools === undefined ? undefined : new Set(request.visibleTools);
    const excludeTags = new Set(request.excludeTags ?? []);
    if (visible === undefined && excludeTags.size === 0) return undefined;
    return { visible, excludeTags };
  }

  private withEvalContext<T>(
    request: ScriptRequest,
    filter: PendingEvalFilter | undefined,
    deadline: number | undefined,
    runId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.evalScope.run(
      {
        filter,
        binding: request.identity.binding,
        ...(deadline === undefined ? {} : { deadline }),
        runId,
      },
      run,
    );
  }

  /** Timeout that `runEval` will apply; used to derive the L1 deadline up front. */
  private evalTimeoutFor(request: ScriptRequest): number | undefined {
    const resolved = resolveDefaultEvalTimeout(resolveEvalTimeout(request.timeoutMs), this.defaultMaxEvalMs);
    return clampEvalTimeout(resolved, request.async);
  }

  /**
   * Expands `excludeTags` against the catalog snapshot taken when the eval
   * starts. Unknown `visibleTools` names are ignored with a warning (design
   * 03 §2.5), never an error.
   */
  private resolveFilter(pending: PendingEvalFilter): EvalToolFilter {
    const snapshot = this.catalog?.snapshot();
    if (pending.excludeTags.size > 0 && snapshot === undefined) {
      throw new ReplError(
        'INTERNAL_ERROR',
        'excludeTags needs the tool catalog; pass `catalog` to ExecGatewayOptions',
      );
    }

    const excludedByTag = new Set<string>();
    if (snapshot !== undefined) {
      for (const tool of snapshot.tools) {
        if (tool.tags === undefined) continue;
        if (tool.tags.some((tag) => pending.excludeTags.has(tag))) excludedByTag.add(tool.name);
      }
      if (pending.visible !== undefined) {
        const known = new Set(snapshot.tools.map((tool) => tool.name));
        const unknown = [...pending.visible].filter((name) => !known.has(name));
        if (unknown.length > 0) {
          this.log(`visibleTools names are not in the catalog: ${unknown.join(', ')}`, { level: 'warn', scope: 'exec' });
        }
      }
    }
    return { visible: pending.visible, excludedByTag };
  }

  /** Records images/documents returned at the top level of a tool result. */
  private collectMedia(runtime: SessionRuntime, evalId: number, value: unknown): void {
    const media = mediaOf(value);
    if (media === undefined) return;
    let bucket = runtime.media.get(evalId);
    if (bucket === undefined) {
      bucket = { images: [], documents: [], seenImages: new Set(), seenDocuments: new Set() };
      runtime.media.set(evalId, bucket);
    }
    for (const image of media.images) {
      if (bucket.seenImages.has(image.base64)) continue;
      bucket.seenImages.add(image.base64);
      bucket.images.push(image);
    }
    for (const document of media.documents) {
      if (bucket.seenDocuments.has(document.base64)) continue;
      bucket.seenDocuments.add(document.base64);
      bucket.documents.push(document);
    }
  }

  /** Removes and returns one eval's media, so a second reader cannot double-attach it. */
  private takeMedia(runtime: SessionRuntime, evalId: number): EvalMedia | undefined {
    const media = runtime.media.get(evalId);
    runtime.media.delete(evalId);
    return media;
  }

  /**
   * Collects media from a settled eval's top-level return value and takes the
   * accumulated bucket. Tool-result media was collected call by call, so the
   * same block returned from the script is deduplicated here.
   */
  private mediaOfSettlement(runtime: SessionRuntime, settlement: EvalSettlement): EvalMedia | undefined {
    this.collectMedia(runtime, settlement.evalId, settlement.result);
    return this.takeMedia(runtime, settlement.evalId);
  }

  /** Declared concurrency tier from the catalog, when the snapshot has it. */
  private toolModeOf(call: ToolCallRequest): CatalogTool['concurrency'] | undefined {
    const snapshot = this.catalog?.snapshot();
    if (snapshot === undefined) return undefined;
    const name = canonicalToolName(call);
    return snapshot.tools.find((tool) => catalogToolName(tool) === name)?.concurrency;
  }

  /**
   * Applies an eval's filter before the call reaches the injected transport,
   * clamps Bash to the eval deadline and enforces the L1 per-call budget with a
   * call-level abort signal.
   */
  private callToolFor(runtime: SessionRuntime, call: ToolCallRequest, signal: AbortSignal): unknown {
    const name = canonicalToolName(call);
    const filter = runtime.filters.get(call.evalId);
    if (filter !== undefined) {
      const hiddenByNames = filter.visible !== undefined && !filter.visible.has(name);
      const excludedByTag = filter.excludedByTag.has(name);
      if (hiddenByNames || excludedByTag) {
        this.emitAudit({
          event: 'tool_denied',
          evalId: call.evalId,
          seq: call.callSeq,
          tool: name,
          server: toolServer(call),
          reason: hiddenByNames ? 'not_visible' : 'excluded_tag',
          rule: hiddenByNames ? 'visibleTools' : 'excludeTags',
          workspace: runtime.record.workspace,
          ...runFields(runtime, call.evalId),
        });
        throw new ReplError('TOOL_NOT_VISIBLE', `${name} is not visible in this call`);
      }
    }

    const queuedAt = this.now();
    const binding = runtime.bindings.get(call.evalId) ?? null;
    let used = runtime.toolsUsed.get(call.evalId);
    if (used === undefined) {
      used = new Set();
      runtime.toolsUsed.set(call.evalId, used);
    }
    used.add(name);
    const gate = this.gateOf(call);
    // Where this call waited. The keyed gate is observed here by elapsed time;
    // the pool's gates report themselves through `observation`.
    let waitReason: ToolWaitReason | undefined;
    const observation: ToolCallObservation = {
      noteWait: (reason) => {
        waitReason ??= reason;
      },
    };
    // No eval deadline means only the per-call L1 limit applies.
    const evalDeadline = runtime.deadlines.get(call.evalId) ?? Number.POSITIVE_INFINITY;

    this.emitAudit({
      event: 'tool_call',
      evalId: call.evalId,
      seq: call.callSeq,
      tool: name,
      server: toolServer(call),
      mode: this.modeOf(call, gate),
      // Honest three-segment timing (`02 §2.4`): arrival here, execution start
      // inside the gate, end in `finish`.
      queuedAt,
      // Raw arguments as the script passed them; the Bash timeout default is a
      // server-side detail and is added inside the execution body.
      args: call.args,
      workspace: runtime.record.workspace,
      ...runFields(runtime, call.evalId),
    });

    const execute = (): unknown => {
      const started = this.now();
      let args = call.args;
      let callDeadline: number;

      if (call.server === undefined && call.tool === 'Bash') {
        const requested = args.timeout === undefined ? { ...args, timeout: this.toolTimeouts.bashMs } : args;
        const clamped = clampBashArgs(requested, evalDeadline, started);
        args = clamped;
        callDeadline = Math.min(evalDeadline, started + clamped.timeout);
      } else {
        const limit = call.server === undefined ? this.toolTimeouts.officialMs : this.toolTimeouts.mcpMs;
        callDeadline = Math.min(evalDeadline, started + limit);
      }

      const controller = new AbortController();
      const forwardAbort = (): void => controller.abort(signal.reason);
      if (signal.aborted) forwardAbort();
      else signal.addEventListener('abort', forwardAbort, { once: true });
      const budget = Math.max(0, callDeadline - started);
      const timer = setTimeout(() => {
        controller.abort(new ReplError('TOOL_TIMEOUT', `${name} timed out after ${budget}ms`));
      }, budget);
      timer.unref?.();
      const cleanup = (): void => {
        clearTimeout(timer);
        signal.removeEventListener('abort', forwardAbort);
      };

      const finish = (ok: boolean, error?: unknown, value?: unknown): void => {
        const endedAt = this.now();
        const ms = endedAt - started;
        const outBytes = jsonBytes(value);
        const errorCode = errorCodeOf(error);
        const queueMs = started - queuedAt;
        // Only the gate can say whether it queued: `queueMs` includes a couple
        // of milliseconds of scheduling even for an uncontended call.
        const reason = waitReason;
        this.emitAudit({
          event: 'tool_result',
          evalId: call.evalId,
          seq: call.callSeq,
          tool: name,
          server: toolServer(call),
          ok,
          // How long the call waited for the gate; `ms` stays total elapsed so
          // the waterfall can draw queue + exec as one span (`02 §2.4`).
          queueMs,
          ms: endedAt - queuedAt,
          startedAt: started,
          endedAt,
          durMs: ms,
          ...(reason === undefined ? {} : { waitReason: reason }),
          ...(outBytes === undefined ? {} : { outBytes }),
          ...(errorCode === undefined ? {} : { errorCode }),
          ...runFields(runtime, call.evalId),
          // The result body is captured for the first time here; the audit
          // runtime externalises it when it exceeds the inline budget.
          ...(ok && value !== undefined ? { result: value } : {}),
          ...(error === undefined
            ? {}
            : { error: { message: (error as Error).message ?? String(error), ...(errorCode === undefined ? {} : { code: errorCode }) } }),
        });
      };

      try {
        const transportCall: ToolCallRequest = { ...call, args };
        const outcome = this.callTool(
          transportCall,
          runtime.record.workspace,
          binding,
          controller.signal,
          callDeadline,
          runtime.record.id,
          observation,
        );
        return raceAbort(Promise.resolve(outcome), controller.signal)
          .then((value) => {
            this.collectMedia(runtime, call.evalId, value);
            finish(true, undefined, value);
            return value;
          })
          .catch((error: unknown) => {
            finish(false, error);
            throw annotateArgumentError(this.catalog, call, error);
          })
          .finally(cleanup);
      } catch (error) {
        cleanup();
        finish(false, error);
        throw annotateArgumentError(this.catalog, call, error);
      }
    };

    if (gate.policy === 'parallel') return execute();
    // A queued call is cancellable: the eval's abort signal removes it from the
    // lane instead of letting a dead eval start one more tool call.
    return this.toolGate.run(gate.key, execute, signal, () => {
      waitReason ??= 'keyed-gate';
    });
  }

  /**
   * Mode written to the audit row.
   *
   * Third-party tools keep their declared value: `PoolGates` enforces it on the
   * pool side, and the gateway adds nothing. Official tools have no meaningful
   * declaration — `claude mcp serve` exports no `isConcurrencySafe` — so the row
   * reports what this gateway actually did with the call.
   */
  private modeOf(call: ToolCallRequest, gate: { policy: ConcurrencyPolicy }): ConcurrencyPolicy {
    if (call.server !== undefined) return this.toolModeOf(call) ?? gate.policy;
    return gate.policy;
  }

  /**
   * Picks the gate for one call.
   *
   * Official tools have no exported `isConcurrencySafe`, so the lane key is the
   * *resource* rather than the tool: two `Edit` calls to the same file
   * serialise, two to different files do not, and a write-mode `Bash` takes a
   * single lane. Third-party tools are already gated by `PoolGates`, so the
   * gateway adds nothing for them.
   */
  private gateOf(call: ToolCallRequest): { policy: ConcurrencyPolicy; key: string } {
    const declared = this.toolModeOf(call);
    if (declared === 'exclusive') return { policy: 'exclusive', key: 'exclusive' };
    if (call.server !== undefined) return { policy: 'parallel', key: '' };

    const name = canonicalToolName(call);
    if (name === 'Bash') {
      return bashConcurrency(call.args) === 'parallel'
        ? { policy: 'parallel', key: '' }
        : { policy: 'serial', key: 'official:Bash' };
    }
    if (FILE_WRITERS.has(name)) {
      const target = call.args['file_path'] ?? call.args['notebook_path'] ?? call.args['path'];
      const key = typeof target === 'string' && target !== '' ? `official:file:${target}` : `official:${name}`;
      return { policy: 'serial', key };
    }
    return { policy: 'parallel', key: '' };
  }

  private emitAudit(event: Record<string, unknown> & { event: string }): void {
    try {
      this.audit?.(event);
    } catch {
      // Audit must never break an eval (design 02 §6.1).
    }
  }

  private identityFields(request: ScriptRequest): Record<string, unknown> {
    return {
      identityKind: request.identity.identity,
      binding: request.identity.binding,
      client: request.identity.client,
      clientName: request.identity.clientName ?? '',
      clientVersion: request.identity.clientVersion ?? '',
      mcp: request.identity.mcp,
    };
  }

  /** Entry metadata shared by `eval_start`, `eval_end` and `async_dispatch` (10 §7.4). */
  private entryFields(request: ScriptRequest): Record<string, unknown> {
    const argsBytes = request.args === undefined ? undefined : jsonBytes(request.args);
    const argsPreview = argsPreviewOf(request.args);
    // Count-only summary; never carries the matched text (design 10 §11).
    const secretWarnings = secretWarningsOf('args', request.args);
    return {
      entryTool: 'run_script',
      entryMode: request.entryMode ?? 'code',
      ...(request.scriptId === undefined ? {} : { scriptId: request.scriptId }),
      ...(request.scriptVersion === undefined ? {} : { scriptVersion: request.scriptVersion }),
      ...(request.scriptMode === undefined ? {} : { scriptMode: request.scriptMode }),
      ...(argsBytes === undefined ? {} : { argsBytes }),
      ...(argsPreview === undefined ? {} : { argsPreview }),
      ...(secretWarnings.length === 0 ? {} : { secretWarnings }),
    };
  }

  /** Appends one settled eval to `script_runs`; archive failures never change the result. */
  private archiveRun(
    request: ScriptRequest,
    runtime: SessionRuntime,
    settlement: EvalSettlement,
    runId: string,
  ): void {
    const toolsUsed = [...(runtime.toolsUsed.get(settlement.evalId) ?? [])];
    runtime.toolsUsed.delete(settlement.evalId);
    if (this.onScriptRun === undefined) return;
    const entryMode = request.entryMode ?? 'code';
    try {
      this.onScriptRun({
        runId,
        createdAt: new Date(this.now()).toISOString(),
        execId: runtime.record.id,
        evalId: settlement.evalId,
        requestId: request.requestId ?? null,
        binding: runtime.record.binding,
        clientName: request.identity.clientName ?? '',
        clientVersion: request.identity.clientVersion ?? '',
        workspace:
          request.workspace === undefined || request.workspace.trim() === ''
            ? ''
            : runtime.record.workspace,
        entryTool: 'run_script',
        entryMode,
        scriptId: request.scriptId ?? null,
        scriptVersion: request.scriptVersion ?? null,
        scriptMode: request.scriptMode ?? null,
        args: request.args ?? null,
        argsPreview: argsPreviewOf(request.args) ?? null,
        code: settlement.ok && entryMode === 'code' ? request.code : null,
        ok: settlement.ok,
        error: settlement.ok ? null : (settlement.error ?? settlement.outcome),
        resultBytes: jsonBytes(settlement.result) ?? 0,
        durationMs: settlement.ms,
        toolsUsed,
        purpose: request.purpose ?? 'run',
        ...(request.actor === undefined ? {} : { actor: request.actor }),
        activateOnSuccess: request.activateOnSuccess === true,
      });
    } catch (error) {
      this.log(`script run archive failed: ${(error as Error).message}`, {
        level: 'warn',
        scope: 'exec',
        runId,
      });
    }
  }

  private emitEvalStart(
    request: ScriptRequest,
    exec: ExecSessionRecord<SessionRuntime, unknown>,
    mode: 'sync' | 'async',
    runId: string,
    start: { evalId: number; epoch: number; timeoutMs?: number },
  ): void {
    this.emitAudit({
      event: 'eval_start',
      exec: exec.id,
      runId,
      evalId: start.evalId,
      epoch: start.epoch,
      mode,
      async: mode === 'async',
      ...(start.timeoutMs === undefined ? {} : { timeoutMs: start.timeoutMs }),
      workspace: exec.workspace,
      ...this.identityFields(request),
      ...this.entryFields(request),
      ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      codeBytes: Buffer.byteLength(request.code, 'utf8'),
      codeSha256: createHash('sha256').update(request.code, 'utf8').digest('hex'),
      codePrefix: request.code.slice(0, 200),
    });
  }

  private emitEvalEnd(
    request: ScriptRequest,
    exec: ExecSessionRecord<SessionRuntime, unknown>,
    settlement: EvalSettlement,
    runId: string,
  ): void {
    const resultBytes = jsonBytes(settlement.result) ?? 0;
    this.emitAudit({
      event: 'eval_end',
      exec: exec.id,
      runId,
      evalId: settlement.evalId,
      workspace: exec.workspace,
      ...this.identityFields(request),
      ...this.entryFields(request),
      ok: settlement.ok,
      outcome: settlement.outcome,
      ...(settlement.layer === undefined ? {} : { layer: settlement.layer }),
      calls: settlement.budget?.calls ?? 0,
      resultBytes,
      ms: settlement.ms,
      ...(settlement.error === undefined ? {} : { error: String(settlement.error) }),
    });
  }

  private assertUsable(): void {
    if (this.disposed) {
      throw new ReplError('MCP_SERVER_UNAVAILABLE', 'repl-server is shutting down; new evals are rejected');
    }
  }

  async runScript(request: ScriptRequest): Promise<ScriptOutcome> {
    this.assertUsable();
    const { runtime, record } = await this.runtimeFor(request);
    try {
      const filter = this.filterFor(request);
      const timeoutMs = this.evalTimeoutFor(request);
      const deadline = timeoutMs === undefined ? undefined : this.now() + timeoutMs;
      const runId = randomUUID();
      const settlement = await this.withEvalContext(request, filter, deadline, runId, () =>
        runEval(runtime.session, request.code, {
          async: false,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          onStart: (start) => this.emitEvalStart(request, record, 'sync', runId, start),
        }),
      );
      this.emitEvalEnd(request, record, settlement, runId);
      const media = this.mediaOfSettlement(runtime, settlement);
      const outcome = outcomeOf(settlement, media, this.outputLimits, runId);
      this.archiveRun(request, runtime, settlement, runId);
      return { ...outcome, runId };
    } finally {
      this.execSessions.endEval(record);
    }
  }

  async dispatchScript(
    request: ScriptRequest,
  ): Promise<{ taskId: string; evalId: number; runId: string }> {
    this.assertUsable();
    const { runtime, record } = await this.runtimeFor(request);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      this.execSessions.endEval(record);
    };
    let taskId: string | undefined;
    try {
      const filter = this.filterFor(request);
      const timeoutMs = this.evalTimeoutFor(request);
      const deadline = timeoutMs === undefined ? undefined : this.now() + timeoutMs;
      const owner = ownerKey(request.identity);
      this.pruneTaskTracking();
      const runId = randomUUID();
      const argsPreview = argsPreviewOf(request.args);
      const created = this.tasks.create(0, owner, {
        runId,
        ...(request.scriptId === undefined ? {} : { scriptId: request.scriptId }),
        ...(request.scriptVersion === undefined ? {} : { scriptVersion: request.scriptVersion }),
        ...(request.scriptMode === undefined ? {} : { scriptMode: request.scriptMode }),
        ...(argsPreview === undefined ? {} : { argsPreview }),
        entryMode: request.entryMode ?? 'code',
      });
      taskId = created;
      this.taskLinks.set(created, { sessionId: record.id, owner });

      const onSettled = (settled: EvalSettlement): void => {
        this.finishTask(created, runtime, settled);
        this.emitEvalEnd(request, record, settled, runId);
        this.archiveRun(request, runtime, settled, runId);
        release();
      };

      const receipt = await this.withEvalContext(request, filter, deadline, runId, () =>
        runEval(runtime.session, request.code, {
          async: true,
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
          evalTaskId: created,
          onStart: (start) => this.emitEvalStart(request, record, 'async', runId, start),
          onSettled,
        }),
      );
      this.tasks.setEvalId(created, receipt.evalId);
      // design 02 §5.3: the dispatch is its own audit event, because `eval_start`
      // is emitted by `onStart` and does not carry the task id or its TTL.
      this.emitAudit({
        event: 'async_dispatch',
        exec: record.id,
        runId,
        evalTaskId: created,
        evalId: receipt.evalId,
        ttlMs: this.tasks.ttl,
        workspace: record.workspace,
        ...this.identityFields(request),
        ...this.entryFields(request),
        ...(request.requestId === undefined ? {} : { requestId: request.requestId }),
      });
      return { taskId: created, evalId: receipt.evalId, runId };
    } catch (error) {
      if (taskId !== undefined) {
        const code = error instanceof ReplError ? error.code : 'DISPATCH_FAILED';
        this.tasks.fail(taskId, {
          code,
          retryable: false,
          detail: { message: error instanceof Error ? error.message : String(error) },
        });
        // The task id never reached the client, so a retained record would only
        // consume capacity until its TTL.
        this.tasks.remove(taskId);
        this.taskLinks.delete(taskId);
        this.taskMedia.delete(taskId);
      }
      release();
      throw error;
    }
  }

  /** Stores one settled async result; a prior cancel stays `cancelled`. */
  private finishTask(taskId: string, runtime: SessionRuntime, settled: EvalSettlement): void {
    this.tasks.setEvalId(taskId, settled.evalId);
    const media = this.mediaOfSettlement(runtime, settled);
    const outcome = outcomeOf(settled, media, this.outputLimits);
    const fields = { result: outcome.content, stdout: settled.stdout };
    if (settled.outcome === 'cancelled') {
      this.tasks.cancel(taskId, fields);
    } else if (settled.ok) {
      this.tasks.complete(taskId, fields);
    } else {
      this.tasks.fail(taskId, taskErrorOf(settled), fields);
    }
    if (!this.tasks.has(taskId)) return;
    if (outcome.images !== undefined || outcome.documents !== undefined) {
      this.taskMedia.set(taskId, {
        images: outcome.images ?? [],
        documents: outcome.documents ?? [],
      });
    }
  }

  async waitTasks(owner: string, taskIds: string[], timeoutMs: number): Promise<unknown> {
    const waited = await this.tasks.wait(owner, taskIds, timeoutMs);
    const consumed = this.tasks.consume(owner, taskIds);
    return {
      ok: true,
      timedOut: waited.timedOut && consumed.pending > 0,
      events: consumed.events,
      pending: consumed.pending,
    };
  }

  async getTask(owner: string, taskId: string): Promise<TaskSnapshot | null> {
    let snapshot;
    try {
      snapshot = this.tasks.get(owner, taskId);
    } catch (error) {
      if (error instanceof ReplError && (error.code === 'UNKNOWN_TASK' || error.code === 'TASK_EXPIRED')) {
        return null;
      }
      throw error;
    }
    const view: TaskSnapshot = {
      taskId,
      status: snapshot.status,
      createdAt: new Date(snapshot.createdAt).toISOString(),
      lastUpdatedAt: new Date(snapshot.updatedAt).toISOString(),
      ttlMs: snapshot.expiresAt - snapshot.createdAt,
      pollIntervalMs: LIMITS.taskPollIntervalMs,
      ...(snapshot.runId === undefined ? {} : { runId: snapshot.runId }),
      ...(snapshot.scriptId === undefined ? {} : { scriptId: snapshot.scriptId }),
      ...(snapshot.scriptVersion === undefined ? {} : { scriptVersion: snapshot.scriptVersion }),
      ...(snapshot.scriptMode === undefined ? {} : { scriptMode: snapshot.scriptMode }),
      ...(snapshot.argsPreview === undefined ? {} : { argsPreview: snapshot.argsPreview }),
    };
    if (snapshot.result !== undefined) {
      const media = this.taskMedia.get(taskId);
      view.result = {
        content: snapshot.result,
        isError: snapshot.status !== 'completed',
        ...(media === undefined || media.images.length === 0 ? {} : { images: media.images }),
        ...(media === undefined || media.documents.length === 0 ? {} : { documents: media.documents }),
      };
    }
    if (snapshot.error !== undefined) {
      const detail = isRecord(snapshot.error.detail) ? snapshot.error.detail : undefined;
      const message =
        detail !== undefined && typeof detail['message'] === 'string'
          ? detail['message']
          : snapshot.error.code;
      view.error = {
        code: snapshot.error.code,
        message,
        ...(snapshot.error.detail === undefined ? {} : { data: snapshot.error.detail }),
      };
    }
    return view;
  }

  async cancelTask(owner: string, taskId: string): Promise<boolean> {
    let snapshot;
    try {
      snapshot = this.tasks.get(owner, taskId);
    } catch {
      this.emitTaskCancel(taskId, undefined, false, 'client');
      return false;
    }
    if (snapshot.status !== 'working') {
      this.emitTaskCancel(taskId, snapshot.evalId, false, 'client');
      return false;
    }
    if (!this.tasks.cancel(taskId)) {
      this.emitTaskCancel(taskId, snapshot.evalId, false, 'client');
      return false;
    }
    this.emitTaskCancel(taskId, snapshot.evalId, true, 'client');
    const link = this.taskLinks.get(taskId);
    if (link !== undefined) {
      const runtime = this.runtimes.get(link.sessionId);
      if (runtime !== undefined) this.abortEval(runtime, snapshot.evalId);
    }
    return true;
  }

  /**
   * `task_cancel` (design 02 §5.3). Emitted for every cancel request, not only
   * the honoured ones: "the client asked and we refused" is the interesting
   * case when a task keeps running against expectations.
   */
  private emitTaskCancel(
    taskId: string,
    evalId: number | undefined,
    honoured: boolean,
    by: 'client' | 'binding' | 'transport',
  ): void {
    const link = this.taskLinks.get(taskId);
    this.emitAudit({
      event: 'task_cancel',
      evalTaskId: taskId,
      by,
      honoured,
      ...(evalId === undefined ? {} : { evalId }),
      ...(link === undefined ? {} : { exec: link.sessionId, owner: link.owner }),
    });
  }

  /** Cooperative cancel: stops new calls and aborts the ones already in flight. */
  private abortEval(runtime: SessionRuntime, evalId: number): void {
    const active = runtime.session.activeEvals.get(evalId);
    if (active !== undefined) {
      active.accepting = false;
      const reason = new ReplError('EVAL_CANCELLED', `eval ${evalId} was cancelled`);
      for (const call of active.inflight.values()) {
        try {
          call.controller.abort(reason);
        } catch {
          // An already-aborted controller keeps its first reason.
        }
      }
    }
    runtime.session.cancelExecutorEval(evalId);
  }

  /** Live execution-session counters for the admin overview. */
  stats(): { sessions: number; inFlightEvals: number } {
    let inFlightEvals = 0;
    for (const record of this.execSessions.list()) inFlightEvals += record.inFlightEvals;
    return { sessions: this.execSessions.size, inFlightEvals };
  }

  /** Live per-binding counters; unbound sessions are grouped under `null`. */
  bindingStats(): Array<{ binding: string | null; execSessions: number; inFlightEvals: number }> {
    const byBinding = new Map<
      string,
      { binding: string | null; execSessions: number; inFlightEvals: number }
    >();
    for (const record of this.execSessions.list()) {
      const key = record.binding ?? '';
      let entry = byBinding.get(key);
      if (entry === undefined) {
        entry = { binding: record.binding, execSessions: 0, inFlightEvals: 0 };
        byBinding.set(key, entry);
      }
      entry.execSessions += 1;
      entry.inFlightEvals += record.inFlightEvals;
    }
    return [...byBinding.values()];
  }

  /**
   * In-flight evals across every execution session, oldest first. `total` is
   * the count before `limit`, so a truncated page still shows the real backlog.
   */
  inFlightEvals(limit = 200): InFlightEvalsView {
    const now = this.now();
    const items: InFlightEvalView[] = [];
    for (const runtime of this.runtimes.values()) {
      for (const active of runtime.session.activeEvals.values()) {
        const item: InFlightEvalView = {
          exec: runtime.record.id,
          evalId: active.evalId,
          binding: runtime.record.binding,
          workspace: runtime.record.workspace,
          async: active.async,
          startedAt: active.startedAt,
          ageMs: now - active.startedAt,
        };
        if (active.timeoutMs !== undefined) item.timeoutMs = active.timeoutMs;
        items.push(item);
      }
    }
    items.sort((a, b) => a.startedAt - b.startedAt);
    return { total: items.length, items: items.slice(0, Math.max(0, limit)) };
  }

  /**
   * Admin cancel: cooperative abort first, then a hard stop of the execution
   * session's worker when the eval is still registered after the grace. The
   * hard stop also terminates the session's other in-flight evals.
   * Returns false only when the named eval is not live.
   */
  async cancelEval(exec: string, evalId: number): Promise<boolean> {
    const runtime = this.runtimes.get(exec);
    const active = runtime?.session.activeEvals.get(evalId);
    if (runtime === undefined || active === undefined) return false;
    this.emitAudit({
      event: 'eval_cancel',
      exec,
      evalId,
      binding: runtime.record.binding,
      client: runtime.record.clientLabel,
      mcp: runtime.record.mcpSessionId,
      by: 'admin',
    });
    this.abortEval(runtime, evalId);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        active.completed,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, EVAL_CANCEL_GRACE_MS);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    const stillActive = runtime.session.activeEvals.get(evalId);
    if (stillActive !== undefined) await hardStop(runtime.session, stillActive, 'wall');
    return true;
  }

  /**
   * Binding deletion/rotation: cancels in-flight evals, drops the binding's
   * tasks and disposes every execution session it owns across transports.
   */
  async destroyOwner(owner: string): Promise<void> {
    if (typeof owner !== 'string' || owner === '') return;
    const targets = this.execSessions.list().filter((record) => record.binding === owner);
    await this.destroySessions(targets, owner, 'binding');
  }

  /**
   * `DELETE /mcp` / idle transport expiry: tears down the unbound execution
   * sessions created by one transport and the tasks they own. Bound sessions
   * and their tasks belong to the binding and stay alive.
   */
  async destroyTransport(transportId: string): Promise<void> {
    if (typeof transportId !== 'string' || transportId === '') return;
    const targets = this.execSessions
      .list()
      .filter((record) => record.binding === null && record.mcpSessionId === transportId);
    await this.destroySessions(targets, transportId, 'transport');
  }

  /** Cancels the affected tasks, removes the records and awaits their teardown. */
  private async destroySessions(
    targets: ExecSessionRecord<SessionRuntime, unknown>[],
    taskOwner: string,
    by: 'binding' | 'transport',
  ): Promise<void> {
    const targetIds = new Set(targets.map((record) => record.id));

    // Cancel linked tasks first, so a settling eval cannot flip them to completed.
    for (const [taskId, link] of [...this.taskLinks]) {
      if (!targetIds.has(link.sessionId) && link.owner !== taskOwner) continue;
      let honoured = false;
      try {
        honoured = this.tasks.get(link.owner, taskId).status === 'working';
      } catch {
        honoured = false;
      }
      this.tasks.cancel(taskId);
      this.emitTaskCancel(taskId, undefined, honoured, by);
      this.tasks.remove(taskId);
      this.taskLinks.delete(taskId);
      this.taskMedia.delete(taskId);
    }
    this.tasks.removeOwner(taskOwner);

    const teardowns: Promise<void>[] = [];
    for (const record of targets) {
      const removed = this.execSessions.remove(record.id, 'delete');
      if (removed === undefined) continue;
      const teardown = this.teardowns.get(record.id);
      if (teardown !== undefined) teardowns.push(teardown);
    }
    await Promise.all(teardowns);
  }

  /**
   * Idle lifecycle (design 03 §2.3): hibernates idle workers, releases serve
   * handles and recycles long-idle execution sessions. The task table is
   * deliberately untouched, so `tasks/get` keeps working inside its TTL.
   */
  async sweepIdle(options: IdleSweepOptions = {}): Promise<IdleSweepResult> {
    const hibernateMs = options.hibernateMs ?? EXEC_IDLE_HIBERNATE_MS;
    const recycleMs = options.recycleMs ?? EXEC_IDLE_RECYCLE_MS;
    const releaseServeMs = options.releaseServeMs ?? SERVE_IDLE_RELEASE_MS;
    const result: IdleSweepResult = { hibernated: 0, recycled: 0, serveReleased: 0 };
    if (this.disposed) return result;

    const now = this.clock.now();
    for (const snapshot of this.execSessions.list()) {
      // Re-read after every await: a previous entry's teardown yields, and a
      // new eval may have started on this session in the meantime.
      const record = this.execSessions.get(snapshot.id);
      if (record === undefined || record.inFlightEvals > 0) continue;
      // A long eval updates only `lastRequestAt` when it ends, so the active
      // marker is the later of the two.
      const idle = now - Math.max(record.lastEvalAt, record.lastRequestAt);

      if (idle >= recycleMs) {
        const removed = this.execSessions.remove(record.id, 'idle_recycle');
        if (removed === undefined) continue;
        result.recycled += 1;
        const teardown = this.teardowns.get(removed.id);
        if (teardown !== undefined) await teardown;
        continue;
      }

      const runtime = this.runtimes.get(record.id);
      if (runtime !== undefined && !runtime.hibernated && idle >= hibernateMs) {
        try {
          if (await runtime.session.hibernateWorker()) {
            runtime.hibernated = true;
            result.hibernated += 1;
            this.emitAudit({ event: 'exec_hibernate', execId: record.id, workspace: record.workspace });
          }
        } catch {
          // Hibernation is best effort; the next sweep retries.
        }
      }

      if (
        runtime !== undefined &&
        !runtime.serveReleased &&
        idle >= releaseServeMs &&
        this.onSessionClosed !== undefined
      ) {
        // A new eval may have started while hibernation awaited; releasing its
        // serve handle would race with that eval's next tool call.
        const live = this.execSessions.get(record.id);
        if (live === undefined || live.inFlightEvals > 0) continue;
        try {
          await this.onSessionClosed(record.workspace, {
            id: record.id,
            mcpSessionId: record.mcpSessionId,
            binding: record.binding,
            workspace: record.workspace,
          });
          runtime.serveReleased = true;
          result.serveReleased += 1;
        } catch {
          // Releasing a serve handle is best effort; the next tool call re-acquires.
        }
      }
    }
    return result;
  }

  /** Terminates every worker; used on shutdown and in tests. */
  async disposeAll(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.execSessions.destroyAll('shutdown');
    while (this.teardowns.size > 0) {
      await Promise.all([...this.teardowns.values()]);
    }
    this.tasks.clear();
    this.taskLinks.clear();
    this.taskMedia.clear();
    this.runtimes.clear();
  }

  private handleRemoved(record: ExecSessionRecord<SessionRuntime, unknown>, reason: SessionRemovalReason): void {
    const runtime = this.runtimes.get(record.id);
    if (runtime === undefined) return;
    this.runtimes.delete(record.id);
    const teardown = this.teardown(runtime, reason);
    this.teardowns.set(record.id, teardown);
    void teardown.finally(() => {
      if (this.teardowns.get(record.id) === teardown) this.teardowns.delete(record.id);
    });
  }

  /** Awaited by the destroy methods/`disposeAll`; never rejects. */
  private async teardown(runtime: SessionRuntime, reason: SessionRemovalReason): Promise<void> {
    runtime.filters.clear();
    runtime.bindings.clear();
    runtime.deadlines.clear();
    runtime.media.clear();
    runtime.toolsUsed.clear();
    for (const active of [...runtime.session.activeEvals.values()]) {
      this.abortEval(runtime, active.evalId);
    }
    this.emitAudit({
      event: 'exec_end',
      execId: runtime.session.id,
      workspace: runtime.record.workspace,
      reason,
    });
    try {
      await runtime.session.dispose();
    } catch {
      // Teardown must finish even when a wedged worker refuses to terminate.
    }
    try {
      await this.onSessionClosed?.(runtime.record.workspace, {
        id: runtime.record.id,
        mcpSessionId: runtime.record.mcpSessionId,
        binding: runtime.record.binding,
        workspace: runtime.record.workspace,
      });
    } catch {
      // Serve release failures are the assembly's concern; the session is gone.
    }
  }

  /** Drops task bookkeeping once the core table evicted its record. */
  private pruneTaskTracking(): void {
    if (this.taskLinks.size === 0) return;
    for (const taskId of [...this.taskLinks.keys()]) {
      if (this.tasks.has(taskId)) continue;
      this.taskLinks.delete(taskId);
      this.taskMedia.delete(taskId);
    }
  }
}

function ownerKey(identity: RequestIdentity): string {
  return identity.binding ?? identity.mcp;
}
