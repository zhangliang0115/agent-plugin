/** Hand-written MCP tasks layer: dispatch decision, mcpTaskId mapping and get/cancel/update. @module */

import { randomUUID } from 'node:crypto';

import {
  systemClock,
  type Clock,
  type ExecutionGateway,
  type RequestIdentity,
  type TaskSnapshot,
} from '../ports.ts';
import { LIMITS } from '@zhangliang0115/repl-server-core';
import { JsonRpcError, JSON_RPC_INVALID_PARAMS } from '../mcp/errors.ts';
import { toCallToolResult, type CallToolResult } from '../tools/registry.ts';

/**
 * Process-safety retention for task records. Scripts have no execution cap, but
 * the mapping table is bounded in memory and capacity; 2.5 hours covers the
 * long jobs the MCP tasks extension is meant for.
 */
export const TASK_TTL_MS = LIMITS.taskTtlMs;
export const TASK_POLL_INTERVAL_MS = LIMITS.taskPollIntervalMs;

/** A run longer than this becomes a task when the client declared the tasks extension. */
export const TASK_TIMEOUT_THRESHOLD_MS = 30_000;

export type TaskStatus = TaskSnapshot['status'];

/** Task ownership: a bound client's binding id, otherwise this transport session. */
export function ownerOf(identity: RequestIdentity): string {
  return identity.binding ?? identity.mcp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the per-request declaration at
 * `params._meta["io.modelcontextprotocol/clientCapabilities"].extensions["io.modelcontextprotocol/tasks"]`.
 * Presence of the key is what counts; the value is an empty object in current clients.
 */
export function clientDeclaredTasks(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const meta = params._meta;
  if (!isRecord(meta)) return false;
  const capabilities = meta['io.modelcontextprotocol/clientCapabilities'];
  if (!isRecord(capabilities)) return false;
  const extensions = capabilities.extensions;
  if (!isRecord(extensions)) return false;
  return Object.hasOwn(extensions, 'io.modelcontextprotocol/tasks');
}

export type ToolDispatchMode = 'sync' | 'async' | 'task';

/**
 * Frozen decision table (docs/protocol.md §3.4). Only `run_script` can become a task:
 * - `async: true` always returns a normal CallToolResult carrying an evalTaskId, never a task.
 * - A client that declared tasks gets a CreateTaskResult when `async` is absent/false and the
 *   requested timeout is above 30000.
 * - Everything else stays synchronous, including `timeout: 30000` exactly.
 */
export function resolveDispatchMode(
  toolName: string,
  args: unknown,
  tasksDeclared: boolean,
): ToolDispatchMode {
  if (toolName !== 'run_script') return 'sync';
  const record = isRecord(args) ? args : {};
  if (record.async === true) return 'async';
  const timeout = typeof record.timeout === 'number' ? record.timeout : TASK_TIMEOUT_THRESHOLD_MS;
  if (tasksDeclared && timeout > TASK_TIMEOUT_THRESHOLD_MS) return 'task';
  return 'sync';
}

export interface CreateTaskResult {
  readonly resultType: 'task';
  readonly taskId: string;
  readonly status: 'working';
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;
}

export function isCreateTaskResult(value: unknown): value is CreateTaskResult {
  return isRecord(value) && value.resultType === 'task';
}

export interface TaskAcknowledgement {
  readonly resultType: 'complete';
}

export type TaskMethodErrorCode = 'TASK_NOT_FOUND' | 'TASK_EXPIRED';

/**
 * JSON-RPC mapping frozen in docs/protocol.md §8: `-32602` with `data.code`.
 * Extends `JsonRpcError` so the dispatcher serializes it without a translation layer.
 */
export class TaskMethodError extends JsonRpcError {
  readonly taskCode: TaskMethodErrorCode;

  constructor(code: TaskMethodErrorCode, message: string) {
    super(JSON_RPC_INVALID_PARAMS, message, { code });
    this.name = 'TaskMethodError';
    this.taskCode = code;
  }
}

export interface McpTaskRecord {
  readonly taskId: string;
  readonly evalTaskId: string;
  readonly owner: string;
  readonly createdAt: number;
  readonly expiresAt: number;
}

export interface McpTaskStoreOptions {
  clock?: Clock;
  idFactory?: () => string;
  ttlMs?: number;
  pollIntervalMs?: number;
}

/**
 * Process-level index from the client-visible `mcpTaskId` to the core-owned `evalTaskId`.
 * Core keeps the results; this store keeps only the mapping and its TTL. A binding may see its
 * tasks from a reconnected transport session; an unbound client is limited to the MCP session
 * that created them, which the owner check enforces.
 */
export class McpTaskStore {
  private readonly byId = new Map<string, McpTaskRecord>();
  private readonly clock: Clock;
  private readonly idFactory: () => string;
  private readonly ttlMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: McpTaskStoreOptions = {}) {
    this.clock = options.clock ?? systemClock;
    this.idFactory = options.idFactory ?? (() => `t_${randomUUID().replaceAll('-', '')}`);
    this.ttlMs = options.ttlMs ?? TASK_TTL_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? TASK_POLL_INTERVAL_MS;
  }

  get size(): number {
    return this.byId.size;
  }

  create(owner: string, evalTaskId: string): CreateTaskResult {
    const now = this.clock.now();
    this.sweep(now);
    let taskId = this.idFactory();
    while (this.byId.has(taskId)) taskId = this.idFactory();
    this.byId.set(taskId, {
      taskId,
      evalTaskId,
      owner,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    });
    const createdAt = new Date(now).toISOString();
    return {
      resultType: 'task',
      taskId,
      status: 'working',
      createdAt,
      lastUpdatedAt: createdAt,
      ttlMs: this.ttlMs,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  /** Resolves an mcpTaskId for its owner; unknown, foreign and expired ids are errors. */
  resolve(owner: string, taskId: string): McpTaskRecord {
    const record = this.byId.get(taskId);
    if (record === undefined || record.owner !== owner) {
      throw new TaskMethodError('TASK_NOT_FOUND', `task ${taskId} was not found`);
    }
    if (this.clock.now() >= record.expiresAt) {
      this.byId.delete(taskId);
      throw new TaskMethodError('TASK_EXPIRED', `task ${taskId} expired`);
    }
    return record;
  }

  get(taskId: string): McpTaskRecord | undefined {
    return this.byId.get(taskId);
  }

  remove(taskId: string): boolean {
    return this.byId.delete(taskId);
  }

  /**
   * Drops every task owned by one owner: a binding id, or a transport id for
   * unbound clients. Tasks of other owners stay resolvable.
   */
  clearOwner(owner: string): number {
    let removed = 0;
    for (const [taskId, record] of this.byId) {
      if (record.owner !== owner) continue;
      this.byId.delete(taskId);
      removed += 1;
    }
    return removed;
  }

  sweep(now: number = this.clock.now()): number {
    let removed = 0;
    for (const [taskId, record] of this.byId) {
      if (now < record.expiresAt) continue;
      this.byId.delete(taskId);
      removed += 1;
    }
    return removed;
  }
}

/** `tasks/get` result: full Task with `resultType: "complete"` and an optional CallToolResult. */
export interface TaskView {
  readonly resultType: 'complete';
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;
  result?: CallToolResult;
  error?: { code: string; message: string; data?: unknown };
}

function toTaskView(taskId: string, snapshot: TaskSnapshot): TaskView {
  const view: TaskView = {
    resultType: 'complete',
    taskId,
    status: snapshot.status,
    createdAt: snapshot.createdAt,
    lastUpdatedAt: snapshot.lastUpdatedAt,
    ttlMs: snapshot.ttlMs,
    pollIntervalMs: snapshot.pollIntervalMs,
  };
  if (snapshot.result !== undefined) {
    view.result = toCallToolResult(snapshot.result);
  }
  if (snapshot.error !== undefined) {
    const error: { code: string; message: string; data?: unknown } = {
      code: snapshot.error.code,
      message: snapshot.error.message,
    };
    if (snapshot.error.data !== undefined) error.data = snapshot.error.data;
    view.error = error;
  }
  return view;
}

/** `tasks/get` is an idempotent read; it never consumes the `wait_tasks` queue. */
export async function getMcpTask(
  store: McpTaskStore,
  gateway: ExecutionGateway,
  owner: string,
  taskId: string,
): Promise<TaskView> {
  const record = store.resolve(owner, taskId);
  const snapshot = await gateway.getTask(owner, record.evalTaskId);
  if (snapshot === null) {
    store.remove(taskId);
    throw new TaskMethodError('TASK_NOT_FOUND', `task ${taskId} is no longer available`);
  }
  return toTaskView(taskId, snapshot);
}

/**
 * `tasks/cancel`: cooperative cancel for a working task, and the current
 * terminal state for one that already finished (protocol §6). Unknown or
 * evicted eval tasks are `TASK_NOT_FOUND`; the mapping is dropped on the way.
 */
export async function cancelMcpTask(
  store: McpTaskStore,
  gateway: ExecutionGateway,
  owner: string,
  taskId: string,
): Promise<TaskView | TaskAcknowledgement> {
  const record = store.resolve(owner, taskId);
  const snapshot = await gateway.getTask(owner, record.evalTaskId);
  if (snapshot === null) {
    store.remove(taskId);
    throw new TaskMethodError('TASK_NOT_FOUND', `task ${taskId} is no longer available`);
  }
  if (snapshot.status !== 'working') return toTaskView(taskId, snapshot);

  const cancelled = await gateway.cancelTask(owner, record.evalTaskId);
  if (cancelled) return { resultType: 'complete' };

  // The eval settled between the read and the cancel: report that terminal state.
  const settled = await gateway.getTask(owner, record.evalTaskId);
  if (settled === null) {
    store.remove(taskId);
    throw new TaskMethodError('TASK_NOT_FOUND', `task ${taskId} is no longer available`);
  }
  return toTaskView(taskId, settled);
}

/** `tasks/update` never produces `input_required`; unknown keys are ignored by the caller. */
export function updateMcpTask(
  store: McpTaskStore,
  owner: string,
  taskId: string,
): TaskAcknowledgement {
  store.resolve(owner, taskId);
  return { resultType: 'complete' };
}
