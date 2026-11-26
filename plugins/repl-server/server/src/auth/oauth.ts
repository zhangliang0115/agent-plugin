/**
 * Minimal OAuth 2.1 authorization server for the local MCP endpoint.
 *
 * The MCP client discovers `/.well-known/oauth-protected-resource`, registers
 * itself dynamically, gets an authorization code through the loopback consent
 * page, and trades it for a bearer token. Everything lives in memory: a server
 * restart invalidates tokens, and the client simply authorizes again.
 *
 * @module
 */
import { createHash, randomBytes } from 'node:crypto';

import { sha256Hex, timingSafeEqualString } from './tokens.ts';

const CODE_TTL_MS = 60_000;
/** Local single-user server: an authorization should survive for a year, not an hour. */
const ACCESS_TTL_MS = 365 * 24 * 3_600_000;
const REFRESH_TTL_MS = 365 * 24 * 3_600_000;
const MAX_CLIENTS = 64;

export interface OAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly createdAt: number;
}

interface OAuthCode {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly resource: string;
  /** Binding chosen on the consent page; `null` keeps the client unbound. */
  readonly bindingId: string | null;
  readonly createdAt: number;
}

interface OAuthToken {
  readonly clientId: string;
  readonly bindingId: string | null;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly refreshHash: string | null;
  readonly refreshExpiresAt: number | null;
}

function newSecret(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

/** PKCE S256: BASE64URL(SHA256(verifier)) === challenge. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const digest = createHash('sha256').update(verifier, 'ascii').digest('base64url');
  return timingSafeEqualString(digest, challenge);
}

/** Shape written to `oauth_authorizations`; mirrors one access token. */
export interface StoredAuthorization {
  accessHash: string;
  clientId: string;
  clientName: string;
  bindingId: string | null;
  refreshHash: string | null;
  createdAt: number;
  expiresAt: number;
  refreshExpiresAt: number | null;
}

/** Persistence the store writes through so a restart keeps authorizations alive. */
export interface OAuthPersistence {
  list(): readonly StoredAuthorization[];
  save(row: StoredAuthorization): void;
  remove(accessHash: string): void;
}

export class OAuthStore {
  private readonly clients = new Map<string, OAuthClient>();
  private readonly codes = new Map<string, OAuthCode>();
  private readonly access = new Map<string, OAuthToken>();
  /** refresh token hash → access token hash, so a refresh rotates both. */
  private readonly refresh = new Map<string, string>();
  private readonly persistence: OAuthPersistence | undefined;

  constructor(persistence?: OAuthPersistence) {
    this.persistence = persistence;
    if (persistence === undefined) return;
    // Restored clients keep their name for display but not their redirect URIs;
    // a client that reconnects registers again and gets a fresh client_id.
    for (const row of persistence.list()) {
      this.clients.set(row.clientId, {
        clientId: row.clientId,
        clientName: row.clientName,
        redirectUris: [],
        createdAt: row.createdAt,
      });
      this.access.set(row.accessHash, {
        clientId: row.clientId,
        bindingId: row.bindingId,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        refreshHash: row.refreshHash,
        refreshExpiresAt: row.refreshExpiresAt,
      });
      if (row.refreshHash !== null) this.refresh.set(row.refreshHash, row.accessHash);
    }
  }

  register(input: { clientName?: string; redirectUris: readonly string[] }): OAuthClient {
    if (this.clients.size >= MAX_CLIENTS) {
      const oldest = [...this.clients.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
      if (oldest !== undefined) this.clients.delete(oldest.clientId);
    }
    const client: OAuthClient = {
      clientId: newSecret('client'),
      clientName: input.clientName ?? 'MCP client',
      redirectUris: input.redirectUris,
      createdAt: Date.now(),
    };
    this.clients.set(client.clientId, client);
    return client;
  }

  client(clientId: string): OAuthClient | undefined {
    return this.clients.get(clientId);
  }

  issueCode(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    resource: string;
    bindingId?: string | null;
  }): string {
    const code = newSecret('code');
    this.codes.set(code, { ...input, bindingId: input.bindingId ?? null, createdAt: Date.now() });
    return code;
  }

  /** Consumes a code exactly once; any mismatch returns undefined. */
  takeCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
  }): OAuthCode | undefined {
    const entry = this.codes.get(input.code);
    if (entry === undefined) return undefined;
    this.codes.delete(input.code);
    if (Date.now() - entry.createdAt > CODE_TTL_MS) return undefined;
    if (entry.clientId !== input.clientId || entry.redirectUri !== input.redirectUri) return undefined;
    if (!verifyPkce(input.verifier, entry.codeChallenge)) return undefined;
    return entry;
  }

  issueTokens(clientId: string, bindingId: string | null = null): {
    accessToken: string;
    refreshToken: string;
    expiresIn: number;
  } {
    const accessToken = newSecret('at');
    const refreshToken = newSecret('rt');
    const now = Date.now();
    const accessHash = sha256Hex(accessToken);
    const refreshHash = sha256Hex(refreshToken);
    this.access.set(accessHash, {
      clientId,
      bindingId,
      createdAt: now,
      expiresAt: now + ACCESS_TTL_MS,
      refreshHash,
      refreshExpiresAt: now + REFRESH_TTL_MS,
    });
    this.refresh.set(refreshHash, accessHash);
    this.persistence?.save({
      accessHash,
      clientId,
      clientName: this.clients.get(clientId)?.clientName ?? '',
      bindingId,
      refreshHash,
      createdAt: now,
      expiresAt: now + ACCESS_TTL_MS,
      refreshExpiresAt: now + REFRESH_TTL_MS,
    });
    return { accessToken, refreshToken, expiresIn: Math.floor(ACCESS_TTL_MS / 1000) };
  }

  /** Rotation: the refresh token is single-use and a new pair replaces it. */
  refreshTokens(refreshToken: string): { accessToken: string; refreshToken: string; expiresIn: number } | undefined {
    const refreshHash = sha256Hex(refreshToken);
    const accessHash = this.refresh.get(refreshHash);
    if (accessHash === undefined) return undefined;
    const record = this.access.get(accessHash);
    if (record?.refreshHash !== null && record?.refreshHash !== undefined) {
      if (!timingSafeEqualString(record.refreshHash, refreshHash)) return undefined;
    }
    if (record === undefined) return undefined;
    if (record.refreshExpiresAt !== null && record.refreshExpiresAt !== undefined && Date.now() > record.refreshExpiresAt) {
      this.refresh.delete(refreshHash);
      this.access.delete(accessHash);
      return undefined;
    }
    this.refresh.delete(refreshHash);
    this.access.delete(accessHash);
    this.persistence?.remove(accessHash);
    return this.issueTokens(record.clientId, record.bindingId);
  }

  /** Live authorizations for the admin surface; `expiresAt` is the refresh deadline. */
  listAuthorizations(): Array<{
    clientId: string;
    clientName: string;
    bindingId: string | null;
    createdAt: string;
    accessExpiresAt: string;
    refreshExpiresAt: string | null;
  }> {
    const now = Date.now();
    return [...this.access.values()]
      .filter((record) => (record.refreshExpiresAt ?? record.expiresAt) > now)
      .map((record) => ({
        clientId: record.clientId,
        clientName: this.clients.get(record.clientId)?.clientName ?? '',
        bindingId: record.bindingId,
        createdAt: new Date(record.createdAt).toISOString(),
        accessExpiresAt: new Date(record.expiresAt).toISOString(),
        refreshExpiresAt:
          record.refreshExpiresAt === null ? null : new Date(record.refreshExpiresAt).toISOString(),
      }));
  }

  /** Drops every token of one client: used when a binding is deleted or rotated. */
  revokeClient(clientId: string): number {
    let removed = 0;
    for (const [hash, record] of this.access) {
      if (record.clientId !== clientId) continue;
      this.access.delete(hash);
      this.persistence?.remove(hash);
      if (record.refreshHash !== null) this.refresh.delete(record.refreshHash);
      removed += 1;
    }
    return removed;
  }

  /** `bound` when the bearer token is a live OAuth access token. */
  inspect(token: string): { clientId: string; bindingId: string | null } | undefined {
    const hash = sha256Hex(token);
    const record = this.access.get(hash);
    if (record === undefined) return undefined;
    if (Date.now() > record.expiresAt) {
      this.access.delete(hash);
      this.persistence?.remove(hash);
      return undefined;
    }
    return { clientId: record.clientId, bindingId: record.bindingId };
  }
}

/** PRM body (RFC 9728); `resource` must match the URL the client called. */
export function protectedResourceMetadata(baseUrl: string): Record<string, unknown> {
  return {
    resource: `${baseUrl}/mcp`,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ['header'],
    resource_name: 'repl-server',
  };
}

/** AS metadata (RFC 8414). */
export function authorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  };
}

/**
 * Consent page. Local single-user server, so the page carries the whole
 * decision: which client, where it redirects, and which binding (if any) the
 * resulting token inherits.
 */
export function consentPage(input: {
  clientName: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  params: Record<string, string>;
  bindings: ReadonlyArray<{ id: string; label: string; agent?: string | null }>;
}): string {
  const hidden = Object.entries(input.params)
    .map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`)
    .join('');
  const options = input.bindings
    .map((binding) => {
      const agent = binding.agent === undefined || binding.agent === null ? '' : ` · ${escapeHtml(binding.agent)}`;
      return `<option value="${escapeHtml(binding.id)}">${escapeHtml(binding.label)}${agent}</option>`;
    })
    .join('');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>授权 · repl-server</title>
<style>
  :root { color-scheme: light dark; --bg:#f5f6f8; --card:#ffffff; --line:#e4e7ec; --text:#16181d;
          --muted:#6b7280; --soft:#f2f4f7; --accent:#4f6bff; --accent-2:#7a5cff; --danger:#d14343; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1114; --card:#181b1f; --line:#2a2f36; --text:#e9ebee; --muted:#9aa1ab; --soft:#22262c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px;
         background:var(--bg); color:var(--text);
         font:15px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", system-ui, sans-serif;
         -webkit-font-smoothing:antialiased; }
  .card { width:min(520px, 100%); background:var(--card); border:1px solid var(--line);
          border-radius:16px; padding:32px 32px 24px; box-shadow:0 12px 40px rgba(16,24,40,.08); }
  .brand { display:flex; align-items:center; gap:12px; margin-bottom:28px; }
  .logo { width:38px; height:38px; border-radius:11px; display:grid; place-items:center;
          background:linear-gradient(135deg, var(--accent), var(--accent-2)); color:#fff;
          font-weight:700; font-size:17px; letter-spacing:-.5px; }
  .brand-name { font-weight:650; font-size:15px; letter-spacing:.01em; }
  .brand-sub { font-size:12px; color:var(--muted); margin-top:1px; }
  h1 { font-size:21px; line-height:1.35; margin:0 0 6px; font-weight:650; letter-spacing:-.01em; }
  .lede { margin:0 0 24px; color:var(--muted); font-size:14px; }
  .client { display:flex; align-items:center; gap:14px; padding:16px; border-radius:12px;
            background:var(--soft); margin-bottom:24px; }
  .client-avatar { width:40px; height:40px; border-radius:10px; flex:none; display:grid; place-items:center;
                   background:var(--card); border:1px solid var(--line); font-weight:600; font-size:15px; }
  .client-name { font-weight:600; }
  .client-id { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px;
               color:var(--muted); margin-top:2px; overflow-wrap:anywhere; }
  .facts { margin:0 0 24px; padding:0; display:grid; gap:12px; }
  .fact { display:grid; grid-template-columns:104px 1fr; gap:12px; align-items:baseline; }
  .fact dt { color:var(--muted); font-size:13px; margin:0; }
  .fact dd { margin:0; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
             font-size:12.5px; overflow-wrap:anywhere; }
  .field { margin-bottom:24px; }
  .field label { display:block; font-size:13px; font-weight:600; margin-bottom:8px; }
  .field .hint { font-size:12.5px; color:var(--muted); margin:0 0 10px; }
  select { width:100%; font:inherit; padding:11px 12px; border-radius:10px; color:var(--text);
           background:var(--card); border:1px solid var(--line); }
  select:focus-visible, button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  .actions { display:flex; gap:10px; margin-top:8px; }
  button { font:inherit; font-weight:600; border-radius:10px; padding:11px 20px; cursor:pointer;
           border:1px solid transparent; transition:filter .12s ease, background .12s ease; }
  button:hover { filter:brightness(1.06); }
  .allow { flex:1; background:linear-gradient(135deg, var(--accent), var(--accent-2)); color:#fff; }
  .deny { background:transparent; border-color:var(--line); color:var(--text); }
  .footer { margin:24px 0 0; padding-top:18px; border-top:1px solid var(--line);
            font-size:12px; color:var(--muted); display:grid; gap:4px; }
</style>
</head>
<body>
<main class="card">
  <div class="brand">
    <div class="logo" aria-hidden="true">re</div>
    <div>
      <div class="brand-name">repl-server</div>
      <div class="brand-sub">本机 MCP 服务 · 127.0.0.1</div>
    </div>
  </div>
  <h1>允许此客户端访问 repl-server？</h1>
  <p class="lede">授权后，客户端可以调用本机沙箱里的工具与脚本库。</p>
  <div class="client">
    <div class="client-avatar" aria-hidden="true">${escapeHtml(initials(input.clientName))}</div>
    <div>
      <div class="client-name">${escapeHtml(input.clientName)}</div>
      <div class="client-id">${escapeHtml(input.clientId)}</div>
    </div>
  </div>
  <dl class="facts">
    <div class="fact"><dt>回调地址</dt><dd>${escapeHtml(input.redirectUri)}</dd></div>
    <div class="fact"><dt>访问资源</dt><dd>${escapeHtml(input.resource)}</dd></div>
  </dl>
  <form method="post" action="/authorize">
    ${hidden}
    <div class="field">
      <label for="binding_id">绑定客户端配置</label>
      <p class="hint">绑定后继承该客户端的配额、可见工具与默认 workspace；不绑定则以无配置身份访问。</p>
      <select id="binding_id" name="binding_id">
        <option value="">不绑定</option>
        ${options}
      </select>
    </div>
    <div class="actions">
      <button class="allow" name="decision" value="allow" type="submit">允许访问</button>
      <button class="deny" name="decision" value="deny" type="submit">拒绝</button>
    </div>
  </form>
  <p class="footer">
    <span>仅接受本机连接；令牌可随时在管理端撤销。</span>
    <span>授权有效期 365 天，服务重启后仍然有效。</span>
  </p>
</main>
</body>
</html>`;
}

/** Two-character avatar text for the client card. */
function initials(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  return trimmed.slice(0, 2).toUpperCase();
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export { CODE_TTL_MS, ACCESS_TTL_MS, REFRESH_TTL_MS };
