/** Admin API for the tag dictionary (`GET /tags`, `PUT /tags`).
 *
 * Tags stay ASCII keys in `servers.tags_json` / `tools.tags_json`; the dictionary only
 * supplies the Chinese and English labels the admin UI shows. It is stored under the
 * `tagDictionary` key of the settings table so it travels with the rest of the config.
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
import { ACTION_TAG_KEYS } from '../catalog/tag-policy.ts';
import type { SettingsStore, StoredSettings } from './settings.ts';

export interface TagDefinition {
  /** Key stored in `tags_json`; lowercase ASCII slug. */
  key: string;
  zh: string;
  en: string;
}

export interface AdminTagsDeps {
  settings: SettingsStore;
}

const SETTING_KEY = 'tagDictionary';
/** Settings-table key; exported for in-transaction dictionary appends. */
export const TAG_SETTING_KEY = SETTING_KEY;
const MAX_TAGS = 200;
const TAG_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const LABEL_MAX_LENGTH = 40;

/** Shown until the administrator saves their own dictionary; an explicit `[]` clears it.
 *
 * Tags are multi-valued and never double as categories: they carry environment,
 * provenance, capability, common product and cross-cutting concern. `env.*` only
 * declares which environments a server touches; it is not an isolation boundary.
 */
export const DEFAULT_TAG_DICTIONARY: readonly TagDefinition[] = Object.freeze([
  { key: 'official', zh: '官方', en: 'Official' },
  { key: 'builtin', zh: '内置', en: 'Built-in' },
  { key: 'env.dev', zh: '开发环境', en: 'Development' },
  { key: 'env.test', zh: '测试环境', en: 'Testing' },
  { key: 'env.pre', zh: '预发环境', en: 'Staging' },
  { key: 'env.prod', zh: '生产环境', en: 'Production' },
  { key: 'cross-env', zh: '跨环境', en: 'Cross-environment' },
  { key: 'memory', zh: '记忆', en: 'Memory' },
  { key: 'docs', zh: '文档', en: 'Docs' },
  { key: 'testing', zh: '测试', en: 'Testing' },
  { key: 'security', zh: '安全', en: 'Security' },
  { key: 'mysql', zh: 'MySQL', en: 'MySQL' },
  { key: 'postgresql', zh: 'PostgreSQL', en: 'PostgreSQL' },
  { key: 'elasticsearch', zh: 'Elasticsearch', en: 'Elasticsearch' },
  { key: 'redis', zh: 'Redis', en: 'Redis' },
  { key: 'prometheus', zh: 'Prometheus', en: 'Prometheus' },
  { key: 'apm', zh: 'APM', en: 'APM' },
  { key: 'gitlab', zh: 'GitLab', en: 'GitLab' },
  { key: 'browser', zh: '浏览器', en: 'Browser' },
  { key: 'computer-use', zh: 'Computer Use', en: 'Computer Use' },
]);

/** Built-in tags: every shipped default key plus the `env.*` namespace. Never editable or removable. */
const LOCKED_TAG_KEYS: ReadonlySet<string> = new Set(DEFAULT_TAG_DICTIONARY.map((tag) => tag.key));

export function isLockedTagKey(key: string): boolean {
  return key.startsWith('env.') || LOCKED_TAG_KEYS.has(key);
}

/** The 15-entry default from before categories and tags diverged. */
const LEGACY_DEFAULT_DICTIONARY: readonly TagDefinition[] = [
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

function defaultTags(): TagDefinition[] {
  return DEFAULT_TAG_DICTIONARY.map((tag) => ({ ...tag }));
}

/** Requires the exact old default, same order and labels; any reorder or relabel is custom. */
function isLegacyDefault(tags: readonly TagDefinition[]): boolean {
  if (tags.length !== LEGACY_DEFAULT_DICTIONARY.length) return false;
  return tags.every((tag, index) => {
    const expected = LEGACY_DEFAULT_DICTIONARY[index];
    return (
      expected !== undefined &&
      tag.key === expected.key &&
      tag.zh === expected.zh &&
      tag.en === expected.en
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the stored dictionary; malformed entries are ignored, not fatal. */
export function readTagDictionary(settings: StoredSettings): TagDefinition[] {
  const raw = settings[SETTING_KEY];
  if (raw === undefined) return defaultTags();
  if (!Array.isArray(raw)) return [];
  const tags: TagDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = typeof entry['key'] === 'string' ? entry['key'].trim() : '';
    const zh = typeof entry['zh'] === 'string' ? entry['zh'].trim() : '';
    const en = typeof entry['en'] === 'string' ? entry['en'].trim() : '';
    if (!TAG_KEY_PATTERN.test(key) || zh === '' || en === '' || seen.has(key)) continue;
    // Action keys are never part of the tag vocabulary; drop stale rows left by
    // an older dictionary before the UI or AI sees them.
    if (ACTION_TAG_KEYS.has(key)) continue;
    seen.add(key);
    tags.push({ key, zh, en });
  }
  // Settings saved from the old 15-entry default are upgraded in place; anything
  // else (including `[]`) is the administrator's own dictionary and is kept.
  if (isLegacyDefault(tags)) return defaultTags();
  return tags;
}

/** Validates a full replacement; rejects duplicates and out-of-range labels. */
export function parseTagDictionary(value: unknown): TagDefinition[] {
  if (!Array.isArray(value)) {
    throw new AdminApiError(422, 'INVALID_TAGS', 'tags must be an array');
  }
  if (value.length > MAX_TAGS) {
    throw new AdminApiError(422, 'INVALID_TAGS', `tags must contain at most ${MAX_TAGS} entries`);
  }
  const tags: TagDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (!isRecord(entry)) {
      throw new AdminApiError(422, 'INVALID_TAGS', 'each tag must be an object');
    }
    const key = typeof entry['key'] === 'string' ? entry['key'].trim() : '';
    const zh = typeof entry['zh'] === 'string' ? entry['zh'].trim() : '';
    const en = typeof entry['en'] === 'string' ? entry['en'].trim() : '';
    if (!TAG_KEY_PATTERN.test(key)) {
      throw new AdminApiError(
        422,
        'INVALID_TAGS',
        `invalid tag key ${JSON.stringify(key)}; expected ${TAG_KEY_PATTERN.source}`,
      );
    }
    if (zh === '' || en === '') {
      throw new AdminApiError(422, 'INVALID_TAGS', `tag ${key} requires both zh and en labels`);
    }
    if (zh.length > LABEL_MAX_LENGTH || en.length > LABEL_MAX_LENGTH) {
      throw new AdminApiError(422, 'INVALID_TAGS', `tag ${key} labels exceed ${LABEL_MAX_LENGTH} characters`);
    }
    if (ACTION_TAG_KEYS.has(key)) {
      throw new AdminApiError(
        422,
        'INVALID_TAGS',
        `tag ${key} is an action key; actions are not tags`,
      );
    }
    if (seen.has(key)) {
      throw new AdminApiError(422, 'INVALID_TAGS', `duplicate tag key ${key}`);
    }
    seen.add(key);
    tags.push({ key, zh, en });
  }
  return tags;
}

/** Appends accepted suggestions; an existing key keeps its stored labels. */
export function appendTagDictionary(
  settings: StoredSettings,
  additions: readonly TagDefinition[],
): { tags: TagDefinition[]; added: TagDefinition[] } {
  const tags = readTagDictionary(settings);
  const seen = new Set(tags.map((tag) => tag.key));
  const added: TagDefinition[] = [];
  for (const entry of additions) {
    if (ACTION_TAG_KEYS.has(entry.key)) {
      throw new AdminApiError(
        422,
        'INVALID_TAGS',
        `tag ${entry.key} is an action key; actions are not tags`,
      );
    }
    if (seen.has(entry.key)) continue;
    if (tags.length >= MAX_TAGS) {
      throw new AdminApiError(
        422,
        'INVALID_TAGS',
        `tags must contain at most ${MAX_TAGS} entries`,
      );
    }
    seen.add(entry.key);
    tags.push({ ...entry });
    added.push({ ...entry });
  }
  return { tags, added };
}

/** `GET /tags` and `PUT /tags`. */
export function createAdminTagsHandler(deps: AdminTagsDeps): AdminHandler {
  return adminHandler(async (request: AdminRequest): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments.length !== 1 || segments[0] !== 'tags') return null;
    const method = request.method.toUpperCase();

    if (method === 'GET') {
      const { settings, revision } = await deps.settings.read();
      return adminJson(200, { tags: readTagDictionary(settings), revision });
    }

    if (method === 'PUT') {
      const expected = parseIfMatch(request);
      const tags = parseTagDictionary(requireObjectBody(request)['tags']);
      const current = await deps.settings.read();
      assertRevision(current.revision, expected);
      // System-managed keys that exist today must survive the full replacement
      // unchanged; otherwise a replace could silently drop provenance tags.
      for (const entry of readTagDictionary(current.settings)) {
        if (!isLockedTagKey(entry.key)) continue;
        const next = tags.find((tag) => tag.key === entry.key);
        if (next === undefined || next.zh !== entry.zh || next.en !== entry.en) {
          throw new AdminApiError(
            422,
            'INVALID_TAGS',
            `tag ${entry.key} is system-managed and cannot be edited or removed`,
          );
        }
      }
      const next: StoredSettings = { ...current.settings, [SETTING_KEY]: tags };
      const { revision } = await deps.settings.replace(next, expected);
      return adminJson(200, { tags: readTagDictionary(next), revision });
    }

    return null;
  });
}
