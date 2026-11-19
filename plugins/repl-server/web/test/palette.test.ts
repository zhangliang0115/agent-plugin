/** Command-palette filtering over static pages and servers. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterPaletteItems,
  PALETTE_PAGES,
  serverItem,
} from '../src/lib/command-palette.ts';

const server = serverItem({ id: 'hexhub', label: 'HexHub' });
const items = [...PALETTE_PAGES, server];

test('filterPaletteItems matches labels, hints and kind', () => {
  assert.deepEqual(filterPaletteItems(items, '标签').map((item) => item.label), ['标签']);
  assert.deepEqual(filterPaletteItems(items, '系统管理').map((item) => item.label), [
    '服务端',
    '工具',
    '客户端',
    '密钥',
    '标签',
    '分类',
    '告警',
    'AI 配置',
    '导入导出',
    '发现',
  ]);
  assert.deepEqual(filterPaletteItems(items, 'server').map((item) => item.kind), ['Server']);
});

test('filterPaletteItems returns everything for an empty query', () => {
  assert.equal(filterPaletteItems(items, '   ').length, items.length);
  assert.deepEqual(filterPaletteItems(items, '不存在'), []);
});

test('manage items carry their tab', () => {
  const tags = PALETTE_PAGES.find((item) => item.label === '标签');
  assert.equal(tags?.path, '/manage');
  assert.equal(tags?.tab, 'tags');
});
