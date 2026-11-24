/** Admin API for the P3 script-candidate review queue (design 10 §9.3, §10). @module */

import {
  adminHandler,
  AdminApiError,
  expectInteger,
  expectString,
  expectStringArray,
  isPlainObject,
  queryValue,
  readJsonBody,
  rejectUnknownFields,
  requestSegments,
  type AdminHandler,
  type AdminRequest,
  type AdminResponse,
} from './servers.ts';
import {
  CANDIDATE_SCAN_DEFAULT,
  CANDIDATE_SCAN_MAX,
  type AcceptCandidateInput,
  type ScriptCandidatesService,
} from '../scripts/candidates.ts';
import {
  SCRIPT_CODE_MAX_BYTES,
  scriptErrorStatus,
  ScriptError,
} from '../scripts/service.ts';
import type { ScriptCandidateStatus } from '../db/script-candidates.ts';

export interface AdminScriptCandidatesOptions {
  candidates: ScriptCandidatesService;
}

const STATUSES = new Set<ScriptCandidateStatus>(['pending', 'accepted', 'rejected']);
const ACCEPT_FIELDS = new Set(['name', 'description', 'tags', 'code', 'inputSchema', 'exampleArgs']);
const SCAN_FIELDS = new Set(['limit']);

interface CandidateCursor {
  v: 1;
  createdAt: string;
  candidateId: string;
}

function encodeCursor(cursor: CandidateCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64');
}

function decodeCursor(raw: string | null): CandidateCursor | null {
  if (raw === null || raw === '') return null;
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is not valid base64 JSON');
  }
  if (!isPlainObject(value) || value['v'] !== 1) {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is not a candidate cursor');
  }
  if (typeof value['createdAt'] !== 'string' || typeof value['candidateId'] !== 'string') {
    throw new AdminApiError(400, 'INVALID_CURSOR', 'cursor is missing createdAt/candidateId');
  }
  return { v: 1, createdAt: value['createdAt'], candidateId: value['candidateId'] };
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

function statusOf(raw: string | null): ScriptCandidateStatus | undefined {
  if (raw === null || raw === '') return undefined;
  if (!STATUSES.has(raw as ScriptCandidateStatus)) {
    throw new AdminApiError(
      400,
      'INVALID_FIELD',
      'status must be pending, accepted or rejected',
      { field: 'status' },
    );
  }
  return raw as ScriptCandidateStatus;
}

/** POST bodies are optional here; an absent body means "use defaults". */
function optionalObjectBody(request: AdminRequest): Record<string, unknown> {
  const body = readJsonBody(request);
  if (body === undefined || body === null) return {};
  if (!isPlainObject(body)) {
    throw new AdminApiError(400, 'INVALID_BODY', 'request body must be a JSON object');
  }
  return body;
}

function acceptBody(request: AdminRequest): AcceptCandidateInput {
  const body = optionalObjectBody(request);
  rejectUnknownFields(body, ACCEPT_FIELDS);
  const input: AcceptCandidateInput = {};
  if (body['name'] !== undefined) {
    input.name = expectString(body['name'], 'name', { max: 120 });
  }
  if (body['description'] !== undefined) {
    input.description = expectString(body['description'], 'description', { max: 2000 });
  }
  if (body['tags'] !== undefined) {
    input.tags = expectStringArray(body['tags'], 'tags', { maxItems: 10, maxLength: 64 });
  }
  if (body['code'] !== undefined) {
    input.code = expectString(body['code'], 'code', { max: SCRIPT_CODE_MAX_BYTES });
  }
  if (body['inputSchema'] !== undefined) {
    if (!isPlainObject(body['inputSchema'])) {
      throw new AdminApiError(400, 'INVALID_FIELD', 'inputSchema must be an object', {
        field: 'inputSchema',
      });
    }
    input.inputSchema = body['inputSchema'];
  }
  if (body['exampleArgs'] !== undefined) {
    if (body['exampleArgs'] !== null && !isPlainObject(body['exampleArgs'])) {
      throw new AdminApiError(400, 'INVALID_FIELD', 'exampleArgs must be an object or null', {
        field: 'exampleArgs',
      });
    }
    input.exampleArgs = body['exampleArgs'] as Record<string, unknown> | null;
  }
  return input;
}

/** Library failures map through the same status table as the scripts routes. */
function withScriptErrors(run: () => AdminResponse): AdminResponse {
  try {
    return run();
  } catch (error) {
    if (error instanceof ScriptError) {
      throw new AdminApiError(scriptErrorStatus(error.code), error.code, error.message, error.details);
    }
    throw error;
  }
}

export function createAdminScriptCandidatesHandler(
  options: AdminScriptCandidatesOptions,
): AdminHandler {
  return adminHandler(async (request) => {
    const segments = requestSegments(request);
    if (segments[0] !== 'script-candidates') return null;
    const { candidates } = options;

    if (segments.length === 1) {
      if (request.method !== 'GET') {
        throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use GET /script-candidates');
      }
      return withScriptErrors(() => {
        const status = statusOf(queryValue(request, 'status'));
        const result = candidates.list({
          ...(status === undefined ? {} : { status }),
          limit: limitOf(request, 50, 200),
          cursor: decodeCursor(queryValue(request, 'cursor')),
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
                    createdAt: result.next.createdAt,
                    candidateId: result.next.candidateId,
                  }),
          },
        };
      });
    }

    if (segments.length === 2 && segments[1] === 'scan') {
      if (request.method !== 'POST') {
        throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', 'use POST /script-candidates/scan');
      }
      const body = optionalObjectBody(request);
      rejectUnknownFields(body, SCAN_FIELDS);
      const limit =
        body['limit'] === undefined
          ? CANDIDATE_SCAN_DEFAULT
          : expectInteger(body['limit'], 'limit', { min: 1, max: CANDIDATE_SCAN_MAX });
      return { status: 200, body: await candidates.scan({ limit }) };
    }

    if (segments.length !== 3) {
      throw new AdminApiError(404, 'NOT_FOUND', 'unknown script-candidates route');
    }
    const candidateId = segments[1] as string;
    const action = segments[2];

    if (action === 'accept' && request.method === 'POST') {
      const input = acceptBody(request);
      return withScriptErrors(() => ({ status: 200, body: candidates.accept(candidateId, input) }));
    }
    if (action === 'reject' && request.method === 'POST') {
      const body = optionalObjectBody(request);
      rejectUnknownFields(body, new Set());
      return withScriptErrors(() => ({ status: 200, body: { candidate: candidates.reject(candidateId) } }));
    }
    if (action === 'accept' || action === 'reject') {
      throw new AdminApiError(405, 'METHOD_NOT_ALLOWED', `use POST /script-candidates/:id/${action}`);
    }
    throw new AdminApiError(404, 'NOT_FOUND', 'unknown script-candidates route');
  });
}
