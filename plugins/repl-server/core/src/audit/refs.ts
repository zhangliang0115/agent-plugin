/**
 * Payload refs are always relative to the log root. This is the only place that
 * turns one into an absolute path, so a `..` or an absolute ref can never reach
 * `state.db`.
 *
 * @module
 */
import { isAbsolute, resolve, sep } from 'node:path';

export function resolveLogRef(logRoot: string, ref: string): string | null {
  if (ref === '' || ref.includes('\0') || ref.includes('\\')) return null;
  if (isAbsolute(ref)) return null;
  const segments = ref.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  const base = resolve(logRoot);
  const target = resolve(base, ref);
  if (target === base || !target.startsWith(`${base}${sep}`)) return null;
  return target;
}
