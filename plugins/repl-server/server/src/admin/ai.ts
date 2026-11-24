/**
 * Admin routes for AI configuration, proposal drafting and annotation
 * (08 §5.2).
 *
 * - `GET/PUT /ai/config`
 * - `POST /ai/propose`, `POST /ai/propose/apply`
 * - `POST /ai/annotate/:serverId` (`mode=preview|apply`)
 * - `GET /ai/annotations/pending` (failed automatic applies)
 *
 * Authentication and CSRF are handled by the admin HTTP shell before dispatch;
 * this module only validates shape and translates `If-Match`.
 * @module
 */

import {
  adminHandler,
  adminJson,
  invalidField,
  parseIfMatch,
  requestSegments,
  requireObjectBody,
  type AdminHandler,
  type AdminResponse,
} from './servers.ts';
import type { AiService } from '../ai/service.ts';

export interface AdminAiDeps {
  ai: AiService;
}

function withRetryAfter(response: AdminResponse | null): AdminResponse | null {
  if (response === null || response.status !== 429) return response;
  return {
    ...response,
    headers: { ...(response.headers ?? {}), 'retry-after': '1' },
  };
}

export function createAdminAiHandler(deps: AdminAiDeps): AdminHandler {
  const ai = deps.ai;

  const handler = adminHandler(async (request): Promise<AdminResponse | null> => {
    const segments = requestSegments(request);
    if (segments[0] !== 'ai') return null;
    const method = request.method.toUpperCase();

    if (segments.length === 2) {
      const resource = segments[1];
      if (resource === 'config') {
        if (method === 'GET') return adminJson(200, await ai.getConfig());
        if (method === 'PUT') {
          const expected = parseIfMatch(request);
          const body = requireObjectBody(request);
          return adminJson(200, await ai.putConfig(body, expected));
        }
        return null;
      }
      if (resource === 'propose' && method === 'POST') {
        return adminJson(200, await ai.propose(requireObjectBody(request)));
      }
      return null;
    }

    if (segments.length === 3) {
      if (segments[1] === 'propose' && segments[2] === 'apply' && method === 'POST') {
        return adminJson(201, await ai.applyProposal(requireObjectBody(request)));
      }
      if (segments[1] === 'annotations' && segments[2] === 'pending' && method === 'GET') {
        return adminJson(200, await ai.pendingAnnotations());
      }
      if (segments[1] === 'annotate' && method === 'POST') {
        const serverId = segments[2];
        if (serverId === undefined) return null;
        const body = requireObjectBody(request);
        const mode = body['mode'];
        if (mode !== 'preview' && mode !== 'apply') {
          throw invalidField('mode', 'must be "preview" or "apply"');
        }
        if (mode === 'preview') {
          return adminJson(200, await ai.annotatePreview(serverId));
        }
        const expected = parseIfMatch(request);
        return adminJson(200, await ai.annotateApply(serverId, body['apply'], expected));
      }
      return null;
    }

    return null;
  });

  return async (request) => withRetryAfter(await handler(request));
}
