/**
 * Per-client MCP server overview: visibility filtering and the two dynamic
 * text fragments (`run_script.description`, discover `instructions`).
 * Design 01 §7.2/§7.3, 03 §6.2: assembled per request, never cached.
 * @module
 */

/** Server fields the overview needs; `ServerRecord` is structurally assignable. */
export interface McpServerSource {
  readonly id: string;
  readonly transport: string;
  readonly enabled: boolean;
  readonly category: string | null;
  readonly tags: readonly string[];
}

/** Tool fields the overview needs; `CatalogTool` is structurally assignable. */
export interface McpToolSource {
  readonly name: string;
  readonly kind: 'builtin' | 'mcp';
  readonly server?: string;
  readonly tags?: string[];
  readonly enabled: boolean;
}

/** One visible server, already filtered for this client. */
export interface McpServerOverview {
  readonly id: string;
  readonly category: string;
  readonly tags: readonly string[];
  readonly toolCount: number;
  readonly toolNames: readonly string[];
}

export interface VisibleServerInput {
  readonly servers: readonly McpServerSource[];
  readonly tools: readonly McpToolSource[];
  /** `client_bindings.allowed_servers`: null is unrestricted, [] is none. */
  readonly allowedServers: readonly string[] | null;
  /** `client_bindings.allowed_tags`: null is unrestricted, [] is none. */
  readonly allowedTags: readonly string[] | null;
}

/** UTF-8 ceiling for `run_script.description` (design 01 §7.2). */
export const DESCRIPTION_MAX_BYTES = 2048;

const NO_SERVERS = 'No MCP servers are visible to this client.';
const BUILTIN_HEADER = '\n\n## Built-in tools (call by bare name)\n\n';
const BUILTIN_CALL = '\nCall: tools.<name>(args)';
const MCP_HEADER = '\n\n## MCP servers (server id, category, visible tool count)\n\n';
const FIXED_GUIDANCE = [
  'Call: tools.mcp.<server>.<tool>(args)',
  'Find: search_tools({ query, server?, category?, tags? })',
  'Args: describe_tools({ names })',
].join('\n');
const ID_MAX_CHARS = 48;
const CATEGORY_MAX_CHARS = 24;

/** Collapses untrusted admin/AI text to one line and clips it. */
export function clipText(value: string | null | undefined, maxChars: number): string {
  const text = (value ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...text];
  if (chars.length <= maxChars) return text;
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}…`;
}

function normalizeTags(tags: readonly string[]): string[] {
  return tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag !== '');
}

function intersects(tags: readonly string[] | undefined, allowed: ReadonlySet<string>): boolean {
  return (tags ?? []).some((tag) => allowed.has(tag.trim().toLowerCase()));
}

/**
 * Filters the configured servers down to what this client may see.
 *
 * Disabled servers, builtin-transport servers (their tools are called by bare
 * name, not `tools.mcp.*`) and servers outside `allowedServers` are dropped.
 * `allowedTags` narrows both the server and its tool count, matching
 * `search_tools` visibility: a server stays listed when its own tags match or
 * when one of its tools matches; idle servers (no rows yet) still show when
 * their server tags match. Empty allow lists match nothing.
 */
export function collectVisibleMcpServers(input: VisibleServerInput): McpServerOverview[] {
  const allowedServers = input.allowedServers === null ? null : new Set(input.allowedServers);
  const allowedTags = input.allowedTags === null ? null : new Set(normalizeTags(input.allowedTags));

  const toolsByServer = new Map<string, McpToolSource[]>();
  for (const tool of input.tools) {
    if (tool.kind !== 'mcp' || tool.server === undefined || tool.enabled !== true) continue;
    const list = toolsByServer.get(tool.server);
    if (list === undefined) toolsByServer.set(tool.server, [tool]);
    else list.push(tool);
  }

  const overviews: McpServerOverview[] = [];
  for (const server of input.servers) {
    if (!server.enabled || server.transport === 'builtin') continue;
    if (allowedServers !== null && !allowedServers.has(server.id)) continue;

    const tools = toolsByServer.get(server.id) ?? [];
    const visibleTools =
      allowedTags === null ? tools : tools.filter((tool) => intersects(tool.tags, allowedTags));
    if (
      allowedTags !== null
      && !intersects(server.tags, allowedTags)
      && visibleTools.length === 0
    ) {
      continue;
    }

    overviews.push({
      id: server.id,
      category: clipText(server.category, CATEGORY_MAX_CHARS),
      tags: [...server.tags],
      toolCount: visibleTools.length,
      toolNames: visibleTools.map((tool) => tool.name),
    });
  }
  return overviews;
}

/**
 * One `## MCP servers` line: `<id>  [<category>]  <N> tools`. Summary, tool
 * names and tags stay out of the 2KB description; `search_tools` carries them.
 */
export function formatServerLine(server: McpServerOverview): string {
  const id = clipText(server.id, ID_MAX_CHARS) || '(unnamed server)';
  const category = clipText(server.category, CATEGORY_MAX_CHARS) || 'other';
  return `${id}  [${category}]  ${server.toolCount} tools`;
}

/**
 * `## Built-in tools` block: every visible official tool name, packed left to
 * right within `budget` bytes. A dropped tail is counted, not silent.
 */
function builtinBlock(names: readonly string[], budget: number): string {
  if (names.length === 0) return '';
  const fixed = Buffer.byteLength(BUILTIN_HEADER, 'utf8') + Buffer.byteLength(BUILTIN_CALL, 'utf8');
  if (fixed >= budget) return '';

  const unique = [...new Set(names)].sort();
  let left = budget - fixed;
  const kept: string[] = [];
  for (const name of unique) {
    const cost = Buffer.byteLength(name, 'utf8') + (kept.length === 0 ? 0 : 2);
    if (cost > left) break;
    kept.push(name);
    left -= cost;
  }
  if (kept.length === 0) return '';

  let list = kept.join(', ');
  let dropped = unique.length - kept.length;
  // Make room for the count note rather than dropping the tail silently.
  while (dropped > 0) {
    const note = ` … (+${dropped} more via search_tools)`;
    if (Buffer.byteLength(note, 'utf8') <= left) {
      list += note;
      break;
    }
    const removed = kept.pop();
    if (removed === undefined) break;
    left += Buffer.byteLength(removed, 'utf8') + (kept.length === 0 ? 0 : 2);
    list = kept.join(', ');
    dropped = unique.length - kept.length;
  }
  return `${BUILTIN_HEADER}${list}${BUILTIN_CALL}`;
}

/**
 * Builds the session-specific `run_script.description`.
 *
 * The static rules in `base` are never truncated. Built-in tools come first
 * (they are always callable and few), then MCP server lines; both are dropped
 * from the tail once the UTF-8 budget is spent. The `Call`/`Find`/`Args`
 * guidance is reserved up front so it always survives truncation. With no
 * visible servers the section says so instead of staying empty. An empty
 * `builtinNames` (official sync unavailable, tools disabled by policy, or the
 * caller has no tag permission) omits the block entirely.
 */
export function buildRunScriptDescription(
  base: string,
  servers: readonly McpServerOverview[],
  builtinNames: readonly string[] = [],
): string {
  const suffix = `\n\n${FIXED_GUIDANCE}`;
  let budget = DESCRIPTION_MAX_BYTES
    - Buffer.byteLength(base, 'utf8')
    - Buffer.byteLength(suffix, 'utf8');
  // The fixed core and guidance are reserved first; everything after is optional.
  if (budget <= 0) return `${base}${suffix}`;

  let description = base;
  const builtins = builtinBlock(builtinNames, budget);
  if (builtins !== '') {
    description += builtins;
    budget -= Buffer.byteLength(builtins, 'utf8');
  }

  const headerCost = Buffer.byteLength(MCP_HEADER, 'utf8');
  if (budget > headerCost) {
    const lines = servers.length === 0 ? [NO_SERVERS] : servers.map(formatServerLine);
    const kept: string[] = [];
    let used = 0;
    for (const line of lines) {
      const cost = Buffer.byteLength(line, 'utf8') + (kept.length === 0 ? 0 : 1);
      if (used + cost > budget - headerCost) break;
      kept.push(line);
      used += cost;
    }
    if (kept.length === 0) {
      // A visible list that cannot fit is reported, not rendered as an empty section.
      const note = servers.length === 0 ? NO_SERVERS : '(server list omitted: description budget)';
      if (Buffer.byteLength(note, 'utf8') <= budget - headerCost) kept.push(note);
    }
    if (kept.length > 0) description += `${MCP_HEADER}${kept.join('\n')}`;
  }

  return `${description}${suffix}`;
}
