/** Shared FTS5 query building for the scripts and catalog search paths. @module */

/** Token shape shared by both FTS5 indexes: Han runs or letter/number runs. */
export const FTS_TOKEN_RE = /[\p{Script=Han}]+|[\p{L}\p{N}]+/gu;

/**
 * Extracts FTS tokens from `text`, preserving case and duplicates. The
 * `maxTerms` cap applies after the full text is tokenized.
 */
export function tokenizeFts(text: string, maxTerms: number): string[] {
  return [...text.matchAll(FTS_TOKEN_RE)].map((match) => match[0]).slice(0, maxTerms);
}

/** Quotes one FTS5 term as a prefix token; embedded quotes are doubled. */
export function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"*`;
}

/** Joins quoted terms into one FTS5 MATCH expression; `null` for no terms. */
export function buildFtsMatch(tokens: readonly string[], op: 'AND' | 'OR'): string | null {
  if (tokens.length === 0) return null;
  const separator = op === 'AND' ? ' ' : ' OR ';
  return tokens.map(quoteFtsTerm).join(separator);
}

/** Builds a `bm25(table, w1, w2, ...)` SQL expression. */
export function bm25Expression(table: string, weights: readonly number[]): string {
  return `bm25(${table}, ${weights.join(', ')})`;
}

/**
 * Escapes SQL LIKE metacharacters (`\`, `%`, `_`) with a backslash. The
 * matching query must declare `ESCAPE '\'`.
 */
export function escapeLikeTerm(term: string): string {
  return term.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

/** Contains pattern for `LIKE ... ESCAPE '\'`: `%<escaped term>%`. */
export function likeContainsPattern(term: string): string {
  return `%${escapeLikeTerm(term)}%`;
}
