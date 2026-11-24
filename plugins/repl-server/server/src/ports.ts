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

/** Script owner identity; `isAdmin` may manage every script (design 10 §8, §11). */
export interface ScriptActor {
  /** Binding id or MCP session id; stored as `created_by`. */
  createdBy: string;
  /** Admin management ignores the owner check. */
  isAdmin?: boolean;
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
  /** Entry surface for the archive and audit rows; defaults to `code`. */
  entryMode?: 'code' | 'script';
  /** Saved script that produced `code`; present when `entryMode` is `script`. */
  scriptId?: string;
  scriptVersion?: number;
  /** Version mode of the saved script; `exact` or `parameterized`. */
  scriptMode?: 'exact' | 'parameterized';
  /** Arguments a parameterized script was called with; archived, never reused. */
  args?: Record<string, unknown>;
  /** `test` marks a draft-version execution; it does not count as a real use. */
  purpose?: 'run' | 'test';
  /** Owner/admin identity; the settle-time activation checks it before activating. */
  actor?: ScriptActor;
  /** Activates the draft version when this eval settles successfully (sync or async). */
  activateOnSuccess?: boolean;
}

export interface ScriptOutcome {
  content: string;
  isError: boolean;
  /** Execution id rendered into the envelope; one per execution. */
  runId?: string;
  images?: { base64: string; mediaType: string }[];
  documents?: { base64: string }[];
}

/** One eval currently registered in an execution session. */
export interface InFlightEvalView {
  exec: string;
  evalId: number;
  binding: string | null;
  workspace: string;
  async: boolean;
  startedAt: number;
  ageMs: number;
  timeoutMs?: number;
}

/** In-flight evals for the admin overview; `total` counts before `limit` truncation. */
export interface InFlightEvalsView {
  total: number;
  items: InFlightEvalView[];
}

export interface TaskSnapshot {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
  /** Execution id of the eval behind this task. */
  runId?: string;
  scriptId?: string;
  scriptVersion?: number;
  scriptMode?: 'exact' | 'parameterized';
  /** Args summary capped at 512 characters. */
  argsPreview?: string;
  result?: ScriptOutcome;
  error?: { code: string; message: string; data?: unknown };
}

/** Everything the MCP tools need from the executor. The core package implements it. */
export interface ExecutionGateway {
  runScript(request: ScriptRequest): Promise<ScriptOutcome>;
  dispatchScript(request: ScriptRequest): Promise<{ taskId: string; evalId: number; runId: string }>;
  waitTasks(owner: string, taskIds: string[], timeoutMs: number): Promise<unknown>;
  getTask(owner: string, taskId: string): Promise<TaskSnapshot | null>;
  cancelTask(owner: string, taskId: string): Promise<boolean>;
  destroyOwner(owner: string): Promise<void>;
  /** Tears down the unbound execution sessions created through one transport. */
  destroyTransport(transportId: string): Promise<void>;
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

/** Where one tool call spent its wait, from the outermost gate inwards. */
export type ToolWaitReason = 'binding-quota' | 'server-write-lock' | 'exclusive-gate' | 'keyed-gate';

/**
 * Out-of-band sink for a tool call's timing observations.
 *
 * The gateway owns the audit row but the wait happens deeper (pool quota, the
 * server's write lock, the exclusive gate), so the reason travels back up here
 * instead of being guessed from durations. It is deliberately not part of
 * `ToolCallRequest`: that type is what the script asked for, this is what the
 * server observed.
 */
export interface ToolCallObservation {
  /** Records where the call waited; the first report wins. */
  noteWait(reason: ToolWaitReason): void;
}
