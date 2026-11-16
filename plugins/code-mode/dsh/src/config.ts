/** Deployment-owned limits for Code Mode. @module */
import z from '@deepseek-ai/schemastery';
import { DEFAULT_LIMITS, type CodeLimits } from '@zhangliang0115/code-mode-core';

/**
 * Limits one deployment may tune. Every field has a default in {@link Config}, and the model cannot
 * change any of them. The unchanged core defaults live in `CodeLimits`; this schema reads them so
 * there is one source of truth.
 */
export interface Config {
  /** Run deadline in milliseconds. The model cannot request another value. */
  timeoutMs: number;
  /** Largest deadline a caller may request, in milliseconds. */
  maxTimeoutMs: number;
  /** Heap limit for one agent's QuickJS runtime, in bytes. */
  memoryBytes: number;
  /** Tool calls one run may start. Later calls reject inside the program. */
  maxSubCallsPerRun: number;
  /** Tool calls one run may have in flight at once. */
  maxParallelSubCalls: number;
  /** Characters kept in `<result>`. A larger result keeps the core's spill path. */
  resultChars: number;
  /** Characters kept in `<log>`. */
  logChars: number;
  /** Characters kept in `<error>`. */
  errorChars: number;
  /**
   * Tools a program may run concurrently even though the tool itself declares no
   * concurrency safety. Names match exactly; a trailing `*` matches a prefix
   * (`mcp__jev__*`). Empty by default: omitting a tool keeps DSH's fail-closed
   * behavior, where only tools with `isConcurrencySafe() === true` overlap.
   *
   * Only list calls that are safe to run at the same time. Listing a stateful tool
   * lets two of its calls interleave and can corrupt their shared state.
   */
  concurrentTools: string[];
}

/** Validated limits; an omitted field takes the core default. */
export const Config: z<Partial<Config>, Config> = z.object({
  timeoutMs: z.natural().min(1).default(DEFAULT_LIMITS.timeoutMs),
  maxTimeoutMs: z.natural().min(1).default(DEFAULT_LIMITS.maxTimeoutMs),
  memoryBytes: z.natural().min(1).default(DEFAULT_LIMITS.memoryBytes),
  maxSubCallsPerRun: z.natural().min(1).default(DEFAULT_LIMITS.maxSubCallsPerRun),
  maxParallelSubCalls: z.natural().min(1).default(DEFAULT_LIMITS.maxParallelSubCalls),
  resultChars: z.natural().min(1).default(DEFAULT_LIMITS.resultChars),
  logChars: z.natural().min(1).default(DEFAULT_LIMITS.logChars),
  errorChars: z.natural().min(1).default(DEFAULT_LIMITS.errorChars),
  concurrentTools: z.array(z.string()).default([]),
});

/**
 * Resolve a deployment config into sandbox limits. Fields the schema does not expose
 * (`consoleRingSize`, `drainGraceMs`) keep their core defaults.
 * @param config - deployment config, possibly partial; Cordis has already validated a mounted row.
 * @returns limits for `new CodeMode(limits)`.
 */
export function codeLimits(config: Partial<Config> = {}): Partial<CodeLimits> {
  const { concurrentTools: _concurrentTools, ...limits } = Config(config);
  return limits;
}

/**
 * True when `name` belongs to the deployment's concurrency allowlist. Exact names match
 * literally; a pattern ending in `*` matches every name with that prefix.
 * @param name - the model-facing tool name of a sub-call.
 * @param patterns - the deployment's `concurrentTools` value.
 */
export function allowsConcurrency(name: string, patterns: readonly string[]): boolean {
  for (const pattern of patterns) {
    if (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern) return true;
  }
  return false;
}
