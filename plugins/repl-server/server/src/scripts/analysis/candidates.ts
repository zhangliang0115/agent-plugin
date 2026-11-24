/**
 * P3 candidate scan (design 10 §10): cluster successful code runs globally,
 * score them, and attach deterministic suggestions. Pure and offline; the AI
 * suggester is only a contract that `applySuggestion` can fold in later.
 * @module
 */

import {
  countDeclarations,
  countLiterals,
  hashScriptCode,
  literalShape,
  literalSignature,
  tokenizeScriptCode,
  type CodeToken,
} from './normalize.ts';
import { scoreCluster } from './score.ts';
import type {
  ScriptCandidate,
  ScriptCandidateSuggestion,
  ScriptRunSample,
} from './types.ts';

const DEFAULT_WORKSPACE = 'default';
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_TAGS = 10;

interface SampleFeatures {
  readonly sample: ScriptRunSample;
  readonly workspace: string;
  readonly sessionKey: string;
  readonly shape: string;
  readonly signature: string;
  readonly literalCount: number;
  readonly declarationCount: number;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareTime(left: string, right: string): number {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isNaN(leftMs) && !Number.isNaN(rightMs)) return leftMs - rightMs;
  return compareText(left, right);
}

function truncate(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

function normalizeWorkspace(workspace: string): string {
  const text = workspace.trim();
  return text === '' ? DEFAULT_WORKSPACE : text;
}

function dayOf(createdAt: string): string {
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? createdAt.slice(0, 10) : new Date(ms).toISOString().slice(0, 10);
}

/**
 * `script_runs` exposes `exec_id`; when the caller cannot pass it, one
 * workspace + calendar day is the closest available stand-in for a session.
 */
function sessionKeyOf(sample: ScriptRunSample, workspace: string): string {
  const sessionId = sample.sessionId?.trim();
  return sessionId === undefined || sessionId === ''
    ? `context:${workspace}\u0000${dayOf(sample.createdAt)}`
    : `session:${sessionId}`;
}

function compareRuns(left: ScriptRunSample, right: ScriptRunSample): number {
  return (
    compareText(left.runId, right.runId) ||
    compareText(left.code, right.code) ||
    compareText(left.workspace, right.workspace) ||
    compareText(left.createdAt, right.createdAt) ||
    compareText(left.sessionId ?? '', right.sessionId ?? '') ||
    compareText(left.toolsUsed.join('\u0000'), right.toolsUsed.join('\u0000'))
  );
}

/** Invalid duplicate run ids are ignored deterministically, independent of input order. */
function dedupeRuns(runs: readonly ScriptRunSample[]): ScriptRunSample[] {
  const seen = new Set<string>();
  const unique: ScriptRunSample[] = [];
  for (const run of [...runs].sort(compareRuns)) {
    if (seen.has(run.runId)) continue;
    seen.add(run.runId);
    unique.push(run);
  }
  return unique;
}

function toFeatures(sample: ScriptRunSample): SampleFeatures | null {
  const tokens = tokenizeScriptCode(sample.code);
  if (tokens.length === 0) return null;
  const workspace = normalizeWorkspace(sample.workspace);
  return {
    sample,
    workspace,
    sessionKey: sessionKeyOf(sample, workspace),
    shape: literalShape(tokens),
    signature: literalSignature(tokens),
    literalCount: countLiterals(tokens),
    declarationCount: countDeclarations(tokens),
  };
}

interface RawCodeStat {
  count: number;
  latestAt: string;
  feature: SampleFeatures;
}

/**
 * Most frequent raw code wins; ties go to the most recent run, then to the
 * lexicographically smallest source so the result never depends on input order.
 */
function pickRepresentative(features: readonly SampleFeatures[]): SampleFeatures {
  const stats = new Map<string, RawCodeStat>();
  for (const feature of features) {
    const code = feature.sample.code;
    const existing = stats.get(code);
    if (existing === undefined) {
      stats.set(code, { count: 1, latestAt: feature.sample.createdAt, feature });
      continue;
    }
    existing.count += 1;
    if (compareTime(feature.sample.createdAt, existing.latestAt) > 0) {
      existing.latestAt = feature.sample.createdAt;
    }
  }

  let chosen: RawCodeStat | null = null;
  let chosenCode = '';
  for (const [code, stat] of stats) {
    if (chosen === null) {
      chosen = stat;
      chosenCode = code;
      continue;
    }
    if (stat.count !== chosen.count) {
      if (stat.count > chosen.count) {
        chosen = stat;
        chosenCode = code;
      }
      continue;
    }
    const timeOrder = compareTime(stat.latestAt, chosen.latestAt);
    if (timeOrder > 0 || (timeOrder === 0 && code < chosenCode)) {
      chosen = stat;
      chosenCode = code;
    }
  }
  // `features` is non-empty and every entry registers in `stats`.
  return (chosen as RawCodeStat).feature;
}

function humanizeTool(tool: string): string {
  const dot = tool.indexOf('.');
  const server = dot === -1 ? '' : tool.slice(0, dot);
  const method = dot === -1 ? tool : tool.slice(dot + 1);
  const words = method.replace(/_/gu, ' ').trim();
  if (server === '') return words === '' ? tool : words;
  return words === '' ? server : `${server}: ${words}`;
}

/** Most frequently used tool across the cluster; ties resolve lexicographically. */
function primaryTool(toolCounts: ReadonlyMap<string, number>): string | null {
  let primary: string | null = null;
  for (const [tool, count] of toolCounts) {
    if (primary === null) {
      primary = tool;
      continue;
    }
    const primaryCount = toolCounts.get(primary) ?? 0;
    if (count > primaryCount || (count === primaryCount && tool < primary)) primary = tool;
  }
  return primary;
}

function suggestedName(tool: string | null): string | null {
  return tool === null ? null : truncate(humanizeTool(tool), MAX_NAME_LENGTH);
}

function suggestedTags(toolsUsed: readonly string[]): string[] {
  const tags = new Set<string>();
  for (const tool of toolsUsed) {
    const server = tool.split('.')[0] ?? '';
    tags.add(server === '' ? tool : server);
    if (tags.size === MAX_TAGS) break;
  }
  return [...tags].sort();
}

function suggestedDescription(
  runCount: number,
  sessionCount: number,
  toolsUsed: readonly string[],
): string {
  const times = runCount === 1 ? 'time' : 'times';
  const sessions = sessionCount === 1 ? 'session' : 'sessions';
  const tools = toolsUsed.length === 0 ? '' : ` using ${toolsUsed.join(', ')}`;
  return truncate(
    `Reused ${runCount} ${times} across ${sessionCount} ${sessions}${tools}.`,
    MAX_DESCRIPTION_LENGTH,
  );
}

function buildCandidate(features: readonly SampleFeatures[]): ScriptCandidate {
  const representative = pickRepresentative(features);
  const runIds = new Set<string>();
  const workspaces = new Set<string>();
  const tools = new Set<string>();
  const toolCounts = new Map<string, number>();
  const signatures = new Set<string>();
  const sessions = new Set<string>();
  let firstSeenAt = representative.sample.createdAt;
  let lastSeenAt = representative.sample.createdAt;

  for (const feature of features) {
    runIds.add(feature.sample.runId);
    workspaces.add(feature.workspace);
    sessions.add(feature.sessionKey);
    signatures.add(feature.signature);
    const runTools = new Set<string>();
    for (const tool of feature.sample.toolsUsed) {
      const name = tool.trim();
      if (name !== '') runTools.add(name);
    }
    for (const tool of runTools) {
      tools.add(tool);
      toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    }
    if (compareTime(feature.sample.createdAt, firstSeenAt) < 0) firstSeenAt = feature.sample.createdAt;
    if (compareTime(feature.sample.createdAt, lastSeenAt) > 0) lastSeenAt = feature.sample.createdAt;
  }

  const toolsUsed = [...tools].sort();
  const sourceRunIds = [...runIds].sort();
  const score = scoreCluster({
    runCount: sourceRunIds.length,
    sessionCount: sessions.size,
    literalCount: representative.literalCount,
    declarationCount: representative.declarationCount,
    literalVariantCount: signatures.size,
    toolCount: toolsUsed.length,
  });

  return {
    codeSha256: hashScriptCode(representative.sample.code),
    code: representative.sample.code,
    sourceRunIds,
    score,
    runCount: sourceRunIds.length,
    sessionCount: sessions.size,
    workspaces: [...workspaces].sort(),
    toolsUsed,
    firstSeenAt,
    lastSeenAt,
    suggestedName: suggestedName(primaryTool(toolCounts)),
    suggestedDescription: suggestedDescription(sourceRunIds.length, sessions.size, toolsUsed),
    suggestedTags: suggestedTags(toolsUsed),
    suggestedInputSchema: null,
    suggestedCode: null,
  };
}

/**
 * Clusters all successful runs by literal shape -- normalized code with
 * literals blinded -- across workspaces. Runs that differ only in formatting,
 * comments or hardcoded values land in one candidate, which is exactly the
 * parameterization signal; identical code lands there too.
 */
export function analyzeScriptRuns(runs: readonly ScriptRunSample[]): ScriptCandidate[] {
  const clusters = new Map<string, SampleFeatures[]>();
  for (const run of dedupeRuns(runs)) {
    const features = toFeatures(run);
    if (features === null) continue;
    const cluster = clusters.get(features.shape);
    if (cluster === undefined) clusters.set(features.shape, [features]);
    else cluster.push(features);
  }

  const candidates = [...clusters.values()].map(buildCandidate);
  candidates.sort(
    (left, right) =>
      right.score - left.score ||
      right.runCount - left.runCount ||
      compareText(left.codeSha256, right.codeSha256),
  );
  return candidates;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeText(current: string | null, value: string | undefined, max: number): string | null {
  if (typeof value !== 'string') return current;
  const text = value.trim();
  return text === '' ? current : truncate(text, max);
}

function mergeTags(tags: readonly string[]): string[] {
  const merged: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (tag === '' || merged.includes(tag)) continue;
    merged.push(tag);
    if (merged.length === MAX_TAGS) break;
  }
  return merged;
}

/**
 * Folds an AI suggestion into a candidate without calling a model. Empty or
 * malformed entries keep the deterministic value; tags are trimmed,
 * deduplicated and capped like `save_script` does.
 */
export function applySuggestion(
  candidate: ScriptCandidate,
  suggestion: ScriptCandidateSuggestion | null,
): ScriptCandidate {
  if (suggestion === null) return candidate;
  return {
    ...candidate,
    suggestedName: mergeText(candidate.suggestedName, suggestion.name, MAX_NAME_LENGTH),
    suggestedDescription: mergeText(
      candidate.suggestedDescription,
      suggestion.description,
      MAX_DESCRIPTION_LENGTH,
    ),
    suggestedTags: suggestion.tags === undefined ? candidate.suggestedTags : mergeTags(suggestion.tags),
    suggestedInputSchema:
      suggestion.inputSchema === undefined
        ? candidate.suggestedInputSchema
        : isPlainObject(suggestion.inputSchema)
          ? suggestion.inputSchema
          : null,
    suggestedCode:
      suggestion.code === undefined
        ? candidate.suggestedCode
        : typeof suggestion.code === 'string' && suggestion.code.trim() !== ''
          ? suggestion.code
          : null,
  };
}
