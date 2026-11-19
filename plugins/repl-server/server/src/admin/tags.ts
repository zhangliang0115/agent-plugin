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
const MAX_TAGS = 200;
const TAG_KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const LABEL_MAX_LENGTH = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads the stored dictionary; malformed entries are ignored, not fatal. */
export function readTagDictionary(settings: StoredSettings): TagDefinition[] {
  const raw = settings[SETTING_KEY];
  if (!Array.isArray(raw)) return [];
  const tags: TagDefinition[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const key = typeof entry['key'] === 'string' ? entry['key'].trim() : '';
    const zh = typeof entry['zh'] === 'string' ? entry['zh'].trim() : '';
    const en = typeof entry['en'] === 'string' ? entry['en'].trim() : '';
    if (!TAG_KEY_PATTERN.test(key) || zh === '' || en === '' || seen.has(key)) continue;
    seen.add(key);
    tags.push({ key, zh, en });
  }
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
    if (seen.has(key)) {
      throw new AdminApiError(422, 'INVALID_TAGS', `duplicate tag key ${key}`);
    }
    seen.add(key);
    tags.push({ key, zh, en });
  }
  return tags;
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
      const next: StoredSettings = { ...current.settings, [SETTING_KEY]: tags };
      const { revision } = await deps.settings.replace(next, expected);
      return adminJson(200, { tags, revision });
    }

    return null;
  });
}
