/**
 * HTTP routes for the local OAuth authorization server: discovery, dynamic
 * registration, consent, and token exchange. Loopback-only; the caller has
 * already applied the Host allowlist.
 *
 * @module
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  authorizationServerMetadata,
  consentPage,
  protectedResourceMetadata,
  type OAuthStore,
} from './oauth.ts';

const MAX_BODY_BYTES = 64 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body) ?? 'null';
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
  });
  res.end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(body)) out[key] = value;
  return out;
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location, 'cache-control': 'no-store' });
  res.end();
}

function withQuery(base: string, params: Record<string, string>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface OAuthHttpOptions {
  store: OAuthStore;
  /** Origin the client used, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Bindings offered on the consent page; the chosen one is inherited by the token. */
  listBindings?: () => Promise<ReadonlyArray<{ id: string; label: string; agent?: string | null }>>;
  /** Validates a binding id from the form; unknown ids are rejected. */
  hasBinding?: (id: string) => Promise<boolean> | boolean;
}

/**
 * Returns true when the request was an OAuth route and the response is written.
 * Unknown `/.well-known/*` paths fall through to the caller's 404.
 */
export async function handleOAuthRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  options: OAuthHttpOptions,
): Promise<boolean> {
  const { store, baseUrl } = options;

  if (url.pathname === '/.well-known/oauth-protected-resource') {
    sendJson(res, 200, protectedResourceMetadata(baseUrl));
    return true;
  }

  if (url.pathname === '/.well-known/oauth-authorization-server') {
    sendJson(res, 200, authorizationServerMetadata(baseUrl));
    return true;
  }

  if (url.pathname === '/register' && req.method === 'POST') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      sendJson(res, 400, { error: 'invalid_client_metadata' });
      return true;
    }
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((uri): uri is string => typeof uri === 'string' && uri !== '')
      : [];
    if (redirectUris.length === 0) {
      sendJson(res, 400, { error: 'invalid_redirect_uri' });
      return true;
    }
    const client = store.register({
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirectUris,
    });
    sendJson(res, 201, {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
    return true;
  }

  if (url.pathname === '/authorize' && req.method === 'GET') {
    const params = Object.fromEntries(url.searchParams);
    const verdict = validateAuthorize(params, store, baseUrl);
    if (verdict.error !== undefined) {
      sendHtml(res, 400, `<p>${escapeHtml(verdict.error)}</p>`);
      return true;
    }
    const bindings = options.listBindings === undefined ? [] : await options.listBindings();
    sendHtml(
      res,
      200,
      consentPage({
        clientName: verdict.clientName,
        clientId: params['client_id'] ?? '',
        redirectUri: params['redirect_uri'] ?? '',
        resource: params['resource'] ?? `${baseUrl}/mcp`,
        params,
        bindings,
      }),
    );
    return true;
  }

  if (url.pathname === '/authorize' && req.method === 'POST') {
    const params = parseForm(await readBody(req));
    const verdict = validateAuthorize(params, store, baseUrl);
    if (verdict.error !== undefined) {
      sendHtml(res, 400, `<p>${escapeHtml(verdict.error)}</p>`);
      return true;
    }
    const redirectUri = params['redirect_uri'] ?? '';
    const state = params['state'];
    if (params['decision'] !== 'allow') {
      redirect(res, withQuery(redirectUri, { error: 'access_denied', ...(state === undefined ? {} : { state }) }));
      return true;
    }
    const requestedBinding = params['binding_id'] ?? '';
    if (requestedBinding !== '') {
      const valid = options.hasBinding === undefined ? false : await options.hasBinding(requestedBinding);
      if (!valid) {
        sendHtml(res, 400, `<p>Unknown binding: ${escapeHtml(requestedBinding)}</p>`);
        return true;
      }
    }
    const code = store.issueCode({
      clientId: params['client_id'] ?? '',
      redirectUri,
      codeChallenge: params['code_challenge'] ?? '',
      resource: params['resource'] ?? `${baseUrl}/mcp`,
      bindingId: requestedBinding === '' ? null : requestedBinding,
    });
    redirect(res, withQuery(redirectUri, { code, ...(state === undefined ? {} : { state }) }));
    return true;
  }

  if (url.pathname === '/token' && req.method === 'POST') {
    const form = parseForm(await readBody(req));
    const grant = form['grant_type'];
    if (grant === 'authorization_code') {
      const taken = store.takeCode({
        code: form['code'] ?? '',
        clientId: form['client_id'] ?? '',
        redirectUri: form['redirect_uri'] ?? '',
        verifier: form['code_verifier'] ?? '',
      });
      if (taken === undefined) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return true;
      }
      const tokens = store.issueTokens(taken.clientId, taken.bindingId);
      sendJson(res, 200, {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      });
      return true;
    }
    if (grant === 'refresh_token') {
      const tokens = store.refreshTokens(form['refresh_token'] ?? '');
      if (tokens === undefined) {
        sendJson(res, 400, { error: 'invalid_grant' });
        return true;
      }
      sendJson(res, 200, {
        access_token: tokens.accessToken,
        token_type: 'Bearer',
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      });
      return true;
    }
    sendJson(res, 400, { error: 'unsupported_grant_type' });
    return true;
  }

  return false;
}

function validateAuthorize(
  params: Record<string, string>,
  store: OAuthStore,
  baseUrl: string,
): { error?: string; clientName: string } {
  if (params['response_type'] !== 'code') return { error: 'unsupported response_type', clientName: '' };
  const client = store.client(params['client_id'] ?? '');
  if (client === undefined) return { error: 'unknown client_id', clientName: '' };
  const redirectUri = params['redirect_uri'] ?? '';
  if (!client.redirectUris.includes(redirectUri)) {
    return { error: 'redirect_uri is not registered for this client', clientName: client.clientName };
  }
  if (params['code_challenge_method'] !== 'S256' || (params['code_challenge'] ?? '') === '') {
    return { error: 'PKCE S256 is required', clientName: client.clientName };
  }
  const resource = params['resource'];
  if (resource !== undefined && resource !== `${baseUrl}/mcp`) {
    return { error: `resource must be ${baseUrl}/mcp`, clientName: client.clientName };
  }
  return { clientName: client.clientName };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
