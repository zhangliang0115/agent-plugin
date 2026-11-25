/**
 * Payload refs are always relative to the log root. This is the only place that
 * turns one into an absolute path, so a `..` or an absolute ref can never reach
 * `state.db`.
 *
 * @module
 */
import { isAbsolute, resolve, sep } from 'node:path';

/** Every ref segment: letters, digits, dot, underscore, hyphen only. */
const REF_SEGMENT = /^[A-Za-z0-9._-]+$/;

export function resolveLogRef(logRoot: string, ref: string): string | null {
  if (ref === '' || ref.includes('\0') || ref.includes('\\')) return null;
  if (isAbsolute(ref)) return null;
  const segments = ref.split('/');
  for (const segment of segments) {
    // `.` and `..` are both rejected: a ref names a file, never a directory hop.
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (!REF_SEGMENT.test(segment)) return null;
  }
  const base = resolve(logRoot);
  const target = resolve(base, ref);
  if (target === base || !target.startsWith(`${base}${sep}`)) return null;
  return target;
}
