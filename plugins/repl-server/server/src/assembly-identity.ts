import type { ClientBinding, IdentityConfig } from './auth/identity.ts';

export interface IdentityConfigInput {
  mode: 'loose' | 'strict';
  globalToken: string;
  bindings: { findByToken(token: string): ClientBinding | null | Promise<ClientBinding | null> };
  /** Access tokens from the local OAuth authorization server. */
  oauth?: IdentityConfig['oauth'];
}

/** Narrows the local token/DB wiring to the auth module's config shape. */
export function resolveIdentityConfig(input: IdentityConfigInput): IdentityConfig {
  return {
    mode: input.mode,
    globalToken: input.globalToken,
    bindings: input.bindings,
    ...(input.oauth === undefined ? {} : { oauth: input.oauth }),
  };
}
