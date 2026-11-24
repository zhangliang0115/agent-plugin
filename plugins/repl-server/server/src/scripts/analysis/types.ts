/**
 * Data types for the P3 script-candidate analysis (design 10 §5.4, §10).
 * Deliberately independent of the P1 archive/repository modules so this
 * analysis can be built and tested before those land.
 * @module
 */

/** One successful `run_script` execution, reduced to the fields analysis needs. */
export interface ScriptRunSample {
  /** Execution id; unique per run and copied into `sourceRunIds`. */
  readonly runId: string;
  /** Source exactly as archived. */
  readonly code: string;
  /** Execution context; recorded, never used to partition the global library. */
  readonly workspace: string;
  /** Canonical `<server>.<tool>` names called by the run. */
  readonly toolsUsed: readonly string[];
  /** ISO 8601 timestamp; also the fallback cross-session signal. */
  readonly createdAt: string;
  /**
   * Execution session when the caller has one (`script_runs.exec_id`). When
   * omitted, a workspace + calendar-day pair stands in for a session.
   */
  readonly sessionId?: string;
}

/** A cluster of structurally identical runs proposed as a reusable script. */
export interface ScriptCandidate {
  /** SHA-256 of the representative raw `code`, same digest as `script_runs.code_sha256`. */
  readonly codeSha256: string;
  /** Raw code of the most frequent run in the cluster; never a synthetic rewrite. */
  readonly code: string;
  /** Every successful run in the cluster, sorted by `runId`. */
  readonly sourceRunIds: readonly string[];
  /** Ranking score in `[0, 1]`; see `scoreCluster` for the four components. */
  readonly score: number;
  readonly runCount: number;
  /** Distinct `sessionId` values, or distinct workspace + day pairs as a fallback. */
  readonly sessionCount: number;
  readonly workspaces: readonly string[];
  readonly toolsUsed: readonly string[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  /** Deterministic heuristic from the most-used tool; AI may replace it. */
  readonly suggestedName: string | null;
  /** Deterministic factual summary; AI may replace it. */
  readonly suggestedDescription: string | null;
  /** Server names from `toolsUsed`, sorted and deduplicated. */
  readonly suggestedTags: readonly string[];
  /** Parameterized schema suggestion. Only an AI suggestion fills this. */
  readonly suggestedInputSchema: Record<string, unknown> | null;
  /** Parameterized code suggestion using `args`. Only an AI suggestion fills this. */
  readonly suggestedCode: string | null;
}

/** Output of the P3 AI step; the shape `applySuggestion` folds into a candidate. */
export interface ScriptCandidateSuggestion {
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  /** P1 input-schema subset; validated when the candidate is accepted, not here. */
  readonly inputSchema?: Record<string, unknown> | null;
  /** Parameterized rewrite; compiled and tested on the normal save path. */
  readonly code?: string | null;
}

/**
 * Placeholder contract for the AI suggester (design 10 §10.3). The analysis
 * module never calls a model: an implementation supplies suggestions and
 * `applySuggestion` merges them, leaving this module pure and offline.
 */
export interface ScriptCandidateSuggester {
  suggest(
    candidate: ScriptCandidate,
  ): ScriptCandidateSuggestion | null | Promise<ScriptCandidateSuggestion | null>;
}
