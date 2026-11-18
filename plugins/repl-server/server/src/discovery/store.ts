/**
 * Transactional store for discovery results (design 07 §3.8).
 *
 * The apply path writes discovered rows, the discovery config and the stale set
 * in **one** savepoint, then lets the caller rebuild the catalog after commit.
 * `bumpRevision` runs once regardless of how many tool rows changed, so one
 * scan never produces N catalog revisions.
 *
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';

import { AdminApiError } from '../admin/servers.ts';
import { withTransaction } from '../db/migrate.ts';
import { bumpRevision, getRevision } from '../db/meta.ts';
import { getServer } from '../db/servers.ts';
import { isoNow, jsonText } from '../db/schema.ts';
import {
  hashToolSchema,
  listTools,
  refreshServerIndex,
  type ToolDiscoverySource,
} from '../db/tools.ts';
import {
  canonicalToolDiscovery,
  decodeStoredDiscovery,
  toolDiscoveryToJson,
} from './config.ts';
import type { ParsedDiscoveryTool } from './parse.ts';
import type { ToolDiscoveryConfig } from './types.ts';

/** Hard cap on discovered rows per server (design 07 §3.9 `DISCOVERY_LIMIT`). */
export const DISCOVERY_SEARCH_LIMIT = 500;

/** Preview snapshot subset the apply path trusts (never client-supplied schemas). */
export interface DiscoveryApplySnapshot {
  discoveryId: string;
  config: ToolDiscoveryConfig;
  parsed: boolean;
  /** Full parsed name set before `maxTools` truncation; stale baseline. */
  allNames: readonly string[];
  /** Tools after `maxTools` truncation; the only acceptable `accept` values. */
  tools: readonly ParsedDiscoveryTool[];
  partial: boolean;
  nextCursor: string | null;
  omitted: number;
}

export interface ApplyDiscoveredToolsInput {
  snapshot: DiscoveryApplySnapshot;
  /** Apply only these names; omitted means every preview tool. */
  accept?: readonly string[];
  overwriteStatic: boolean;
  staleOthers: boolean;
  confirmPartialStale: boolean;
  allowEmpty: boolean;
  /** `If-Match` value; re-checked inside the transaction. */
  expectedRevision: number;
}

export interface ApplyResult {
  serverId: string;
  applied: number;
  created: number;
  updated: number;
  skippedStatic: number;
  skippedOther: number;
  stale: number;
  revision: number;
}

/** Internal result: `changed` decides whether the catalog is rebuilt. */
export interface ApplyStoreResult extends ApplyResult {
  changed: boolean;
}

interface PlannedWrite {
  tool: ParsedDiscoveryTool;
  source: ToolDiscoverySource;
}

/**
 * Applies one preview snapshot. The checks are intentionally repeated here:
 * the preview may be minutes old, so conflict/action is recomputed against the
 * committed rows instead of trusting the preview response.
 */
export function applyDiscoveredTools(
  db: DatabaseSync,
  serverId: string,
  input: ApplyDiscoveredToolsInput,
): ApplyStoreResult {
  return withTransaction(db, () => {
    const currentRevision = getRevision(db);
    if (currentRevision !== input.expectedRevision) {
      throw new AdminApiError(
        409,
        'REVISION_CONFLICT',
        `revision ${input.expectedRevision} does not match current revision ${currentRevision}`,
        { expected: input.expectedRevision, current: currentRevision },
      );
    }

    const server = getServer(db, serverId);
    if (server === null) {
      throw new AdminApiError(404, 'SERVER_NOT_FOUND', `server ${serverId} does not exist`, {
        serverId,
      });
    }
    if (!server.enabled) {
      throw new AdminApiError(409, 'SERVER_DISABLED', `server ${serverId} is disabled`, {
        serverId,
      });
    }

    const rows = listTools(db, serverId);
    if (rows.length === 0) {
      throw new AdminApiError(
        422,
        'DISCOVERY_NO_TOOLS',
        `server ${serverId} has no tool rows yet; connect or refresh tools first`,
        { serverId },
      );
    }

    const staticNames = rows
      .filter((row) => row.discoveredVia === 'static')
      .map((row) => row.name);
    const searchTool = input.snapshot.config.searchTool ?? '';
    if (!staticNames.includes(searchTool)) {
      throw new AdminApiError(
        422,
        'DISCOVERY_SEARCH_TOOL_NOT_FOUND',
        `searchTool ${JSON.stringify(searchTool)} is not a static tool of server ${serverId}`,
        { availableTools: staticNames.sort() },
      );
    }

    const snapshot = input.snapshot;
    const isEmpty = !snapshot.parsed || snapshot.tools.length === 0;
    if (isEmpty && !input.allowEmpty) {
      throw new AdminApiError(
        422,
        'DISCOVERY_EMPTY_PREVIEW',
        'the preview contains no usable tools; pass allowEmpty=true only after confirming',
        { discoveryId: snapshot.discoveryId, parsed: snapshot.parsed },
      );
    }

    const accept = input.accept === undefined ? undefined : new Set(input.accept);
    const accepted =
      accept === undefined ? snapshot.tools : snapshot.tools.filter((tool) => accept.has(tool.name));

    const existingByName = new Map(rows.map((row) => [row.name, row]));
    const planned: PlannedWrite[] = [];
    let skippedStatic = 0;

    for (const tool of accepted) {
      const existing = existingByName.get(tool.name);
      if (existing !== undefined && existing.discoveredVia === 'static' && !input.overwriteStatic) {
        skippedStatic += 1;
        continue;
      }
      planned.push({
        tool,
        source:
          existing?.discoveredVia === 'static'
            ? 'search'
            : existing?.discoveredVia ?? 'search',
      });
    }

    const existingSearch = rows.filter((row) => row.discoveredVia === 'search').length;
    const newSearchNames = planned.filter((write) => !existingByName.has(write.tool.name)).length;
    const convertedStatic = planned.filter(
      (write) => existingByName.get(write.tool.name)?.discoveredVia === 'static',
    ).length;
    if (existingSearch + newSearchNames + convertedStatic > DISCOVERY_SEARCH_LIMIT) {
      throw new AdminApiError(
        422,
        'DISCOVERY_LIMIT',
        `server ${serverId} would exceed ${DISCOVERY_SEARCH_LIMIT} discovered tools`,
        { limit: DISCOVERY_SEARCH_LIMIT, current: existingSearch },
      );
    }

    const now = isoNow();
    let created = 0;
    let updated = 0;
    const insert = db.prepare(`
      INSERT INTO tools (
        server_id, name, display_name, description, description_override,
        enabled, concurrency, type, tags_json,
        index_description, index_summary, index_tags_json,
        schema_json, schema_hash, category, composite_code,
        discovered_via, stale, stale_override, first_seen_at, last_seen_at
      ) VALUES (
        ?, ?, NULL, ?, NULL,
        1, 'parallel', NULL, '[]',
        '', '', '[]',
        ?, ?, NULL, NULL,
        'search', 0, 0, ?, ?
      )
    `);
    const update = db.prepare(`
      UPDATE tools
      SET description = ?, schema_json = ?, schema_hash = ?, discovered_via = ?,
          stale = 0, last_seen_at = ?
      WHERE server_id = ? AND name = ?
    `);

    for (const write of planned) {
      const schemaJson = jsonText(write.tool.inputSchema ?? {});
      const schemaHash = hashToolSchema(write.tool.inputSchema);
      if (existingByName.has(write.tool.name)) {
        update.run(
          write.tool.description,
          schemaJson,
          schemaHash,
          write.source,
          now,
          serverId,
          write.tool.name,
        );
        updated += 1;
      } else {
        insert.run(
          serverId,
          write.tool.name,
          write.tool.description,
          schemaJson,
          schemaHash,
          now,
          now,
        );
        created += 1;
      }
    }

    if (accepted.length !== created + updated + skippedStatic) {
      throw new AdminApiError(
        500,
        'INTERNAL_ERROR',
        'apply counted more tools than it wrote',
      );
    }

    let stale = 0;
    if (input.staleOthers && !isEmpty && snapshot.allNames.length > 0) {
      if (snapshot.partial && !input.confirmPartialStale) {
        throw new AdminApiError(
          422,
          'DISCOVERY_PARTIAL_STALE_UNCONFIRMED',
          'the preview is incomplete; confirm partial stale marking or disable staleOthers',
          { nextCursor: snapshot.nextCursor, omitted: snapshot.omitted },
        );
      }
      const names = [...snapshot.allNames];
      const placeholders = names.map(() => '?').join(', ');
      const result = db
        .prepare(`
          UPDATE tools
          SET stale = 1
          WHERE server_id = ?
            AND discovered_via = 'search'
            AND stale_override = 0
            AND stale = 0
            AND name NOT IN (${placeholders})
        `)
        .run(serverId, ...names);
      stale = Number(result.changes);
    }

    const configJson = toolDiscoveryToJson(snapshot.config);
    const configChanged =
      canonicalToolDiscovery(decodeStoredDiscovery(server.discoveryJson)) !==
      canonicalToolDiscovery(snapshot.config);
    if (configChanged) {
      db.prepare(
        'UPDATE servers SET discovery_json = ?, revision = revision + 1, updated_at = ? WHERE id = ?',
      ).run(configJson, now, serverId);
    }

    const wrote = created + updated;
    if (wrote > 0) refreshServerIndex(db, serverId);
    const changed = wrote > 0 || stale > 0 || configChanged;
    const revision = changed ? bumpRevision(db) : currentRevision;

    return {
      serverId,
      applied: wrote,
      created,
      updated,
      skippedStatic,
      skippedOther: accepted.length - created - updated - skippedStatic,
      stale,
      revision,
      changed,
    };
  });
}

/**
 * Marks every `discovered_via = 'search'` row stale (design 07 §3.8, mode
 * switch back to static). `stale_override` does **not** exempt a row: it keeps
 * search visibility, not callability.
 */
export function demoteDiscoveredTools(db: DatabaseSync, serverId: string): number {
  return withTransaction(db, () => {
    const result = db
      .prepare(`
        UPDATE tools
        SET stale = 1
        WHERE server_id = ? AND discovered_via = 'search' AND stale = 0
      `)
      .run(serverId);
    return Number(result.changes);
  });
}
