import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { JSON_RPC_INVALID_PARAMS, JSON_RPC_METHOD_NOT_FOUND } from '../src/mcp/errors.ts';
import { createMethodTable } from '../src/mcp/methods.ts';
import {
  SKILL_CACHE_SCOPE,
  SKILL_NAME,
  SKILL_TTL_MS,
  SKILL_URI,
  type Resource,
  type ResourcesListResult,
  type ResourcesReadResult,
  type Skill,
  type SkillResource,
  type SkillsGetResult,
  type SkillsListResult,
} from '../src/mcp/skills.ts';

const SKILL_DIR = fileURLToPath(new URL('../../skills/zl-repl-server/', import.meta.url));

/** Independent scan used to verify the manifest covers every file on disk. */
function scanFiles(): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(relative(SKILL_DIR, full).split(sep).join('/'));
    }
  };
  visit(SKILL_DIR);
  return found.sort((a, b) => {
    if (a === 'SKILL.md') return -1;
    if (b === 'SKILL.md') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const response = await createMethodTable().handle({ jsonrpc: '2.0', id: 1, method, params });
  assert.ok(
    response !== null && 'result' in response,
    `${method} should succeed: ${JSON.stringify(response)}`,
  );
  return response.result;
}

async function callError(
  method: string,
  params: Record<string, unknown> = {},
): Promise<{ code: number; message: string }> {
  const response = await createMethodTable().handle({ jsonrpc: '2.0', id: 1, method, params });
  assert.ok(
    response !== null && 'error' in response,
    `${method} should fail: ${JSON.stringify(response)}`,
  );
  return response.error;
}

test('skills/list publishes SKILL.md and every non-hidden file on disk', async () => {
  const result = (await call('skills/list', { cursor: 'ignored' })) as SkillsListResult;

  assert.equal(SKILL_TTL_MS, 300_000);
  assert.equal(SKILL_CACHE_SCOPE, 'public');
  assert.equal(SKILL_NAME, 'zl-repl-server');
  assert.equal(SKILL_URI, 'skill://zl-repl-server/SKILL.md');
  assert.equal(result.resultType, 'complete');
  assert.equal(result.ttlMs, SKILL_TTL_MS);
  assert.equal(result.cacheScope, SKILL_CACHE_SCOPE);
  assert.equal(result.skills.length, 1);

  const skill = result.skills[0];
  if (skill === undefined) assert.fail('expected one skill');
  assert.equal(skill.uri, SKILL_URI);

  const files = scanFiles();
  assert.equal(skill.resources.length, files.length);
  assert.deepEqual(
    skill.resources.map((resource) => resource.uri),
    files.map((file) => `skill://${SKILL_NAME}/${file}`),
  );

  for (const [index, file] of files.entries()) {
    const bytes = readFileSync(join(SKILL_DIR, file));
    const resource: SkillResource | undefined = skill.resources[index];
    if (resource === undefined) assert.fail(`missing manifest entry for ${file}`);
    assert.equal(resource.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`);
    assert.match(resource.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(resource.size, bytes.length);
  }

  const source = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
  const argumentHint = /^argument-hint:\s*(.+)$/m
    .exec(source)?.[1]
    ?.replace(/^(['"])(.*)\1$/, '$2');
  assert.equal(skill.frontmatter['name'], SKILL_NAME);
  assert.ok((skill.frontmatter['description'] ?? '').length > 0);
  assert.equal(skill.frontmatter['argument-hint'], argumentHint);

  // Caching is process-wide: a second call returns the same catalog.
  const again = (await call('skills/list')) as SkillsListResult;
  assert.deepEqual(again.skills, result.skills);
});

test('skills/get returns the listed skill and rejects unknown, missing or non-string uris', async () => {
  const listed = (await call('skills/list')) as SkillsListResult;
  const result = (await call('skills/get', { uri: SKILL_URI })) as SkillsGetResult;

  assert.equal(result.resultType, 'complete');
  assert.equal(result.ttlMs, SKILL_TTL_MS);
  assert.equal(result.cacheScope, SKILL_CACHE_SCOPE);
  assert.deepEqual(result.skill, listed.skills[0]);

  const unknown = await callError('skills/get', { uri: 'skill://other/SKILL.md' });
  assert.equal(unknown.code, JSON_RPC_INVALID_PARAMS);
  assert.equal(unknown.message, 'No skill is served at skill://other/SKILL.md');

  for (const params of [{}, { uri: 42 }, { uri: '' }]) {
    const error = await callError('skills/get', params);
    assert.equal(error.code, JSON_RPC_INVALID_PARAMS);
    assert.equal(error.message, 'skills/get requires a non-empty uri string');
  }
});

test('resources/templates/list answers an empty list instead of Method not found', async () => {
  const result = await call('resources/templates/list');
  assert.deepEqual(result, {
    resultType: 'complete',
    resourceTemplates: [],
    ttlMs: SKILL_TTL_MS,
    cacheScope: SKILL_CACHE_SCOPE,
  });
});

test('resources/list exposes SKILL.md metadata and basenames for other files', async () => {
  const listed = (await call('skills/list')) as SkillsListResult;
  const result = (await call('resources/list')) as ResourcesListResult;
  const skill: Skill | undefined = listed.skills[0];
  if (skill === undefined) assert.fail('expected one skill');

  assert.equal(result.resultType, 'complete');
  assert.equal(result.ttlMs, SKILL_TTL_MS);
  assert.equal(result.cacheScope, SKILL_CACHE_SCOPE);
  assert.equal(result.resources.length, skill.resources.length);

  const first = result.resources[0];
  assert.deepEqual(first, {
    uri: SKILL_URI,
    name: skill.frontmatter['name'],
    description: skill.frontmatter['description'],
    mimeType: 'text/markdown',
  });

  const files = scanFiles();
  for (const [index, file] of files.entries()) {
    if (file === 'SKILL.md') continue;
    const resource: Resource | undefined = result.resources[index];
    if (resource === undefined) assert.fail(`missing resource for ${file}`);
    assert.equal(resource.uri, `skill://${SKILL_NAME}/${file}`);
    assert.equal(resource.name, basename(file));
    assert.equal(resource.description, undefined);
  }
});

test('resources/read returns SKILL.md text byte-for-byte', async () => {
  const result = (await call('resources/read', { uri: SKILL_URI })) as ResourcesReadResult;

  assert.equal(result.resultType, 'complete');
  assert.equal(result.ttlMs, SKILL_TTL_MS);
  assert.equal(result.cacheScope, SKILL_CACHE_SCOPE);
  assert.equal(result.contents.length, 1);

  const content = result.contents[0];
  if (content === undefined) assert.fail('expected one content entry');
  assert.equal(content.uri, SKILL_URI);
  assert.equal(content.mimeType, 'text/markdown');
  assert.equal(typeof content.text, 'string');
  assert.equal(content.blob, undefined);
  assert.deepEqual(Buffer.from(content.text ?? '', 'utf8'), readFileSync(join(SKILL_DIR, 'SKILL.md')));
});

test('unknown resources are -32602 and resources/directory/read stays -32601', async () => {
  const missing = await callError('resources/read', { uri: 'skill://zl-repl-server/missing.md' });
  assert.equal(missing.code, JSON_RPC_INVALID_PARAMS);
  assert.match(missing.message, /^No resource is served at /);

  const noParam = await callError('resources/read');
  assert.equal(noParam.code, JSON_RPC_INVALID_PARAMS);
  assert.equal(noParam.message, 'resources/read requires a non-empty uri string');

  const directory = await callError('resources/directory/read', { uri: `skill://${SKILL_NAME}` });
  assert.equal(directory.code, JSON_RPC_METHOD_NOT_FOUND);
  assert.equal(directory.message, 'Method not found: resources/directory/read');
});
