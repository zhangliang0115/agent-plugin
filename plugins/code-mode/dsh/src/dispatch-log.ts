/**
 * Session events for the tool calls of one run_code program, written the way
 * DSH's own program executor (dsh-tool-executor-ptc) writes them:
 * `tool/ptc-dispatch-start` when a sub-call enters the pipeline and
 * `tool/ptc-dispatch` when it settles. Trajectory views, the approval panel and
 * auto-review read these. Their payload types live only in the PTC package, so
 * this file writes through a local structural type and a contract test pins the
 * shape. @module
 */
import type { Context } from '@deepseek-ai/cordis';
import { scopeTarget } from '@deepseek-ai/dsh-scope';
import type { ToolExecutionResult, ToolRunContext } from '@deepseek-ai/dsh-tools';

/** The slice of the session an agent exposes that this file writes to. */
interface EventSink {
  append(type: string, data: unknown): unknown;
}

/** Waterfall access for `tools/ptc-dispatch-log`, which dsh-tools does not type. */
interface Waterfall {
  waterfall(target: unknown, event: string, ...args: unknown[]): Promise<unknown>;
}

/** One run's dispatch log. Without an agent every method does nothing. */
export class DispatchLog {
  private readonly ctx: Context;
  private readonly exec: ToolRunContext;
  private readonly work = new Set<Promise<void>>();

  constructor(ctx: Context, exec: ToolRunContext) {
    this.ctx = ctx;
    this.exec = exec;
  }

  /** A sub-call is about to enter the pipeline. */
  start(subCallId: string, name: string, args: unknown): void {
    this.append('tool/ptc-dispatch-start', {
      rootCallId: this.exec.rootCallId,
      parentCallId: this.exec.callId,
      subCallId,
      name,
      arguments: detached(args),
    });
  }

  /**
   * A sub-call settled. Runs the `tools/ptc-dispatch-log` waterfall, which may replace the logged
   * content (for example with a preview), then appends the settle event. Returns at once; the work
   * is awaited by {@link drain}, so the program never waits for a log listener.
   */
  settle(subCallId: string, name: string, args: unknown, result: ToolExecutionResult): void {
    const agent = this.exec.agent;
    if (agent === undefined) return;
    const task: Promise<void> = (async () => {
      const content = await this.shape(subCallId, name, result);
      this.append('tool/ptc-dispatch', {
        rootCallId: this.exec.rootCallId,
        parentCallId: this.exec.callId,
        subCallId,
        name,
        arguments: detached(args),
        isError: result.isError,
        ...result.error?.info === undefined ? {} : { error: result.error.info },
        content,
        ...result.meta === undefined ? {} : { meta: result.meta },
      });
    })().finally(() => {
      this.work.delete(task);
    });
    this.work.add(task);
  }

  /**
   * Wait for every pending settle event, but no longer than `timeoutMs`.
   * A listener that never resolves must not keep `run_code` pending after the program ended.
   * Never rejects.
   */
  async drain(timeoutMs: number): Promise<void> {
    if (this.work.size === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...this.work]).then(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (this.work.size > 0) {
      this.ctx.logger.warn(`code-mode: ${this.work.size} dispatch log event(s) still pending after ${timeoutMs} ms; continuing`);
    }
  }

  private async shape(subCallId: string, name: string, result: ToolExecutionResult): Promise<unknown> {
    const agent = this.exec.agent;
    try {
      return await (this.ctx as unknown as Waterfall).waterfall(
        scopeTarget(this.ctx.tools, agent),
        'tools/ptc-dispatch-log',
        { exec: this.exec, agent, subCallId, name, isError: result.isError, content: result.content },
        () => Promise.resolve(result.content),
      );
    } catch (error) {
      this.ctx.logger.warn(`code-mode: tools/ptc-dispatch-log listener failed for ${name}: ${describe(error)}; logging the original content`);
      return result.content;
    }
  }

  private append(type: string, data: unknown): void {
    const agent = this.exec.agent;
    if (agent === undefined) return;
    try {
      (agent.session as unknown as EventSink).append(type, data);
    } catch (error) {
      this.ctx.logger.warn(`code-mode: could not write ${type}: ${describe(error)}`);
    }
  }
}

/** A separate JSON copy, so a tool that mutates its arguments cannot change what the log records. */
function detached(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null)) as unknown;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
