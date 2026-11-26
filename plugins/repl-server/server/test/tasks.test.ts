import assert from 'node:assert/strict';
import test from 'node:test';

import type { Clock, ExecutionGateway, ScriptOutcome, TaskSnapshot } from '../src/ports.ts';
import { JsonRpcError } from '../src/mcp/errors.ts';
import {
  cancelMcpTask,
  clientDeclaredTasks,
  getMcpTask,
  isCreateTaskResult,
  McpTaskStore,
  resolveDispatchMode,
  TASK_POLL_INTERVAL_MS,
  TASK_TTL_MS,
  TaskMethodError,
  updateMcpTask,
} from '../src/tasks/mcp-tasks.ts';

const START = Date.UTC(2026, 10, 18, 6, 0, 0);
const OUTCOME: ScriptOutcome = {
  content: '<repl-output eval="3"><result>ok</result></repl-output>',
  isError: false,
};

function fakeClock(start = START): Clock & { advance(ms: number): void } {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

class FakeGateway implements ExecutionGateway {
  task: TaskSnapshot | null = null;
  /** When non-empty, `getTask` shifts one response per call before falling back to `task`. */
  readonly taskQueue: Array<TaskSnapshot | null> = [];
  cancelResult = true;
  readonly getTaskCalls: Array<{ owner: string; taskId: string }> = [];
  readonly cancelCalls: Array<{ owner: string; taskId: string }> = [];

  async runScript(): Promise<ScriptOutcome> {
    throw new Error('runScript is not used by the tasks layer');
  }

  async dispatchScript(): Promise<{ taskId: string; evalId: number; runId: string }> {
    throw new Error('dispatchScript is not used by the tasks layer');
  }

  async waitTasks(): Promise<unknown> {
    throw new Error('waitTasks is not used by the tasks layer');
  }

  async getTask(owner: string, taskId: string): Promise<TaskSnapshot | null> {
    this.getTaskCalls.push({ owner, taskId });
    if (this.taskQueue.length > 0) return this.taskQueue.shift() ?? null;
    return this.task;
  }

  async cancelTask(owner: string, taskId: string): Promise<boolean> {
    this.cancelCalls.push({ owner, taskId });
    return this.cancelResult;
  }

  async destroyOwner(): Promise<void> {}
  async destroyTransport(): Promise<void> {}
}

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    taskId: 'ev_1',
    status: 'completed',
    createdAt: '2026-11-18T06:00:00.000Z',
    lastUpdatedAt: '2026-11-18T06:01:00.000Z',
    ttlMs: TASK_TTL_MS,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
    result: OUTCOME,
    ...overrides,
  };
}

function taskError(fn: () => unknown): TaskMethodError {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof TaskMethodError, 'expected a TaskMethodError');
    return error;
  }
  throw new Error('expected a TaskMethodError');
}

async function taskErrorAsync(fn: () => Promise<unknown>): Promise<TaskMethodError> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof TaskMethodError, 'expected a TaskMethodError');
    return error;
  }
  throw new Error('expected a TaskMethodError');
}

test('task constants come from the frozen protocol values', () => {
  assert.equal(TASK_TTL_MS, 9_000_000);
  assert.equal(TASK_POLL_INTERVAL_MS, 500);
});

test('clientDeclaredTasks reads the per-request extension declaration', () => {
  const declared = {
    _meta: {
      'io.modelcontextprotocol/clientCapabilities': {
        extensions: { 'io.modelcontextprotocol/tasks': {} },
      },
    },
  };
  assert.equal(clientDeclaredTasks(declared), true);
  assert.equal(clientDeclaredTasks({ _meta: {} }), false);
  assert.equal(
    clientDeclaredTasks({
      _meta: { 'io.modelcontextprotocol/clientCapabilities': { extensions: {} } },
    }),
    false,
  );
  assert.equal(
    clientDeclaredTasks({
      _meta: {
        'io.modelcontextprotocol/clientCapabilities': {
          extensions: { 'io.modelcontextprotocol/other': {} },
        },
      },
    }),
    false,
  );
  assert.equal(clientDeclaredTasks(undefined), false);
  assert.equal(clientDeclaredTasks({ _meta: { 'io.modelcontextprotocol/clientCapabilities': 'yes' } }), false);
});

test('resolveDispatchMode implements the frozen decision table', () => {
  assert.equal(resolveDispatchMode('run_script', { async: true }, true), 'task');
  assert.equal(resolveDispatchMode('run_script', { async: true, timeout: 1000 }, true), 'task');
  assert.equal(resolveDispatchMode('run_script', { async: true }, false), 'async');
  assert.equal(resolveDispatchMode('run_script', { async: true, timeout: 35000 }, false), 'async');
  assert.equal(resolveDispatchMode('run_script', { timeout: 35000 }, true), 'task');
  assert.equal(resolveDispatchMode('run_script', { async: false, timeout: 35000 }, true), 'task');
  assert.equal(resolveDispatchMode('run_script', { timeout: 30000 }, true), 'sync');
  assert.equal(resolveDispatchMode('run_script', {}, true), 'sync');
  assert.equal(resolveDispatchMode('run_script', { timeout: 35000 }, false), 'sync');
  assert.equal(resolveDispatchMode('search_tools', { async: true, timeout: 35000 }, true), 'sync');
});

test('McpTaskStore.create returns the CreateTaskResult shape and maps both id spaces', () => {
  const clock = fakeClock();
  const ids = ['t_1'];
  const store = new McpTaskStore({ clock, idFactory: () => ids.shift() ?? 't_fallback' });
  const created = store.create('owner-a', 'ev_9');

  assert.deepEqual(created, {
    resultType: 'task',
    taskId: 't_1',
    status: 'working',
    createdAt: '2026-11-18T06:00:00.000Z',
    lastUpdatedAt: '2026-11-18T06:00:00.000Z',
    ttlMs: 9_000_000,
    pollIntervalMs: 500,
  });
  assert.equal(isCreateTaskResult(created), true);
  assert.equal(isCreateTaskResult({ resultType: 'complete' }), false);

  const record = store.resolve('owner-a', 't_1');
  assert.equal(record.evalTaskId, 'ev_9');
  assert.equal(record.owner, 'owner-a');
  assert.equal(record.expiresAt, START + TASK_TTL_MS);

  const collisionIds = ['t_dup', 't_dup', 't_next'];
  const colliding = new McpTaskStore({ clock, idFactory: () => collisionIds.shift() ?? 't_x' });
  assert.equal(colliding.create('owner-a', 'ev_1').taskId, 't_dup');
  assert.equal(colliding.create('owner-a', 'ev_2').taskId, 't_next');
});

test('McpTaskStore rejects foreign ids and expires by TTL', () => {
  const clock = fakeClock();
  const store = new McpTaskStore({ clock, idFactory: () => 't_1' });
  store.create('owner-a', 'ev_1');

  const foreign = taskError(() => store.resolve('owner-b', 't_1'));
  assert.ok(foreign instanceof JsonRpcError, 'task errors serialize as JSON-RPC errors');
  assert.equal(foreign.taskCode, 'TASK_NOT_FOUND');
  assert.equal(foreign.code, -32602);
  assert.deepEqual(foreign.data, { code: 'TASK_NOT_FOUND' });
  assert.equal(store.size, 1);

  clock.advance(TASK_TTL_MS - 1);
  assert.equal(store.resolve('owner-a', 't_1').evalTaskId, 'ev_1');

  clock.advance(1);
  const expired = taskError(() => store.resolve('owner-a', 't_1'));
  assert.equal(expired.taskCode, 'TASK_EXPIRED');
  assert.deepEqual(expired.toBody(), {
    code: -32602,
    message: 'task t_1 expired',
    data: { code: 'TASK_EXPIRED' },
  });
  assert.equal(store.size, 0);
});

test('McpTaskStore sweeps and clears by owner', () => {
  const clock = fakeClock();
  let next = 0;
  const store = new McpTaskStore({ clock, idFactory: () => `t_${(next += 1)}` });
  store.create('owner-a', 'ev_1');
  store.create('owner-b', 'ev_2');

  assert.equal(store.clearOwner('owner-a'), 1);
  assert.equal(store.size, 1);
  assert.equal(store.resolve('owner-b', 't_2').evalTaskId, 'ev_2');

  clock.advance(TASK_TTL_MS);
  assert.equal(store.sweep(), 1);
  assert.equal(store.size, 0);
});

test('getMcpTask maps a completed snapshot to a CallToolResult', async () => {
  const clock = fakeClock();
  const store = new McpTaskStore({ clock, idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  gateway.task = snapshot();
  const created = store.create('owner-a', 'ev_1');

  const view = await getMcpTask(store, gateway, 'owner-a', created.taskId);
  assert.deepEqual(view, {
    resultType: 'complete',
    taskId: 't_1',
    status: 'completed',
    createdAt: '2026-11-18T06:00:00.000Z',
    lastUpdatedAt: '2026-11-18T06:01:00.000Z',
    ttlMs: 9_000_000,
    pollIntervalMs: 500,
    result: {
      resultType: 'complete',
      content: [{ type: 'text', text: OUTCOME.content }],
      isError: false,
    },
  });
  assert.deepEqual(gateway.getTaskCalls, [{ owner: 'owner-a', taskId: 'ev_1' }]);
});

test('getMcpTask maps media, errors and working snapshots', async () => {
  const store = new McpTaskStore({ clock: fakeClock(), idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  store.create('owner-a', 'ev_1');

  gateway.task = snapshot({
    result: {
      content: '<repl-output eval="1"></repl-output>',
      isError: true,
      images: [{ base64: 'aW1n', mediaType: 'image/png' }],
      documents: [{ base64: 'cGRm' }],
    },
  });
  const withMedia = await getMcpTask(store, gateway, 'owner-a', 't_1');
  assert.deepEqual(withMedia.result?.content, [
    { type: 'text', text: '<repl-output eval="1"></repl-output>' },
    { type: 'image', data: 'aW1n', mimeType: 'image/png' },
    {
      type: 'resource',
      resource: { uri: 'repl://document/0', mimeType: 'application/pdf', blob: 'cGRm' },
    },
  ]);
  assert.equal(withMedia.result?.isError, true);

  gateway.task = snapshot({
    status: 'failed',
    result: undefined,
    error: { code: 'EVAL_TIMEOUT', message: 'stopped at layer wall', data: { layer: 'wall' } },
  });
  const failed = await getMcpTask(store, gateway, 'owner-a', 't_1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.result, undefined);
  assert.deepEqual(failed.error, {
    code: 'EVAL_TIMEOUT',
    message: 'stopped at layer wall',
    data: { layer: 'wall' },
  });

  gateway.task = snapshot({ status: 'working', result: undefined });
  const working = await getMcpTask(store, gateway, 'owner-a', 't_1');
  assert.equal(working.status, 'working');
  assert.equal(working.result, undefined);
  assert.equal(working.error, undefined);
});

test('getMcpTask drops the mapping when the core table no longer has the task', async () => {
  const store = new McpTaskStore({ clock: fakeClock(), idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  gateway.task = null;
  store.create('owner-a', 'ev_1');

  const error = await taskErrorAsync(() => getMcpTask(store, gateway, 'owner-a', 't_1'));
  assert.equal(error.taskCode, 'TASK_NOT_FOUND');
  assert.equal(store.size, 0);
});

test('tasks/cancel acknowledges a working task and leaves a foreign or missing one alone', async () => {
  const store = new McpTaskStore({ clock: fakeClock(), idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  store.create('owner-a', 'ev_1');
  gateway.task = snapshot({ status: 'working', result: undefined });

  assert.deepEqual(updateMcpTask(store, 'owner-a', 't_1'), { resultType: 'complete' });
  assert.deepEqual(await cancelMcpTask(store, gateway, 'owner-a', 't_1'), { resultType: 'complete' });
  assert.deepEqual(gateway.cancelCalls, [{ owner: 'owner-a', taskId: 'ev_1' }]);

  const foreign = await taskErrorAsync(() => cancelMcpTask(store, gateway, 'owner-b', 't_1'));
  assert.equal(foreign.taskCode, 'TASK_NOT_FOUND');
  assert.equal(gateway.cancelCalls.length, 1);

  gateway.task = null;
  const gone = await taskErrorAsync(() => cancelMcpTask(store, gateway, 'owner-a', 't_1'));
  assert.equal(gone.taskCode, 'TASK_NOT_FOUND');
  assert.equal(store.size, 0, 'a mapping whose eval task vanished is dropped');
});

test('tasks/cancel on an already-finished task returns its current terminal state', async () => {
  const store = new McpTaskStore({ clock: fakeClock(), idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  store.create('owner-a', 'ev_1');
  gateway.task = snapshot();

  const view = await cancelMcpTask(store, gateway, 'owner-a', 't_1');
  assert.equal((view as { status?: string }).status, 'completed');
  assert.equal((view as { resultType?: string }).resultType, 'complete');
  assert.equal((view as { taskId?: string }).taskId, 't_1');
  assert.equal(gateway.cancelCalls.length, 0, 'a terminal task is not cancelled again');
});

test('tasks/cancel reports the terminal state when the eval finishes during the cancel', async () => {
  const store = new McpTaskStore({ clock: fakeClock(), idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  store.create('owner-a', 'ev_1');
  gateway.cancelResult = false;
  gateway.taskQueue.push(snapshot({ status: 'working', result: undefined }), snapshot());

  const view = await cancelMcpTask(store, gateway, 'owner-a', 't_1');
  assert.equal((view as { status?: string }).status, 'completed');
  assert.deepEqual(gateway.cancelCalls, [{ owner: 'owner-a', taskId: 'ev_1' }]);
});

test('McpTaskStore clears tasks by owner and leaves other owners alone', () => {
  const clock = fakeClock();
  let next = 0;
  const store = new McpTaskStore({ clock, idFactory: () => `t_${(next += 1)}` });
  const first = store.create('cb_bound', 'ev_1');
  const second = store.create('cb_bound', 'ev_2');
  store.create('owner-c', 'ev_3');

  assert.equal(store.clearOwner('cb_bound'), 2);
  assert.equal(store.size, 1);
  assert.throws(() => store.resolve('cb_bound', first.taskId), TaskMethodError);
  assert.throws(() => store.resolve('cb_bound', second.taskId), TaskMethodError);
  assert.equal(store.resolve('owner-c', 't_3').evalTaskId, 'ev_3');
});

test('tasks/cancel and tasks/update use the task error codes', async () => {
  const clock = fakeClock();
  const store = new McpTaskStore({ clock, idFactory: () => 't_1' });
  const gateway = new FakeGateway();
  store.create('owner-a', 'ev_1');

  const foreign = await taskErrorAsync(() => cancelMcpTask(store, gateway, 'owner-b', 't_1'));
  assert.equal(foreign.taskCode, 'TASK_NOT_FOUND');
  assert.deepEqual(store.resolve('owner-a', 't_1').evalTaskId, 'ev_1');
  assert.equal(gateway.cancelCalls.length, 0);

  const unknown = taskError(() => updateMcpTask(store, 'owner-a', 't_missing'));
  assert.equal(unknown.taskCode, 'TASK_NOT_FOUND');

  clock.advance(TASK_TTL_MS);
  const expired = taskError(() => updateMcpTask(store, 'owner-a', 't_1'));
  assert.equal(expired.taskCode, 'TASK_EXPIRED');
});
