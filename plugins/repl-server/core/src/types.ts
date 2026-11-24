/** Shared contracts between the host process, the worker and the audit layer. @module */

export type TimeoutLayer = 'sync' | 'tool' | 'soft' | 'wall' | 'budget' | 'output';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export type FinishedTaskStatus = Extract<TaskStatus, 'completed' | 'failed' | 'cancelled'>;

export interface TruncationFlags {
  result?: boolean;
  stdout?: boolean;
  stderr?: boolean;
}

export interface TimeoutInfo {
  layer: TimeoutLayer;
  limitMs: number;
}

export interface ProcRecord {
  handle: string;
  pid: number;
  pgid: number;
  cmd: string;
  startTime: string;
}

export interface KillRecord {
  pid: number;
  pgid: number;
  signal: string;
  reason: string;
}

export interface UnattributedProcess {
  pid: number;
  cmd: string;
  reason: string;
}

export interface StructuredToolError {
  code: string;
  server?: string;
  tool?: string;
  retryable: boolean;
  retryAfterMs?: number;
  detail?: unknown;
}

/** Server-side result of one eval. Never returned as `structuredContent`. */
export interface RunScriptResult {
  evalId: number;
  code: string;
  result?: unknown;
  stdout: string;
  stderr: string;
  error?: string;
  ms: number;
  stoppedBy?: 'user' | 'refusal';
  neverRan?: 'person' | 'other';
  asyncDispatched?: boolean;
  late?: boolean;
  evalTaskId?: string;
  toolsUsed?: string[];
  images?: { base64: string; mediaType: string }[];
  documents?: { base64: string }[];
  imagesOmitted?: number;
  documentsOmitted?: number;
  truncated: TruncationFlags;
  timeout?: TimeoutInfo;
  contextReset: boolean;
  stateRestored: 'lastGood' | 'none';
  stateSnapshot?: 'too-large';
  lastActivity?: { tool: string; args: unknown; elapsedMs: number };
  leftRunning: ProcRecord[];
  killed: KillRecord[];
  unattributed: UnattributedProcess[];
  budget: { calls: number };
  errorInfo?: StructuredToolError;
}

export interface ToolCallRequest {
  evalId: number;
  epoch: number;
  callSeq: number;
  tool: string;
  server?: string;
  args: Record<string, unknown>;
}

export type HostToWorker =
  | { t: 'eval'; evalId: number; epoch: number; code: string; syncMs: number }
  | { t: 'cancel'; evalId: number }
  | { t: 'snapshot'; evalId: number };

export type WorkerToHost =
  | { t: 'ready'; epoch: number }
  | ({ t: 'call' } & ToolCallRequest)
  | { t: 'log'; evalId: number; stream: 'stdout' | 'stderr' | 'console'; text: string }
  | {
      t: 'done';
      evalId: number;
      result?: unknown;
      stdout: string;
      stderr: string;
      ms: number;
      truncated: TruncationFlags;
    }
  | { t: 'error'; evalId: number; message: string; stack?: string; layer?: TimeoutLayer }
  | { t: 'snapshot'; evalId: number; buf: ArrayBuffer };

/** Execution identity carried by the task table (design 10 §7.4). */
export interface EvalTaskMeta {
  runId?: string;
  scriptId?: string;
  scriptVersion?: number;
  scriptMode?: 'exact' | 'parameterized';
  /** Args summary capped at 512 characters; the full args stay in `script_runs`. */
  argsPreview?: string;
  entryMode?: 'code' | 'script';
}

export interface EvalTaskEvent extends EvalTaskMeta {
  taskId: string;
  evalId: number;
  status: FinishedTaskStatus;
  result?: string;
  stdout?: string;
  elapsedMs: number;
  error?: StructuredToolError;
}
