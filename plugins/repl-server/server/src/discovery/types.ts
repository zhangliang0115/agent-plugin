/**
 * Tool-discovery domain types (design 07 §2.1).
 *
 * A server keeps at most one discovery configuration. `static` means the tool
 * catalog only ever holds `tools/list` rows; `search` means an upstream search
 * tool registers tools on the current connection and those rows are stored with
 * `discovered_via = 'search'`.
 *
 * @module
 */

export type ToolDiscoveryMode = 'static' | 'search';

/** Normalized discovery configuration as stored in `servers.discovery_json`. */
export interface ToolDiscoveryConfig {
  mode: ToolDiscoveryMode;
  /** mode=search only: the upstream tool that performs the search. */
  searchTool?: string;
  /** Scan query; defaults to the empty string (upstream default behaviour). */
  query?: string;
  /** Fixed search arguments; the string "$query" is replaced per call. */
  args?: Record<string, unknown>;
  /** 1..200, defaults to 50. */
  maxTools?: number;
  /** Warm the connection with a search before a discovered tool call. Defaults to true. */
  prepareOnCall?: boolean;
}

/** Wire response of the parser plus service-only bookkeeping. */
export interface DiscoverySkippedTool {
  name?: string;
  reason: string;
}

/**
 * 422 raised by discovery-configuration validation. Kept independent of the
 * admin layer so the same validator serves `PATCH /servers`, config import and
 * preview requests; the admin boundary translates it to `AdminApiError`.
 */
export class DiscoveryConfigError extends Error {
  readonly status = 422;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DiscoveryConfigError';
    this.code = code;
    this.details = details;
  }
}
