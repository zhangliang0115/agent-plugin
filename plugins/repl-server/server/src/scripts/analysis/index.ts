/** Public surface of the P3 script-candidate analysis (design 10 §10). @module */
export { analyzeScriptRuns, applySuggestion } from './candidates.ts';
export {
  countDeclarations,
  countLiterals,
  hashScriptCode,
  literalShape,
  literalSignature,
  normalizeScriptCode,
  tokenizeScriptCode,
} from './normalize.ts';
export { scoreCluster } from './score.ts';
export type { ClusterScoreInput } from './score.ts';
export type { CodeToken, CodeTokenType } from './normalize.ts';
export type {
  ScriptCandidate,
  ScriptCandidateSuggester,
  ScriptCandidateSuggestion,
  ScriptRunSample,
} from './types.ts';
