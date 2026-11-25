/** `search_tools` over an immutable catalog snapshot. @module */

import type { CatalogSnapshot, CatalogTool } from '../ports.ts';
import { canonicalToolName } from './registry.ts';

export interface SearchToolsInput {
  query?: string;
  /** MCP server id filter; excludes built-in tools when set. */
  server?: string;
  category?: string;
  tags?: string[];
  max?: number;
  /** Binding server allow list: null/undefined is unrestricted, [] hides every MCP tool. */
  allowedServers?: readonly string[] | null;
  /** Binding tag allow list (any-of): null/undefined is unrestricted, [] hides every tool. */
  allowedTags?: readonly string[] | null;
}

/** Visibility shared by `search_tools` and `describe_tools`. */
export interface ToolVisibility {
  allowedServers?: readonly string[] | null;
  allowedTags?: readonly string[] | null;
}

/** One protocol-level result item; MCP names are `<server>.<tool>`, built-ins are bare. */
export interface SearchToolItem {
  name: string;
  kind: 'builtin' | 'mcp';
  server?: string;
  category?: string;
  summary?: string;
  toolCount?: number;
  description?: string;
  tags?: string[];
}

export const SEARCH_DEFAULT_MAX = 10;

/** Pseudo server id used by the overview to group the official bare-name tools. */
export const OFFICIAL_TOOL_GROUP = '__official__';

/** Locale-independent ordering keeps tools/list and search results stable across machines. */
export function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeTags(tags: readonly string[]): string[] {
  return tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== '');
}

/**
 * Applies the binding allow lists. `allowedServers` constrains MCP tools only;
 * `allowedTags` is any-of over the effective tags and constrains builtins too.
 * Empty lists hide everything they cover.
 */
export function isToolVisible(tool: CatalogTool, visibility: ToolVisibility = {}): boolean {
  const { allowedServers, allowedTags } = visibility;
  if (allowedServers != null && tool.kind === 'mcp') {
    if (allowedServers.length === 0) return false;
    if (tool.server === undefined || !allowedServers.includes(tool.server)) return false;
  }
  if (allowedTags != null) {
    if (allowedTags.length === 0) return false;
    const allowed = new Set(normalizeTags(allowedTags));
    const tags = normalizeTags(tool.tags ?? []);
    if (!tags.some((tag) => allowed.has(tag))) return false;
  }
  return true;
}

export function matchesFilters(tool: CatalogTool, input: SearchToolsInput): boolean {
  if (input.server !== undefined) {
    if (input.server === OFFICIAL_TOOL_GROUP) {
      if (tool.kind !== 'builtin') return false;
    } else if (tool.kind !== 'mcp' || tool.server !== input.server) {
      return false;
    }
  }
  if (input.category !== undefined && tool.category !== input.category) return false;
  if (input.tags !== undefined && input.tags.length > 0) {
    const toolTags = tool.tags ?? [];
    for (const tag of input.tags) {
      if (!toolTags.includes(tag)) return false;
    }
  }
  return true;
}

export function toItem(tool: CatalogTool, name: string): SearchToolItem {
  const item: SearchToolItem = { name, kind: tool.kind };
  if (tool.kind === 'mcp' && tool.server !== undefined) item.server = tool.server;
  if (tool.category !== undefined) item.category = tool.category;
  if (tool.summary !== undefined) item.summary = tool.summary;
  if (tool.description !== undefined) item.description = tool.description;
  if (tool.tags !== undefined && tool.tags.length > 0) item.tags = [...tool.tags];
  return item;
}

/**
 * Ranking only compares scores, so the absolute scale is irrelevant; zero means
 * no match. Canonical names match exactly (`pg.query`), but substring matching
 * uses the bare tool name so the server id never becomes a keyword.
 */
export function scoreTool(tool: CatalogTool, canonicalName: string, terms: readonly string[]): number {
  const canonical = canonicalName.toLowerCase();
  const bareName = tool.name.toLowerCase();
  const tags = (tool.tags ?? []).map((tag) => tag.toLowerCase());
  const description = (tool.description ?? '').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (canonical === term || bareName === term) score += 10;
    else if (bareName.includes(term)) score += 3;

    if (tags.some((tag) => tag === term)) score += 2;
    else if (tags.some((tag) => tag.includes(term))) score += 1;
    if (description.includes(term)) score += 1;
  }
  return score;
}

function visibleTools(snapshot: CatalogSnapshot, input: SearchToolsInput): CatalogTool[] {
  return snapshot.tools.filter(
    (tool) => tool.enabled && isToolVisible(tool, input) && matchesFilters(tool, input),
  );
}

/**
 * Discovery semantics:
 * - empty query, no `server`: server overview (category, summary, tags, tool count);
 * - empty query, `server` set: that server's tools, alphabetically, up to `max`;
 * - non-empty query: tool search over name, tags and description, with
 *   server/category/tags as structural narrowing only.
 * Server summary and server id never participate in keyword matching.
 */
export function searchTools(snapshot: CatalogSnapshot, input: SearchToolsInput): SearchToolItem[] {
  const tools = visibleTools(snapshot, input);
  // A negative or non-finite max turns `slice` into "all but N" or no cap.
  const requested = input.max ?? SEARCH_DEFAULT_MAX;
  const limit = Number.isSafeInteger(requested) && requested > 0 ? requested : SEARCH_DEFAULT_MAX;
  const query = (input.query ?? '').trim();

  if (query === '') {
    if (input.server !== undefined) {
      return tools
        .map((tool) => ({ tool, name: canonicalToolName(tool) }))
        .sort((left, right) => compareNames(left.name, right.name))
        .slice(0, limit)
        .map((entry) => toItem(entry.tool, entry.name));
    }
    const servers = new Map<
      string,
      { count: number; tags: Set<string>; category?: string; summary?: string }
    >();
    for (const tool of tools) {
      if (tool.kind !== 'mcp' || tool.server === undefined || tool.server === '') continue;
      const summary = servers.get(tool.server) ?? { count: 0, tags: new Set<string>() };
      summary.count += 1;
      for (const tag of tool.tags ?? []) summary.tags.add(tag);
      if (summary.category === undefined && tool.category !== undefined) {
        summary.category = tool.category;
      }
      if (summary.summary === undefined && tool.summary !== undefined) {
        summary.summary = tool.summary;
      }
      servers.set(tool.server, summary);
    }
    const items: SearchToolItem[] = [];
    const builtins = tools.filter((tool) => tool.kind === 'builtin');
    if (builtins.length > 0) {
      const item: SearchToolItem = {
        name: OFFICIAL_TOOL_GROUP,
        kind: 'builtin',
        toolCount: builtins.length,
        description: `${builtins.length} tool${builtins.length === 1 ? '' : 's'}; call tools.<tool>(args)`,
        summary: 'Official Claude Code tools',
      };
      const tags = new Set<string>();
      for (const tool of builtins) for (const tag of tool.tags ?? []) tags.add(tag);
      if (tags.size > 0) item.tags = [...tags].sort((left, right) => compareNames(left, right));
      items.push(item);
    }
    const serverItems = [...servers.entries()]
      .sort(([left], [right]) => compareNames(left, right))
      .map(([server, summary]) => {
        const item: SearchToolItem = {
          name: server,
          kind: 'mcp',
          server,
          toolCount: summary.count,
          description: `${summary.count} tool${summary.count === 1 ? '' : 's'}; call tools.mcp.${server}.<tool>(args)`,
        };
        if (summary.category !== undefined) item.category = summary.category;
        if (summary.summary !== undefined) item.summary = summary.summary;
        if (summary.tags.size > 0) {
          item.tags = [...summary.tags].sort((left, right) => compareNames(left, right));
        }
        return item;
      });
    items.push(...serverItems);
    return items.slice(0, limit);
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  const scored: Array<{ item: SearchToolItem; name: string; score: number }> = [];
  for (const tool of tools) {
    const name = canonicalToolName(tool);
    const score = scoreTool(tool, name, terms);
    if (score <= 0) continue;
    scored.push({ item: toItem(tool, name), name, score });
  }
  scored.sort((left, right) => right.score - left.score || compareNames(left.name, right.name));
  return scored.slice(0, limit).map((entry) => entry.item);
}
