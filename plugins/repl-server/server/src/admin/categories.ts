/** Admin API for the category dictionary (`GET /categories`, `PUT /categories`).
 *
 * Categories stay string keys in `servers.category` / tool overrides; the dictionary only
 * supplies the Chinese and English labels the admin UI shows. It is stored under the
 * `categoryDictionary` key of the settings table so it travels with the rest of the config.
 * `PUT` is a full replacement guarded by `If-Match: <meta.revision>`.
 * @module
 */

import {
  AdminApiError,
  adminHandler,
  adminJson,
  assertRevision,
  parseIfMatch,
  requireObjectBody,
  requestSegments,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';
import type { SettingsStore, StoredSettings } from './settings.ts';

export interface CategoryDefinition {
  /** Key stored in `category`; lowercase ASCII slug. */
  key: string;
  zh: string;
  en: string;
}

export interface AdminCategoriesDeps {
  settings: SettingsStore;
}

const SETTING_KEY = 'categoryDictionary';
/** Settings-table key; exported for in-transaction dictionary appends. */
export const CATEGORY_SETTING_KEY = SETTING_KEY;
const MAX_CATEGORIES = 100;
const CATEGORY_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const LABEL_MAX_LENGTH = 40;

/** Shown until the administrator saves their own dictionary; an explicit `[]` clears it. */
export const DEFAULT_CATEGORY_DICTIONARY: readonly CategoryDefinition[] = Object.freeze([
  { key: 'database', zh: '数据库', en: 'Database' },
  { key: 'observability', zh: '可观测性', en: 'Observability' },
  { key: 'devtools', zh: '开发工具', en: 'Developer tools' },
  { key: 'ui-automation', zh: 'UI 自动化', en: 'UI automation' },
  { key: 'filesystem', zh: '文件系统', en: 'Filesystem' },
  { key: 'search', zh: '搜索', en: 'Search' },
  { key: 'messaging', zh: '消息', en: 'Messaging' },
  { key: 'cloud', zh: '云服务', en: 'Cloud' },
  { key: 'ai', zh: '人工智能', en: 'AI' },
  { key: 'other', zh: '其他', en: 'Other' },
]);

/** The 15-entry default from before categories and tags diverged. */
const LEGACY_DEFAULT_DICTIONARY: readonly CategoryDefinition[] = [
  { key: 'official', zh: '官方', en: 'Official' },
  { key: 'builtin', zh: '内置', en: 'Built-in' },
  { key: 'database', zh: '数据库', en: 'Database' },
  { key: 'filesystem', zh: '文件系统', en: 'Filesystem' },
  { key: 'search', zh: '搜索', en: 'Search' },
  { key: 'web', zh: '网页', en: 'Web' },
  { key: 'browser', zh: '浏览器', en: 'Browser' },
  { key: 'ai', zh: '人工智能', en: 'AI' },
  { key: 'dev', zh: '开发', en: 'Development' },
  { key: 'ops', zh: '运维', en: 'Operations' },
  { key: 'docs', zh: '文档', en: 'Docs' },
  { key: 'messaging', zh: '消息', en: 'Messaging' },
  { key: 'memory', zh: '记忆', en: 'Memory' },
  { key: 'security', zh: '安全', en: 'Security' },
  { key: 'testing', zh: '测试', en: 'Testing' },
];

function defaultCategories(): CategoryDefinition[] {
  return DEFAULT_CATEGORY_DICTIONARY.map((category) => ({ ...category }));
}

/** Requires the exact old default, same order and labels; any reorder or relabel is custom. */
function isLegacyDefault(categories: readonly CategoryDefinition[]): boolean {
  if (categories.length !== LEGACY_DEFAULT_DICTIONARY.length) return false;
  return categories.every((category, index) => {
    const expected = LEGACY_DEFAULT_DICTIONARY[index];
    return (
      expected !== undefined &&
      category.key === expected.key &&
      category.zh === expected.zh &&
      category.en === expected.en
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the stored dictionary; malformed entries are ignored, not fatal. */
export function readCategoryDictionary(settings: StoredSettings): CategoryDefinition[] {
  const raw = settings[SETTING_KEY];
  if (raw === undefined) return defaultCategories();
  if (!Array.isArray(raw)) return [];
  const categories: CategoryDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = typeof entry['key'] === 'string' ? entry['key'].trim() : '';
    const zh = typeof entry['zh'] === 'string' ? entry['zh'].trim() : '';
    const en = typeof entry['en'] === 'string' ? entry['en'].trim() : '';
    if (!CATEGORY_KEY_PATTERN.test(key) || zh === '' || en === '' || seen.has(key)) continue;
    seen.add(key);
    categories.push({ key, zh, en });
  }
  // Settings saved from the old 15-entry default are upgraded in place; anything
  // else (including `[]`) is the administrator's own dictionary and is kept.
  if (isLegacyDefault(categories)) return defaultCategories();
  return categories;
}

/** Validates a full replacement; rejects duplicates and out-of-range labels. */
export function parseCategoryDictionary(value: unknown): CategoryDefinition[] {
  if (!Array.isArray(value)) {
    throw new AdminApiError(422, 'INVALID_CATEGORIES', 'categories must be an array');
  }
  if (value.length > MAX_CATEGORIES) {
    throw new AdminApiError(
      422,
      'INVALID_CATEGORIES',
      `categories must contain at most ${MAX_CATEGORIES} entries`,
    );
  }
  const categories: CategoryDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new AdminApiError(422, 'INVALID_CATEGORIES', 'each category must be an object');
    }
    const key = typeof entry['key'] === 'string' ? entry['key'].trim() : '';
    const zh = typeof entry['zh'] === 'string' ? entry['zh'].trim() : '';
    const en = typeof entry['en'] === 'string' ? entry['en'].trim() : '';
    if (!CATEGORY_KEY_PATTERN.test(key)) {
      throw new AdminApiError(
        422,
        'INVALID_CATEGORIES',
        `invalid category key ${JSON.stringify(key)}; expected ${CATEGORY_KEY_PATTERN.source}`,
      );
    }
    if (zh === '' || en === '') {
      throw new AdminApiError(422, 'INVALID_CATEGORIES', `category ${key} requires both zh and en labels`);
    }
    if (zh.length > LABEL_MAX_LENGTH || en.length > LABEL_MAX_LENGTH) {
      throw new AdminApiError(
        422,
        'INVALID_CATEGORIES',
        `category ${key} labels exceed ${LABEL_MAX_LENGTH} characters`,
      );
    }
    if (seen.has(key)) {
      throw new AdminApiError(422, 'INVALID_CATEGORIES', `duplicate category key ${key}`);
    }
    seen.add(key);
    categories.push({ key, zh, en });
  }
  return categories;
}

/** Appends accepted suggestions; an existing key keeps its stored labels. */
export function appendCategoryDictionary(
  settings: StoredSettings,
  additions: readonly CategoryDefinition[],
): { categories: CategoryDefinition[]; added: CategoryDefinition[] } {
  const categories = readCategoryDictionary(settings);
  const seen = new Set(categories.map((category) => category.key));
  const added: CategoryDefinition[] = [];
  for (const entry of additions) {
    if (seen.has(entry.key)) continue;
    if (categories.length >= MAX_CATEGORIES) {
      throw new AdminApiError(
        422,
        'INVALID_CATEGORIES',
        `categories must contain at most ${MAX_CATEGORIES} entries`,
      );
    }
    seen.add(entry.key);
    categories.push({ ...entry });
    added.push({ ...entry });
  }
  return { categories, added };
}

/** `GET /categories` and `PUT /categories`. */
export function createAdminCategoriesHandler(deps: AdminCategoriesDeps): AdminHandler {
  return adminHandler(async (request: AdminRequest): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments.length !== 1 || segments[0] !== 'categories') return null;
    const method = request.method.toUpperCase();

    if (method === 'GET') {
      const { settings, revision } = await deps.settings.read();
      return adminJson(200, { categories: readCategoryDictionary(settings), revision });
    }

    if (method === 'PUT') {
      const expected = parseIfMatch(request);
      const categories = parseCategoryDictionary(requireObjectBody(request)['categories']);
      const current = await deps.settings.read();
      assertRevision(current.revision, expected);
      const next: StoredSettings = { ...current.settings, [SETTING_KEY]: categories };
      const { revision } = await deps.settings.replace(next, expected);
      return adminJson(200, { categories: readCategoryDictionary(next), revision });
    }

    return null;
  });
}
