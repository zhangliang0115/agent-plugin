/** Which servers and tools use each tag / category, built from the admin API. */
import type { ApiClient } from './api.ts';

export interface DictionaryUsage {
  /** Server labels, one entry per server. */
  servers: string[];
  /** `serverId / toolName` entries. */
  tools: string[];
}

export interface DictionaryUsageIndex {
  tags: Map<string, DictionaryUsage>;
  categories: Map<string, DictionaryUsage>;
}

interface ServersResponse {
  servers?: Array<{ id: string; label?: string; category?: string | null; tags?: string[] }>;
}

interface ServerToolsResponse {
  tools?: Array<{ name: string; tags?: string[] }>;
}

function usageOf(map: Map<string, DictionaryUsage>, key: string): DictionaryUsage {
  const normalized = key.trim().toLowerCase();
  let usage = map.get(normalized);
  if (usage === undefined) {
    usage = { servers: [], tools: [] };
    map.set(normalized, usage);
  }
  return usage;
}

/** Reads `/servers` plus every server's tools once and indexes both dictionaries. */
export async function loadDictionaryUsage(api: ApiClient): Promise<DictionaryUsageIndex> {
  const tags = new Map<string, DictionaryUsage>();
  const categories = new Map<string, DictionaryUsage>();
  const response = await api.get<ServersResponse>('/servers');
  for (const server of response.servers ?? []) {
    const label = server.label ?? server.id;
    const tools = await api.get<ServerToolsResponse>(
      `/servers/${encodeURIComponent(server.id)}/tools`,
    );
    const toolNames = (tools.tools ?? []).map((tool) => `${server.id} / ${tool.name}`);
    for (const tag of server.tags ?? []) usageOf(tags, tag).servers.push(label);
    for (const tool of tools.tools ?? []) {
      for (const tag of tool.tags ?? []) usageOf(tags, tag).tools.push(`${server.id} / ${tool.name}`);
    }
    if (typeof server.category === 'string' && server.category.trim() !== '') {
      const usage = usageOf(categories, server.category);
      usage.servers.push(label);
      usage.tools.push(...toolNames);
    }
  }
  return { tags, categories };
}
