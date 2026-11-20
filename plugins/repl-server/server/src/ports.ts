/** Ports the server layer depends on. Implementations live in core, db, or the pool. @module */

export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export interface AuditEvent {
  event: string;
  ts: string;
  [key: string]: unknown;
}

export interface AuditSink {
  write(event: AuditEvent): void;
}

export interface ProcessLedger {
  recordPool(entry: Record<string, unknown>): Promise<void>;
  removePool(serverId: string): Promise<void>;
}

/** Identity resolved from the request token. `binding` is null for unbound clients. */
export interface RequestIdentity {
  identity: 'bound' | 'unbound';
  binding: string | null;
  /** Self-reported `name/version` label; display only. */
  client: string;
  /** Parsed `clientInfo.name`; display only, empty when unreported. */
  clientName?: string;
  /** Parsed `clientInfo.version`; display only, empty when unreported. */
  clientVersion?: string;
  mcp: string;
  exec?: string;
}

export interface ScriptRequest {
  code: string;
  /** Omitted means no wall-clock deadline. */
  timeoutMs?: number;
  async: boolean;
  workspace?: string;
  visibleTools?: string[];
  excludeTags?: string[];
  identity: RequestIdentity;
  /** JSON-RPC id of the `tools/call` that started this eval; stamped into `eval_start`. */
  requestId?: string | number;
}

export interface ScriptOutcome {
  content: string;
  isError: boolean;
  images?: { base64: string; mediaType: string }[];
  documents?: { base64: string }[];
}

export interface TaskSnapshot {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  result?: ScriptOutcome;
  error?: { code: string; message: string; data?: unknown };
}

/** Everything the MCP tools need from the executor. The core package implements it. */
export interface ExecutionGateway {
  runScript(request: ScriptRequest): Promise<ScriptOutcome>;
  dispatchScript(request: ScriptRequest): Promise<{ taskId: string; evalId: number }>;
  waitTasks(owner: string, taskIds: string[] | undefined, timeoutMs: number): Promise<unknown>;
  getTask(owner: string, taskId: string): Promise<TaskSnapshot | null>;
  cancelTask(owner: string, taskId: string): Promise<boolean>;
  destroyOwner(owner: string): Promise<void>;
}

/** Catalog snapshot used by search/describe and the script tool surface. */
export interface CatalogTool {
  name: string;
  kind: 'builtin' | 'mcp';
  server?: string;
  description?: string;
  /** Server-level category inherited from the owning server row (including builtins). */
  category?: string;
  /** Server-level summary inherited from the owning server row (including builtins). */
  summary?: string;
  tags?: string[];
  inputSchema: unknown;
  concurrency: 'parallel' | 'serial' | 'exclusive';
  enabled: boolean;
}

export interface CatalogSnapshot {
  revision: number;
  tools: readonly CatalogTool[];
}

export interface Catalog {
  snapshot(): CatalogSnapshot;
}

/** Outcome of one lazy `tools/list` sync for the seeded `__official__` server. */
export interface OfficialToolsSyncResult {
  status: 'synced' | 'unavailable' | 'failed';
  count: number;
  /** Human-readable reason when no rows were written. */
  notice?: string;
}

/** Lazy official-tool catalog sync; `force` bypasses the once-per-process cache. */
export interface OfficialToolsSync {
  ensure(options?: { force?: boolean }): Promise<OfficialToolsSyncResult>;
}
