/** Admin API for the saved-script library (design 10 §9.3). @module */

import {
  adminHandler,
  AdminApiError,
  expectBoolean,
  expectString,
  expectStringArray,
  isPlainObject,
  queryValue,
  readJsonBody,
  requireObjectBody,
  requestSegments,
  rejectUnknownFields,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';
import {
  SCRIPT_CODE_MAX_BYTES,
  scriptErrorStatus,
  ScriptError,
  versionSecretWarnings,
  type ScriptService,
} from '../scripts/service.ts';
import type { ScriptRunRecord, ScriptStatus, ScriptVersionRecord, VersionMode } from '../db/scripts.ts';
import type { ExecutionGateway, RequestIdentity, ScriptRequest } from '../ports.ts';
import { secretWarningsOf, type SecretWarning } from '../scripts/security/secrets.ts';

export interface AdminScriptsOptions {
  scripts: ScriptService;
  /** Runs the admin test endpoint through the same eval path as `run_script`. */
  gateway: Pick<ExecutionGateway, 'runScript'>;
}

const STATUSES = new Set<ScriptStatus>(['draft', 'active', 'disabled', 'archived']);
const PATCH_FIELDS = new Set(['name', 'description', 'tags', 'status']);
const VERSION_FIELDS = new Set(['mode', 'runId', 'code', 'inputSchema', 'exampleArgs', 'changelog']);
const TEST_FIELDS = new Set(['version', 'args', 'activateOnSuccess']);

/** `script_runs` attribution for admin-triggered tests. */
const ADMIN_IDENTITY: RequestIdentity = {
  identity: 'bound',
  binding: 'admin',
  client: 'admin',
  mcp: 'admin',
};

/** The admin surface is always the owner/admin side of the minimal ACL. */
const ADMIN_ACTOR = { createdBy: 'admin', isAdmin: true } as const;

interface ScriptCursor {
  v: 1;
  updatedAt: string;
  scriptId: string;
}

interface RunCursor {
  v: 1;
  createdAt: string;
  runId: string;
}

function encodeCursor(value: ScriptCursor | RunCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodeCursor(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is not valid base64 JSON');
  }
}

function scriptCursor(raw: string | null): ScriptCursor | null {
  const value = decodeCursor(raw);
  if (value === null) return null;
  if (!isPlainObject(value) || value['v'] !== 1) {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is not a script cursor');
  }
  if (typeof value['updatedAt'] !== 'string' || typeof value['scriptId'] !== 'string') {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is missing updatedAt/scriptId');
  }
  return { v: 1, updatedAt: value['updatedAt'], scriptId: value['scriptId'] };
}

function runCursor(raw: string | null): RunCursor | null {
  const value = decodeCursor(raw);
  if (value === null) return null;
  if (!isPlainObject(value) || value['v'] !== 1) {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is not a run cursor');
  }
  if (typeof value['createdAt'] !== 'string' || typeof value['runId'] !== 'string') {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is missing createdAt/runId');
  }
  return { v: 1, createdAt: value['createdAt'], runId: value['runId'] };
}

function limitOf(request: AdminRequest, fallback: number, max: number): number {
  const raw = queryValue(request, 'limit');
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new AdminApiError(400, 'INVALID_QUERY', `limit must be an integer between 1 and ${max}`);
  }
  return value;
}

function versionNumber(raw: string, field = 'version'): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new AdminApiError(400, 'INVALID_FIELD', `${field} must be a positive integer`, {
      field,
    });
  }
  return value;
}

/** `baseVersion` is mandatory for a diff; it names the left-hand version. */
function requiredVersionQuery(request: AdminRequest, name: string): number {
  const raw = queryValue(request, name);
  if (raw === null || raw === '') {
    throw new AdminApiError(400, 'INVALID_QUERY', `${name} is required`);
  }
  return versionNumber(raw, name);
}

/** Version list entries omit the code body; the detail endpoint carries it. */
function versionSummary(version: ScriptVersionRecord): Omit<ScriptVersionRecord, 'code'> {
  const { code: _code, ...rest } = version;
  return rest;
}

/** Run rows keep `argsPreview` (already redacted) but never the plaintext args or code. */
function runSummary(run: ScriptRunRecord): Omit<ScriptRunRecord, 'args' | 'code'> {
  const { args: _args, code: _code, ...rest } = run;
  return rest;
}

function versionWarnings(version: ScriptVersionRecord): SecretWarning[] {
  return versionSecretWarnings(version.code, version.exampleArgs);
}

function statusOf(value: unknown): ScriptStatus {
  if (typeof value !== 'string' || !STATUSES.has(value as ScriptStatus)) {
    throw new AdminApiError(400, 'INVALID_FIELD', 'status must be draft, active, disabled or archived', {
      field: 'status',
    });
  }
  return value as ScriptStatus;
}

function versionBody(request: AdminRequest): {
  mode?: VersionMode;
  runId?: string;
  code?: string;
  inputSchema?: Record<string, unknown>;
  exampleArgs?: Record<string, unknown> | null;
  changelog?: string;
} {
  const body = requireObjectBody(request);
  rejectUnknownFields(body, VERSION_FIELDS);
  if (body['mode'] !== undefined && body['mode'] !== 'exact' && body['mode'] !== 'parameterized') {
    throw new AdminApiError(400, 'INVALID_FIELD', 'mode must be exact or parameterized', {
      field: 'mode',
    });
  }
  const out: {
    mode?: VersionMode;
    runId?: string;
    code?: string;
    inputSchema?: Record<string, unknown>;
    exampleArgs?: Record<string, unknown> | null;
    changelog?: string;
  } = {};
  if (body['mode'] !== undefined) out.mode = body['mode'] as VersionMode;
  if (body['runId'] !== undefined) {
    out.runId = expectString(body['runId'], 'runId', { max: 128 });
  }
  if (body['code'] !== undefined) {
    out.code = expectString(body['code'], 'code', { max: SCRIPT_CODE_MAX_BYTES });
  }
  if (body['inputSchema'] !== undefined) {
    if (!isPlainObject(body['inputSchema'])) {
      throw new AdminApiError(400, 'INVALID_FIELD', 'inputSchema must be an object', {
        field: 'inputSchema',
      });
    }
    out.inputSchema = body['inputSchema'];
  }
  if (body['exampleArgs'] !== undefined) {
    if (body['exampleArgs'] !== null && !isPlainObject(body['exampleArgs'])) {
      throw new AdminApiError(400, 'INVALID_FIELD', 'exampleArgs must be an object or null', {
        field: 'exampleArgs',
      });
    }
    out.exampleArgs = body['exampleArgs'] as Record<string, unknown> | null;
  }
  if (body['changelog'] !== undefined) {
    out.changelog = expectString(body['changelog'], 'changelog', { allowEmpty: true, max: 1000 });
  }
  return out;
}

function testBody(request: AdminRequest): {
  version?: number;
  args?: Record<string, unknown>;
  activateOnSuccess?: boolean;
} {
  const raw = readJsonBody(request);
  const body = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(body)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  rejectUnknownFields(body, TEST_FIELDS);
  const out: { version?: number; args?: Record<string, unknown>; activateOnSuccess?: boolean } = {};
  if (body['version'] !== undefined) {
    const value = body['version'];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
      throw new AdminApiError(400, 'INVALID_FIELD', 'version must be a positive integer', {
        field: 'version',
      });
    }
    out.version = value;
  }
  if (body['args'] !== undefined) {
    if (!isPlainObject(body['args'])) {
      throw new AdminApiError(400, 'INVALID_FIELD', 'args must be an object', { field: 'args' });
    }
    out.args = body['args'];
  }
  if (body['activateOnSuccess'] !== undefined) {
    out.activateOnSuccess = expectBoolean(body['activateOnSuccess'], 'activateOnSuccess');
  }
  return out;
}

/** Rethrows library failures as the admin error shape with the design's status mapping. */
function rethrowScriptError(error: unknown): never {
  if (error instanceof ScriptError) {
    throw new AdminApiError(scriptErrorStatus(error.code), error.code, error.message, error.details);
  }
  throw error;
}

function withScriptErrors(run: () => AdminResponse): AdminResponse {
  try {
    return run();
  } catch (error) {
    rethrowScriptError(error);
  }
}

async function withScriptErrorsAsync(run: () => Promise<AdminResponse>): Promise<AdminResponse> {
  try {
    return await run();
  } catch (error) {
    rethrowScriptError(error);
  }
}

export function createAdminScriptsHandler(options: AdminScriptsOptions): AdminHandler {
  return adminHandler(async (request) => {
    const segments = requestSegments(request);
    if (segments[0] !== 'scripts') return null;
    const { scripts } = options;

    if (segments.length === 1) {
      if (request.method === 'GET') {
        return withScriptErrors(() => {
          const rawStatus = queryValue(request, 'status');
          const result = scripts.list({
            ...(rawStatus === null || rawStatus === '' ? {} : { status: statusOf(rawStatus) }),
            ...(queryValue(request, 'q') === null ? {} : { query: queryValue(request, 'q') as string }),
            limit: limitOf(request, 50, 200),
            cursor: scriptCursor(queryValue(request, 'cursor')),
          });
          return {
            status: 200,
            body: {
              items: result.items,
              nextCursor:
                result.next === null
                  ? null
                  : encodeCursor({
                      v: 1,
                      updatedAt: result.next.updatedAt,
                      scriptId: result.next.scriptId,
                    }),
            },
          };
        });
      }
      throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use GET /scripts');
    }

    const scriptId = segments[1] as string;

    if (segments.length === 2) {
      if (request.method === 'GET') {
        const script = withScriptErrors(() => {
          const found = scripts.getWithStats(scriptId);
          if (found === null) {
            throw new ScriptError('SCRIPT_NOT_FOUND', `script ${scriptId} was not found`);
          }
          return { status: 200, body: { script: found } };
        });
        return script;
      }
      if (request.method === 'PATCH') {
        const body = requireObjectBody(request);
        rejectUnknownFields(body, PATCH_FIELDS);
        if (Object.keys(body).length === 0) {
          throw new AdminApiError(400, 'INVALID_BODY', 'at least one field is required');
        }
        return withScriptErrors(() => {
          const patch: {
            name?: string;
            description?: string;
            tags?: string[];
            status?: ScriptStatus;
          } = {};
          if (body['name'] !== undefined) {
            patch.name = expectString(body['name'], 'name', { max: 120 });
          }
          if (body['description'] !== undefined) {
            patch.description = expectString(body['description'], 'description', { max: 2000 });
          }
          if (body['tags'] !== undefined) {
            patch.tags = expectStringArray(body['tags'], 'tags', { maxItems: 10, maxLength: 64 });
          }
          if (body['status'] !== undefined) {
            patch.status = statusOf(body['status']);
            if (patch.status === 'active') {
              const current = scripts.get(scriptId);
              if (current === null || current.activeVersion === null) {
                throw new AdminApiError(
                  422,
                  'INVALID_FIELD',
                  'cannot mark a script active without an active version',
                  { field: 'status' },
                );
              }
            }
          }
          return { status: 200, body: { script: scripts.patch(scriptId, patch) } };
        });
      }
      throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use GET or PATCH /scripts/:id');
    }

    if (segments[2] === 'versions') {
      if (segments.length === 3) {
        if (request.method === 'GET') {
          return withScriptErrors(() => ({
            status: 200,
            body: { items: scripts.versions(scriptId).map(versionSummary) },
          }));
        }
        if (request.method === 'POST') {
          const body = versionBody(request);
          return withScriptErrors(() => {
            const version = scripts.createVersion(scriptId, body);
            return {
              status: 201,
              body: { version, warnings: versionWarnings(version) },
            };
          });
        }
        throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use GET or POST /scripts/:id/versions');
      }

      const version = versionNumber(segments[3] as string);
      if (segments.length === 4) {
        if (request.method !== 'GET') {
          throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use GET /scripts/:id/versions/:version');
        }
        return withScriptErrors(() => {
          const found = scripts.version(scriptId, version);
          return { status: 200, body: { version: found, warnings: versionWarnings(found) } };
        });
      }
      if (segments.length === 5 && segments[4] === 'diff' && request.method === 'GET') {
        return withScriptErrors(() => {
          const baseVersion = requiredVersionQuery(request, 'baseVersion');
          return { status: 200, body: scripts.diff(scriptId, version, baseVersion) };
        });
      }
      if (segments.length === 5 && segments[4] === 'activate' && request.method === 'POST') {
        return withScriptErrors(() => {
          const activated = scripts.activateVersion(scriptId, version);
          const script = scripts.get(scriptId);
          return { status: 200, body: { script, version: activated } };
        });
      }
      throw new AdminApiError(404, 'NOT_FOUND', 'unknown scripts route');
    }

    if (segments[2] === 'test' && segments.length === 3) {
      if (request.method !== 'POST') {
        throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use POST /scripts/:id/test');
      }
      const body = testBody(request);
      return withScriptErrorsAsync(async () => {
        const resolved = scripts.resolveExecution(
          {
            scriptId,
            ...(body.version === undefined ? {} : { scriptVersion: body.version }),
            ...(body.args === undefined ? {} : { args: body.args }),
          },
          { purpose: 'test', actor: ADMIN_ACTOR },
        );
        if (body.activateOnSuccess === true && resolved.version.status !== 'draft') {
          throw new ScriptError(
            'SCRIPT_VERSION_NOT_DRAFT',
            `script ${scriptId} version ${resolved.version.version} is not a draft`,
          );
        }
        const runRequest: ScriptRequest = {
          code: resolved.code,
          async: false,
          identity: ADMIN_IDENTITY,
          entryMode: 'script',
          actor: ADMIN_ACTOR,
          scriptId: resolved.script.scriptId,
          scriptVersion: resolved.version.version,
          scriptMode: resolved.version.mode,
          args: resolved.args,
          purpose: 'test',
          ...(body.activateOnSuccess === true ? { activateOnSuccess: true } : {}),
        };
        const outcome = await options.gateway.runScript(runRequest);
        // The archive row carries the measured duration and failure text; read it
        // back when available so the UI never has to parse `output` for them.
        const archived = outcome.runId === undefined ? null : scripts.getRun(outcome.runId);
        const version = scripts.version(scriptId, resolved.version.version);
        const activated =
          outcome.runId !== undefined
          && version.status === 'active'
          && version.verifiedRunId === outcome.runId;
        return {
          status: 200,
          body: {
            runId: outcome.runId ?? null,
            ok: !outcome.isError,
            durationMs: archived?.durationMs ?? null,
            output: outcome.content,
            error: archived?.error ?? null,
            activated,
            status: version.status,
            secretWarnings: secretWarningsOf('args', body.args),
          },
        };
      });
    }

    if (segments[2] === 'runs' && segments.length === 3 && request.method === 'GET') {
      return withScriptErrors(() => {
        const result = scripts.runs(scriptId, {
          limit: limitOf(request, 50, 200),
          cursor: runCursor(queryValue(request, 'cursor')),
        });
        return {
          status: 200,
          body: {
            items: result.items.map(runSummary),
            nextCursor:
              result.next === null
                ? null
                : encodeCursor({ v: 1, createdAt: result.next.createdAt, runId: result.next.runId }),
          },
        };
      });
    }

    throw new AdminApiError(404, 'NOT_FOUND', 'unknown scripts route');
  });
}
