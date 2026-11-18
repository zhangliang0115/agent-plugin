/** Frozen defaults from the design docs. Tests may shrink them through injection. @module */

export const LIMITS = {
  syncMs: 5_000,
  syncDefaultMs: 30_000,
  syncMaxMs: 600_000,
  asyncDefaultMs: 7_200_000,
  asyncMaxMs: 7_200_000,
  graceMs: 2_000,
  terminateMs: 3_000,
  callsLimit: 50_000,
  inFlightPerExecSession: 8,
  execSessionsPerBinding: 4,
  inFlightPerBinding: 16,
  callsPerBindingPerServer: 4,
  queuedPerBindingPerServer: 32,
  evictIdleMs: 300_000,
  resultChars: 30_000,
  logLines: 1_000,
  estimatedTokens: 20_000,
  images: 8,
  documents: 4,
  mediaBytes: 5 * 1024 * 1024,
  stateBytes: 1 << 20,
  taskTtlMs: 9_000_000,
  taskPollIntervalMs: 500,
} as const;

export type Limits = typeof LIMITS;
