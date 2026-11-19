/** Pure logic behind the management page: deep links, conflict mapping and form rules. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError } from '../src/lib/api.ts';
import {
  filterTools,
  isConflictError,
  isServerDraftDirty,
  manageHashForTab,
  parseTabParam,
  serverDraftSignature,
  serverStatusSummary,
  validateServerForm,
} from '../src/pages/manage.ts';
import { failureText } from '../src/pages/shared.ts';

const VALID_STDIO = {
  id: 'pg',
  label: 'PostgreSQL',
  transport: 'stdio' as const,
  command: 'npx',
  args: '-y\n@modelcontextprotocol/server-everything',
  cwd: '',
  url: '',
  envKeys: 'DATABASE_URL',
  headerKeys: '',
  timeoutMs: '60000',
  maxConcurrency: '8',
};

function fieldsOf(errors: ReadonlyArray<{ field: string }>): string[] {
  return errors.map((entry) => entry.field);
}

test('parseTabParam accepts every section id and defaults to servers', () => {
  for (const id of ['servers', 'tools', 'clients', 'secrets', 'alerts', 'ai', 'config', 'discover']) {
    assert.equal(parseTabParam(id), id);
  }
  assert.equal(parseTabParam(' servers '), 'servers');
  assert.equal(parseTabParam(null), 'servers');
  assert.equal(parseTabParam(undefined), 'servers');
  assert.equal(parseTabParam(''), 'servers');
  assert.equal(parseTabParam('bogus'), 'servers');
});

test('manageHashForTab keeps the default tab clean and syncs the rest', () => {
  assert.equal(manageHashForTab('servers'), '#/manage');
  assert.equal(manageHashForTab('tools'), '#/manage?tab=tools');
  assert.equal(manageHashForTab('ai'), '#/manage?tab=ai');
});

test('isConflictError recognises 409 and *_CONFLICT codes', () => {
  assert.equal(isConflictError(new ApiError(409, 'REVISION_CONFLICT', 'stale')), true);
  assert.equal(isConflictError(new ApiError(409, 'SOMETHING_ELSE', 'stale')), true);
  assert.equal(isConflictError(new ApiError(500, 'CONFLICT', 'boom')), true);
  assert.equal(isConflictError(new ApiError(422, 'CATALOG_CONFLICT', 'boom')), true);
  assert.equal(isConflictError(new ApiError(409, 'SERVER_EXISTS', 'dup')), false);
  assert.equal(isConflictError(new ApiError(409, 'SERVER_BUSY', 'busy')), false);
  assert.equal(isConflictError(new ApiError(400, 'INVALID_CONFIG', 'bad')), false);
  assert.equal(isConflictError(new Error('offline')), false);
  assert.equal(isConflictError(null), false);
});

test('failureText appends the shared next-step hint', () => {
  const capacity = failureText(new ApiError(429, 'CAPACITY_EXCEEDED', 'too many'));
  assert.ok(capacity.includes('too many'));
  assert.ok(capacity.includes('并发容量已满'));

  const conflict = failureText(new ApiError(409, 'REVISION_CONFLICT', 'stale'));
  assert.ok(conflict.includes('配置已在别处修改'));

  const unknown = failureText(new ApiError(500, 'UNKNOWN_CODE', 'boom'));
  assert.ok(unknown.includes('boom'));
  assert.ok(unknown.includes('请查看详情后重试'));

  assert.equal(failureText(new Error('network down')), 'network down');
});

test('serverDraftSignature ignores revision and mode but tracks editable values', () => {
  const draft = {
    mode: 'edit' as const,
    revision: 3,
    id: 'pg',
    label: 'PostgreSQL',
    transport: 'stdio' as const,
    command: 'npx',
    args: '-y',
    cwd: '',
    url: '',
    envKeys: 'DATABASE_URL',
    headerKeys: '',
    enabled: true,
    connectMode: 'lazy' as const,
    summary: '',
    category: '',
    tags: '',
    timeoutMs: '60000',
    maxConcurrency: '8',
  };
  const baseline = serverDraftSignature(draft);
  assert.equal(isServerDraftDirty(draft, baseline), false);
  assert.equal(isServerDraftDirty({ ...draft, revision: 99, mode: 'create' }, baseline), false);
  assert.equal(isServerDraftDirty({ ...draft, args: '-y\n--flag' }, baseline), true);
  assert.equal(isServerDraftDirty({ ...draft, enabled: false }, baseline), true);
  assert.equal(isServerDraftDirty(draft, null), false);
});

test('validateServerForm accepts a valid stdio draft', () => {
  assert.deepEqual(validateServerForm(VALID_STDIO, { mode: 'create', builtin: false }), []);
  assert.deepEqual(
    validateServerForm(
      { ...VALID_STDIO, id: 'pg' },
      { mode: 'edit', builtin: false },
    ),
    [],
  );
});

test('validateServerForm reports fields in editor order and focuses the first one', () => {
  const errors = validateServerForm(
    {
      ...VALID_STDIO,
      id: '',
      command: '',
      envKeys: '1BAD',
      headerKeys: 'bad header',
      timeoutMs: 'abc',
      maxConcurrency: '0',
    },
    { mode: 'create', builtin: false },
  );
  assert.deepEqual(fieldsOf(errors), ['id', 'command', 'envKeys', 'headerKeys', 'timeoutMs', 'maxConcurrency']);
  assert.match(errors[0]?.message ?? '', /id 不能为空/);
});

test('validateServerForm enforces id syntax, http urls and ranges', () => {
  assert.deepEqual(
    fieldsOf(
      validateServerForm(
        { ...VALID_STDIO, id: '__builtin__' },
        { mode: 'create', builtin: false },
      ),
    ),
    ['id'],
  );
  assert.deepEqual(
    fieldsOf(
      validateServerForm(
        { ...VALID_STDIO, id: 'bad id' },
        { mode: 'create', builtin: false },
      ),
    ),
    ['id'],
  );

  const httpBase = { ...VALID_STDIO, transport: 'http' as const, command: '' };
  assert.deepEqual(
    fieldsOf(validateServerForm({ ...httpBase, url: '' }, { mode: 'create', builtin: false })),
    ['url'],
  );
  assert.deepEqual(
    fieldsOf(
      validateServerForm({ ...httpBase, url: 'ftp://example.com' }, { mode: 'create', builtin: false }),
    ),
    ['url'],
  );
  assert.deepEqual(
    fieldsOf(
      validateServerForm(
        { ...httpBase, url: 'https://user:pw@example.com/mcp' },
        { mode: 'create', builtin: false },
      ),
    ),
    ['url'],
  );
  assert.deepEqual(
    validateServerForm(
      { ...httpBase, url: 'https://example.com/mcp' },
      { mode: 'create', builtin: false },
    ),
    [],
  );

  assert.deepEqual(
    fieldsOf(
      validateServerForm(
        { ...VALID_STDIO, cwd: 'relative/path' },
        { mode: 'create', builtin: false },
      ),
    ),
    ['cwd'],
  );
  assert.deepEqual(
    fieldsOf(
      validateServerForm(
        { ...VALID_STDIO, timeoutMs: '999', maxConcurrency: '65' },
        { mode: 'create', builtin: false },
      ),
    ),
    ['timeoutMs', 'maxConcurrency'],
  );
});

test('validateServerForm skips transport rules for builtin servers', () => {
  const errors = validateServerForm(
    { ...VALID_STDIO, id: '', command: '', envKeys: '1BAD' },
    { mode: 'edit', builtin: true },
  );
  assert.deepEqual(errors, []);
});

test('filterTools matches name, display name, description, tags and category', () => {
  const tools = [
    {
      serverId: 'pg',
      name: 'query',
      displayName: 'SQL 查询',
      description: 'Read-only SQL',
      descriptionOverride: null,
      enabled: true,
      concurrency: 'parallel',
      type: 'query',
      tags: ['db', 'read'],
      category: 'database',
      stale: false,
      staleOverride: false,
    },
    {
      serverId: 'pg',
      name: 'write',
      displayName: null,
      description: null,
      descriptionOverride: null,
      enabled: true,
      concurrency: 'serial',
      type: null,
      tags: [],
      category: null,
      stale: false,
      staleOverride: false,
    },
  ];

  assert.deepEqual(
    filterTools(tools, '').map((tool) => tool.name),
    ['query', 'write'],
  );
  assert.deepEqual(
    filterTools(tools, 'SQL').map((tool) => tool.name),
    ['query'],
  );
  assert.deepEqual(
    filterTools(tools, 'read').map((tool) => tool.name),
    ['query'],
  );
  assert.deepEqual(
    filterTools(tools, 'database').map((tool) => tool.name),
    ['query'],
  );
  assert.deepEqual(
    filterTools(tools, 'write').map((tool) => tool.name),
    ['write'],
  );
  assert.deepEqual(filterTools(tools, 'missing'), []);
});

test('serverStatusSummary exposes diagnostics only when fields exist', () => {
  const failed = serverStatusSummary({
    state: 'failed',
    lastError: 'spawn ENOENT',
    lastConnectedAt: '2026-11-19T10:00:00.000Z',
  });
  assert.equal(failed.label, '连接失败');
  assert.equal(failed.tone, 'error');
  assert.equal(failed.detail, 'state=failed');
  assert.ok(failed.lines.some((line) => line.includes('lastError：spawn ENOENT')));
  assert.ok(failed.lines.some((line) => line.startsWith('上次连接：')));
  assert.ok(failed.lines.some((line) => line.startsWith('建议：')));

  const ready = serverStatusSummary({ state: 'ready' });
  assert.equal(ready.label, '连接就绪');
  assert.equal(ready.tone, 'ok');
  assert.deepEqual(ready.lines, []);

  const unknown = serverStatusSummary({ state: '' });
  assert.equal(unknown.label, '状态未知');
  assert.equal(unknown.detail, 'state=unknown');
});
