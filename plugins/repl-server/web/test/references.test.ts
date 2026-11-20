import assert from 'node:assert/strict';
import test from 'node:test';

import type { ApiClient } from '../src/lib/api.ts';
import { loadDictionaryUsage } from '../src/lib/references.ts';

test('loadDictionaryUsage indexes tags and categories to servers and tools', async () => {
  const toolsByServer: Record<string, unknown> = {
    pg: { tools: [{ name: 'query', tags: ['read', 'query'] }] },
    sentry: { tools: [{ name: 'list_issues', tags: ['Sentry'] }] },
  };
  const api = {
    get: async (path: string) => {
      if (path === '/servers') {
        return {
          servers: [
            { id: 'pg', label: 'PG', category: 'database', tags: ['read'] },
            { id: 'sentry', category: 'observability', tags: ['apm'] },
          ],
        };
      }
      const match = /^\/servers\/([^/]+)\/tools$/u.exec(path);
      assert.ok(match, path);
      return toolsByServer[decodeURIComponent(match[1] ?? '')];
    },
  } as unknown as ApiClient;

  const usage = await loadDictionaryUsage(api);

  assert.deepEqual(usage.tags.get('read'), { servers: ['PG'], tools: ['pg / query'] });
  assert.deepEqual(usage.tags.get('sentry'), { servers: [], tools: ['sentry / list_issues'] });
  assert.deepEqual(usage.tags.get('apm'), { servers: ['sentry'], tools: [] });
  assert.deepEqual(usage.categories.get('database'), {
    servers: ['PG'],
    tools: ['pg / query'],
  });
  assert.deepEqual(usage.categories.get('observability'), {
    servers: ['sentry'],
    tools: ['sentry / list_issues'],
  });
});
