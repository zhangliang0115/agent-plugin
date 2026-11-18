/**
 * Admin endpoint for tool discovery (design 07 §3.1/§3.2).
 *
 * `POST /admin/api/servers/:id/tools/discover` is both preview and apply:
 * `preview=true` (default) calls the upstream search tool and stores a
 * snapshot; `preview=false` requires the snapshot id and `If-Match`, then
 * writes it. Keeping one path means the CSRF/Cookie/If-Match rules live in one
 * place.
 *
 * @module
 */

import {
  adminHandler,
  adminJson,
  expectBoolean,
  invalidField,
  isPlainObject,
  parseIfMatch,
  rejectUnknownFields,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from '../admin/servers.ts';
import type { DiscoverRequest, DiscoveryApplyRequest, DiscoveryService } from './service.ts';

export interface AdminDiscoveryDeps {
  service: DiscoveryService;
}

const DISCOVER_FIELDS: ReadonlySet<string> = new Set([
  'preview',
  'searchTool',
  'query',
  'args',
  'maxTools',
  'prepareOnCall',
  'timeoutMs',
  'cursor',
  'includeRaw',
  'discoveryId',
  'accept',
  'overwriteStatic',
  'staleOthers',
  'confirmPartialStale',
  'allowEmpty',
]);

const MAX_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 1_000;

function readOptionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  if (!Object.hasOwn(body, field)) return undefined;
  return expectBoolean(body[field], field);
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
  if (!Object.hasOwn(body, field)) return undefined;
  const value = body[field];
  if (typeof value !== 'string') throw invalidField(field, 'must be a string');
  return value;
}

function readAccept(body: Record<string, unknown>): string[] | undefined {
  if (!Object.hasOwn(body, 'accept')) return undefined;
  const value = body['accept'];
  if (!Array.isArray(value)) throw invalidField('accept', 'must be an array of tool names');
  if (value.length > 2_000) throw invalidField('accept', 'must have at most 2000 entries');
  const names: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || entry === '') {
      throw invalidField(`accept[${index}]`, 'must be a non-empty string');
    }
    if (entry.length > 256) {
      throw invalidField(`accept[${index}]`, 'must be at most 256 characters');
    }
    if (!seen.has(entry)) {
      seen.add(entry);
      names.push(entry);
    }
  }
  return names;
}

function readTimeout(body: Record<string, unknown>): number | undefined {
  if (!Object.hasOwn(body, 'timeoutMs')) return undefined;
  const value = body['timeoutMs'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw invalidField('timeoutMs', 'must be an integer');
  }
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw invalidField('timeoutMs', `must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

function readCursor(body: Record<string, unknown>): string | null | undefined {
  if (!Object.hasOwn(body, 'cursor')) return undefined;
  const value = body['cursor'];
  if (value === null) return null;
  if (typeof value !== 'string') throw invalidField('cursor', 'must be a string or null');
  if (value.length > 4096) throw invalidField('cursor', 'must be at most 4096 characters');
  return value;
}

function buildPreviewRequest(body: Record<string, unknown>): DiscoverRequest {
  const request: DiscoverRequest = {};
  if (Object.hasOwn(body, 'preview')) request.preview = expectBoolean(body['preview'], 'preview');
  const searchTool = readOptionalString(body, 'searchTool');
  if (searchTool !== undefined) request.searchTool = searchTool;
  const query = readOptionalString(body, 'query');
  if (query !== undefined) request.query = query;
  if (Object.hasOwn(body, 'args')) {
    if (!isPlainObject(body['args'])) {
      throw invalidField('args', 'must be a JSON object');
    }
    request.args = body['args'];
  }
  if (Object.hasOwn(body, 'maxTools')) {
    const maxTools = body['maxTools'];
    if (typeof maxTools !== 'number' || !Number.isSafeInteger(maxTools)) {
      throw invalidField('maxTools', 'must be an integer');
    }
    request.maxTools = maxTools;
  }
  if (Object.hasOwn(body, 'prepareOnCall')) {
    if (typeof body['prepareOnCall'] !== 'boolean') {
      throw invalidField('prepareOnCall', 'must be a boolean');
    }
    request.prepareOnCall = body['prepareOnCall'];
  }
  const timeoutMs = readTimeout(body);
  if (timeoutMs !== undefined) request.timeoutMs = timeoutMs;
  const cursor = readCursor(body);
  if (cursor !== undefined) request.cursor = cursor;
  const includeRaw = readOptionalBoolean(body, 'includeRaw');
  if (includeRaw !== undefined) request.includeRaw = includeRaw;
  const discoveryId = readOptionalString(body, 'discoveryId');
  if (discoveryId !== undefined) request.discoveryId = discoveryId;
  const accept = readAccept(body);
  if (accept !== undefined) request.accept = accept;
  const overwriteStatic = readOptionalBoolean(body, 'overwriteStatic');
  if (overwriteStatic !== undefined) request.overwriteStatic = overwriteStatic;
  const staleOthers = readOptionalBoolean(body, 'staleOthers');
  if (staleOthers !== undefined) request.staleOthers = staleOthers;
  const confirmPartialStale = readOptionalBoolean(body, 'confirmPartialStale');
  if (confirmPartialStale !== undefined) request.confirmPartialStale = confirmPartialStale;
  const allowEmpty = readOptionalBoolean(body, 'allowEmpty');
  if (allowEmpty !== undefined) request.allowEmpty = allowEmpty;
  return request;
}

function buildApplyRequest(
  body: Record<string, unknown>,
  expectedRevision: number,
): DiscoveryApplyRequest {
  const discoveryId = body['discoveryId'];
  if (typeof discoveryId !== 'string' || discoveryId === '') {
    throw invalidField('discoveryId', 'is required when preview=false');
  }
  if (discoveryId.length > 256) throw invalidField('discoveryId', 'must be at most 256 characters');

  const request: DiscoveryApplyRequest = { discoveryId, expectedRevision };
  const accept = readAccept(body);
  if (accept !== undefined) request.accept = accept;
  const overwriteStatic = readOptionalBoolean(body, 'overwriteStatic');
  if (overwriteStatic !== undefined) request.overwriteStatic = overwriteStatic;
  const staleOthers = readOptionalBoolean(body, 'staleOthers');
  if (staleOthers !== undefined) request.staleOthers = staleOthers;
  const confirmPartialStale = readOptionalBoolean(body, 'confirmPartialStale');
  if (confirmPartialStale !== undefined) request.confirmPartialStale = confirmPartialStale;
  const allowEmpty = readOptionalBoolean(body, 'allowEmpty');
  if (allowEmpty !== undefined) request.allowEmpty = allowEmpty;
  return request;
}

/** `POST /admin/api/servers/:id/tools/discover`. */
export function createAdminDiscoveryHandler(deps: AdminDiscoveryDeps): AdminHandler {
  return adminHandler(async (request: AdminRequest): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (request.method.toUpperCase() !== 'POST') return null;
    if (segments.length !== 4) return null;
    if (segments[0] !== 'servers' || segments[2] !== 'tools' || segments[3] !== 'discover') {
      return null;
    }
    const serverId = segments[1];
    if (serverId === undefined) return null;

    const body = requireObjectBody(request);
    rejectUnknownFields(body, DISCOVER_FIELDS);

    const preview = body['preview'] === undefined ? true : expectBoolean(body['preview'], 'preview');
    if (preview) {
      return adminJson(200, await deps.service.preview(serverId, buildPreviewRequest(body)));
    }

    const expectedRevision = parseIfMatch(request);
    const result = await deps.service.apply(serverId, buildApplyRequest(body, expectedRevision));
    return adminJson(200, result);
  });
}
