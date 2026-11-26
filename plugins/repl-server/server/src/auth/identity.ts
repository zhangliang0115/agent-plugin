/** Client identity for `/mcp`: token → `client_bindings` row, with the frozen loose/strict matrix. @module */
import type { AgentKind, RequestIdentity } from '../ports.ts';

import { parseBearer, sha256Hex, timingSafeEqualString } from './tokens.ts';

/** Default is loose: a missing token is `unbound`, never a global-token identity. */
export type AuthMode = 'loose' | 'strict';

/** The subset of a `client_bindings` row that the MCP layer needs. */
export interface ClientBinding {
  id: string;
  label?: string;
  /** Configured agent family; `null` keeps the standard result path. */
  agent?: AgentKind | null;
  /** SHA-256 hex of the plaintext token; the store looks rows up by it. */
  tokenHash?: string;
  defaultWorkspace?: string | null;
  allowedServers?: readonly string[] | null;
  allowedTags?: readonly string[] | null;
}

/** Per-request lookup that receives the SHA-256 hex of the presented token. */
export interface TokenHashLookup {
  findByTokenHash(
    tokenHash: string,
  ): ClientBinding | null | undefined | Promise<ClientBinding | null | undefined>;
}

/** Per-request lookup that receives the plaintext token and hashes it itself (repository style). */
export interface TokenLookup {
  findByToken(
    token: string,
  ): ClientBinding | null | undefined | Promise<ClientBinding | null | undefined>;
}

/**
 * Called for every `/mcp` request, so deleted/rotated bindings stop working at once.
 * `findByTokenHash` wins when both methods exist.
 */
export type ClientBindingLookup = TokenHashLookup | TokenLookup;

export interface IdentityRequest {
  authorization?: string | null;
  /** Client-reported `clientInfo` label (`name/version`); audit display only, never identity. */
  client?: string;
  /** Parsed `clientInfo.name`; audit display only. */
  clientName?: string;
  /** Parsed `clientInfo.version`; empty when the client reported none. */
  clientVersion?: string;
}

export interface IdentityConfig {
  mode?: AuthMode;
  /** Global `mcp-token`; loose mode maps it to `unbound`, strict mode rejects it. */
  globalToken?: string | null;
  bindings: ClientBindingLookup;
  /** Access tokens issued by the local OAuth authorization server. */
  oauth?: {
    inspect(token: string): { clientId: string; bindingId: string | null } | undefined;
    /** Resolves the binding chosen on the consent page into the full row. */
    lookupBinding?(id: string): ClientBinding | null | Promise<ClientBinding | null>;
  };
}

export type IdentityReason = 'client_token' | 'global_token' | 'oauth_token' | 'no_token';

export type IdentityFailureReason =
  | 'missing_token'
  | 'malformed_token'
  | 'unknown_token'
  | 'global_token_disabled';

export interface IdentityAllowed {
  ok: true;
  identity: 'bound' | 'unbound';
  /** Full binding row when `identity === 'bound'`; null for unbound clients. */
  binding: ClientBinding | null;
  reason: IdentityReason;
  client: string;
  clientName: string;
  clientVersion: string;
}

export interface IdentityDenied {
  ok: false;
  status: 401;
  error: { code: 'UNAUTHORIZED'; message: string; reason: IdentityFailureReason };
  wwwAuthenticate: string;
}

export type IdentityOutcome = IdentityAllowed | IdentityDenied;

/**
 * Applies the credential matrix from protocol.md §2:
 *
 * | Authorization | loose | strict |
 * |---|---|---|
 * | client token matching a binding | bound | bound |
 * | global `mcp-token` | unbound | 401 |
 * | none | unbound | 401 |
 * | unknown / malformed token | 401 | 401 |
 */
export async function resolveIdentity(
  request: IdentityRequest,
  config: IdentityConfig,
): Promise<IdentityOutcome> {
  const mode = config.mode ?? 'loose';
  const client = request.client ?? '';
  const clientName = request.clientName ?? '';
  const clientVersion = request.clientVersion ?? '';
  const bearer = parseBearer(request.authorization);

  if (bearer.kind === 'none') {
    if (mode === 'strict') return deny('missing_token', 'a client token is required in strict mode');
    return allow({
      identity: 'unbound',
      binding: null,
      reason: 'no_token',
      client,
      clientName,
      clientVersion,
    });
  }

  if (bearer.kind === 'invalid') {
    return deny('malformed_token', 'the Authorization header is not a valid bearer token');
  }

  if (config.globalToken && timingSafeEqualString(bearer.token, config.globalToken)) {
    if (mode === 'strict') {
      return deny('global_token_disabled', 'the global mcp-token is not accepted in strict mode');
    }
    return allow({
      identity: 'unbound',
      binding: null,
      reason: 'global_token',
      client,
      clientName,
      clientVersion,
    });
  }

  const tokenHash = sha256Hex(bearer.token);
  const binding = await findBinding(config.bindings, bearer.token, tokenHash);
  if (binding === null || binding === undefined || typeof binding.id !== 'string' || binding.id === '') {
    const oauth = config.oauth?.inspect(bearer.token);
    if (oauth !== undefined) {
      // The consent page may have attached a binding; a deleted binding degrades
      // to unbound rather than rejecting a token the client still holds.
      if (oauth.bindingId !== null && config.oauth?.lookupBinding !== undefined) {
        const bound = await config.oauth.lookupBinding(oauth.bindingId);
        if (bound !== null && bound !== undefined && typeof bound.id === 'string' && bound.id !== '') {
          return allow({
            identity: 'bound',
            binding: bound,
            reason: 'oauth_token',
            client,
            clientName,
            clientVersion,
          });
        }
      }
      return allow({
        identity: 'unbound',
        binding: null,
        reason: 'oauth_token',
        client,
        clientName,
        clientVersion,
      });
    }
    return deny('unknown_token', 'unknown client token');
  }
  // The store is expected to match on the token; verify the stored hash again in constant time.
  if (binding.tokenHash !== undefined && !timingSafeEqualString(binding.tokenHash, tokenHash)) {
    return deny('unknown_token', 'unknown client token');
  }

  return allow({
    identity: 'bound',
    binding,
    reason: 'client_token',
    client,
    clientName,
    clientVersion,
  });
}

async function findBinding(
  lookup: ClientBindingLookup,
  token: string,
  tokenHash: string,
): Promise<ClientBinding | null | undefined> {
  if ('findByTokenHash' in lookup) return lookup.findByTokenHash(tokenHash);
  if ('findByToken' in lookup) return lookup.findByToken(token);
  throw new TypeError('client binding lookup needs findByTokenHash or findByToken');
}

export interface IdentityIds {
  /** `Mcp-Session-Id` of the current transport session. */
  mcp: string;
  /** Exec-session id once one exists. */
  exec?: string;
}

/** Projects a successful resolution into the executor's `RequestIdentity` shape. */
export function toRequestIdentity(outcome: IdentityAllowed, ids: IdentityIds): RequestIdentity {
  const identity: RequestIdentity = {
    identity: outcome.identity,
    binding: outcome.binding?.id ?? null,
    client: outcome.client,
    clientName: outcome.clientName,
    clientVersion: outcome.clientVersion,
    agent: outcome.binding?.agent ?? null,
    mcp: ids.mcp,
  };
  if (ids.exec !== undefined) identity.exec = ids.exec;
  return identity;
}

function allow(
  fields: Pick<
    IdentityAllowed,
    'identity' | 'binding' | 'reason' | 'client' | 'clientName' | 'clientVersion'
  >,
): IdentityAllowed {
  return { ok: true, ...fields };
}

function deny(reason: IdentityFailureReason, message: string): IdentityDenied {
  return {
    ok: false,
    status: 401,
    error: { code: 'UNAUTHORIZED', message, reason },
    wwwAuthenticate: reason === 'missing_token' ? 'Bearer' : 'Bearer error="invalid_token"',
  };
}
