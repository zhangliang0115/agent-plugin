/** Annotate prompt: dictionary injection, suggestion contract and prompt version. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CATEGORY_DICTIONARY } from '../src/admin/categories.ts';
import { DEFAULT_TAG_DICTIONARY } from '../src/admin/tags.ts';
import {
  buildAnnotatePrompt,
  buildProposePrompt,
  PROMPT_VERSION,
  truncateDescription,
} from '../src/ai/prompts.ts';

test('propose prompt injects both dictionaries and forbids invented keys', () => {
  const prompt = buildProposePrompt(
    '配一个向量数据库 mcp',
    {
      categories: [{ key: 'vector-db', zh: '向量数据库' }],
      tags: [
        { key: 'embedding', zh: '嵌入' },
        { key: 'read', zh: '只读' },
      ],
    },
    'abcd1234',
  );

  assert.equal(PROMPT_VERSION, 10);
  assert.ok(prompt.includes('分类字典（category 只能从这里选；都不合适时用 other）：\nvector-db=向量数据库'));
  assert.ok(prompt.includes('标签字典（tags 只能从这里选；没有合适的就留空）：\nembedding=嵌入, read=只读'));
  assert.match(prompt, /category 必须从下面的分类字典 key 中选一个/);
  assert.match(prompt, /tags 只能从下面的标签字典 key 中选/);
  assert.match(prompt, /不要编造新 key/);
  assert.match(prompt, /都不合适时用 "other"/);
  assert.match(prompt, /connectMode 默认 "eager"/);
  assert.ok(prompt.includes('{"$secret":"KEY_NAME"}'));
});

test('annotate prompt carries both dictionaries and the suggestion rules', () => {
  const result = buildAnnotatePrompt(
    { id: 'pg' },
    [],
    { categories: DEFAULT_CATEGORY_DICTIONARY, tags: DEFAULT_TAG_DICTIONARY },
    'abcd1234',
  );

  assert.equal(PROMPT_VERSION, 10);
  assert.match(result.prompt, /database=数据库/);
  assert.match(result.prompt, /observability=可观测性/);
  assert.match(result.prompt, /env\.dev=开发环境/);
  assert.match(result.prompt, /tagSuggestions/);
  assert.match(result.prompt, /categorySuggestion/);
  assert.match(result.prompt, /禁止生成 env\.\*、cross-env、official、builtin/);
  assert.match(result.prompt, /分类 key 与标签 key 不能重名/);
  assert.match(result.prompt, /categorySuggestion 同样不能用 env\.\*、cross-env、official、builtin/);
  assert.match(result.prompt, /≤40 字符/);
  assert.match(result.prompt, /zh 用中文名称/);
  assert.match(result.prompt, /不要生成工具描述/);
  assert.match(result.prompt, /"toolOverrides": \[\n    \{"name": "query", "tags"/);
  assert.doesNotMatch(result.prompt, /"description": "Run a read-only/);
});

test('description truncation keeps 400 characters and never splits a surrogate pair', () => {
  assert.equal(truncateDescription(null), null);
  const ascii = 'a'.repeat(400);
  assert.equal(truncateDescription(ascii), ascii);

  const longAscii = truncateDescription('a'.repeat(401)) ?? '';
  assert.equal([...longAscii].length, 401);
  assert.ok(longAscii.endsWith('…'));

  const chinese = '中'.repeat(200);
  assert.equal(truncateDescription(chinese), chinese);

  const emoji = truncateDescription('😀'.repeat(401)) ?? '';
  assert.equal([...emoji].length, 401);
  assert.equal(
    Buffer.from(emoji, 'utf8').toString('utf8'),
    emoji,
    'a surrogate pair must not be cut in half',
  );
});
