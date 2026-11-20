/** Frozen defaults from the design docs. Tests may shrink them through injection. @module */

export const LIMITS = {
  syncMs: 5_000,
  graceMs: 2_000,
  terminateMs: 3_000,
  inFlightPerExecSession: 64,
  execSessionsPerBinding: 64,
  inFlightPerBinding: 256,
  callsPerBindingPerServer: 64,
  queuedPerBindingPerServer: 256,
  evictIdleMs: 300_000,
  images: 8,
  documents: 4,
  mediaBytes: 5 * 1024 * 1024,
  stateBytes: 1 << 20,
  taskTtlMs: 9_000_000,
  taskPollIntervalMs: 500,
} as const;

export type Limits = typeof LIMITS;
