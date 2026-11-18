/**
 * Annotation apply: one transaction that updates server metadata, tool overrides
 * and the derived `index_*` columns, then bumps `meta.revision` once (08 §4.5,
 * §6.2).
 *
 * This module intentionally does not call `updateServer` (it increments
 * `servers.revision`, the pool's `cfgVersion`) or `patchTool` (it opens its own
 * transaction and bumps per tool). It uses the exported row-level helpers
 * `applyToolPatch` / `writeToolRow` inside the caller's transaction.
 * @module
 */

import type { DatabaseSync } from 'node:sqlite';

import { AdminApiError, assertRevision } from '../admin/servers.ts';
import { withTransaction } from '../db/migrate.ts';
import { bumpRevision, getRevision } from '../db/meta.ts';
import { getServer, type ServerRecord } from '../db/servers.ts';
import { isoNow, jsonText } from '../db/schema.ts';
import {
  applyToolPatch,
  listTools,
  refreshServerIndex,
  type ToolPatch,
  type ToolRecord,
  writeToolRow,
} from '../db/tools.ts';

export interface ToolOverridePatch {
  name: string;
  /** Absent: leave the override untouched. `null`: clear it. */
  description?: string | null;
  /** Absent: leave tags untouched. Empty array: clear them. */
  tags?: string[];
}

export interface AnnotationPatch {
  summary?: string | null;
  category?: string | null;
  tags?: string[];
  toolOverrides?: ToolOverridePatch[];
}

export interface ApplyAnnotationInput {
  serverId: string;
  patch: AnnotationPatch;
}

export interface ApplyAnnotationResult {
  changed: string[];
  revision: number;
}

/** Raised before any write when an override names a tool that no longer exists. */
export class UnknownToolError extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(`unknown tool(s): ${names.join(', ')}`);
    this.name = 'UnknownToolError';
    this.names = names;
  }
}

interface AnnotationPlan {
  changed: string[];
  summary?: string | null;
  summarySource?: string | null;
  category?: string | null;
  tags?: string[];
  toolUpdates: Array<{ current: ToolRecord; patch: ToolPatch }>;
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function planAnnotationChanges(
  db: DatabaseSync,
  current: ServerRecord,
  patch: AnnotationPatch,
): AnnotationPlan {
  const plan: AnnotationPlan = { changed: [], toolUpdates: [] };

  if (patch.summary !== undefined && patch.summary !== current.summary) {
    plan.changed.push('server.summary');
    plan.summary = patch.summary;
    // Only a real summary change may move its provenance.
    plan.summarySource = patch.summary === null ? null : 'ai';
  }
  if (patch.category !== undefined && patch.category !== current.category) {
    plan.changed.push('server.category');
    plan.category = patch.category;
  }
  if (patch.tags !== undefined && !sameStringArray(patch.tags, current.tags)) {
    plan.changed.push('server.tags');
    plan.tags = patch.tags;
  }

  if (patch.toolOverrides !== undefined) {
    const byName = new Map(listTools(db, current.id).map((tool) => [tool.name, tool]));
    const unknown: string[] = [];
    for (const override of patch.toolOverrides) {
      const tool = byName.get(override.name);
      if (tool === undefined) {
        if (!unknown.includes(override.name)) unknown.push(override.name);
        continue;
      }

      const toolPatch: ToolPatch = {};
      let touched = false;
      if (override.description !== undefined && override.description !== tool.descriptionOverride) {
        toolPatch.description = override.description;
        plan.changed.push(`tools.${override.name}.description_override`);
        touched = true;
      }
      if (override.tags !== undefined && !sameStringArray(override.tags, tool.tags)) {
        toolPatch.tags = override.tags;
        plan.changed.push(`tools.${override.name}.tags`);
        touched = true;
      }
      if (touched) plan.toolUpdates.push({ current: tool, patch: toolPatch });
    }
    if (unknown.length > 0) throw new UnknownToolError(unknown);
  }

  return plan;
}

/**
 * Applies one annotation patch. `changed` is empty when every submitted value
 * already matches the stored state; in that case nothing is written, the index
 * is not refreshed, the catalog is not rebuilt and the revision does not move.
 */
export function applyAnnotation(
  db: DatabaseSync,
  input: ApplyAnnotationInput,
  expectedRevision: number,
): ApplyAnnotationResult {
  return withTransaction(db, () => {
    assertRevision(getRevision(db), expectedRevision);

    const current = getServer(db, input.serverId);
    if (current === null) {
      throw new AdminApiError(
        404,
        'SERVER_NOT_FOUND',
        `server ${input.serverId} does not exist`,
        { serverId: input.serverId },
      );
    }

    const plan = planAnnotationChanges(db, current, input.patch);
    if (plan.changed.length === 0) {
      return { changed: [], revision: getRevision(db) };
    }

    const summary = plan.summary !== undefined ? plan.summary : current.summary;
    const summarySource =
      plan.summarySource !== undefined ? plan.summarySource : current.summarySource;
    const category = plan.category !== undefined ? plan.category : current.category;
    const tags = plan.tags !== undefined ? plan.tags : current.tags;

    // Dedicated UPDATE: `servers.revision` is the pool's cfgVersion and must not
    // move for metadata edits.
    db.prepare(`
      UPDATE servers
      SET summary = ?, summary_source = ?, category = ?, tags_json = ?, updated_at = ?
      WHERE id = ?
    `).run(summary, summarySource, category, jsonText(tags), isoNow(), input.serverId);

    for (const update of plan.toolUpdates) {
      writeToolRow(db, applyToolPatch(update.current, update.patch));
    }

    refreshServerIndex(db, input.serverId);
    const revision = bumpRevision(db);
    return { changed: plan.changed, revision };
  });
}
