/** Stable id prefixes and a single generator for ledgers, tasks and sessions. @module */
import { randomUUID } from 'node:crypto';

export const ID_PREFIX = {
  boot: 'b',
  execSession: 'es',
  session: 's',
  process: 'p',
  task: 't',
  clientBinding: 'cb',
  mcpSession: 'mcp',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/** `newId('task')` → `t_<32 hex>`; fixed length, lowercase, collision-safe. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${randomUUID().replaceAll('-', '')}`;
}
