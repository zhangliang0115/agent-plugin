/** Tag/category dictionary rules shared by the dictionary pages and the annotation UI.
 *
 * The locked key lists mirror `DEFAULT_TAG_DICTIONARY` (server/src/admin/tags.ts) and
 * `DEFAULT_CATEGORY_DICTIONARY` (server/src/admin/categories.ts); the server rejects
 * edits, these lists only drive the UI affordances.
 */

/** Every shipped default tag key; `env.*` is locked as a namespace too. */
export const LOCKED_TAG_KEYS: ReadonlySet<string> = new Set([
  'official',
  'builtin',
  'env.dev',
  'env.test',
  'env.pre',
  'env.prod',
  'cross-env',
  'memory',
  'docs',
  'testing',
  'security',
  'mysql',
  'postgresql',
  'elasticsearch',
  'redis',
  'prometheus',
  'apm',
  'gitlab',
  'browser',
  'computer-use',
]);

/** Every shipped default category key. */
export const LOCKED_CATEGORY_KEYS: ReadonlySet<string> = new Set([
  'database',
  'observability',
  'devtools',
  'ui-automation',
  'filesystem',
  'search',
  'messaging',
  'cloud',
  'ai',
  'other',
]);

export function isLockedTagKey(key: string): boolean {
  return key.startsWith('env.') || LOCKED_TAG_KEYS.has(key);
}

export function isLockedCategoryKey(key: string): boolean {
  return LOCKED_CATEGORY_KEYS.has(key);
}

/** Dictionary keys that no server or tool references; locked keys are never listed. */
export function unusedTagKeys(
  entries: readonly { key: string }[],
  referenced: ReadonlySet<string>,
): string[] {
  const unused: string[] = [];
  for (const entry of entries) {
    const key = entry.key.trim().toLowerCase();
    if (key === '' || isLockedTagKey(key) || referenced.has(key)) continue;
    if (!unused.includes(key)) unused.push(key);
  }
  return unused;
}
