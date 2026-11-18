/** `search_tools` over an immutable catalog snapshot. @module */

import type { CatalogSnapshot, CatalogTool } from '../ports.ts';
import { canonicalToolName } from './registry.ts';

export interface SearchToolsInput {
  query?: string;
  category?: string;
  tags?: string[];
  max?: number;
}

/** One protocol-level result item; MCP names are `<server>.<tool>`, built-ins are bare. */
export interface SearchToolItem {
  name: string;
  kind: 'builtin' | 'mcp';
  server?: string;
  description?: string;
  tags?: string[];
}

export const SEARCH_DEFAULT_MAX = 10;

/** Locale-independent ordering keeps tools/list and search results stable across machines. */
function compareNames(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Category is server-level in the config model but CatalogTool does not expose it yet, so a
 * snapshot may still carry the extra field at runtime. Fall back to the server id for MCP tools;
 * built-ins are their own group.
 */
type CatalogToolWithCategory = CatalogTool & { category?: string };

function matchesFilters(tool: CatalogTool, input: SearchToolsInput): boolean {
  if (input.category !== undefined) {
    const declared = (tool as CatalogToolWithCategory).category;
    if (declared !== undefined) {
      if (declared !== input.category) return false;
    } else if (tool.kind === 'mcp') {
      if (tool.server !== input.category) return false;
    } else if (input.category !== 'builtin') {
      return false;
    }
  }
  if (input.tags !== undefined && input.tags.length > 0) {
    const toolTags = tool.tags ?? [];
    for (const tag of input.tags) {
      if (!toolTags.includes(tag)) return false;
    }
  }
  return true;
}

function toItem(tool: CatalogTool, name: string): SearchToolItem {
  const item: SearchToolItem = { name, kind: tool.kind };
  if (tool.kind === 'mcp' && tool.server !== undefined) item.server = tool.server;
  if (tool.description !== undefined) item.description = tool.description;
  if (tool.tags !== undefined && tool.tags.length > 0) item.tags = [...tool.tags];
  return item;
}

/** Ranking only compares scores, so the absolute scale is irrelevant; zero means no match. */
function scoreTool(tool: CatalogTool, canonicalName: string, terms: readonly string[]): number {
  const canonical = canonicalName.toLowerCase();
  const bareName = tool.name.toLowerCase();
  const tags = (tool.tags ?? []).map((tag) => tag.toLowerCase());
  const server = (tool.server ?? '').toLowerCase();
  const description = (tool.description ?? '').toLowerCase();

  let score = 0;
  for (const term of terms) {
    if (canonical === term || bareName === term) score += 10;
    else if (canonical.includes(term)) score += 4;
    else if (bareName.includes(term)) score += 3;

    if (tags.some((tag) => tag === term)) score += 2;
    else if (tags.some((tag) => tag.includes(term))) score += 1;
    if (server.includes(term)) score += 1.5;
    if (description.includes(term)) score += 1;
  }
  return score;
}

function enabledTools(snapshot: CatalogSnapshot): CatalogTool[] {
  return snapshot.tools.filter((tool) => tool.enabled);
}

/**
 * Empty query returns the server overview: one item per MCP server with its tool count and the
 * call form. Non-empty queries score name, tags, server and description and return at most `max`.
 */
export function searchTools(snapshot: CatalogSnapshot, input: SearchToolsInput): SearchToolItem[] {
  const tools = enabledTools(snapshot).filter((tool) => matchesFilters(tool, input));
  const limit = input.max ?? SEARCH_DEFAULT_MAX;
  const query = (input.query ?? '').trim();

  if (query === '') {
    const servers = new Map<string, { count: number; tags: Set<string> }>();
    for (const tool of tools) {
      if (tool.kind !== 'mcp' || tool.server === undefined || tool.server === '') continue;
      const summary = servers.get(tool.server) ?? { count: 0, tags: new Set<string>() };
      summary.count += 1;
      for (const tag of tool.tags ?? []) summary.tags.add(tag);
      servers.set(tool.server, summary);
    }
    return [...servers.entries()]
      .sort(([left], [right]) => compareNames(left, right))
      .slice(0, limit)
      .map(([server, summary]) => {
        const item: SearchToolItem = {
          name: server,
          kind: 'mcp',
          server,
          description: `${summary.count} tool${summary.count === 1 ? '' : 's'}; call tools.mcp.${server}.<tool>(args)`,
        };
        if (summary.tags.size > 0) {
          item.tags = [...summary.tags].sort((left, right) => compareNames(left, right));
        }
        return item;
      });
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
