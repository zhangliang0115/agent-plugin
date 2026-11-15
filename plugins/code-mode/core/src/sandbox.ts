/**
 * Sealed, persistent JavaScript contexts keyed by owner (an agent, or a single
 * call's temporary owner). Each owner has one QuickJS runtime. The guest reaches
 * the host only through two synchronous bridge functions:
 *  - invoke: starts a tool call and returns at once; the guest holds a promise.
 *  - done: reports a run's final value or error.
 * The host settles guest promises from its own loop, so calls run in parallel
 * without asyncify. @module
 */
import {
  newQuickJSWASMModule,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
  type QuickJSWASMModule,
} from 'quickjs-emscripten';
import { GUEST_BOOTSTRAP, globalToolNames } from './prelude.ts';
import { transformProgram, type TransformedProgram } from './transform.ts';
import { ToolCallError, type CodeLimits, type ToolDescriptor, type ToolInvoker } from './types.ts';

export interface EvaluateRequest {
  readonly tools: readonly ToolDescriptor[];
  readonly invoke: ToolInvoker;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface EvaluationResult {
  readonly evalIndex: number;
  readonly ok: boolean;
  readonly value?: string;
  readonly error?: string;
  readonly log: string;
}

interface Settlement {
  readonly id: number;
  readonly ok: boolean;
  readonly payload: string;
  /** JSON `{code?, errorName?}` for a rejection that carries the host's error identity. */
  readonly info?: string;
}

/** The program text as the user wrote it, and how many lines the transform added before it. */
interface RunSource {
  readonly code: string;
  readonly prefixLines: number;
  /**
   * The file name this run was evaluated under. Each run gets a fresh name so a stack frame
   * from a function defined in an earlier run cannot be located in this run's source.
   */
  readonly file: string;
}

/** A guest error: its `name: message` text and its raw stack. */
interface ErrorInfo {
  readonly text: string;
  readonly stack: string;
}

interface RunState {
  readonly id: number;
  readonly invoke: ToolInvoker;
  readonly signal: AbortSignal;
  readonly subAbort: AbortController;
  /** Moves later by the time spent in held waits. */
  deadline: number;
  readonly tasks: Set<Promise<void>>;
  readonly queue: Array<() => void>;
  readonly source: RunSource;
  settlements: Settlement[];
  outstanding: number;
  inFlight: number;
  subCalls: number;
  /** Active deadline holds. The deadline does not elapse while this is above zero. */
  holds: number;
  heldSince?: number;
  /** When the guest code now running on the host thread started, or undefined between guest segments. */
  segmentStart?: number;
  /** Set when the run has finished; late hold releases then do nothing. */
  ended: boolean;
  interruptReason?: 'timeout' | 'aborted';
  done?: ErrorInfo & { ok: boolean; hasResult: boolean };
  failure?: string;
  wake?: () => void;
  stop?: Promise<void>;
}

/** The run currently using an owner's context. Bridge closures read it; the owner object is created after them. */
interface RunSlot {
  current?: RunState;
}

interface OwnerState {
  readonly runtime: QuickJSRuntime;
  readonly context: QuickJSContext;
  readonly slot: RunSlot;
  readonly settleFn: QuickJSHandle;
  readonly runFn: QuickJSHandle;
  readonly setToolsFn: QuickJSHandle;
  readonly takeLogFn: QuickJSHandle;
  evalCount: number;
  lane: Promise<unknown>;
  runIds: number;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The error identity of a {@link ToolCallError} as JSON, or undefined for any other error. */
function infoOf(error: unknown): string | undefined {
  if (!(error instanceof ToolCallError)) return undefined;
  const info: { code?: string; errorName?: string } = {};
  if (error.code !== undefined) info.code = error.code;
  if (error.errorName !== undefined) info.errorName = error.errorName;
  return JSON.stringify(info);
}
/** `Name: message` for host-side errors, so the model sees the error class. */
function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Owns every owner's sealed context and runs their programs one at a time. */
export class CodeSandbox {
  private readonly owners = new Map<object, Promise<OwnerState>>();
  private readonly limits: CodeLimits;

  constructor(limits: CodeLimits) {
    this.limits = limits;
  }

  /**
   * Run one program in the owner's context. Calls for the same owner queue in
   * arrival order; each run gets the next eval index, even when it fails.
   */
  async evaluate(owner: object, code: string, request: EvaluateRequest): Promise<EvaluationResult> {
    const pending = this.ownerState(owner);
    const state = await pending;
    const result = state.lane.then(() => this.runLocked(state, code, request));
    state.lane = result.catch(() => undefined);
    return result;
  }

  /** Drop an owner's context after its current run, if any, has finished. */
  release(owner: object): void {
    const entry = this.owners.get(owner);
    if (entry === undefined) return;
    this.owners.delete(owner);
    void entry.then((state) => state.lane.then(() => disposeOwner(state)), () => undefined);
  }

  /** Release every owner. */
  dispose(): void {
    for (const owner of [...this.owners.keys()]) this.release(owner);
  }

  private ownerState(owner: object): Promise<OwnerState> {
    let entry = this.owners.get(owner);
    if (entry === undefined) {
      entry = this.createOwner();
      this.owners.set(owner, entry);
    }
    return entry;
  }

  private async createOwner(): Promise<OwnerState> {
    // One WASM instance per owner: a QuickJS abort (for example a leak assertion after an out-of-memory
    // error) then stays inside that owner instead of breaking every owner.
    const module = await newQuickJSWASMModule();
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(this.limits.memoryBytes);
    const context = runtime.newContext();
    const slot: RunSlot = {};
    runtime.setInterruptHandler(() => {
      const run = slot.current;
      if (run === undefined) return false;
      if (run.interruptReason === undefined) {
        if (run.signal.aborted) run.interruptReason = 'aborted';
        else if (this.expiredInGuest(run)) run.interruptReason = 'timeout';
      }
      return run.interruptReason !== undefined;
    });

    const invoke = context.newFunction('__cmInvoke', (idHandle, nameHandle, argsHandle) => {
      const run = slot.current;
      if (run === undefined) return;
      this.onInvoke(run, Number(context.dump(idHandle)), String(context.dump(nameHandle)), String(context.dump(argsHandle)));
    });
    const done = context.newFunction('__cmDone', (runIdHandle, okHandle, textHandle, hasResultHandle, stackHandle) => {
      const run = slot.current;
      if (run === undefined || run.id !== Number(context.dump(runIdHandle))) return;
      run.done = {
        ok: context.dump(okHandle) === true,
        text: String(context.dump(textHandle)),
        hasResult: context.dump(hasResultHandle) === true,
        stack: String(context.dump(stackHandle)),
      };
      run.wake?.();
    });
    const bootstrap = context.unwrapResult(context.evalCode(GUEST_BOOTSTRAP));
    const ringSize = context.newNumber(this.limits.consoleRingSize);
    const logChars = context.newNumber(this.limits.logChars);
    const api = context.unwrapResult(context.callFunction(bootstrap, context.undefined, invoke, done, ringSize, logChars));
    invoke.dispose();
    done.dispose();
    bootstrap.dispose();
    ringSize.dispose();
    logChars.dispose();
    const owner: OwnerState = {
      runtime,
      context,
      slot,
      evalCount: 0,
      lane: Promise.resolve(),
      runIds: 0,
      settleFn: context.getProp(api, 'settle'),
      runFn: context.getProp(api, 'run'),
      setToolsFn: context.getProp(api, 'setTools'),
      takeLogFn: context.getProp(api, 'takeLog'),
    };
    api.dispose();
    return owner;
  }

  private onInvoke(run: RunState, id: number, name: string, argsText: string): void {
    run.subCalls++;
    run.outstanding++;
    if (run.subCalls > this.limits.maxSubCallsPerRun) {
      this.settle(run, { id, ok: false, payload: `sub-call limit reached: a run may start at most ${this.limits.maxSubCallsPerRun} tool calls` });
      return;
    }
    const start = (): void => {
      if (run.subAbort.signal.aborted) {
        this.settle(run, { id, ok: false, payload: 'the run ended before this tool call started' });
        return;
      }
      run.inFlight++;
      const task = (async () => {
        const args: unknown = JSON.parse(argsText);
        const value = await run.invoke(name, args, run.subAbort.signal, { holdDeadline: () => this.holdDeadline(run) });
        return JSON.stringify(value ?? null) ?? 'null';
      })().then(
        (payload) => this.settle(run, { id, ok: true, payload }),
        (error: unknown) => this.settle(run, { id, ok: false, payload: messageOf(error), info: infoOf(error) }),
      ).finally(() => {
        run.tasks.delete(task);
        run.inFlight--;
        run.queue.shift()?.();
        run.wake?.();
      });
      run.tasks.add(task);
    };
    if (run.inFlight < this.limits.maxParallelSubCalls) start();
    else run.queue.push(start);
  }

  /** Whether the deadline has passed. It never passes while a hold is active. */
  private expired(run: RunState): boolean {
    return run.holds === 0 && Date.now() >= run.deadline;
  }

  /**
   * Whether guest code that is running now has used up the budget. Guest code blocks the host thread, so
   * an abort or a hold release cannot arrive while it runs. A hold therefore pauses only the waiting:
   * guest CPU time in a held period still counts, and `endSegment` keeps it out of the held time.
   */
  private expiredInGuest(run: RunState): boolean {
    if (run.holds === 0) return this.expired(run);
    if (run.heldSince === undefined || run.segmentStart === undefined) return false;
    return Date.now() - Math.max(run.segmentStart, run.heldSince) >= run.deadline - run.heldSince;
  }

  /** Run one synchronous call into the guest and account for the time it takes. */
  private inGuest<T>(run: RunState, call: () => T): T {
    run.segmentStart = Date.now();
    try {
      return call();
    } finally {
      this.endSegment(run);
    }
  }

  /** Guest CPU time during a hold is not held time: move the hold start past it. */
  private endSegment(run: RunState): void {
    const start = run.segmentStart;
    run.segmentStart = undefined;
    if (start === undefined || run.holds === 0 || run.heldSince === undefined) return;
    run.heldSince += Date.now() - Math.max(start, run.heldSince);
  }

  /** Pause the deadline. The first hold records the time; the last release adds the held time back. */
  private holdDeadline(run: RunState): () => void {
    let released = false;
    run.holds++;
    if (run.holds === 1) run.heldSince = Date.now();
    return () => {
      if (released) return;
      released = true;
      if (run.ended) return;
      run.holds--;
      if (run.holds === 0 && run.heldSince !== undefined) {
        run.deadline += Date.now() - run.heldSince;
        run.heldSince = undefined;
      }
      run.wake?.();
    };
  }

  private settle(run: RunState, settlement: Settlement): void {
    run.settlements.push(settlement);
    run.wake?.();
  }

  private async runLocked(owner: OwnerState, code: string, request: EvaluateRequest): Promise<EvaluationResult> {
    owner.evalCount++;
    const evalIndex = owner.evalCount;
    let program: TransformedProgram;
    try {
      program = transformProgram(code);
    } catch (error) {
      return { evalIndex, ok: false, error: describeError(error), log: '' };
    }

    const subAbort = new AbortController();
    const id = ++owner.runIds;
    const run: RunState = {
      id,
      invoke: request.invoke,
      signal: request.signal,
      subAbort,
      deadline: Date.now() + request.timeoutMs,
      tasks: new Set(),
      queue: [],
      source: { code, prefixLines: program.prefixLines, file: programFileName(id) },
      settlements: [],
      outstanding: 0,
      inFlight: 0,
      subCalls: 0,
      holds: 0,
      ended: false,
    };
    owner.slot.current = run;
    let stopAbort: (() => void) | undefined;
    try {
      // Resolves on abort only. The deadline is a per-wait timer in `drive`, because holds move it.
      // Aborting also cancels every sub-call: a cancelled run must not start, or finish, tool bodies.
      run.stop = new Promise<void>((resolve) => {
        const onAbort = (): void => {
          subAbort.abort();
          resolve();
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
        stopAbort = () => request.signal.removeEventListener('abort', onAbort);
      });
      if (request.signal.aborted) {
        subAbort.abort();
        run.interruptReason = 'aborted';
      } else {
        this.setTools(owner, request.tools);
        const programFn = this.evalProgram(owner, program.body, run.source.file);
        if (programFn.error !== undefined) {
          run.failure = withLocation(programFn.error, run.source);
        } else if (request.signal.aborted) {
          // A stop that arrived while the program was being compiled still suppresses the program.
          subAbort.abort();
          run.interruptReason = 'aborted';
        } else {
          this.startRun(owner, run, programFn.handle, program.hasResult);
          await this.drive(owner, run);
        }
      }
    } catch (error) {
      run.failure ??= messageOf(error);
    } finally {
      stopAbort?.();
      run.ended = true;
      owner.slot.current = undefined;
    }

    const log = this.takeLog(owner);
    if (run.failure === undefined && run.done === undefined) {
      run.failure = 'Code did not finish: a promise it awaits never settled.';
    }
    if (run.tasks.size > 0) {
      run.subAbort.abort();
      if (run.interruptReason === undefined) {
        // A normal end waits for started work, so its events land before the run result.
        await Promise.allSettled([...run.tasks]);
      } else {
        // A timeout or abort gives up after the grace period: a tool that ignores cancellation
        // must not hold the run open. The executor skips its post-execute stage (see the adapter).
        await this.drain(run);
      }
    }
    // An interrupt surfaces inside the program as a rejection, so the interrupt reason wins over `done`.
    if (run.interruptReason === undefined && run.done !== undefined && run.failure === undefined) {
      const { ok, text, hasResult, stack } = run.done;
      if (ok) return { evalIndex, ok: true, value: hasResult ? text : undefined, log };
      return { evalIndex, ok: false, error: withLocation({ text, stack }, run.source), log };
    }
    return { evalIndex, ok: false, error: this.failureText(run, request.timeoutMs), log };
  }

  private failureText(run: RunState, timeoutMs: number): string {
    if (run.interruptReason === 'timeout') return `Code run timed out after ${timeoutMs} ms`;
    if (run.interruptReason === 'aborted') return 'Code run was aborted';
    return run.failure ?? 'Code run failed';
  }

  private setTools(owner: OwnerState, tools: readonly ToolDescriptor[]): void {
    const names = tools.map((tool) => tool.name);
    const all = owner.context.newString(JSON.stringify(names));
    const globals = owner.context.newString(JSON.stringify(globalToolNames(names)));
    const result = owner.context.callFunction(owner.setToolsFn, owner.context.undefined, all, globals);
    all.dispose();
    globals.dispose();
    if (result.error) {
      throw new Error(`could not install tools: ${readError(owner.context, result.error).text}`);
    }
    result.value.dispose();
  }

  private evalProgram(owner: OwnerState, body: string, file: string): { handle: QuickJSHandle; error?: undefined } | { handle?: undefined; error: ErrorInfo } {
    const result = owner.context.evalCode(`(async function () {\n${body}\n})`, file);
    if (result.error) {
      return { error: readError(owner.context, result.error) };
    }
    return { handle: result.value };
  }

  private startRun(owner: OwnerState, run: RunState, program: QuickJSHandle, hasResult: boolean): void {
    const ctx = owner.context;
    const runId = ctx.newNumber(run.id);
    const hasResultHandle = hasResult ? ctx.true : ctx.false;
    const result = this.inGuest(run, () => ctx.callFunction(owner.runFn, ctx.undefined, program, hasResultHandle, runId));
    program.dispose();
    runId.dispose();
    if (result.error) {
      run.failure = withLocation(readError(ctx, result.error), run.source);
      return;
    }
    result.value.dispose();
  }

  /** Alternate guest job draining with settling host tool calls until the run is done or stopped. */
  private async drive(owner: OwnerState, run: RunState): Promise<void> {
    for (;;) {
      // Check cancellation before pumping: a cancelled run must not execute any more guest jobs,
      // and in particular must not start the tool bodies those jobs queued.
      if (run.signal.aborted || this.expired(run)) {
        run.interruptReason ??= run.signal.aborted ? 'aborted' : 'timeout';
        return;
      }
      if (!this.pump(owner, run)) return;
      if (run.done !== undefined) return;
      const next = run.settlements.shift();
      if (next !== undefined) {
        if (!this.deliver(owner, run, next)) return;
        continue;
      }
      if (run.outstanding === 0) return;
      const wake = new Promise<void>((resolve) => {
        run.wake = resolve;
      });
      const waits: Array<Promise<void> | undefined> = [wake, run.stop];
      let tick: ReturnType<typeof setTimeout> | undefined;
      if (run.holds === 0) {
        const remaining = Math.max(0, run.deadline - Date.now());
        waits.push(new Promise<void>((resolve) => {
          tick = setTimeout(resolve, remaining);
        }));
      }
      await Promise.race(waits);
      clearTimeout(tick);
      run.wake = undefined;
    }
  }

  /** Drain guest jobs. Returns false when the run has failed. */
  private pump(owner: OwnerState, run: RunState): boolean {
    const jobs = this.inGuest(run, () => owner.runtime.executePendingJobs());
    if (jobs.error) {
      run.failure ??= withLocation(readError(owner.context, jobs.error), run.source);
      return false;
    }
    return run.failure === undefined;
  }

  private deliver(owner: OwnerState, run: RunState, settlement: Settlement): boolean {
    const ctx = owner.context;
    const id = ctx.newNumber(settlement.id);
    const ok = settlement.ok ? ctx.true : ctx.false;
    const payload = ctx.newString(settlement.payload);
    const info = ctx.newString(settlement.info ?? '');
    const result = this.inGuest(run, () => ctx.callFunction(owner.settleFn, ctx.undefined, id, ok, payload, info));
    id.dispose();
    payload.dispose();
    info.dispose();
    run.outstanding--;
    if (result.error) {
      run.failure = withLocation(readError(ctx, result.error), run.source);
      return false;
    }
    result.value.dispose();
    return this.pump(owner, run);
  }

  private takeLog(owner: OwnerState): string {
    const result = owner.context.callFunction(owner.takeLogFn, owner.context.undefined);
    if (result.error) {
      result.error.dispose();
      return '';
    }
    const text = owner.context.getString(result.value);
    result.value.dispose();
    return text;
  }

  /** Wait for in-flight tool calls to settle, but no longer than the grace period. */
  private async drain(run: RunState): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const grace = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.limits.drainGraceMs);
    });
    await Promise.race([Promise.allSettled([...run.tasks]).then(() => undefined), grace]);
    clearTimeout(timer);
  }
}

/**
 * The file name a run is evaluated under. Each run gets its own name, so a frame left by a function
 * defined in an earlier run (in the same persistent context) is not located in this run's source.
 */
function programFileName(runId: number): string {
  return `program-${runId}.js`;
}

/** The first stack frame that lies in a program's source, with the run number and line. */
const PROGRAM_FRAME = /program-(\d+)\.js:(\d+):\d+/;

/** Longest source line quoted after an error. */
const SOURCE_LINE_CHARS = 200;

/**
 * Reads an error handle into its text and stack, and always disposes it. Reading can fail when
 * the guest is out of memory, so a fallback text is used instead of throwing.
 */
function readError(context: QuickJSContext, handle: QuickJSHandle): ErrorInfo {
  try {
    const value = context.dump(handle) as { name?: unknown; message?: unknown } | string | null;
    if (typeof value === 'string') return { text: value, stack: '' };
    if (value !== null && typeof value === 'object') {
      const name = typeof value.name === 'string' ? value.name : 'Error';
      const message = typeof value.message === 'string' ? value.message : '';
      return { text: message === '' ? name : `${name}: ${message}`, stack: readStack(context, handle) };
    }
    return { text: String(value), stack: '' };
  } catch {
    return { text: 'InternalError: out of memory or unreadable error', stack: '' };
  } finally {
    handle.dispose();
  }
}

/** The `stack` property of an error handle, or an empty string when it has none. */
function readStack(context: QuickJSContext, handle: QuickJSHandle): string {
  try {
    const prop = context.getProp(handle, 'stack');
    try {
      const value = context.dump(prop);
      return typeof value === 'string' ? value : '';
    } finally {
      prop.dispose();
    }
  } catch {
    return '';
  }
}

/**
 * Adds the user line where an error was thrown, when the stack has a frame in the program.
 * The line is the stack's line in the evaluated source, minus the wrapper line and the
 * hoisted prefix, so it matches the user's own numbering.
 */
function withLocation(error: ErrorInfo, source: RunSource): string {
  const frame = PROGRAM_FRAME.exec(error.stack);
  if (frame === null) return error.text;
  // The first program frame is where the error was thrown. When it belongs to an earlier run, the
  // code came from that run's source, and quoting this run's line would point at an unrelated line.
  if (`program-${frame[1]}.js` !== source.file) return error.text;
  const line = Number(frame[2]) - 1 - source.prefixLines;
  const lines = source.code.split('\n');
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return error.text;
  const text = (lines[line - 1] ?? '').trim();
  const shown = text.length > SOURCE_LINE_CHARS ? `${text.slice(0, SOURCE_LINE_CHARS)}…` : text;
  return `${error.text}\n    at line ${line}: ${shown}`;
}

function disposeOwner(owner: OwnerState): void {
  try {
    owner.settleFn.dispose();
    owner.runFn.dispose();
    owner.setToolsFn.dispose();
    owner.takeLogFn.dispose();
    owner.context.dispose();
    owner.runtime.dispose();
  } catch {
    // The owner's WASM instance is unusable and unreferenced; it is collected with it.
  }
}
