/**
 * Candidate ranking for the P3 analysis (design 10 §10.2): frequency,
 * cross-session reuse, parameterization potential and tool combination.
 * Every component saturates, so one very active script cannot dominate forever.
 * @module
 */

/** Runs at which frequency scores 1; 10 successful reuses is strong evidence. */
const FREQUENCY_FULL = 10;
/** Distinct sessions at which cross-session reuse scores 1. */
const SESSION_FULL = 4;
/** Literals at which the literal part of parameterization scores 1. */
const LITERAL_FULL = 5;
/** Declarations at which the variable part of parameterization scores 1. */
const DECLARATION_FULL = 2;
/** Extra literal variants at which the variant part of parameterization scores 1. */
const VARIANT_FULL = 2;
/** Distinct tools at which tool-combination value scores 1. */
const TOOL_FULL = 3;

export interface ClusterScoreInput {
  readonly runCount: number;
  /** Distinct sessions, or the workspace + day fallback used by the caller. */
  readonly sessionCount: number;
  readonly literalCount: number;
  readonly declarationCount: number;
  /** Distinct literal signatures among runs that share one literal shape. */
  readonly literalVariantCount: number;
  readonly toolCount: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Weighted sum in `[0, 1]`:
 * - frequency 0.40: log-scaled run count;
 * - cross-session 0.20: distinct sessions, so a burst in one session ranks low;
 * - parameterization 0.25: literals, declarations and distinct literal variants;
 * - tool combination 0.15: scripts orchestrating more tools are worth more.
 */
export function scoreCluster(input: ClusterScoreInput): number {
  const frequency = clamp01(
    Math.log1p(Math.max(0, input.runCount)) / Math.log1p(FREQUENCY_FULL),
  );
  const crossSession = clamp01(input.sessionCount / SESSION_FULL);
  const parameterization = clamp01(
    0.5 * clamp01(input.literalCount / LITERAL_FULL) +
      0.2 * clamp01(input.declarationCount / DECLARATION_FULL) +
      0.3 * clamp01((input.literalVariantCount - 1) / VARIANT_FULL),
  );
  const tools = clamp01(input.toolCount / TOOL_FULL);
  return round4(
    0.4 * frequency + 0.2 * crossSession + 0.25 * parameterization + 0.15 * tools,
  );
}
