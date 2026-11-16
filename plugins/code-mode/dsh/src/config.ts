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
});

/**
 * Resolve a deployment config into sandbox limits. Fields the schema does not expose
 * (`consoleRingSize`, `drainGraceMs`) keep their core defaults.
 * @param config - deployment config, possibly partial; Cordis has already validated a mounted row.
 * @returns limits for `new CodeMode(limits)`.
 */
export function codeLimits(config: Partial<Config> = {}): Partial<CodeLimits> {
  return Config(config);
}
