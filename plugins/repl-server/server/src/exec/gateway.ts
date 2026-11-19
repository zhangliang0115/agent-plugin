import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import {
  DEFAULT_TASK_CAPACITY,
  ExecSession,
  LIMITS,
  TaskStore,
  clampBashArgs,
  newId,
  normalizeOutput,
  ReplError,
  renderEnvelope,
  resolveEvalTimeout,
  runEval,
  Sandbox,
  type EvalExecutor,
  type EvalSettlement,
  type OutputDocument,
  type OutputImage,
  type OutputLimits,
  type StructuredToolError,
  type ToolCallRequest,
} from '@zhangliang0115/repl-server-core';

import type {
  Catalog,
  Clock,
  ExecutionGateway,
  RequestIdentity,
  ScriptOutcome,
  ScriptRequest,
  TaskSnapshot,
} from '../ports.ts';
import { resolveWorkspace, type WorkspaceFileSystem } from '../sessions/workspace.ts';
import { type CapacityLimits } from './capacity.ts';
import {
  ExecSessionRegistry,
  type ExecSession as ExecSessionRecord,
  type SessionRemovalReason,
} from './exec-sessions.ts';

/** Envelope caps from L5; media and field normalization happen before rendering. */
const ENVELOPE_LIMITS = { resultChars: 30_000, logChars: 30_000, errorChars: 2_000 };

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
 */
export type CallToolTransport = (
  call: ToolCallRequest,
  workspace?: string,
  binding?: string | null,
  signal?: AbortSignal,
  deadline?: number,
  execSessionId?: string,
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
  /** L5 overrides; tests shrink the media caps. */
  outputLimits?: Partial<OutputLimits>;
  /** Task table injection; defaults to a private store using `ttlMs`. */
  taskStore?: TaskStore;
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
  /** Absolute epoch-ms deadline, used as the L1 upper bound. */
  readonly deadline: number;
}

/** One execution session plus the per-eval context of the evals running in it. */
interface SessionRuntime {
  readonly record: ExecSessionRecord<SessionRuntime, unknown>;
  session: ExecSession;
  readonly filters: Map<number, EvalToolFilter>;
  /** Binding id of the client that owns each running eval; `null` when unbound. */
  readonly bindings: Map<number, string | null>;
  readonly deadlines: Map<number, number>;
  readonly media: Map<number, EvalMedia>;
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
      // `runEval` has already registered the eval, so its authoritative deadline
      // is available here; the dispatch-time estimate is only a fallback.
      const deadline = runtime.session.activeEvals.get(options.evalId)?.deadline ?? pending?.deadline;
      if (deadline !== undefined) runtime.deadlines.set(options.evalId, deadline);
      const outcome = sandbox.eval(code, options);
      const clear = (): void => {
        runtime.filters.delete(options.evalId);
        runtime.bindings.delete(options.evalId);
        runtime.deadlines.delete(options.evalId);
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
): ScriptOutcomeWithOmitted {
  if (settlement.asyncDispatched === true) {
    return {
      content: renderEnvelope(
        {
          evalId: settlement.evalId,
          async: true,
          evalTaskId: settlement.evalTaskId,
          reset: settlement.contextReset,
          restored: settlement.stateRestored === 'lastGood' ? 'lastGood' : undefined,
        },
        ENVELOPE_LIMITS,
      ),
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
    content: renderEnvelope(
      {
        evalId: settlement.evalId,
        log,
        result: normalized.result,
        error: settlement.ok ? undefined : settlement.error ?? settlement.outcome,
        reset: settlement.contextReset,
        restored: settlement.stateRestored === 'lastGood' ? 'lastGood' : undefined,
        truncated,
      },
      ENVELOPE_LIMITS,
    ),
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
  private readonly audit: ((event: Record<string, unknown> & { event: string }) => void) | undefined;
  private readonly onSessionClosed:
    | ((workspace: string, session?: ClosedExecutionSession) => Promise<void> | void)
    | undefined;
  private readonly now: () => number;
  private readonly clock: Clock;
  private readonly toolTimeouts: ToolCallTimeouts;
  private readonly outputLimits: Partial<OutputLimits>;
  private readonly workspaceFs: WorkspaceFileSystem | undefined;
  private readonly tasks: TaskStore;
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
    this.audit = options.onAudit;
    this.onSessionClosed = options.onSessionClosed;
    this.now = options.now ?? (() => Date.now());
    this.clock = options.clock ?? { now: this.now };
    this.workspaceFs = options.workspaceFs;
    this.toolTimeouts = { ...DEFAULT_TOOL_CALL_TIMEOUTS, ...options.toolTimeouts };
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
   * idle LRU eviction live in `ExecSessionRegistry`; `WS_LIMIT` comes from its
   * per-MCP-session workspace quota.
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
      media: new Map(),
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
    deadline: number,
    run: () => Promise<T>,
  ): Promise<T> {
    return this.evalScope.run(
      { filter, binding: request.identity.binding, deadline },
      run,
    );
  }

  /** Timeout that `runEval` will apply; used to derive the L1 deadline up front. */
  private evalTimeoutFor(runtime: SessionRuntime, request: ScriptRequest, asyncMode: boolean): number {
    return resolveEvalTimeout(asyncMode, request.timeoutMs, runtime.session.limits);
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
          console.warn(`repl-server: visibleTools names are not in the catalog: ${unknown.join(', ')}`);
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
      if (hiddenByNames || filter.excludedByTag.has(name)) {
        this.emitAudit({ event: 'tool_denied', evalId: call.evalId, tool: name, workspace: runtime.record.workspace });
        throw new ReplError('TOOL_NOT_VISIBLE', `${name} is not visible in this call`);
      }
    }

    const started = this.now();
    const binding = runtime.bindings.get(call.evalId) ?? null;
    const evalDeadline = runtime.deadlines.get(call.evalId) ?? started + this.toolTimeouts.officialMs;
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

    this.emitAudit({ event: 'tool_call', evalId: call.evalId, tool: name, workspace: runtime.record.workspace });
    const finish = (ok: boolean, error?: unknown): void => {
      this.emitAudit({
        event: 'tool_result',
        evalId: call.evalId,
        tool: name,
        ok,
        durMs: this.now() - started,
        ...(error === undefined ? {} : { error: { message: (error as Error).message ?? String(error) } }),
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
      );
      return raceAbort(Promise.resolve(outcome), controller.signal)
        .then((value) => {
          this.collectMedia(runtime, call.evalId, value);
          finish(true);
          return value;
        })
        .catch((error: unknown) => {
          finish(false, error);
          throw error;
        })
        .finally(cleanup);
    } catch (error) {
      cleanup();
      finish(false, error);
      throw error;
    }
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

  private emitEvalStart(
    request: ScriptRequest,
    exec: ExecSessionRecord<SessionRuntime, unknown>,
    mode: 'sync' | 'async',
  ): void {
    this.emitAudit({
      event: 'eval_start',
      exec: exec.id,
      mode,
      workspace: exec.workspace,
      ...this.identityFields(request),
      codeBytes: Buffer.byteLength(request.code, 'utf8'),
      codeSha256: createHash('sha256').update(request.code, 'utf8').digest('hex'),
      codePrefix: request.code.slice(0, 200),
    });
  }

  private emitEvalEnd(
    request: ScriptRequest,
    exec: ExecSessionRecord<SessionRuntime, unknown>,
    settlement: EvalSettlement,
  ): void {
    this.emitAudit({
      event: 'eval_end',
      exec: exec.id,
      evalId: settlement.evalId,
      workspace: exec.workspace,
      ...this.identityFields(request),
      ok: settlement.ok,
      outcome: settlement.outcome,
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
      const timeoutMs = this.evalTimeoutFor(runtime, request, false);
      const deadline = this.now() + timeoutMs;
      this.emitEvalStart(request, record, 'sync');
      const settlement = await this.withEvalContext(request, filter, deadline, () =>
        runEval(runtime.session, request.code, {
          async: false,
          timeoutMs,
        }),
      );
      this.emitEvalEnd(request, record, settlement);
      const media = this.mediaOfSettlement(runtime, settlement);
      return outcomeOf(settlement, media, this.outputLimits);
    } finally {
      this.execSessions.endEval(record);
    }
  }

  async dispatchScript(request: ScriptRequest): Promise<{ taskId: string; evalId: number }> {
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
      const timeoutMs = this.evalTimeoutFor(runtime, request, true);
      const deadline = this.now() + timeoutMs;
      const owner = ownerKey(request.identity);
      this.pruneTaskTracking();
      const created = this.tasks.create(0, owner);
      taskId = created;
      this.taskLinks.set(created, { sessionId: record.id, owner });
      this.emitEvalStart(request, record, 'async');

      const onSettled = (settled: EvalSettlement): void => {
        this.finishTask(created, runtime, settled);
        this.emitEvalEnd(request, record, settled);
        release();
      };

      const receipt = await this.withEvalContext(request, filter, deadline, () =>
        runEval(runtime.session, request.code, {
          async: true,
          timeoutMs,
          evalTaskId: created,
          onSettled,
        }),
      );
      this.tasks.setEvalId(created, receipt.evalId);
      return { taskId: created, evalId: receipt.evalId };
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

  async waitTasks(owner: string, taskIds: string[] | undefined, timeoutMs: number): Promise<unknown> {
    const ids = taskIds ?? this.tasks.unconsumedIds(owner);
    const waited = await this.tasks.wait(owner, ids, timeoutMs);
    const consumed = this.tasks.consume(owner, ids);
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
      return false;
    }
    if (snapshot.status !== 'working') return false;
    if (!this.tasks.cancel(taskId)) return false;
    const link = this.taskLinks.get(taskId);
    if (link !== undefined) {
      const runtime = this.runtimes.get(link.sessionId);
      if (runtime !== undefined) this.abortEval(runtime, snapshot.evalId);
    }
    return true;
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

  /**
   * `DELETE /mcp` / binding deletion: cancels in-flight evals, drops the task
   * table slice, disposes workers and serve handles, and is idempotent.
   * `owner` may be a binding id or an MCP session id.
   */
  async destroyOwner(owner: string): Promise<void> {
    if (typeof owner !== 'string' || owner === '') return;
    const targets = this.execSessions
      .list()
      .filter((record) => record.binding === owner || record.mcpSessionId === owner);
    const targetIds = new Set(targets.map((record) => record.id));

    // Cancel linked tasks first, so a settling eval cannot flip them to completed.
    for (const [taskId, link] of [...this.taskLinks]) {
      if (!targetIds.has(link.sessionId) && link.owner !== owner) continue;
      this.tasks.cancel(taskId);
      this.tasks.remove(taskId);
      this.taskLinks.delete(taskId);
      this.taskMedia.delete(taskId);
    }
    this.tasks.removeOwner(owner);

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

  /** Awaited by `destroyOwner`/`disposeAll`; never rejects. */
  private async teardown(runtime: SessionRuntime, reason: SessionRemovalReason): Promise<void> {
    runtime.filters.clear();
    runtime.bindings.clear();
    runtime.deadlines.clear();
    runtime.media.clear();
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
