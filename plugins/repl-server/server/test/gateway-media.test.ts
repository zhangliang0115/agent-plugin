import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

import { mcpClientFactory, mcpTransportFactory } from '../src/pool/adapters/client.ts';
import { createPoolRuntime, type PoolRuntimeServerRecord } from '../src/pool/runtime.ts';
import { toCallToolResult } from '../src/tools/registry.ts';
import {
  ExecGateway,
  type ExecGatewayOptions,
  type ScriptOutcomeWithOmitted,
} from '../src/exec/gateway.ts';
import type { RequestIdentity, ScriptRequest } from '../src/ports.ts';

const IDENTITY: RequestIdentity = {
  identity: 'unbound',
  binding: null,
  client: 'test-client/1.0',
  mcp: 'mcp_media',
};

function createGateway(t: TestContext, options: Partial<ExecGatewayOptions> = {}): ExecGateway {
  const gateway = new ExecGateway({
    callTool: async () => ({ ok: true }),
    ...options,
  });
  t.after(async () => {
    await gateway.disposeAll();
  });
  return gateway;
}

function request(code: string, extra: Partial<ScriptRequest> = {}): ScriptRequest {
  return { code, timeoutMs: 10_000, async: false, identity: IDENTITY, ...extra };
}

const IMAGE = { base64: 'aW1n', mediaType: 'image/png' };
const PDF = { base64: 'cGRm' };

test('tool media is attached to the outcome and kept out of the XML', async (t) => {
  const gateway = createGateway(t, {
    callTool: async () => ({ text: 'saved', images: [IMAGE], documents: [PDF] }),
  });

  const outcome = await gateway.runScript(request(`
    const result = await tools.Read({ path: '/tmp/a' });
    return result.text;
  `));

  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>saved<\/result>/);
  assert.doesNotMatch(outcome.content, /aW1n|cGRm/);
  assert.deepEqual(outcome.images, [IMAGE]);
  assert.deepEqual(outcome.documents, [PDF]);
});

test('script return media at the top level is collected and deduplicated', async (t) => {
  const gateway = createGateway(t, {
    callTool: async () => ({ text: 'saved', images: [IMAGE] }),
  });

  const outcome = await gateway.runScript(request(`
    return await tools.Read({ path: '/tmp/a' });
  `));

  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>\{"text":"saved"\}<\/result>/);
  assert.doesNotMatch(outcome.content, /aW1n/);
  assert.deepEqual(outcome.images, [IMAGE]);
});

test('object and array results are serialized as JSON instead of String()', async (t) => {
  const gateway = createGateway(t);

  const object = await gateway.runScript(request(`
    return { answer: 42, nested: { ok: true }, list: [1, 2] };
  `));
  assert.equal(object.isError, false, object.content);
  assert.match(object.content, /<result>\{"answer":42,"nested":\{"ok":true\},"list":\[1,2\]\}<\/result>/);
  assert.doesNotMatch(object.content, /\[object Object\]/);

  const array = await gateway.runScript(request(`return ['a', 'b'];`));
  assert.equal(array.isError, false, array.content);
  assert.match(array.content, /<result>\["a","b"\]<\/result>/);
});

test('media is capped through normalizeOutput: 8 images, 4 PDFs, byte limit', async (t) => {
  const images = Array.from({ length: 9 }, (_, index) => ({
    base64: Buffer.from(`image-${index}`).toString('base64'),
    mediaType: 'image/png',
  }));
  const documents = Array.from({ length: 5 }, (_, index) => ({
    base64: Buffer.from(`pdf-${index}`).toString('base64'),
  }));
  const gateway = createGateway(t, {
    callTool: async () => ({ images, documents, oversize: [{ base64: 'AAAAAAAA' }] }),
    outputLimits: { mediaBytes: 4 },
  });

  const outcome = await gateway.runScript(request(`
    return await tools.Read({ path: '/tmp/a' });
  `));

  assert.equal(outcome.isError, false, outcome.content);
  // Every block in this fixture decodes to more than the 4-byte test limit.
  assert.equal(outcome.images, undefined);
  assert.equal(outcome.documents, undefined);

  const capped = createGateway(t, {
    callTool: async () => ({ images, documents }),
  });
  const outcomeCapped = (await capped.runScript(request(`
    return await tools.Read({ path: '/tmp/a' });
  `))) as ScriptOutcomeWithOmitted;
  assert.equal(outcomeCapped.images?.length, 8);
  assert.equal(outcomeCapped.documents?.length, 4);
  assert.equal(outcomeCapped.imagesOmitted, 1);
  assert.equal(outcomeCapped.documentsOmitted, 1);
});

test('a tool loop keeps only the first 8 images instead of accumulating 20', async (t) => {
  const gateway = createGateway(t, {
    callTool: async (call) => ({
      text: 'saved',
      images: [
        {
          base64: Buffer.from(`loop-image-${String(call.args['index'] ?? 0)}`).toString('base64'),
          mediaType: 'image/png',
        },
      ],
    }),
  });

  const outcome = (await gateway.runScript(request(`
    for (let index = 0; index < 20; index += 1) {
      await tools.Read({ path: '/tmp/a', index });
    }
    return 'done';
  `))) as ScriptOutcomeWithOmitted;

  assert.equal(outcome.isError, false, outcome.content);
  assert.equal(outcome.images?.length, 8);
  assert.equal(outcome.imagesOmitted, 12);
  assert.equal(new Set(outcome.images?.map((image) => image.base64)).size, 8);
});

test('a real MCP media result returned by the script stays out of the XML and appears once', async (t) => {
  const fixture = fileURLToPath(new URL('./fixtures/media-mcp/server.mjs', import.meta.url));
  const record: PoolRuntimeServerRecord = {
    id: 'media',
    transport: 'stdio',
    command: process.execPath,
    args: [fixture],
    env: {},
    cwd: null,
    url: null,
    headers: {},
    enabled: true,
    revision: 1,
  };
  const runtime = createPoolRuntime({
    servers: { get: async (id) => (id === 'media' ? record : null) },
    secrets: { get: async () => undefined },
    transportFactory: mcpTransportFactory,
    clientFactory: mcpClientFactory,
    health: false,
    autoReconnect: false,
    connectTimeoutMs: 5_000,
    callTimeoutMs: 5_000,
  });
  t.after(async () => {
    await runtime.dispose();
  });
  const gateway = createGateway(t, {
    callTool: (call, _workspace, binding, signal, deadline) =>
      runtime.callTool(call, {
        bindingId: binding ?? null,
        ...(signal === undefined ? {} : { signal }),
        ...(deadline === undefined ? {} : { deadline }),
      }),
  });

  const outcome = await gateway.runScript(request(`
    return await tools.mcp.media.fetch({});
  `));

  assert.equal(outcome.isError, false, outcome.content);
  assert.match(outcome.content, /<result>\{"text":"saved"\}<\/result>/);
  assert.doesNotMatch(outcome.content, /aW1n|cGRm/);
  assert.deepEqual(outcome.images, [{ base64: 'aW1n', mediaType: 'image/png' }]);
  assert.deepEqual(outcome.documents, [{ base64: 'cGRm' }]);

  const callResult = toCallToolResult(outcome);
  assert.equal(callResult.content.filter((block) => block.type === 'image').length, 1);
  assert.equal(callResult.content.filter((block) => block.type === 'resource').length, 1);
});

test('async tasks/get and wait_tasks share the same envelope and media', async (t) => {
  const gateway = createGateway(t, {
    callTool: async () => ({ text: 'read', images: [IMAGE], documents: [PDF] }),
  });

  const dispatched = await gateway.dispatchScript(
    request(`
      const result = await tools.Read({ path: '/tmp/a' });
      return result.text;
    `, { async: true }),
  );
  assert.ok(dispatched.evalId > 0, 'the dispatch receipt must carry the real evalId');

  const waited = (await gateway.waitTasks(IDENTITY.mcp, [dispatched.taskId], 10_000)) as {
    ok: boolean;
    timedOut: boolean;
    pending: number;
    events: Array<{ taskId: string; evalId: number; status: string; result?: string }>;
  };
  assert.equal(waited.ok, true);
  assert.equal(waited.timedOut, false);
  assert.equal(waited.pending, 0);
  assert.equal(waited.events.length, 1);
  const event = waited.events[0];
  assert.ok(event !== undefined);
  assert.equal(event.evalId, dispatched.evalId);
  assert.equal(event.status, 'completed');
  assert.match(event.result ?? '', /<result>read<\/result>/);
  assert.doesNotMatch(event.result ?? '', /aW1n|cGRm/);

  const snapshot = await gateway.getTask(IDENTITY.mcp, dispatched.taskId);
  assert.ok(snapshot !== null);
  assert.equal(snapshot.status, 'completed');
  assert.equal(snapshot.result?.content, event.result);
  assert.deepEqual(snapshot.result?.images, [IMAGE]);
  assert.deepEqual(snapshot.result?.documents, [PDF]);
});
