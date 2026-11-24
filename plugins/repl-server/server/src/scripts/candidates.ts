/** P3 candidate scan and review service (design 10 §10, §12 P3). @module */
import type { DatabaseSync } from 'node:sqlite';

import {
  findPendingCandidateByCodeSha,
  findReviewedCandidateByCodeSha,
  getCandidate,
  insertCandidate,
  listCandidateSourceRuns,
  listCandidates,
  markCandidateAccepted,
  markCandidateRejected,
  updatePendingCandidate,
  type CandidateListQuery,
  type ScriptCandidateRecord,
} from '../db/script-candidates.ts';
import { withTransaction } from '../db/migrate.ts';
import type { LogFn } from '../log.ts';
import {
  analyzeScriptRuns,
  applySuggestion,
  type ScriptCandidateSuggester,
} from './analysis/index.ts';
import { ScriptError, type ScriptService, type SaveScriptResult } from './service.ts';

/** Source runs a single scan analyzes when the caller gives no limit. */
export const CANDIDATE_SCAN_DEFAULT = 500;
/** Hard ceiling for one scan; more history should be reviewed in several passes. */
export const CANDIDATE_SCAN_MAX = 2000;
/** `save_script` rejects an empty schema root because `type` must be `object`. */
const EMPTY_INPUT_SCHEMA: Record<string, unknown> = { type: 'object', properties: {} };

export interface ScriptCandidatesServiceOptions {
  db: DatabaseSync;
  scripts: ScriptService;
  /** Optional model-backed suggestion step; failures are warnings, not scan failures. */
  suggester?: ScriptCandidateSuggester | null;
  now?: () => number;
  log?: LogFn;
}

export interface ScanCandidatesInput {
  /** Maximum successful source runs to analyze; defaults to {@link CANDIDATE_SCAN_DEFAULT}. */
  limit?: number;
}

export interface ScanCandidatesResult {
  scanned: number;
  created: number;
  updated: number;
  warnings: string[];
}

/** Admin overrides for the generated draft; every field is optional. */
export interface AcceptCandidateInput {
  name?: string;
  description?: string;
  tags?: string[];
  code?: string;
  inputSchema?: Record<string, unknown>;
  exampleArgs?: Record<string, unknown> | null;
}

export interface AcceptCandidateResult {
  candidate: ScriptCandidateRecord;
  script: SaveScriptResult;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Same shape as the agent save path; acceptance always creates a testable draft. */
function acceptName(candidate: ScriptCandidateRecord, input: AcceptCandidateInput): string {
  const name = input.name ?? candidate.suggestedName ?? '';
  if (name.trim() === '') {
    throw new ScriptError(
      'SCRIPT_CANDIDATE_INCOMPLETE',
      `candidate ${candidate.candidateId} has no suggested name; provide one in the accept body`,
    );
  }
  return name;
}

function acceptDescription(candidate: ScriptCandidateRecord, input: AcceptCandidateInput): string {
  const description = input.description ?? candidate.suggestedDescription ?? '';
  if (description.trim() === '') {
    throw new ScriptError(
      'SCRIPT_CANDIDATE_INCOMPLETE',
      `candidate ${candidate.candidateId} has no suggested description; provide one in the accept body`,
    );
  }
  return description;
}

export class ScriptCandidatesService {
  private readonly db: DatabaseSync;
  private readonly scripts: ScriptService;
  private readonly suggester: ScriptCandidateSuggester | null;
  private readonly now: () => number;
  private readonly log: LogFn | undefined;

  constructor(options: ScriptCandidatesServiceOptions) {
    this.db = options.db;
    this.scripts = options.scripts;
    this.suggester = options.suggester ?? null;
    this.now = options.now ?? Date.now;
    this.log = options.log;
  }

  /**
   * Clusters the recent successful code runs and upserts one candidate per
   * representative raw source. Reviewed candidates are frozen; pending ones
   * refresh their runs/score while keeping a previously stored AI suggestion
   * when this run's suggestion step fails.
   */
  async scan(input: ScanCandidatesInput = {}): Promise<ScanCandidatesResult> {
    const limit = Math.min(
      Math.max(input.limit ?? CANDIDATE_SCAN_DEFAULT, 1),
      CANDIDATE_SCAN_MAX,
    );
    const now = new Date(this.now()).toISOString();
    const runs = listCandidateSourceRuns(this.db, { now, limit });
    const samples = runs.map((run) => ({
      runId: run.runId,
      code: run.code,
      workspace: run.workspace,
      toolsUsed: run.toolsUsed,
      createdAt: run.createdAt,
      ...(run.execId === null ? {} : { sessionId: run.execId }),
    }));

    const warnings: string[] = [];
    const warn = (message: string): void => {
      if (warnings.includes(message)) return;
      warnings.push(message);
      this.log?.(message, { level: 'warn', scope: 'scripts' });
    };

    let created = 0;
    let updated = 0;
    for (const cluster of analyzeScriptRuns(samples)) {
      const pending = findPendingCandidateByCodeSha(this.db, cluster.codeSha256);
      if (pending === null && findReviewedCandidateByCodeSha(this.db, cluster.codeSha256) !== null) {
        continue;
      }

      let candidate = cluster;
      if (this.suggester !== null) {
        try {
          const suggestion = await this.suggester.suggest(cluster);
          candidate = applySuggestion(cluster, suggestion);
        } catch (error) {
          warn(
            `AI suggestion skipped for candidate ${cluster.codeSha256.slice(0, 12)}: ${errorMessage(error)}`,
          );
        }
      }

      const patch = {
        sourceRunIds: [...cluster.sourceRunIds],
        suggestedName: candidate.suggestedName,
        suggestedDescription: candidate.suggestedDescription,
        suggestedTags: [...candidate.suggestedTags],
        suggestedInputSchema: candidate.suggestedInputSchema,
        suggestedCode: candidate.suggestedCode,
        score: cluster.score,
      };
      if (pending === null) {
        insertCandidate(
          this.db,
          {
            code: cluster.code,
            codeSha256: cluster.codeSha256,
            workspace: cluster.workspaces[0] ?? 'default',
            score: cluster.score,
            suggestedName: patch.suggestedName,
            suggestedDescription: patch.suggestedDescription,
            suggestedTags: patch.suggestedTags,
            suggestedInputSchema: patch.suggestedInputSchema,
            suggestedCode: patch.suggestedCode,
            sourceRunIds: patch.sourceRunIds,
          },
          now,
        );
        created += 1;
        continue;
      }
      updatePendingCandidate(this.db, pending.candidateId, patch);
      updated += 1;
    }

    return { scanned: runs.length, created, updated, warnings };
  }

  list(query: CandidateListQuery): ReturnType<typeof listCandidates> {
    return listCandidates(this.db, query);
  }

  get(candidateId: string): ScriptCandidateRecord {
    const candidate = getCandidate(this.db, candidateId);
    if (candidate === null) {
      throw new ScriptError(
        'SCRIPT_CANDIDATE_NOT_FOUND',
        `candidate ${candidateId} was not found`,
      );
    }
    return candidate;
  }

  /**
   * Accepts a pending candidate through the same `save_script` validation and
   * always produces a draft. When the candidate has no usable parameterized
   * suggestion, its raw code runs with an empty schema instead.
   */
  accept(candidateId: string, input: AcceptCandidateInput = {}): AcceptCandidateResult {
    const candidate = this.get(candidateId);
    if (candidate.status !== 'pending') {
      throw new ScriptError(
        'SCRIPT_CANDIDATE_ALREADY_REVIEWED',
        `candidate ${candidateId} is already ${candidate.status}`,
      );
    }

    // Both halves are needed: code rewritten around `args` without a schema
    // would reject every argument, so a partial suggestion falls back as a pair.
    const suggestion =
      candidate.suggestedCode !== null && candidate.suggestedInputSchema !== null
        ? { code: candidate.suggestedCode, inputSchema: candidate.suggestedInputSchema }
        : null;
    const name = acceptName(candidate, input);
    const description = acceptDescription(candidate, input);
    const code = input.code ?? suggestion?.code ?? candidate.code;
    const inputSchema = input.inputSchema ?? suggestion?.inputSchema ?? EMPTY_INPUT_SCHEMA;
    const tags = input.tags ?? candidate.suggestedTags ?? [];
    const reviewedAt = new Date(this.now()).toISOString();

    return withTransaction(this.db, () => {
      const saved = this.scripts.save(
        { createdBy: 'admin', isAdmin: true },
        {
          mode: 'parameterized',
          name,
          description,
          tags,
          code,
          inputSchema,
          ...(input.exampleArgs === undefined ? {} : { exampleArgs: input.exampleArgs }),
        },
      );
      const accepted = markCandidateAccepted(this.db, candidateId, saved.scriptId, 'admin', reviewedAt);
      if (accepted === null) {
        throw new ScriptError(
          'SCRIPT_CANDIDATE_ALREADY_REVIEWED',
          `candidate ${candidateId} is no longer pending`,
        );
      }
      return { candidate: accepted, script: saved };
    });
  }

  reject(candidateId: string): ScriptCandidateRecord {
    const candidate = this.get(candidateId);
    if (candidate.status !== 'pending') {
      throw new ScriptError(
        'SCRIPT_CANDIDATE_ALREADY_REVIEWED',
        `candidate ${candidateId} is already ${candidate.status}`,
      );
    }
    const rejected = markCandidateRejected(
      this.db,
      candidateId,
      'admin',
      new Date(this.now()).toISOString(),
    );
    if (rejected === null) {
      throw new ScriptError(
        'SCRIPT_CANDIDATE_ALREADY_REVIEWED',
        `candidate ${candidateId} is no longer pending`,
      );
    }
    return rejected;
  }
}
