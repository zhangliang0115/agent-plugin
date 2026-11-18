/**
 * `ai` settings row: defaults, normalization, strict PUT validation and the
 * effective `claudeBin` resolution (08 §5.1, §6.1).
 *
 * Stored values are normalized per field so a hand-edited or corrupt row cannot
 * disable GET; PUT input is validated strictly and rejected with `INVALID_FIELD`.
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

import {
  AdminApiError,
  assertRevision,
  expectBoolean,
  expectInteger,
  invalidField,
  isPlainObject,
  rejectUnknownFields,
} from '../admin/servers.ts';
import { getRevision, getSetting, patchSettings } from '../db/meta.ts';
import { withTransaction } from '../db/migrate.ts';
import {
  AI_DEFAULT_TIMEOUT_MS,
  AI_TIMEOUT_MAX_MS,
  AI_TIMEOUT_MIN_MS,
} from './constants.ts';
import { MODEL_PATTERN } from './validate.ts';

export interface AiSettings {
  enabled: boolean;
  autoAnnotate: boolean;
  claudeBin: string | null;
  model: string | null;
  timeoutMs: number;
}

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabled: true,
  autoAnnotate: true,
  claudeBin: null,
  model: null,
  timeoutMs: AI_DEFAULT_TIMEOUT_MS,
};

export type ClaudeBinSource = 'settings' | 'env' | 'default';

export interface EffectiveAiSettings extends AiSettings {
  effectiveClaudeBin: string;
  claudeBinSource: ClaudeBinSource;
}

const AI_SETTINGS_FIELDS: ReadonlySet<string> = new Set([
  'enabled',
  'autoAnnotate',
  'claudeBin',
  'model',
  'timeoutMs',
]);
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isClaudeBin(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= 1 &&
    value.length <= 1024 &&
    !CONTROL_CHARS.test(value) &&
    (!value.includes('/') || isAbsolute(value))
  );
}

/** Fills missing or invalid stored fields with defaults; never throws. */
export function normalizeAiSettings(raw: unknown): AiSettings {
  const source = isPlainObject(raw) ? raw : {};
  return {
    enabled: typeof source['enabled'] === 'boolean' ? source['enabled'] : DEFAULT_AI_SETTINGS.enabled,
    autoAnnotate:
      typeof source['autoAnnotate'] === 'boolean'
        ? source['autoAnnotate']
        : DEFAULT_AI_SETTINGS.autoAnnotate,
    claudeBin: isClaudeBin(source['claudeBin']) ? source['claudeBin'] : null,
    model:
      typeof source['model'] === 'string' && MODEL_PATTERN.test(source['model'])
        ? source['model']
        : null,
    timeoutMs:
      typeof source['timeoutMs'] === 'number' &&
      Number.isSafeInteger(source['timeoutMs']) &&
      source['timeoutMs'] >= AI_TIMEOUT_MIN_MS &&
      source['timeoutMs'] <= AI_TIMEOUT_MAX_MS
        ? source['timeoutMs']
        : DEFAULT_AI_SETTINGS.timeoutMs,
  };
}

/**
 * Reads the `ai` row. A corrupt JSON value raises `DbValidationError` inside
 * `getSetting`, which must not turn `GET /ai/config` into a 500.
 */
export function getAiSettings(db: DatabaseSync): AiSettings {
  try {
    return normalizeAiSettings(getSetting(db, 'ai'));
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/** Resolves the binary: settings > REPL_AI_CLAUDE_BIN > `claude`. */
export function effectiveAiSettings(settings: AiSettings): EffectiveAiSettings {
  const fromEnv = process.env['REPL_AI_CLAUDE_BIN'];
  if (settings.claudeBin !== null) {
    return { ...settings, effectiveClaudeBin: settings.claudeBin, claudeBinSource: 'settings' };
  }
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return { ...settings, effectiveClaudeBin: fromEnv, claudeBinSource: 'env' };
  }
  return { ...settings, effectiveClaudeBin: 'claude', claudeBinSource: 'default' };
}

/**
 * Strict body validation for `PUT /ai/config`. All five fields are required;
 * unknown fields are rejected so a typo cannot become a dead setting.
 */
export function parseAiSettingsBody(body: unknown): AiSettings {
  if (!isPlainObject(body)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  rejectUnknownFields(body, new Set(['ai']));
  const ai = body['ai'];
  if (!isPlainObject(ai)) throw invalidField('ai', 'must be an object');
  rejectUnknownFields(ai, AI_SETTINGS_FIELDS);

  for (const field of AI_SETTINGS_FIELDS) {
    if (!(field in ai)) throw invalidField(field, 'is required');
  }

  const enabled = expectBoolean(ai['enabled'], 'enabled');
  const autoAnnotate = expectBoolean(ai['autoAnnotate'], 'autoAnnotate');

  const claudeBin = ai['claudeBin'];
  if (claudeBin !== null && !isClaudeBin(claudeBin)) {
    throw invalidField('claudeBin', 'must be null or a 1-1024 character path without control characters');
  }

  const model = ai['model'];
  if (model !== null && (typeof model !== 'string' || !MODEL_PATTERN.test(model))) {
    throw invalidField('model', 'must be null or match the model name pattern');
  }

  const timeoutMs = expectInteger(ai['timeoutMs'], 'timeoutMs', {
    min: AI_TIMEOUT_MIN_MS,
    max: AI_TIMEOUT_MAX_MS,
  });

  return {
    enabled,
    autoAnnotate,
    claudeBin: claudeBin === null ? null : claudeBin,
    model: model === null ? null : model,
    timeoutMs,
  };
}

/**
 * Replaces the `ai` row and bumps `meta.revision` once, in one transaction.
 * Uses `patchSettings` directly rather than `DbSettingsStore.replace`: the AI
 * config owns exactly one top-level row.
 */
export function putAiSettings(
  db: DatabaseSync,
  input: AiSettings,
  expectedRevision: number,
): { ai: AiSettings; revision: number } {
  return withTransaction(db, () => {
    assertRevision(getRevision(db), expectedRevision);
    // `patchSettings` bumps `meta.revision` inside its own savepoint.
    const result = patchSettings(db, { ai: input });
    return {
      ai: normalizeAiSettings(result.settings['ai']),
      revision: result.revision,
    };
  });
}
