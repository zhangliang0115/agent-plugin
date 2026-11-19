/** Annotate prompt: dictionary injection, suggestion contract and prompt version. */
import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_CATEGORY_DICTIONARY } from '../src/admin/categories.ts';
import { DEFAULT_TAG_DICTIONARY } from '../src/admin/tags.ts';
import { buildAnnotatePrompt, PROMPT_VERSION } from '../src/ai/prompts.ts';

test('annotate prompt carries both dictionaries and the suggestion rules', () => {
  const result = buildAnnotatePrompt(
    { id: 'pg' },
    [],
    { categories: DEFAULT_CATEGORY_DICTIONARY, tags: DEFAULT_TAG_DICTIONARY },
    'abcd1234',
  );

  assert.equal(PROMPT_VERSION, 5);
  assert.match(result.prompt, /database=数据库/);
  assert.match(result.prompt, /observability=可观测性/);
  assert.match(result.prompt, /env\.dev=开发环境/);
  assert.match(result.prompt, /tagSuggestions/);
  assert.match(result.prompt, /categorySuggestion/);
  assert.match(result.prompt, /禁止生成 env\.\*、cross-env、official、builtin/);
  assert.match(result.prompt, /分类 key 与标签 key 不能重名/);
  assert.match(result.prompt, /categorySuggestion 同样不能用 env\.\*、cross-env、official、builtin/);
  assert.match(result.prompt, /≤40 字符/);
});
