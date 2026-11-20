/** Pure helpers for the secrets page: which stored keys are still referenced. */

/** The subset of `ServerView` needed to decide which secrets a server can read. */
export interface ReferencedServer {
  id: string;
  envKeys?: string[];
  headerKeys?: string[];
  envSecrets?: Record<string, string>;
  headerSecrets?: Record<string, string>;
  secretArgs?: Array<{ index: number; secret: string }>;
}

/** Every name a server can resolve: literal keys, `$secret` refs and arg secrets. */
export function referencedNames(servers: readonly ReferencedServer[]): Set<string> {
  const names = new Set<string>();
  for (const server of servers) {
    for (const key of server.envKeys ?? []) names.add(key);
    for (const key of server.headerKeys ?? []) names.add(key);
    for (const name of Object.values(server.envSecrets ?? {})) names.add(name);
    for (const name of Object.values(server.headerSecrets ?? {})) names.add(name);
    for (const arg of server.secretArgs ?? []) names.add(arg.secret);
  }
  return names;
}
