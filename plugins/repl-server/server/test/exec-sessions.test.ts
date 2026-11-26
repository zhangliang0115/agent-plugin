import assert from 'node:assert/strict';
import test from 'node:test';

import type { Clock } from '../src/ports.ts';
import { CapacityExceededError, type CapacityResource } from '../src/exec/capacity.ts';
import { ExecSessionRegistry } from '../src/exec/exec-sessions.ts';

class ManualClock implements Clock {
  private current: number;

  constructor(start = 1_000_000) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): void {
    this.current += ms;
  }
}

interface ExpectedCapacity {
  code?: 'CAPACITY_EXCEEDED';
  resource: CapacityResource;
  current: number;
  limit: number;
  scope: string;
}

function expectCapacityError(fn: () => unknown, expected: ExpectedCapacity): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof CapacityExceededError);
    assert.equal(error.code, expected.code ?? 'CAPACITY_EXCEEDED');
    assert.equal(error.resource, expected.resource);
    assert.equal(error.current, expected.current);
    assert.equal(error.limit, expected.limit);
    assert.equal(error.scope, expected.scope);
    return true;
  });
}

test('creates one execution session per (Mcp-Session-Id, workspace) for an unbound client lazily', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({ clock });

  assert.equal(registry.size, 0);

  const session = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo' });
  assert.match(session.id, /^es_[0-9a-f]{32}$/);
  assert.equal(session.mcpSessionId, 'mcp_a');
  assert.equal(session.workspace, '/repo');
  assert.equal(session.binding, null);
  assert.equal(session.clientLabel, '');
  assert.equal(session.inFlightEvals, 0);
  assert.equal(session.createdAt, clock.now());
  assert.equal(session.lastEvalAt, clock.now());
  assert.equal(session.lastRequestAt, clock.now());

  assert.equal(registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo' }), session);
  assert.equal(registry.size, 1);

  const otherWorkspace = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/other' });
  const otherSession = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/repo' });
  assert.notEqual(otherWorkspace, session);
  assert.notEqual(otherSession, session);
  assert.equal(registry.size, 3);
  assert.equal(registry.countForMcpSession('mcp_a'), 2);
  assert.equal(registry.countForMcpSession('mcp_b'), 1);
  assert.equal(registry.countForMcpSession('mcp_missing'), 0);
  assert.equal(registry.find('mcp_b', '/repo'), otherSession);
  assert.equal(registry.find('mcp_b', '/missing'), undefined);
  assert.deepEqual(
    registry.list().map((entry) => entry.id),
    [session.id, otherWorkspace.id, otherSession.id],
  );
  assert.deepEqual(
    registry.listForMcpSession('mcp_a').map((entry) => entry.id),
    [session.id, otherWorkspace.id],
  );
});

test('the session key keeps bound and unbound identities apart', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({ clock });

  const unbound = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo' });
  const bound = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo', binding: 'cb_work' });
  const boundAgain = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo', binding: 'cb_work' });

  assert.notEqual(unbound, bound);
  assert.equal(boundAgain, bound);
  assert.equal(registry.size, 2);
  assert.equal(registry.find('mcp_a', '/repo'), unbound);
  assert.equal(registry.find('mcp_a', '/repo', 'cb_work'), bound);
  assert.equal(registry.find('mcp_a', '/repo', 'cb_other'), undefined);

  // The transport cascade only removes the unbound record; the bound one
  // belongs to its binding and survives the transport.
  assert.equal(registry.destroyByTransport('mcp_a'), 1);
  assert.equal(registry.find('mcp_a', '/repo', 'cb_work'), bound);
  assert.equal(registry.destroyByBinding('cb_work'), 1);
  assert.equal(registry.size, 0);
});

test('a bound client reuses one session per (binding, workspace) across transports', () => {
  const registry = new ExecSessionRegistry({ clock: new ManualClock() });

  const first = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo', binding: 'cb_work' });
  const second = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/repo', binding: 'cb_work' });
  assert.equal(second, first);
  assert.equal(first.mcpSessionId, 'mcp_a');
  assert.equal(registry.countForBinding('cb_work'), 1);

  const otherWorkspace = registry.acquire({
    mcpSessionId: 'mcp_b',
    workspace: '/other',
    binding: 'cb_work',
  });
  assert.notEqual(otherWorkspace, first);
  assert.equal(registry.find('mcp_a', '/other', 'cb_work'), otherWorkspace);
  assert.equal(registry.countForBinding('cb_work'), 2);

  const otherBinding = registry.acquire({
    mcpSessionId: 'mcp_b',
    workspace: '/repo',
    binding: 'cb_other',
  });
  assert.notEqual(otherBinding, first);
  assert.equal(registry.size, 3);
});

test('unbound sessions stay isolated per Mcp-Session-Id', () => {
  const registry = new ExecSessionRegistry({ clock: new ManualClock() });

  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/repo' });
  const b = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/repo' });
  assert.notEqual(a, b);
  assert.equal(registry.size, 2);
  assert.equal(registry.find('mcp_a', '/repo'), a);
  assert.equal(registry.find('mcp_b', '/repo'), b);
});

test('records binding and client label; idFactory is injectable', () => {
  const clock = new ManualClock(42);
  let next = 0;
  const registry = new ExecSessionRegistry<string, string>({
    clock,
    idFactory: () => `es_test_${++next}`,
  });

  const session = registry.acquire({
    mcpSessionId: 'mcp_a',
    workspace: '/repo',
    binding: 'cb_work',
    clientLabel: 'claude-code/2.1.327',
  });
  assert.equal(session.id, 'es_test_1');
  assert.equal(session.binding, 'cb_work');
  assert.equal(session.clientLabel, 'claude-code/2.1.327');
  assert.equal(registry.countForBinding('cb_work'), 1);
  assert.equal(registry.countForBinding('cb_other'), 0);
  assert.equal(session.createdAt, 42);
});

test('rejects duplicate ids coming from an injectable idFactory', () => {
  const registry = new ExecSessionRegistry({
    clock: new ManualClock(),
    idFactory: () => 'es_same',
  });
  registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a' });
  assert.throws(
    () => registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/b' }),
    /duplicate exec session id/,
  );
  assert.equal(registry.size, 1);
});

test('does not cap workspaces per MCP session', () => {
  const registry = new ExecSessionRegistry({ clock: new ManualClock() });

  for (let index = 0; index < 5; index += 1) {
    registry.acquire({ mcpSessionId: 'mcp_a', workspace: `/w${index}` });
  }
  assert.equal(registry.size, 5);
  assert.equal(registry.countForMcpSession('mcp_a'), 5);
  assert.equal(registry.listForMcpSession('mcp_a').length, 5);

  // Another transport only shares the global execution-session limit.
  registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/w0' });
  assert.equal(registry.size, 6);
});

test('unbound clients keep the per-owner execution-session quota', () => {
  const registry = new ExecSessionRegistry({
    clock: new ManualClock(),
    limits: { maxExecSessionsPerBinding: 3 },
  });

  for (let index = 0; index < 3; index += 1) {
    registry.acquire({ mcpSessionId: 'mcp_a', workspace: `/b${index}`, binding: 'cb_work' });
  }
  assert.equal(registry.countForBinding('cb_work'), 3);

  for (let index = 0; index < 3; index += 1) {
    registry.acquire({ mcpSessionId: 'mcp_a', workspace: `/u${index}` });
  }
  expectCapacityError(
    () => registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/u3' }),
    {
      resource: 'exec_sessions_per_binding',
      current: 3,
      limit: 3,
      scope: 'mcp:mcp_a',
    },
  );

  // Another transport has its own owner bucket.
  registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/u3' });
});

test('caps execution sessions per binding at 4 across MCP sessions', () => {
  const registry = new ExecSessionRegistry({
    clock: new ManualClock(),
    limits: { maxExecSessionsPerBinding: 4 },
  });

  for (let index = 0; index < 2; index += 1) {
    registry.acquire({ mcpSessionId: 'mcp_a', workspace: `/a${index}`, binding: 'cb_work' });
    registry.acquire({ mcpSessionId: 'mcp_b', workspace: `/b${index}`, binding: 'cb_work' });
  }
  assert.equal(registry.countForBinding('cb_work'), 4);

  expectCapacityError(
    () => registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/c', binding: 'cb_work' }),
    {
      resource: 'exec_sessions_per_binding',
      current: 4,
      limit: 4,
      scope: 'binding:cb_work',
    },
  );

  registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/c', binding: 'cb_other' });
  assert.equal(registry.countForBinding('cb_other'), 1);
  assert.equal(registry.size, 5);
});

test('evicts the idle LRU session inside one binding at its quota', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({
    clock,
    limits: { maxExecSessionsPerBinding: 2, evictIdleMs: 60_000 },
  });

  const other = registry.acquire({ mcpSessionId: 'mcp_o', workspace: '/o', binding: 'cb_other' });
  clock.advance(10_000);
  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a', binding: 'cb_work' });
  clock.advance(10_000);
  const b = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/b', binding: 'cb_work' });
  clock.advance(60_001);

  const c = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/c', binding: 'cb_work' });

  // `other` is globally older but belongs to another binding and must survive.
  assert.equal(registry.get(other.id), other);
  assert.equal(registry.get(a.id), undefined);
  assert.equal(registry.get(b.id), b);
  assert.equal(registry.get(c.id), c);
  assert.equal(registry.countForBinding('cb_work'), 2);
});

test('unbound sessions are bucketed per MCP session for the binding quota', () => {
  const registry = new ExecSessionRegistry({
    clock: new ManualClock(),
    limits: { maxExecSessionsPerBinding: 2 },
  });

  registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a1' });
  registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a2' });
  expectCapacityError(
    () => registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a3' }),
    {
      resource: 'exec_sessions_per_binding',
      current: 2,
      limit: 2,
      scope: 'mcp:mcp_a',
    },
  );

  registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b1' });
  registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b2' });
  assert.equal(registry.size, 4);
});

test('caps execution sessions per process at 8 when nothing can be evicted', () => {
  const registry = new ExecSessionRegistry({
    clock: new ManualClock(),
    limits: { maxExecSessions: 8 },
  });

  for (const mcpSessionId of ['mcp_a', 'mcp_b']) {
    for (let index = 0; index < 4; index += 1) {
      registry.acquire({ mcpSessionId, workspace: `/w${index}` });
    }
  }
  assert.equal(registry.size, 8);

  expectCapacityError(
    () => registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/w0' }),
    { resource: 'exec_sessions', current: 8, limit: 8, scope: 'global' },
  );
  assert.equal(registry.size, 8);
});

test('evicts the LRU session past evictIdleMs and reports capacity_evict', () => {
  const clock = new ManualClock();
  const removed: { id: string; reason: string }[] = [];
  const registry = new ExecSessionRegistry<string, string>({
    clock,
    limits: { maxExecSessions: 2, evictIdleMs: 60_000 },
    onRemove: (session, reason) => {
      removed.push({ id: session.id, reason });
    },
  });

  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a' });
  clock.advance(10_000);
  const b = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b' });
  clock.advance(50_001); // a idle 60_001ms, b idle 50_001ms

  const c = registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/c' });

  assert.equal(registry.size, 2);
  assert.equal(registry.get(a.id), undefined);
  assert.equal(registry.get(b.id), b);
  assert.equal(registry.get(c.id), c);
  assert.deepEqual(removed, [{ id: a.id, reason: 'capacity_evict' }]);
});

test('never evicts a session with an in-flight eval', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({
    clock,
    limits: { maxExecSessions: 2, evictIdleMs: 60_000 },
  });

  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a' });
  registry.beginEval({ mcpSessionId: 'mcp_a', workspace: '/a' });
  clock.advance(120_000);
  registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b' });

  expectCapacityError(
    () => registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/c' }),
    { resource: 'exec_sessions', current: 2, limit: 2, scope: 'global' },
  );

  assert.equal(registry.endEval(a), 0);
  const c = registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/c' });
  assert.equal(registry.get(a.id), undefined);
  assert.equal(registry.get(c.id), c);
});

test('does not evict a session idle for exactly evictIdleMs', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({
    clock,
    limits: { maxExecSessions: 1, evictIdleMs: 60_000 },
  });

  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a' });
  clock.advance(60_000);
  expectCapacityError(
    () => registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b' }),
    { resource: 'exec_sessions', current: 1, limit: 1, scope: 'global' },
  );

  clock.advance(1);
  const b = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b' });
  assert.equal(registry.get(a.id), undefined);
  assert.equal(registry.get(b.id), b);
});

test('LRU orders by lastEvalAt, not createdAt', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({
    clock,
    limits: { maxExecSessions: 2, evictIdleMs: 60_000 },
  });

  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a' });
  clock.advance(10_000);
  const b = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b' });

  clock.advance(10_000);
  registry.beginEval({ mcpSessionId: 'mcp_a', workspace: '/a' });
  registry.endEval(a);

  clock.advance(60_001); // a idle 60_001ms, b idle 70_001ms
  registry.acquire({ mcpSessionId: 'mcp_c', workspace: '/c' });

  assert.equal(registry.get(b.id), undefined);
  assert.equal(registry.get(a.id), a);
});

test('caps in-flight evals per execution session at 64', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({ clock });
  const request = { mcpSessionId: 'mcp_a', workspace: '/a' };

  const session = registry.beginEval(request);
  assert.equal(session.inFlightEvals, 1);
  for (let index = 2; index <= 64; index += 1) {
    assert.equal(registry.beginEval(request).inFlightEvals, index);
  }

  expectCapacityError(() => registry.beginEval(request), {
    resource: 'in_flight_evals_per_exec_session',
    current: 64,
    limit: 64,
    scope: session.id,
  });

  assert.equal(registry.endEval(session), 63);
  assert.equal(registry.beginEval(request).inFlightEvals, 64);
});

test('caps in-flight evals per binding at 256 across execution sessions', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({ clock });
  const binding = 'cb_work';
  const requestA = { mcpSessionId: 'mcp_a', workspace: '/a', binding };
  const requestB = { mcpSessionId: 'mcp_a', workspace: '/b', binding };
  const requestC = { mcpSessionId: 'mcp_a', workspace: '/c', binding };
  const requestD = { mcpSessionId: 'mcp_a', workspace: '/d', binding };

  const sessionA = registry.beginEval(requestA);
  const sessionB = registry.beginEval(requestB);
  const sessionC = registry.beginEval(requestC);
  const sessionD = registry.beginEval(requestD);
  for (let index = 1; index < 64; index += 1) {
    registry.beginEval(requestA);
    registry.beginEval(requestB);
    registry.beginEval(requestC);
    registry.beginEval(requestD);
  }
  assert.equal(sessionA.inFlightEvals, 64);
  assert.equal(sessionB.inFlightEvals, 64);
  assert.equal(sessionC.inFlightEvals, 64);
  assert.equal(sessionD.inFlightEvals, 64);

  expectCapacityError(() => registry.beginEval(requestA), {
    resource: 'in_flight_evals_per_binding',
    current: 256,
    limit: 256,
    scope: 'binding:cb_work',
  });

  assert.equal(registry.endEval(sessionA), 63);
  assert.equal(registry.beginEval(requestA).inFlightEvals, 64);
});

test('beginEval marks the session active and endEval releases the slot', () => {
  const clock = new ManualClock();
  const registry = new ExecSessionRegistry({ clock });
  const request = { mcpSessionId: 'mcp_a', workspace: '/a' };

  const session = registry.acquire(request);
  assert.equal(session.lastEvalAt, 1_000_000);

  clock.advance(5_000);
  assert.equal(registry.acquire(request).lastEvalAt, 1_000_000);

  assert.equal(registry.beginEval(request).lastEvalAt, 1_005_000);
  assert.equal(session.lastRequestAt, 1_005_000);

  clock.advance(1_000);
  assert.equal(registry.endEval(session), 0);
  assert.equal(session.lastEvalAt, 1_005_000);
  assert.equal(session.lastRequestAt, 1_006_000);

  // Unknown (already removed) session references are ignored.
  registry.destroySession(session.id);
  assert.equal(registry.endEval(session), 0);
});

test('destroys sessions by id, transport, binding and shutdown', () => {
  const clock = new ManualClock();
  const events: string[] = [];
  const registry = new ExecSessionRegistry({
    clock,
    onRemove: (session, reason) => events.push(`${reason}:${session.id}`),
  });

  const a = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/a', binding: 'cb_a' });
  const b = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/b', binding: 'cb_a' });
  const c = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/c', binding: 'cb_b' });
  const d = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/d' });

  assert.equal(registry.destroyByTransport('mcp_missing'), 0);
  assert.equal(registry.destroyByTransport('mcp_b'), 1);
  assert.deepEqual(events, [`delete:${d.id}`]);
  assert.equal(registry.size, 3);

  assert.equal(registry.destroyByBinding('cb_a'), 2);
  assert.deepEqual(events.slice(1), [`binding_deleted:${a.id}`, `binding_deleted:${b.id}`]);
  assert.equal(registry.get(c.id), c);

  assert.equal(registry.destroySession(c.id), true);
  assert.equal(registry.destroySession(c.id), false);
  assert.equal(events.at(-1), `delete:${c.id}`);
  assert.equal(registry.size, 0);

  const again = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/d' });
  assert.notEqual(again.id, d.id);
  assert.equal(registry.destroyAll('shutdown'), 1);
  assert.equal(events.at(-1), `shutdown:${again.id}`);
  assert.equal(registry.size, 0);
});

test('destroyByTransport leaves bound sessions of the same transport alive', () => {
  const registry = new ExecSessionRegistry({ clock: new ManualClock() });

  const unbound = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/u' });
  const bound = registry.acquire({ mcpSessionId: 'mcp_a', workspace: '/b', binding: 'cb_work' });
  const otherTransport = registry.acquire({ mcpSessionId: 'mcp_b', workspace: '/u' });

  assert.equal(registry.destroyByTransport('mcp_a'), 1);
  assert.equal(registry.get(unbound.id), undefined);
  assert.equal(registry.get(bound.id), bound);
  assert.equal(registry.get(otherTransport.id), otherTransport);
  assert.equal(registry.destroyByTransport('mcp_a'), 0);
});

test('rejects empty identifiers before touching quota state', () => {
  const registry = new ExecSessionRegistry({ clock: new ManualClock() });
  assert.throws(
    () => registry.acquire({ mcpSessionId: '', workspace: '/a' }),
    TypeError,
  );
  assert.throws(
    () => registry.acquire({ mcpSessionId: 'mcp_a', workspace: '' }),
    TypeError,
  );
  assert.throws(
    () => registry.beginEval({ mcpSessionId: '', workspace: '/a' }),
    TypeError,
  );
  assert.equal(registry.size, 0);
});

test('invalid limit overrides are rejected at construction', () => {
  assert.throws(
    () => new ExecSessionRegistry({ limits: { maxExecSessions: 0 } }),
    RangeError,
  );
});
