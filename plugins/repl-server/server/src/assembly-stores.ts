import type { DatabaseSync } from 'node:sqlite';

import type {
  ClientBinding as AdminClientBinding,
  ClientBindingInput,
  ClientBindingPatch,
  ClientBindingStore,
} from './admin/clients.ts';
import type {
  ServerConfig,
  ServerConfigPatch,
  ServerRecord as AdminServerRecord,
  ServerStore,
} from './admin/servers.ts';
import type {
  ToolPatch as AdminToolPatch,
  ToolRecord as AdminToolRecord,
  ToolStore,
  ToolUpdate,
} from './admin/tools.ts';
import type { SettingsStore, StoredSettings } from './admin/settings.ts';
import { assertRevision } from './admin/servers.ts';
import {
  createClientBinding,
  deleteClientBinding,
  getClientBinding,
  getClientToken,
  listClientBindings,
  rotateClientToken,
  updateClientBinding,
  type ClientBindingRecord,
} from './db/clients.ts';
import { getRevision, listSettings, patchSettings } from './db/meta.ts';
import {
  createServer,
  deleteServer,
  getServer,
  listServers,
  updateServer,
  type ServerRecord as DbServerRecord,
  type NewServer,
} from './db/servers.ts';
import {
  getTool,
  listTools,
  patchTool,
  type ToolRecord as DbToolRecord,
} from './db/tools.ts';
import { decodeStoredDiscovery, toolDiscoveryToJson } from './discovery/config.ts';

function toAdminServer(row: DbServerRecord): AdminServerRecord {
  return {
    id: row.id,
    label: row.label,
    transport: row.transport,
    command: row.command,
    args: row.args as AdminServerRecord['args'],
    env: row.env as AdminServerRecord['env'],
    cwd: row.cwd,
    url: row.url,
    headers: row.headers as AdminServerRecord['headers'],
    enabled: row.enabled,
    connectMode: row.connectMode,
    summary: row.summary,
    summarySource: row.summarySource,
    category: row.category,
    tags: row.tags,
    timeoutMs: row.timeoutMs,
    maxConcurrency: row.maxConcurrency,
    toolDiscovery: decodeStoredDiscovery(row.discoveryJson),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    revision: row.revision,
  };
}

function toDbServer(config: ServerConfig): NewServer {
  return {
    id: config.id,
    label: config.label,
    transport: config.transport,
    command: config.command,
    args: config.args,
    env: config.env,
    cwd: config.cwd,
    url: config.url,
    headers: config.headers,
    enabled: config.enabled,
    connectMode: config.connectMode,
    summary: config.summary,
    summarySource: config.summarySource,
    category: config.category,
    tags: config.tags,
    timeoutMs: config.timeoutMs,
    maxConcurrency: config.maxConcurrency,
    discoveryJson: toolDiscoveryToJson(config.toolDiscovery),
  };
}

export class DbServerStore implements ServerStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async list(): Promise<AdminServerRecord[]> {
    return listServers(this.db).map(toAdminServer);
  }

  async get(id: string): Promise<AdminServerRecord | null> {
    const row = getServer(this.db, id);
    return row === null ? null : toAdminServer(row);
  }

  async revision(): Promise<number> {
    return getRevision(this.db);
  }

  async create(config: ServerConfig): Promise<{ server: AdminServerRecord; revision: number }> {
    const result = createServer(this.db, toDbServer(config));
    return { server: toAdminServer(result.server), revision: result.revision };
  }

  async update(
    id: string,
    patch: ServerConfigPatch,
    expectedRevision: number,
  ): Promise<{ server: AdminServerRecord; revision: number }> {
    assertRevision(getRevision(this.db), expectedRevision);
    const { toolDiscovery, ...rest } = patch;
    const dbPatch = {
      ...(rest as Parameters<typeof updateServer>[2]),
      ...(toolDiscovery === undefined ? {} : { discoveryJson: toolDiscoveryToJson(toolDiscovery) }),
    };
    const result = updateServer(this.db, id, dbPatch);
    if (result === null) throw new Error(`server ${id} not found`);
    return { server: toAdminServer(result.server), revision: result.revision };
  }

  async remove(id: string, expectedRevision: number): Promise<{ revision: number }> {
    assertRevision(getRevision(this.db), expectedRevision);
    const result = deleteServer(this.db, id);
    if (!result.deleted) throw new Error(`server ${id} not found`);
    return { revision: result.revision };
  }
}

function toAdminTool(serverId: string, row: DbToolRecord): AdminToolRecord {
  return {
    serverId,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    descriptionOverride: row.descriptionOverride,
    enabled: row.enabled,
    concurrency: row.concurrency,
    type: row.type,
    tags: row.tags,
    category: row.category,
    schema: row.inputSchema,
    discoveredVia: row.discoveredVia,
    stale: row.stale,
    staleOverride: row.staleOverride,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    callCount: row.callCount,
    successCount: row.successCount,
    successRate: row.callCount > 0 ? row.successCount / row.callCount : null,
    lastCalledAt: row.lastCalledAt,
  };
}

export class DbToolStore implements ToolStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async listByServer(serverId: string): Promise<AdminToolRecord[]> {
    return listTools(this.db, serverId).map((row) => toAdminTool(serverId, row));
  }

  async get(serverId: string, name: string): Promise<AdminToolRecord | null> {
    const row = getTool(this.db, serverId, name);
    return row === null ? null : toAdminTool(serverId, row);
  }

  async revision(): Promise<number> {
    return getRevision(this.db);
  }

  async update(
    serverId: string,
    name: string,
    patch: AdminToolPatch,
    expectedRevision: number,
  ): Promise<{ tool: AdminToolRecord; revision: number }> {
    assertRevision(getRevision(this.db), expectedRevision);
    const result = patchTool(this.db, serverId, name, patch as Parameters<typeof patchTool>[3]);
    if (result === null) throw new Error(`tool ${serverId}/${name} not found`);
    return { tool: toAdminTool(serverId, result.tool), revision: result.revision };
  }

  async batch(
    updates: ToolUpdate[],
    expectedRevision: number,
  ): Promise<{ tools: AdminToolRecord[]; revision: number }> {
    assertRevision(getRevision(this.db), expectedRevision);
    const tools = updates.map((update) => {
      const result = patchTool(this.db, update.serverId, update.name, update.patch as Parameters<typeof patchTool>[3]);
      if (result === null) throw new Error(`tool ${update.serverId}/${update.name} not found`);
      return toAdminTool(update.serverId, result.tool);
    });
    return { tools, revision: getRevision(this.db) };
  }
}

function toAdminBinding(row: ClientBindingRecord): AdminClientBinding {
  return {
    id: row.id,
    label: row.label,
    agent: row.agent,
    defaultWorkspace: row.defaultWorkspace,
    allowedServers: row.allowedServers,
    allowedTags: row.allowedTags,
    quota: row.quota as AdminClientBinding['quota'],
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
  };
}

export class DbClientBindingStore implements ClientBindingStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async list(): Promise<AdminClientBinding[]> {
    return listClientBindings(this.db).map(toAdminBinding);
  }

  async get(id: string): Promise<AdminClientBinding | null> {
    const row = getClientBinding(this.db, id);
    return row === null ? null : toAdminBinding(row);
  }

  async create(input: ClientBindingInput & { token: string }): Promise<AdminClientBinding> {
    const created = createClientBinding(this.db, {
      label: input.label,
      token: input.token,
      defaultWorkspace: input.defaultWorkspace,
      allowedServers: input.allowedServers,
      allowedTags: input.allowedTags,
      quota: input.quota as Record<string, number> | null,
    });
    return toAdminBinding(created.binding);
  }

  async update(id: string, patch: ClientBindingPatch): Promise<AdminClientBinding> {
    const row = updateClientBinding(this.db, id, patch as Parameters<typeof updateClientBinding>[2]);
    if (row === null) throw new Error(`client ${id} not found`);
    return toAdminBinding(row);
  }

  async token(id: string): Promise<string | null> {
    return getClientToken(this.db, id);
  }

  async rotateToken(id: string, token: string): Promise<AdminClientBinding | null> {
    const row = rotateClientToken(this.db, id, token);
    return row === null ? null : toAdminBinding(row);
  }

  async remove(id: string): Promise<boolean> {
    return deleteClientBinding(this.db, id).deleted;
  }
}

export class DbSettingsStore implements SettingsStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  async read(): Promise<{ settings: StoredSettings; revision: number }> {
    const stored = listSettings(this.db);
    return { settings: stored, revision: getRevision(this.db) };
  }

  async replace(
    settings: StoredSettings,
    expectedRevision: number,
  ): Promise<{ settings: StoredSettings; revision: number }> {
    assertRevision(getRevision(this.db), expectedRevision);
    const result = patchSettings(this.db, settings);
    return { settings: result.settings as StoredSettings, revision: result.revision };
  }
}
