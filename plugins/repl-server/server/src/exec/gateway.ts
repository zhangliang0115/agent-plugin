import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import {
  ExecSession,
  newId,
  ReplError,
  renderEnvelope,
  runEval,
  Sandbox,
  type EvalExecutor,
  type EvalSettlement,
  type SandboxEvalOutcome,
  type ToolCallRequest,
} from '@zhangliang0115/repl-server-core';

import type {
  Catalog,
  ExecutionGateway,
  RequestIdentity,
  ScriptOutcome,
  ScriptRequest,
  TaskSnapshot,
} from '../ports.ts';

export interface GatewayTaskRecord {
  taskId: string;
  evalId: number;
  owner: string;
  status: 'working' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  settlement?: EvalSettlement;
  error?: { code: string; message: string; data?: unknown };
}

export interface ExecGatewayOptions {
  /** Executes one tool call from inside a script. `workspace`/`binding` identify the caller. */
  callTool: (call: ToolCallRequest, workspace?: string, binding?: string | null) => Promise<unknown>;
  /**
   * Catalog snapshot used to resolve `excludeTags`. When omitted, an eval that
   * asks for tag exclusions fails instead of silently exposing every tool.
   */
  catalog?: Catalog;
  /** Optional healthy/restart hooks for the serve process. */
  serve?: { healthy(): boolean; restart(): Promise<void> | void };
  /** Audit sink for eval and tool-call events; failures must never break an eval. */
  onAudit?: (event: Record<string, unknown> & { event: string }) => void;
  /** Called when an execution session is torn down; releases its serve process. */
  onSessionClosed?: (workspace: string) => Promise<void> | void;
  now?: () => number;
  ttlMs?: number;
  maxInFlight?: number;
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

/** One execution session plus the filter context of each eval currently running in it. */
interface SessionRuntime {
  readonly session: ExecSession;
  readonly filters: Map<number, EvalToolFilter>;
  /** Binding id of the client that owns each running eval; `null` when unbound. */
  readonly bindings: Map<number, string | null>;
  /** Owner that first used the session (`binding ?? mcp`), for `destroyOwner`. */
  owner: string | null;
}

function canonicalToolName(call: ToolCallRequest): string {
  return call.server === undefined ? call.tool : `${call.server}.${call.tool}`;
}

/**
 * Wraps one Sandbox as the session's executor so the filter of the `runEval`
 * call that started an eval is bound to the `evalId` the session allocated.
 * The binding is dropped when the eval settles, so later evals start clean.
 */
function filteredExecutor(
  sandbox: Sandbox,
  filters: Map<number, EvalToolFilter>,
  bindings: Map<number, string | null>,
  scope: AsyncLocalStorage<PendingEvalFilter>,
  bindingScope: AsyncLocalStorage<string | null>,
  resolve: (pending: PendingEvalFilter) => EvalToolFilter,
): EvalExecutor {
  return {
    get epoch(): number {
      return sandbox.epoch;
    },
    start: () => sandbox.start(),
    eval: (code, options) => {
      const pending = scope.getStore();
      if (pending !== undefined) filters.set(options.evalId, resolve(pending));
      bindings.set(options.evalId, bindingScope.getStore() ?? null);
      const outcome = sandbox.eval(code, options);
      const clear = (): void => {
        filters.delete(options.evalId);
        bindings.delete(options.evalId);
      };
      void outcome.then(clear, clear);
      return outcome;
    },
    cancel: (evalId) => sandbox.cancel(evalId),
    terminate: () => sandbox.terminate(),
  };
}

function textResult(content: string, isError = false): ScriptOutcome {
  return { content, isError };
}

function envelopeOf(settlement: EvalSettlement): string {
  if (settlement.asyncDispatched === true) {
    return renderEnvelope({
      evalId: settlement.evalId,
      async: true,
      evalTaskId: settlement.evalTaskId,
      reset: settlement.contextReset,
      restored: settlement.stateRestored === 'lastGood' ? 'lastGood' : undefined,
    }, { resultChars: 30000, logChars: 30000, errorChars: 2000 });
  }

  const log = [settlement.stdout, settlement.stderr].filter((part) => part !== '').join('\n');
  return renderEnvelope(
    {
      evalId: settlement.evalId,
      log,
      result: settlement.result === undefined ? undefined : String(settlement.result),
      error: settlement.ok ? undefined : settlement.error ?? settlement.outcome,
      reset: settlement.contextReset,
      restored: settlement.stateRestored === 'lastGood' ? 'lastGood' : undefined,
      truncated: Object.values(settlement.truncated).some(Boolean),
    },
    { resultChars: 30000, logChars: 30000, errorChars: 2000 },
  );
}

function snapshotOf(record: GatewayTaskRecord): TaskSnapshot {
  const settlement = record.settlement;
  const view: TaskSnapshot = {
    taskId: record.taskId,
    status: record.status,
    createdAt: record.createdAt,
    lastUpdatedAt: record.updatedAt,
    ttlMs: 9_000_000,
    pollIntervalMs: 500,
  };
  if (settlement !== undefined) {
    view.result = textResult(envelopeOf(settlement), !settlement.ok);
  }
  if (record.error !== undefined) view.error = record.error;
  return view;
}

/** Minimal ExecutionGateway backed by the core ExecSession/Sandbox. */
export class ExecGateway implements ExecutionGateway {
  private readonly callTool: ExecGatewayOptions['callTool'];
  private readonly catalog: ExecGatewayOptions['catalog'];
  private readonly serve: ExecGatewayOptions['serve'];
  private readonly audit: ((event: Record<string, unknown> & { event: string }) => void) | undefined;
  private readonly onSessionClosed: ((workspace: string) => Promise<void> | void) | undefined;
  private readonly now: () => number;
  private readonly sessions = new Map<string, SessionRuntime>();
  private readonly tasks = new Map<string, GatewayTaskRecord>();
  private readonly pending = new Map<string, Promise<void>>();
  private readonly settled = new Map<string, Promise<void>>();
  /**
   * Carries a `run_script` filter into the executor call for the evalId that
   * `runEval` allocates internally, without relying on dispatch ordering.
   */
  private readonly filterScope = new AsyncLocalStorage<PendingEvalFilter>();
  /** Carries the caller's binding into the eval so tool calls can be grouped per binding. */
  private readonly bindingScope = new AsyncLocalStorage<string | null>();

  constructor(options: ExecGatewayOptions) {
    this.callTool = options.callTool;
    this.catalog = options.catalog;
    this.serve = options.serve;
    this.audit = options.onAudit;
    this.onSessionClosed = options.onSessionClosed;
    this.now = options.now ?? (() => Date.now());
  }

  private sessionFor(workspace: string): SessionRuntime {
    const key = workspace === '' ? '.' : workspace;
    const existing = this.sessions.get(key);
    if (existing !== undefined) return existing;

    const filters = new Map<number, EvalToolFilter>();
    const bindings = new Map<number, string | null>();
    const scope = this.filterScope;
    const bindingScope = this.bindingScope;
    const resolve = (pending: PendingEvalFilter): EvalToolFilter => this.resolveFilter(pending);
    const session = new ExecSession({
      id: newId('execSession'),
      workspace: key,
      serve: this.serve,
      createExecutor: () => {
        const sandbox = new Sandbox({
          sessionId: key,
          onToolCall: (call) => this.callToolFor(filters, bindings, call, key),
        });
        return filteredExecutor(sandbox, filters, bindings, scope, bindingScope, resolve);
      },
    });
    const runtime: SessionRuntime = { session, filters, bindings, owner: null };
    this.sessions.set(key, runtime);
    this.emitAudit({ event: 'exec_start', execId: session.id, workspace: key });
    return runtime;
  }

  /** Turns the request's narrowing into the filter for one eval. */
  private filterFor(request: ScriptRequest): PendingEvalFilter | undefined {
    const visible = request.visibleTools === undefined ? undefined : new Set(request.visibleTools);
    const excludeTags = new Set(request.excludeTags ?? []);
    if (visible === undefined && excludeTags.size === 0) return undefined;
    return { visible, excludeTags };
  }

  private withFilter<T>(filter: PendingEvalFilter | undefined, binding: string | null, run: () => Promise<T>): Promise<T> {
    const scoped = (): Promise<T> => this.bindingScope.run(binding, run);
    return filter === undefined ? scoped() : this.filterScope.run(filter, scoped);
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

  /** Applies an eval's filter before the call reaches the injected transport. */
  private callToolFor(
    filters: Map<number, EvalToolFilter>,
    bindings: Map<number, string | null>,
    call: ToolCallRequest,
    workspace: string,
  ): unknown {
    const name = canonicalToolName(call);
    const filter = filters.get(call.evalId);
    if (filter !== undefined) {
      const hiddenByNames = filter.visible !== undefined && !filter.visible.has(name);
      if (hiddenByNames || filter.excludedByTag.has(name)) {
        this.emitAudit({ event: 'tool_denied', evalId: call.evalId, tool: name, workspace });
        throw new ReplError('TOOL_NOT_VISIBLE', `${name} is not visible in this call`);
      }
    }

    const started = this.now();
    this.emitAudit({ event: 'tool_call', evalId: call.evalId, tool: name, workspace });
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
      const outcome = this.callTool(call, workspace, bindings.get(call.evalId) ?? null);
      return Promise.resolve(outcome).then(
        (value) => {
          finish(true);
          return value;
        },
        (error: unknown) => {
          finish(false, error);
          throw error;
        },
      );
    } catch (error) {
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
      mcp: request.identity.mcp,
    };
  }

  private emitEvalStart(request: ScriptRequest, workspace: string, mode: 'sync' | 'async'): void {
    this.emitAudit({
      event: 'eval_start',
      mode,
      workspace,
      ...this.identityFields(request),
      codeBytes: Buffer.byteLength(request.code, 'utf8'),
      codeSha256: createHash('sha256').update(request.code, 'utf8').digest('hex'),
      codePrefix: request.code.slice(0, 200),
    });
  }

  private emitEvalEnd(request: ScriptRequest, workspace: string, settlement: EvalSettlement): void {
    this.emitAudit({
      event: 'eval_end',
      evalId: settlement.evalId,
      workspace,
      ...this.identityFields(request),
      ok: settlement.ok,
      outcome: settlement.outcome,
      ms: settlement.ms,
      ...(settlement.error === undefined ? {} : { error: String(settlement.error) }),
    });
  }

  async runScript(request: ScriptRequest): Promise<ScriptOutcome> {
    const runtime = this.sessionFor(request.workspace ?? '');
    runtime.owner ??= ownerKey(request.identity);
    const workspace = runtime.session.workspace;
    this.emitEvalStart(request, workspace, 'sync');
    const settlement = await this.withFilter(this.filterFor(request), request.identity.binding, () =>
      runEval(runtime.session, request.code, {
        async: false,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      }),
    );
    this.emitEvalEnd(request, workspace, settlement);
    return textResult(envelopeOf(settlement), !settlement.ok);
  }

  async dispatchScript(request: ScriptRequest): Promise<{ taskId: string; evalId: number }> {
    const runtime = this.sessionFor(request.workspace ?? '');
    runtime.owner ??= ownerKey(request.identity);
    const filter = this.filterFor(request);
    this.emitEvalStart(request, runtime.session.workspace, 'async');
    const taskId = newId('task');
    const owner = ownerKey(request.identity);
    const now = this.now();
    const record: GatewayTaskRecord = {
      taskId,
      evalId: 0,
      owner,
      status: 'working',
      createdAt: new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };
    this.tasks.set(taskId, record);
    let resolveSettled!: () => void;
    const settledPromise = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    this.settled.set(taskId, settledPromise);

    const run = (async () => {
      try {
        const settlement = await this.withFilter(filter, request.identity.binding, () =>
          runEval(runtime.session, request.code, {
            async: true,
            evalTaskId: taskId,
            ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
            onSettled: (settled) => {
              record.evalId = settled.evalId;
              record.settlement = settled;
              record.status = settled.ok ? 'completed' : settled.outcome === 'cancelled' ? 'cancelled' : 'failed';
              record.updatedAt = new Date(this.now()).toISOString();
              this.emitEvalEnd(request, runtime.session.workspace, settled);
              resolveSettled();
            },
          }),
        );
        record.evalId = settlement.evalId;
      } catch (error) {
        record.status = 'failed';
        record.error = { code: 'DISPATCH_FAILED', message: (error as Error).message };
        record.updatedAt = new Date(this.now()).toISOString();
        resolveSettled();
      }
    })();
    this.pending.set(taskId, run);
    return { taskId, evalId: 0 };
  }

  async waitTasks(owner: string, taskIds: string[] | undefined, timeoutMs: number): Promise<unknown> {
    const ids = taskIds ?? [...this.tasks.values()].filter((task) => task.owner === owner).map((task) => task.taskId);
    const deadline = this.now() + timeoutMs;
    const waiting = ids.map((id) => this.settled.get(id)).filter((p): p is Promise<void> => p !== undefined);
    if (waiting.length > 0) {
      let timer: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          Promise.allSettled(waiting),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, Math.max(0, deadline - this.now()));
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    const events = ids
      .map((id) => this.tasks.get(id))
      .filter((task): task is GatewayTaskRecord => task !== undefined && task.status !== 'working')
      .map((task) => ({
        taskId: task.taskId,
        evalId: task.evalId,
        status: task.status,
        result: task.settlement === undefined ? undefined : envelopeOf(task.settlement),
        stdout: task.settlement?.stdout,
        elapsedMs: task.settlement?.ms ?? 0,
        error: task.error,
      }));
    const pending = ids.filter((id) => this.tasks.get(id)?.status === 'working').length;
    return { ok: true, timedOut: pending > 0, events, pending };
  }

  async getTask(owner: string, taskId: string): Promise<TaskSnapshot | null> {
    const record = this.tasks.get(taskId);
    if (record === undefined || record.owner !== owner) return null;
    return snapshotOf(record);
  }

  async cancelTask(owner: string, taskId: string): Promise<boolean> {
    const record = this.tasks.get(taskId);
    if (record === undefined || record.owner !== owner) return false;
    if (record.status !== 'working') return false;
    record.status = 'cancelled';
    record.updatedAt = new Date(this.now()).toISOString();
    return true;
  }

  /** Live execution-session counters for the admin overview. */
  stats(): { sessions: number; inFlightEvals: number } {
    let inFlightEvals = 0;
    for (const runtime of this.sessions.values()) inFlightEvals += runtime.bindings.size;
    return { sessions: this.sessions.size, inFlightEvals };
  }

  async destroyOwner(owner: string): Promise<void> {
    for (const [id, task] of this.tasks) {
      if (task.owner === owner) this.tasks.delete(id);
    }
    for (const [key, runtime] of this.sessions) {
      if (runtime.owner === owner) {
        this.sessions.delete(key);
        runtime.filters.clear();
        runtime.bindings.clear();
        this.emitAudit({ event: 'exec_end', execId: runtime.session.id, workspace: key });
        await runtime.session.dispose();
        await this.onSessionClosed?.(key);
      }
    }
  }

  /** Terminates every worker; used on shutdown and in tests. */
  async disposeAll(): Promise<void> {
    const runtimes = [...this.sessions.values()];
    this.sessions.clear();
    this.tasks.clear();
    this.pending.clear();
    for (const runtime of runtimes) runtime.filters.clear();
    for (const runtime of runtimes) runtime.bindings.clear();
    await Promise.allSettled(runtimes.map((runtime) => runtime.session.dispose()));
    for (const runtime of runtimes) {
      this.emitAudit({ event: 'exec_end', execId: runtime.session.id, workspace: runtime.session.workspace });
      await this.onSessionClosed?.(runtime.session.workspace);
    }
  }
}

function ownerKey(identity: RequestIdentity): string {
  return identity.binding ?? identity.mcp;
}
