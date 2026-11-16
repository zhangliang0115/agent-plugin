/**
 * Code Mode executor. The model sees one tool, `run_code`. Each program it sends
 * runs in the core sandbox. Every tool call the program makes goes through the
 * DSH pipeline (pre-execute, guard, execute, post-execute) as a sub-call of the
 * `run_code` call. @module
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { ToolCallId, createUserMessage, type ToolSchema } from '@deepseek-ai/dsh-llm';
import {
  RUN_CODE_NAME,
  ToolNotFoundError,
  defineTool,
  projectToolSchema,
  type ToolBatchInput,
  type ToolBatchResult,
  type ToolDefinition,
  type ToolExecutionInput,
  type ToolExecutor,
  type ToolModelInput,
  type ToolPromptSection,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { ToolExecutionPipeline, executeToolBatch } from '@deepseek-ai/dsh-tools/pipeline';
import { CodeMode, ToolCallError, renderInstructions, toolCallExample, toolReturns, toolSignature, type CallControl, type ToolDescriptor } from '@zhangliang0115/code-mode-core';
import { allowsConcurrency } from './config.ts';
import { DispatchLog } from './dispatch-log.ts';
import { hiddenToolPredicate } from './disabled.ts';
import { findParallelClassifier } from './parallel.ts';
import { RunScheduler } from './run-scheduler.ts';

// The built-in PTC executor declares this source kind for content it defers from a program run.
// `MessageSourceMap` is merge-extensible, so a program's image result uses the same vocabulary.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ptc-mode': { kind: 'ptc-mode' };
  }
}

const RUN_CODE_DESCRIPTION = 'Run JavaScript that calls the available tools in one step. import, require or process are not available; call the listed tools instead. Only the last expression and self.log output come back to you. Top-level variables persist across run_code calls in this session.';

export interface ExecutorOptions {
  /** Root run_code calls that one batch may run at once. */
  readonly maxParallel?: number;
  /** Sandbox runtime. Defaults to a new CodeMode with default limits. */
  readonly mode?: CodeMode;
  /**
   * Tools whose body waits for a person (a question, a plan review). The run deadline does not
   * elapse while one of them runs. Defaults to `ask_user_question` and `exit_plan_mode`.
   */
  readonly userWaitTools?: readonly string[];
  /**
   * Tool names a program may overlap even though the tool declares no concurrency safety.
   * Exact names, or a trailing `*` for a prefix. Read on every classification, so a
   * deployment that edits the list applies the change to the next sub-call. Omitted or
   * empty keeps DSH's fail-closed scheduling.
   */
  readonly concurrentTools?: () => readonly string[];
}

/** The part of the host spill store this plugin calls. */
interface SpillStoreLike {
  saveText(input: {
    owner: { sessionId: string };
    source: { kind: 'tool'; toolName: string; callId: unknown; label: string };
    suggestedName: string;
    content: string;
  }): Promise<{ locator: unknown; retrievalHint: string }>;
}
/** Per-run state: ordering of the program's tool calls and its session events. */
interface RunState {
  readonly scheduler: RunScheduler;
  readonly log: DispatchLog;
  /** The step's visible tool schemas, so a sub-call carries its binding schema the way PTC does. */
  readonly schemas: ReadonlyMap<string, ToolSchema>;
  /**
   * complete calls finish in submission order, however out of order their bodies do. Post-execute
   * and its session events therefore reach the approval panel and audit trail in model order.
   */
  readonly completeGate: OrderedGate;
  subCalls: number;
}

/**
 * Lets calls settle in submission order. A call whose body finished early waits for the calls
 * submitted before it; a call that failed still advances the order, so the queue cannot stall.
 */
class OrderedGate {
  private next = 0;
  private readonly finished = new Set<number>();
  private readonly pending = new Map<number, () => void>();

  /** Resolves when it is this call's turn to settle. Rejects when the run ends first. */
  wait(index: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(runOverError());
    if (this.finished.has(index) || index <= this.next) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.pending.delete(index);
        reject(runOverError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.pending.set(index, () => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      });
    });
  }

  /** Marks a call finished, in order or out of it, and releases the next waiting call. */
  advance(index: number): void {
    this.finished.add(index);
    while (this.finished.has(this.next)) this.next++;
    const waiter = this.pending.get(this.next);
    if (waiter === undefined) return;
    this.pending.delete(this.next);
    waiter();
  }
}

/** Raised for a call that was still queued when its run ended. */
function runOverError(): Error {
  return new ToolCallError('the run ended before this tool call started', { code: 'ABORTED_BEFORE_DISPATCH', name: 'AbortError' });
}
/** What the `approval/request` and `user-questions/request` listeners read from a request. */
interface UserWaitRequest {
  readonly agent?: unknown;
  readonly callId?: unknown;
  readonly signal?: AbortSignal;
}
type UserWaitListener = (request: UserWaitRequest, next: () => Promise<unknown>) => Promise<unknown>;
/** Host events that ask a person from inside a tool body. Both are waterfalls; an answerer returns without calling `next`. */
const USER_WAIT_EVENTS: readonly string[] = ['approval/request', 'user-questions/request'];

const DEFAULT_USER_WAIT_TOOLS: readonly string[] = ['ask_user_question', 'exit_plan_mode'];

/** How long the run waits for dispatch-log listeners after the program ended. A stuck listener must not hold run_code. */
const LOG_DRAIN_TIMEOUT_MS = 2_000;

function toDescriptor(definition: ToolDefinition): ToolDescriptor {
  const schema = projectToolSchema(definition, false);
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.parameters,
    outputSchema: definition.output.schema,
  };
}

/** The `code` argument's description, listing the tool functions this step actually binds with their return types. */
function codeDescription(tools: readonly ToolDescriptor[]): string {
  const callable = tools.filter((tool) => tool.name !== RUN_CODE_NAME);
  const first = callable[0];
  if (first === undefined) return 'JavaScript program. No tools are available, so it can only compute values.';
  const list = callable.map((tool) => `${toolSignature(tool)}${toolReturns(tool)}`).join('; ');
  return `JavaScript program. Available tools (async functions): ${list}. Example: ${toolCallExample(first)}`;
}

/** Runs run_code batches and sub-calls. One instance per DSH deployment. */
export class CodeModeExecutor implements ToolExecutor {
  readonly sections: readonly ToolPromptSection[];
  private readonly ctx: Context;
  private readonly pipeline: ToolExecutionPipeline;
  private readonly runCodeTool: ToolDefinition;
  private readonly mode: CodeMode;
  private readonly maxParallel: number;
  private readonly registeredAgents = new WeakSet<Agent>();
  private readonly userWaitTools: ReadonlySet<string>;
  /** Reads the allowlist of tool names that may overlap despite declaring no concurrency safety. */
  private readonly concurrentTools: () => readonly string[];
  /** Sub-calls in flight, by agent and then sub-call id, with the control of the run each belongs to. */
  private readonly activeSubCalls = new Map<unknown, Map<string, CallControl>>();
  private readonly listenerDisposers: Array<() => void> = [];
  /** Stop signals of the programs running now, aborted by {@link dispose}. */
  private readonly inflight = new Set<AbortController>();

  constructor(ctx: Context, options: ExecutorOptions = {}) {
    this.ctx = ctx;
    this.mode = options.mode ?? new CodeMode();
    // 0 or NaN would leave the batch scheduler with no slot to admit, spinning forever.
    const requested = options.maxParallel ?? 10;
    this.maxParallel = Number.isFinite(requested) ? Math.max(1, Math.floor(requested)) : 1;
    this.userWaitTools = new Set(options.userWaitTools ?? DEFAULT_USER_WAIT_TOOLS);
    this.concurrentTools = options.concurrentTools ?? (() => []);
    this.runCodeTool = this.runCodeFor([]);
    const tools = ctx.tools;
    this.sections = [{
      name: 'code-mode:run_code',
      order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'),
      text: (visible) => renderInstructions(this.visibleTools(visible).map(toDescriptor)),
      interpolate: false,
    }];
    this.pipeline = new ToolExecutionPipeline(ctx, {
      get: (name, scope, toolSet) => {
        if (name === RUN_CODE_NAME) return this.runCodeTool;
        const tool = tools.executable(name, scope, toolSet);
        // DSH schedules a call concurrently only when the tool opts in. A deployment can list a
        // tool here, or an outside classifier can, to overlap calls the tool itself does not mark
        // safe (read-only MCP helpers, for example). Execution still goes through prepare, guards,
        // approvals and post-execute.
        if (tool === undefined || tool.isConcurrencySafe !== undefined) return tool;
        if (!this.allowsParallel(name)) return tool;
        return { ...tool, isConcurrencySafe: () => true };
      },
      reject: (name, nested) => (!nested && name !== RUN_CODE_NAME
        ? new ToolNotFoundError(name, `only \`${RUN_CODE_NAME}\` is callable directly; call \`${name}\` from inside a \`${RUN_CODE_NAME}\` program instead`)
        : undefined),
    });
    this.watchUserWaits();
  }

  /** The model sees only run_code. Other tools are reached from inside programs. The code description lists the visible tools. */
  describe(tools: readonly ToolDefinition[]): ToolModelInput {
    return { schemas: [projectToolSchema(this.runCodeFor(this.visibleTools(tools).map(toDescriptor)), false)], knownNames: [RUN_CODE_NAME] };
  }

  /**
   * The tools the model may see now: the list without the ones the user disabled. The provider is
   * read on each call, so the result follows the current disabled list.
   */
  private visibleTools<T extends { readonly name: string }>(tools: readonly T[]): T[] {
    const isHidden = hiddenToolPredicate(this.ctx);
    return tools.filter((tool) => !isHidden(tool.name));
  }

  /** The run_code definition. Its code description names the tools in `tools`. */
  private runCodeFor(tools: readonly ToolDescriptor[]): ToolDefinition {
    return defineTool({
      name: RUN_CODE_NAME,
      description: RUN_CODE_DESCRIPTION,
      parameters: {
        code: { type: 'string', required: true, description: codeDescription(tools) },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      execute: (args, exec) => this.runProgram(args.code, exec),
    });
  }

  execute(input: ToolBatchInput): Promise<ToolBatchResult> {
    return executeToolBatch(input, this.pipeline, () => this.maxParallel);
  }

  /**
   * True when the deployment's allowlist or the optional `mcpParallel` classifier lets `name`
   * overlap. Both are read now, so the answer reflects the latest list and the provider present
   * at this sub-call.
   */
  private allowsParallel(name: string): boolean {
    if (allowsConcurrency(name, this.concurrentTools())) return true;
    // A misbehaving external classifier must not fail the sub-call: treat it as "not parallel".
    try {
      return findParallelClassifier(this.ctx)?.isParallel(name) === true;
    } catch {
      return false;
    }
  }

  /** Stop the programs running now and release every sandbox. Called when the plugin is disposed. */
  dispose(): void {
    for (const dispose of this.listenerDisposers.splice(0)) dispose();
    // Abort first: a program still running would otherwise keep calling tools after the executor is gone.
    for (const stop of this.inflight) stop.abort();
    this.inflight.clear();
    this.activeSubCalls.clear();
    this.mode.dispose();
  }

  /**
   * Pause the run deadline while the host waits for a person on behalf of one of this agent's
   * sub-calls, whichever path asks: the pipeline's `ask` decision, an approval a tool requests in its
   * own body (bash, pwsh, write and edit do this for `sandbox_permissions`), or a user question.
   * The listeners are prepended: an answerer returns an outcome without calling `next`, so a
   * listener appended after it would never run.
   */
  private watchUserWaits(): void {
    const on = (this.ctx as unknown as { on(event: string, listener: UserWaitListener, options: { prepend: boolean }): () => void }).on;
    for (const event of USER_WAIT_EVENTS) {
      this.listenerDisposers.push(on.call(this.ctx, event, (request, next) => this.holdWhileAsking(request, next), { prepend: true }));
    }
  }

  private async holdWhileAsking(request: UserWaitRequest, next: () => Promise<unknown>): Promise<unknown> {
    const calls = this.activeSubCalls.get(request.agent);
    if (calls === undefined || calls.size === 0) return next();
    // An approval names its sub-call. A user question does not, so every run of the agent is held.
    const own = typeof request.callId === 'string' ? calls.get(request.callId) : undefined;
    const holds = (own === undefined ? [...calls.values()] : [own]).map((control) => control.holdDeadline());
    const release = (): void => { for (const unhold of holds) unhold(); };
    // The host settles an aborted request as cancelled while the answerer's promise may stay pending.
    request.signal?.addEventListener('abort', release, { once: true });
    try {
      return await next();
    } finally {
      request.signal?.removeEventListener('abort', release);
      release();
    }
  }

  private async runProgram(code: string, exec: ToolRunContext): Promise<string> {
    const agent = exec.agent;
    const owner: object = agent ?? {};
    if (agent !== undefined) this.registerRelease(agent);
    // Disabled tools stay bound on purpose: they are hidden from what the model reads, but a call by name
    // must reach the pipeline, where mcp-ui's tools/pre-execute listener refuses it with a readable reason.
    const schemas = this.ctx.tools.schemas(agent, exec.toolSet).filter((schema) => schema.name !== RUN_CODE_NAME);
    const tools = schemas.map((schema) => ({ name: schema.name, description: schema.description, inputSchema: schema.parameters }));
    const run: RunState = {
      scheduler: new RunScheduler(),
      log: new DispatchLog(this.ctx, exec),
      schemas: new Map(schemas.map((schema) => [schema.name, schema])),
      completeGate: new OrderedGate(),
      subCalls: 0,
    };
    const stop = new AbortController();
    this.inflight.add(stop);
    // The host's signal and this executor's own stop signal: dispose() aborts every running program.
    const runSignal = AbortSignal.any([exec.signal, stop.signal]);
    try {
      return await this.mode.run(owner, {
        code,
        tools,
        invoke: (name, args, signal, control) => this.invokeSubCall(run, exec, ++run.subCalls, name, args, signal, control),
        signal: runSignal,
        onResultOverflow: (text) => this.spillResult(exec, text),
      });
    } finally {
      this.inflight.delete(stop);
      await run.log.drain(LOG_DRAIN_TIMEOUT_MS);
      if (agent === undefined) this.mode.release(owner);
    }
  }

  /** Save an oversized result through the host spill store. Returns the note for the truncation marker, or undefined to keep the plain marker. */
  private async spillResult(exec: ToolRunContext, text: string): Promise<string | undefined> {
    const agent = exec.agent;
    if (agent === undefined) return undefined;
    const store = (this.ctx as unknown as { get(name: string): unknown }).get('spillStore') as SpillStoreLike | undefined;
    if (store === undefined || store === null) return undefined;
    try {
      const ref = await store.saveText({
        owner: { sessionId: agent.session.header.id },
        source: { kind: 'tool', toolName: RUN_CODE_NAME, callId: exec.callId, label: 'result' },
        suggestedName: 'run_code.txt',
        content: text,
      });
      return `Full result stored at: ${String(ref.locator)}. ${ref.retrievalHint}`;
    } catch (error) {
      this.ctx.logger.warn(`code-mode: saving the oversized result failed: ${String(error)}; keeping the plain truncation`);
      return undefined;
    }
  }
  /** Drop an agent's sandbox when the agent is torn down. Registered once per agent. */
  private registerRelease(agent: Agent): void {
    if (this.registeredAgents.has(agent)) return;
    this.registeredAgents.add(agent);
    agent.ctx.effect(() => () => this.mode.release(agent), 'Code Mode retained context');
  }

  /**
   * One tool call from a program: prepare, dispatch, complete, as a child of the run_code call.
   * Nothing here is shared with other runs or agents. While the call waits for a person the run
   * deadline is paused: approval inside `prepare`, a user-wait tool's body, and any approval or user
   * question requested during `dispatch` (see `watchUserWaits`).
   */
  private async invokeSubCall(
    run: RunState,
    exec: ToolRunContext,
    index: number,
    name: string,
    args: unknown,
    signal: AbortSignal,
    control: CallControl,
  ): Promise<unknown> {
    const order = index - 1;
    let advanced = false;
    /**
     * Advances the settle order once, whether this call completed or failed. It runs in the outermost
     * `finally`: a call that throws before taking a scheduler slot (the guard below, a rejected
     * `acquire`) must not keep later calls waiting for this index until the run deadline.
     */
    const advance = (): void => {
      if (advanced) return;
      advanced = true;
      run.completeGate.advance(order);
    };
    try {
      // Defense in depth: run_code is not bound inside a program, so the guest reports it as
      // undefined before reaching this point.
      if (name === RUN_CODE_NAME) throw new Error(`${RUN_CODE_NAME} cannot be called from inside a program`);
      const subCallId = `${exec.callId}:ptc:${index}`;
      const schema = run.schemas.get(name);
      const input: ToolExecutionInput = {
        callId: ToolCallId(subCallId),
        rootCallId: exec.rootCallId,
        name,
        // PTC passes the binding schema; a PTC-aware reviewer (auto-review) requires it.
        ...schema === undefined ? {} : { schema },
        arguments: args,
        agent: exec.agent,
        toolSet: exec.toolSet,
        parent: exec.token,
        signal,
      };
      const release = await run.scheduler.acquire(() => this.pipeline.executionMode(input).kind, signal);
      const forgetCall = this.trackSubCall(exec.agent, subCallId, control);
      try {
        run.log.start(subCallId, name, args);
        // No deadline hold around prepare: an approval or a user question holds the deadline itself,
        // through `watchUserWaits`. Holding the whole prepare would also pause it for a hook that
        // never resolves, and `run_code` would hang instead of running into its deadline.
        const prepared = await this.pipeline.prepare(input);
        let outcome;
        if (prepared.kind === 'dispatch') {
          const unholdDispatch = this.userWaitTools.has(name) ? control.holdDeadline() : undefined;
          try {
            outcome = await this.pipeline.dispatch(prepared.exec);
          } finally {
            unholdDispatch?.();
          }
        } else {
          outcome = prepared;
        }
        // After a timeout or abort the sandbox stops waiting; skip post-execute rather than emit
        // events for a run that already reported its result.
        if (signal.aborted) throw runOverError();
        await run.completeGate.wait(order, signal);
        const result = await this.pipeline.complete(prepared.exec, outcome);
        // An image cannot travel through JSON into the program, so the model would never see it.
        // Defer it as a user message, the way the built-in PTC executor does.
        if (!result.isError && result.content.some((block) => block.type === 'image')) {
          exec.deferContext(createUserMessage({ content: result.content, source: { kind: 'ptc-mode' } }));
        }
        for (const context of result.additionalContexts ?? []) exec.deferContext(context);
        if (result.concludesTurn) exec.concludeTurn();
        run.log.settle(subCallId, name, args, result);
        if (result.isError) throw new ToolCallError(result.error.message, { code: result.error.info?.code, name: result.error.info?.name });
        return result.value;
      } finally {
        forgetCall();
        release();
      }
    } finally {
      // A call that failed before its turn must not block the calls submitted after it.
      advance();
    }
  }

  /** Record a sub-call as in flight for its agent. Returns the function that forgets it. */
  private trackSubCall(agent: unknown, subCallId: string, control: CallControl): () => void {
    if (agent === undefined) return () => undefined;
    const calls = this.activeSubCalls.get(agent) ?? new Map<string, CallControl>();
    calls.set(subCallId, control);
    this.activeSubCalls.set(agent, calls);
    return () => {
      calls.delete(subCallId);
      if (calls.size === 0 && this.activeSubCalls.get(agent) === calls) this.activeSubCalls.delete(agent);
    };
  }
}
