/**
 * Joins the manager's server views with the registered tool definitions, so one
 * list says which tools each server offers. Tools are matched to servers by the
 * `mcp__<server>__` prefix of the server names the manager reports. @module
 */
import type { ServerViewLike, StatusLike } from './server-view.ts';
import { mcpToolName } from './tool-name.ts';

/** Most tools shown for one server. Extra tools are dropped and the server is marked truncated. */
export const MAX_TOOLS_PER_SERVER = 500;
/** Longest description shown, in characters, including the trailing ellipsis. */
export const MAX_DESCRIPTION_LENGTH = 600;

const ELLIPSIS = '…';

/** A registered tool, as the host's tool registry lists it. */
export interface ToolDefinitionLike {
  readonly name: string;
  readonly description?: string;
}

/** One tool of a server, ready to show. */
export interface ServerToolView {
  /** Model-facing name, `mcp__<server>__<tool>`. */
  readonly name: string;
  /** Name the server advertises. */
  readonly rawName: string;
  readonly description: string;
  readonly descriptionTruncated: boolean;
}

/** One server with its tools. */
export interface ServerToolsView {
  readonly name: string;
  readonly configured: boolean;
  readonly status: StatusLike;
  readonly tools: readonly ServerToolView[];
  /** True when the server has more tools than `MAX_TOOLS_PER_SERVER`. */
  readonly truncated: boolean;
}

interface OwnedDefinition {
  readonly definition: ToolDefinitionLike;
  readonly rawName: string;
}

/**
 * Cap a description to `MAX_DESCRIPTION_LENGTH`, ending a cut text with an ellipsis.
 * @param text - the description as the tool registry holds it.
 */
export function capDescription(text: string): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= MAX_DESCRIPTION_LENGTH) return { text, truncated: false };
  return { text: text.slice(0, MAX_DESCRIPTION_LENGTH - ELLIPSIS.length) + ELLIPSIS, truncated: true };
}

/**
 * Copy the status fields the page reads. Fields the manager did not report stay absent.
 * @param status - the manager's status, which may carry more fields.
 */
function pickStatus(status: StatusLike): StatusLike {
  const picked: Record<string, string | number> = { state: status.state };
  if (status.toolCount !== undefined) picked.toolCount = status.toolCount;
  if (status.attempt !== undefined) picked.attempt = status.attempt;
  if (status.reason !== undefined) picked.reason = status.reason;
  if (status.lastError !== undefined) picked.lastError = status.lastError;
  return picked as unknown as StatusLike;
}

/**
 * The server whose prefix is the longest one that the tool name starts with.
 * Longest wins, so `mcp__a___x` belongs to server `a_` rather than server `a`.
 * @param name - full tool name.
 * @param serverNames - server names the manager reports.
 */
function ownerOf(name: string, serverNames: readonly string[]): string | undefined {
  let owner: string | undefined;
  let ownerPrefixLength = 0;
  for (const server of serverNames) {
    const prefix = mcpToolName(server, '');
    if (name.length > prefix.length && name.startsWith(prefix) && prefix.length > ownerPrefixLength) {
      owner = server;
      ownerPrefixLength = prefix.length;
    }
  }
  return owner;
}

/**
 * Group the definitions under the server that owns each one.
 * @param views - the manager's server views.
 * @param definitions - registered tools; names outside every known server are dropped.
 */
function groupByServer(
  views: readonly ServerViewLike[],
  definitions: readonly ToolDefinitionLike[],
): Map<string, OwnedDefinition[]> {
  const serverNames = views.map(view => view.name);
  const groups = new Map<string, OwnedDefinition[]>(serverNames.map(name => [name, []]));
  for (const definition of definitions) {
    const owner = ownerOf(definition.name, serverNames);
    if (owner === undefined) continue;
    const prefix = mcpToolName(owner, '');
    groups.get(owner)?.push({ definition, rawName: definition.name.slice(prefix.length) });
  }
  return groups;
}

function toServerTool(owned: OwnedDefinition): ServerToolView {
  const description = capDescription(owned.definition.description ?? '');
  return {
    name: owned.definition.name,
    rawName: owned.rawName,
    description: description.text,
    descriptionTruncated: description.truncated,
  };
}

/**
 * One list of servers with their tools, in the order the manager reports them.
 * @param views - the manager's server views.
 * @param definitions - the tools the host registry lists.
 */
export function joinServerTools(
  views: readonly ServerViewLike[],
  definitions: readonly ToolDefinitionLike[],
): ServerToolsView[] {
  const groups = groupByServer(views, definitions);
  return views.map((view) => {
    const owned = groups.get(view.name) ?? [];
    return {
      name: view.name,
      configured: view.configured,
      status: pickStatus(view.status),
      tools: owned.slice(0, MAX_TOOLS_PER_SERVER).map(toServerTool),
      truncated: owned.length > MAX_TOOLS_PER_SERVER,
    };
  });
}
