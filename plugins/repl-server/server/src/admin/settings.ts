/** Admin API for runtime settings (`capacity`, `strictAuth`).
 *
 * Routes:
 * - `GET /settings` — normalized runtime settings plus the global `meta.revision`
 * - `PATCH /settings` — partial update, capacity relation check, revision bump
 *
 * `PATCH` requires `If-Match: <meta.revision>`; a mismatch is a 409 `REVISION_CONFLICT`.
 * Unknown top-level or capacity keys are 422 `UNKNOWN_SETTING` so a typo cannot silently
 * become a dead setting.
 * @module
 */

import {
  AdminApiError,
  adminHandler,
  adminJson,
  assertRevision,
  expectBoolean,
  invalidField,
  isPlainObject,
  parseIfMatch,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';

export const CAPACITY_KEYS = [
  'maxExecSessions',
  'maxExecSessionsPerBinding',
  'maxWorkspacesPerMcpSession',
  'maxServeProcesses',
  'maxWorkers',
  'maxInFlightEvalsPerExecSession',
  'maxInFlightEvalsPerBinding',
  'maxInFlightCallsPerBindingPerServer',
  'maxQueuedCallsPerBindingPerServer',
  'evictIdleMs',
] as const;

export type CapacityKey = (typeof CAPACITY_KEYS)[number];
export type CapacitySettings = Record<CapacityKey, number>;

/** Frozen defaults from 03 §2.6. */
export const DEFAULT_CAPACITY: CapacitySettings = {
  maxExecSessions: 8,
  maxExecSessionsPerBinding: 4,
  maxWorkspacesPerMcpSession: 4,
  maxServeProcesses: 8,
  maxWorkers: 8,
  maxInFlightEvalsPerExecSession: 8,
  maxInFlightEvalsPerBinding: 16,
  maxInFlightCallsPerBindingPerServer: 4,
  maxQueuedCallsPerBindingPerServer: 32,
  evictIdleMs: 300_000,
};

export interface RuntimeSettings {
  capacity: CapacitySettings;
  strictAuth: boolean;
}

/** Normalized known settings plus any other stored keys, which PATCH preserves. */
export type SettingsView = RuntimeSettings & Record<string, unknown>;

/** Values as read from the `settings` key/value table; unknown keys are preserved. */
export type StoredSettings = Record<string, unknown>;

export interface SettingsStore {
  read(): Promise<{ settings: StoredSettings; revision: number }>;
  /** Replaces the whole settings snapshot and bumps `meta.revision` in one transaction. */
  replace(
    settings: StoredSettings,
    expectedRevision: number,
  ): Promise<{ settings: StoredSettings; revision: number }>;
}

export interface AdminSettingsDeps {
  settings: SettingsStore;
}

const MINIMUM: Record<CapacityKey, number> = {
  maxExecSessions: 1,
  maxExecSessionsPerBinding: 1,
  maxWorkspacesPerMcpSession: 1,
  maxServeProcesses: 1,
  maxWorkers: 1,
  maxInFlightEvalsPerExecSession: 1,
  maxInFlightEvalsPerBinding: 1,
  maxInFlightCallsPerBindingPerServer: 1,
  maxQueuedCallsPerBindingPerServer: 1,
  evictIdleMs: 0,
};

const MAXIMUM = 1_000_000;
const CAPACITY_KEY_SET: ReadonlySet<string> = new Set(CAPACITY_KEYS);
const SETTINGS_FIELDS: ReadonlySet<string> = new Set(['capacity', 'strictAuth']);

function defaultCapacity(): CapacitySettings {
  return { ...DEFAULT_CAPACITY };
}

function isCapacityValue(key: CapacityKey, value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= MINIMUM[key] &&
    value <= MAXIMUM
  );
}

/** Fills missing keys with defaults and drops invalid stored values. */
export function normalizeSettings(raw: StoredSettings): SettingsView {
  const capacity = defaultCapacity();
  const storedCapacity = raw['capacity'];
  if (isPlainObject(storedCapacity)) {
    for (const key of CAPACITY_KEYS) {
      const value = storedCapacity[key];
      if (isCapacityValue(key, value)) capacity[key] = value;
    }
  }
  return { ...raw, capacity, strictAuth: raw['strictAuth'] === true };
}

function readCapacityPatch(value: unknown): Partial<CapacitySettings> {
  if (!isPlainObject(value)) throw invalidField('capacity', 'must be an object');

  const patch: Partial<CapacitySettings> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!CAPACITY_KEY_SET.has(key)) {
      throw new AdminApiError(422, 'UNKNOWN_SETTING', `unknown capacity key ${key}`, {
        key: `capacity.${key}`,
      });
    }
    const capacityKey = key as CapacityKey;
    if (!isCapacityValue(capacityKey, entry)) {
      throw new AdminApiError(
        422,
        'INVALID_CAPACITY',
        `capacity.${key} must be an integer between ${MINIMUM[capacityKey]} and ${MAXIMUM}`,
        { key: `capacity.${key}`, value: entry },
      );
    }
    patch[capacityKey] = entry;
  }
  return patch;
}

function validateRelations(capacity: CapacitySettings): void {
  if (capacity.maxServeProcesses < capacity.maxExecSessions) {
    throw new AdminApiError(
      422,
      'INVALID_CAPACITY',
      'maxServeProcesses must be >= maxExecSessions',
      { constraint: 'maxServeProcesses >= maxExecSessions', capacity },
    );
  }
}

interface SettingsPatch {
  capacity?: Partial<CapacitySettings>;
  strictAuth?: boolean;
}

function parseSettingsPatch(body: Record<string, unknown>): SettingsPatch {
  for (const key of Object.keys(body)) {
    if (!SETTINGS_FIELDS.has(key)) {
      throw new AdminApiError(422, 'UNKNOWN_SETTING', `unknown setting ${key}`, { key });
    }
  }

  const patch: SettingsPatch = {};
  if ('capacity' in body) patch.capacity = readCapacityPatch(body['capacity']);
  if ('strictAuth' in body) {
    patch.strictAuth = expectBoolean(body['strictAuth'], 'strictAuth');
  }

  const emptyCapacity = patch.capacity !== undefined && Object.keys(patch.capacity).length === 0;
  if (Object.keys(patch).length === 0 || (emptyCapacity && patch.strictAuth === undefined)) {
    throw new AdminApiError(422, 'EMPTY_PATCH', 'patch does not change any setting');
  }
  return patch;
}

/** `GET /settings` and `PATCH /settings`. */
export function createAdminSettingsHandler(deps: AdminSettingsDeps): AdminHandler {
  async function getSettings(): Promise<AdminResponse> {
    const { settings, revision } = await deps.settings.read();
    return adminJson(200, { settings: normalizeSettings(settings), revision });
  }

  async function patchSettings(request: AdminRequest): Promise<AdminResponse> {
    const expected = parseIfMatch(request);
    // Validate the body before the precondition so malformed input always gets 400/422.
    const patch = parseSettingsPatch(requireObjectBody(request));
    const current = await deps.settings.read();
    assertRevision(current.revision, expected);

    const normalized = normalizeSettings(current.settings);
    const next: StoredSettings = {
      ...current.settings,
      capacity: { ...normalized.capacity, ...(patch.capacity ?? {}) },
      strictAuth: patch.strictAuth ?? normalized.strictAuth,
    };
    validateRelations(next['capacity'] as CapacitySettings);

    const { settings, revision } = await deps.settings.replace(next, expected);
    return adminJson(200, { settings: normalizeSettings(settings), revision });
  }

  return adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments.length !== 1 || segments[0] !== 'settings') return null;

    const method = request.method.toUpperCase();
    if (method === 'GET') return getSettings();
    if (method === 'PATCH') return patchSettings(request);
    return null;
  });
}
