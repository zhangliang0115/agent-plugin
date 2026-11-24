/**
 * Descriptive-tag policy shared by admin writes and AI annotations.
 *
 * Server tags are inherited by every tool, so they may only carry values that
 * hold for the whole server. Tool tags add specificity and never repeat an
 * inherited key. Action-like keys (`read`, `write`, `query`, `exec`, `deploy`,
 * `destructive`) describe behaviour, not subject matter, and must not be stored
 * as tags.
 * @module
 */

export const SERVER_TAG_LIMIT = 2;
export const TOOL_TAG_LIMIT = 4;

/** Action keys that must never be stored in `servers.tags_json` or `tools.tags_json`. */
export const ACTION_TAG_KEYS: ReadonlySet<string> = new Set([
  'read',
  'write',
  'query',
  'exec',
  'deploy',
  'destructive',
]);

export type TagPolicyCode =
  | 'TAG_ACTION_KEY'
  | 'TAG_SERVER_LIMIT'
  | 'TAG_TOOL_LIMIT'
  | 'TAG_TOOL_EMPTY'
  | 'TAG_TOOL_INHERITED';

export interface TagPolicyIssue {
  code: TagPolicyCode;
  message: string;
}

export interface TagPolicyResult {
  serverTags: string[];
  toolTags: string[];
  effectiveTags: string[];
  /** Tool tags that repeated a server tag, before any repair. */
  inheritedDuplicates: string[];
  issues: TagPolicyIssue[];
}

export interface TagPolicyOptions {
  /** Remove tool tags that repeat a server tag instead of reporting them. */
  repairInherited?: boolean;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function effectiveTags(
  serverTags: readonly string[],
  toolTags: readonly string[],
): string[] {
  return unique([...serverTags, ...toolTags]);
}

/**
 * Evaluates one tool against its server's tags. The effective set is what
 * `search_tools` and `run_script` see: `server.tags ∪ tool.tags`.
 */
export function evaluateTagPolicy(
  serverTagsInput: readonly string[],
  toolTagsInput: readonly string[],
  options: TagPolicyOptions = {},
): TagPolicyResult {
  const serverTags = unique(serverTagsInput);
  const rawToolTags = unique(toolTagsInput);
  const serverSet = new Set(serverTags);
  const inheritedDuplicates = rawToolTags.filter((tag) => serverSet.has(tag));
  const repair = options.repairInherited === true;
  const toolTags = repair ? rawToolTags.filter((tag) => !serverSet.has(tag)) : rawToolTags;
  const effective = effectiveTags(serverTags, toolTags);
  const issues: TagPolicyIssue[] = [];

  const actionKeys = unique(
    [...serverTags, ...toolTags].filter((tag) => ACTION_TAG_KEYS.has(tag)),
  );
  if (actionKeys.length > 0) {
    issues.push({
      code: 'TAG_ACTION_KEY',
      message: `action keys cannot be tags: ${actionKeys.join(', ')}`,
    });
  }
  if (serverTags.length > SERVER_TAG_LIMIT) {
    issues.push({
      code: 'TAG_SERVER_LIMIT',
      message: `server tags must be at most ${SERVER_TAG_LIMIT} (got ${serverTags.length})`,
    });
  }
  if (effective.length > TOOL_TAG_LIMIT) {
    issues.push({
      code: 'TAG_TOOL_LIMIT',
      message: `effective tags must be at most ${TOOL_TAG_LIMIT} (got ${effective.length})`,
    });
  }
  if (effective.length === 0) {
    issues.push({
      code: 'TAG_TOOL_EMPTY',
      message: 'a tool must keep at least 1 effective tag',
    });
  }
  if (inheritedDuplicates.length > 0 && !repair) {
    issues.push({
      code: 'TAG_TOOL_INHERITED',
      message: `tool tags repeat server tags: ${inheritedDuplicates.join(', ')}`,
    });
  }

  return { serverTags, toolTags, effectiveTags: effective, inheritedDuplicates, issues };
}

/** Server-only checks. An empty server tag list is allowed; tools carry the minimum. */
export function evaluateServerTags(tags: readonly string[]): TagPolicyIssue[] {
  const serverTags = unique(tags);
  const issues: TagPolicyIssue[] = [];
  const actionKeys = serverTags.filter((tag) => ACTION_TAG_KEYS.has(tag));
  if (actionKeys.length > 0) {
    issues.push({
      code: 'TAG_ACTION_KEY',
      message: `action keys cannot be tags: ${actionKeys.join(', ')}`,
    });
  }
  if (serverTags.length > SERVER_TAG_LIMIT) {
    issues.push({
      code: 'TAG_SERVER_LIMIT',
      message: `server tags must be at most ${SERVER_TAG_LIMIT} (got ${serverTags.length})`,
    });
  }
  return issues;
}

export function formatTagPolicyIssues(issues: readonly TagPolicyIssue[]): string[] {
  return issues.map((issue) => `${issue.code}: ${issue.message}`);
}
