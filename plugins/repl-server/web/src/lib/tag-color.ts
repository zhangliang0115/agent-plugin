/** Stable display colors for tag keys, shared by lists and forms. */

/** Semantic keys keep a fixed color so environment and risk tags read the same everywhere. */
const TAG_COLORS: Record<string, string> = {
  'env.dev': 'green',
  'env.test': 'cyan',
  'env.pre': 'gold',
  'env.prod': 'red',
  'cross-env': 'purple',
  official: 'gold',
  builtin: 'purple',
  read: 'blue',
  write: 'orange',
  destructive: 'red',
  security: 'volcano',
};

/** Non-semantic keys hash into this palette; the fixed order keeps their colors stable. */
const FALLBACK_COLORS = ['blue', 'geekblue', 'purple', 'cyan', 'green', 'lime', 'magenta'];

/** Stable color per tag key; unknown keys hash into the fallback palette. */
export function tagColor(key: string): string {
  const explicit = TAG_COLORS[key];
  if (explicit !== undefined) return explicit;
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash = Math.imul(hash ^ key.charCodeAt(index), 16777619);
  }
  return FALLBACK_COLORS[(hash >>> 0) % FALLBACK_COLORS.length]!;
}
