import { createServer, type Server, type ServerResponse } from 'node:http';

import { VERSION } from '@zhangliang0115/repl-server-core';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** Builds the HTTP surface shared by `/mcp`, `/admin` and `/health`. @module */
export function createHttpServer(): Server {
  return createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      sendJson(res, 200, { ok: true, version: VERSION });
      return;
    }
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND' } });
  });
}
