import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { createLog, type LogFn } from './log.ts';
import { isAllowedHost } from './auth/tokens.ts';
import { resolveIdentity, toRequestIdentity, type IdentityConfig } from './auth/identity.ts';
import { parseClientInfo } from './client-info.ts';
import type { JsonRpcDispatcher } from './mcp/jsonrpc.ts';
import type { Catalog, ExecutionGateway, RequestIdentity } from './ports.ts';
import type { ReportService } from './reports/service.ts';
import type { TransportSessionRegistry } from './sessions/transport.ts';
import type { McpTaskStore } from './tasks/mcp-tasks.ts';
import { VERSION } from '@zhangliang0115/repl-server-core';

export interface McpContext {
  identity: RequestIdentity;
  gateway: ExecutionGateway;
  catalog: Catalog;
  tasks: McpTaskStore;
  tasksDeclared: boolean;
  transportId: string;
  /** JSON-RPC id of this request; `null` for notifications. Stamped into eval audits. */
  requestId: string | number | null;
  /** Present when the report pipeline is wired; `report_problem` needs it. */
  reports?: ReportService;
}

export interface AppOptions {
  identity: IdentityConfig;
  sessions: TransportSessionRegistry;
  gateway: ExecutionGateway;
  catalog: Catalog;
  tasks: McpTaskStore;
  dispatcher: JsonRpcDispatcher<McpContext>;
  /** Report service for the `report_problem` tool. */
  reports?: ReportService;
  /** Returns true when the admin layer wrote the response. */
  admin?: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>;
  /** Protocol-frame audit hooks (`summary`/`full` decided by the writer). */
  frames?: {
    recordIn(input: Record<string, unknown>): void;
    recordOut(input: Record<string, unknown>): void;
  };
  /**
   * Observes the identity resolved for a request on a transport session. The
   * admin client list uses it to show live binding/client per `Mcp-Session-Id`.
   */
  onSessionActivity?: (transportId: string, identity: RequestIdentity) => void;
  health?: () => Record<string, unknown>;
  log?: LogFn;
}

const MAX_BODY_BYTES = 1 << 20;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body) ?? 'null';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

class BodyTooLargeError extends Error {}

function methodOf(message: unknown): string | null {
  if (typeof message !== 'object' || message === null) return null;
  const method = (message as { method?: unknown }).method;
  return typeof method === 'string' ? method : null;
}

function declaredTasks(message: unknown): boolean {
  if (typeof message !== 'object' || message === null) return false;
  const params = (message as { params?: unknown }).params;
  if (typeof params !== 'object' || params === null) return false;
  const meta = (params as Record<string, unknown>)['_meta'];
  if (typeof meta !== 'object' || meta === null) return false;
  const caps = (meta as Record<string, unknown>)['io.modelcontextprotocol/clientCapabilities'];
  if (typeof caps !== 'object' || caps === null) return false;
  const extensions = (caps as Record<string, unknown>).extensions;
  if (typeof extensions !== 'object' || extensions === null) return false;
  return (
    (extensions as Record<string, unknown>)['io.modelcontextprotocol/tasks'] !== undefined
  );
}

/** Builds the HTTP surface: `/mcp` modern + legacy, `/admin` delegated, `/health`. */
export function createApp(options: AppOptions): Server {
  const log = options.log ?? createLog((line) => console.error(line));

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    try {
      // DNS-rebinding guard for the public surfaces; the admin layer applies
      // the same check on its own path (protocol.md §1).
      if ((url.pathname === '/health' || url.pathname === '/mcp') && !isAllowedHost(req.headers.host)) {
        sendJson(res, 403, {
          error: { code: 'FORBIDDEN_HOST', message: `host not allowed: ${req.headers.host ?? '<missing>'}` },
        });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/health') {
        sendJson(res, 200, { ok: true, version: VERSION, ...(options.health?.() ?? {}) });
        return;
      }

      if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
        if (options.admin !== undefined && (await options.admin(req, res, url))) return;
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown admin route' } });
        return;
      }

      if (url.pathname !== '/mcp') {
        sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'unknown path' } });
        return;
      }

      if (req.method === 'GET') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET /mcp is not enabled' } }, { allow: 'POST, DELETE' });
        return;
      }

      if (req.method === 'DELETE') {
        const id = req.headers['mcp-session-id'];
        const sessionId = Array.isArray(id) ? id[0] : id;
        if (sessionId === undefined) {
          sendJson(res, 400, { error: { code: 'MISSING_SESSION', message: 'Mcp-Session-Id is required' } });
          return;
        }
        const deleted = await options.sessions.delete(sessionId);
        if (deleted) {
          res.writeHead(204);
          res.end();
        } else {
          sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'unknown session' } });
        }
        return;
      }

      if (req.method !== 'POST') {
        sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'use POST /mcp' } }, { allow: 'POST, DELETE' });
        return;
      }

      let message: unknown;
      try {
        message = JSON.parse(await readBody(req));
      } catch (error) {
        if (error instanceof BodyTooLargeError) {
          sendJson(res, 413, { error: { code: 'BODY_TOO_LARGE', message: 'request body exceeds 1 MiB' } });
          return;
        }
        sendJson(res, 400, {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'parse error' },
        });
        return;
      }

      const method = methodOf(message);
      const header = req.headers['mcp-session-id'];
      const requestedId = Array.isArray(header) ? header[0] : header;

      let transportId: string;
      if (requestedId === undefined) {
        const session = options.sessions.create(method === 'initialize' ? 'legacy' : 'modern', {
          onClose: async (reason) => {
            log(`transport closed (${reason})`, { scope: 'mcp', mcp: session.id });
            // DELETE /mcp and idle expiry both land here: drop the transport's
            // unbound exec sessions, their workers/serve handles and tasks.
            // Bound clients keep their execution sessions across transports.
            await options.gateway.destroyTransport(session.id);
            options.tasks.clearOwner(session.id);
          },
        });
        transportId = session.id;
      } else {
        const session = await options.sessions.touch(requestedId);
        if (session === null) {
          sendJson(res, 404, { error: { code: 'SESSION_NOT_FOUND', message: 'session expired or unknown' } });
          return;
        }
        transportId = session.id;
      }

      // A client that aborts the HTTP request closes the response before the
      // server ends it; log it so cancellation behavior can be observed.
      res.on('close', () => {
        if (res.writableEnded) return;
        log('response closed before completion', {
          level: 'warn',
          scope: 'mcp',
          mcp: transportId,
          method: method ?? 'unknown',
        });
      });

      const info = parseClientInfo(message);
      const authorization = req.headers.authorization ?? null;
      const outcome = await resolveIdentity(
        {
          authorization,
          client: info.label,
          clientName: info.name,
          clientVersion: info.version,
        },
        options.identity,
      );
      if (!outcome.ok) {
        sendJson(
          res,
          outcome.status,
          { error: outcome.error },
          { 'www-authenticate': outcome.wwwAuthenticate },
        );
        return;
      }

      const identity = toRequestIdentity(outcome, { mcp: transportId });
      options.onSessionActivity?.(transportId, identity);
      const messageId = (message as { id?: unknown }).id;
      options.frames?.recordIn({
        mcp: transportId,
        identity: identity.identity,
        binding: identity.binding,
        client: identity.client,
        clientName: identity.clientName ?? '',
        clientVersion: identity.clientVersion ?? '',
        id: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null,
        method: method ?? 'unknown',
        params: (message as { params?: unknown }).params,
      });
      const context: McpContext = {
        identity,
        gateway: options.gateway,
        catalog: options.catalog,
        tasks: options.tasks,
        tasksDeclared: declaredTasks(message),
        transportId,
        requestId:
          typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null,
        ...(options.reports === undefined ? {} : { reports: options.reports }),
      };

      const started = Date.now();
      const response = await options.dispatcher.handle(message, context);
      log(`mcp ${method ?? 'notification'} -> ${response === null ? 202 : 200}`, {
        scope: 'mcp',
        mcp: transportId,
        client: identity.client,
        binding: identity.binding,
        method: method ?? 'notification',
        status: response === null ? 202 : 200,
        durMs: Date.now() - started,
      });
      if (response === null) {
        res.writeHead(202, { 'mcp-session-id': transportId });
        res.end();
        return;
      }
      options.frames?.recordOut({
        mcp: transportId,
        id: typeof messageId === 'string' || typeof messageId === 'number' ? messageId : null,
        ...(method === null ? {} : { method }),
        ...('error' in response
          ? { error: response.error, ok: false }
          : { result: response.result, ok: true }),
      });
      sendJson(res, 200, response, { 'mcp-session-id': transportId });
    } catch (error) {
      log(`unhandled request error: ${(error as Error).message}`, { level: 'error', scope: 'mcp' });
      if (!res.headersSent) {
        sendJson(res, 500, { error: { code: 'INTERNAL', message: 'internal error' } });
      } else {
        res.end();
      }
    }
  });
}
