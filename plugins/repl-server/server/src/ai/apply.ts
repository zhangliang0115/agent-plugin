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

import {
  appendCategoryDictionary,
  CATEGORY_SETTING_KEY,
  readCategoryDictionary,
} from '../admin/categories.ts';
import { AdminApiError, assertRevision, nullIfBlank } from '../admin/servers.ts';
import {
  ACTION_TAG_KEYS,
  evaluateServerTags,
  evaluateTagPolicy,
  formatTagPolicyIssues,
} from '../catalog/tag-policy.ts';
import type { StoredSettings } from '../admin/settings.ts';
import { appendTagDictionary, readTagDictionary, TAG_SETTING_KEY } from '../admin/tags.ts';
import { withTransaction } from '../db/migrate.ts';
import { bumpRevision, getRevision, listSettings } from '../db/meta.ts';
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
import { isAiForbiddenTag } from './validate.ts';

export interface ToolOverridePatch {
  name: string;
  /** Absent or empty: leave tags untouched. Tags are merged, never removed. */
  tags?: string[];
}

/** A new dictionary entry the administrator accepted with this annotation. */
export interface DictionarySuggestion {
  key: string;
  zh: string;
  en: string;
}

export interface AnnotationPatch {
  summary?: string | null;
  category?: string | null;
  categorySuggestion?: DictionarySuggestion | null;
  /** Server-level tags are merged into the existing set; AI cannot delete tags. */
  tags?: string[];
  tagSuggestions?: DictionarySuggestion[];
  toolOverrides?: ToolOverridePatch[];
}

export interface ApplyAnnotationInput {
  serverId: string;
  patch: AnnotationPatch;
}

export interface ApplyAnnotationResult {
  changed: string[];
  revision: number;
  warnings: string[];
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

interface DictionaryWrite {
  key: string;
  value: unknown;
}

interface AnnotationPlan {
  changed: string[];
  warnings: string[];
  summary?: string | null;
  summarySource?: string | null;
  category?: string | null;
  tags?: string[];
  toolUpdates: Array<{ current: ToolRecord; patch: ToolPatch }>;
  dictionaryWrites: DictionaryWrite[];
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Order-preserving union; the existing list keeps its positions. */
function mergeTags(current: readonly string[], added: readonly string[]): string[] {
  const merged = [...current];
  for (const tag of added) {
    if (!merged.includes(tag)) merged.push(tag);
  }
  return merged;
}

function assertAiTagAllowed(tag: string, kind: '标签' | '标签建议' | '工具标签'): void {
  if (!isAiForbiddenTag(tag)) return;
  throw new AdminApiError(
    422,
    'AI_ANNOTATION_INVALID',
    `${kind} ${tag} is maintained by the administrator`,
    { errors: [`${kind} ${tag} 由管理员维护，AI 标注不能写入`] },
  );
}

function assertNotCategoryKey(
  key: string,
  categoryKeys: ReadonlySet<string>,
  kind: '标签' | '标签建议' | '工具标签',
): void {
  if (!categoryKeys.has(key)) return;
  throw new AdminApiError(
    422,
    'AI_ANNOTATION_INVALID',
    `${kind} ${key} is a category key`,
    { errors: [`${kind} ${key} 是分类 key，分类 key 不能当标签`] },
  );
}

function assertNotActionKey(
  key: string,
  kind: '标签' | '标签建议' | '工具标签',
): void {
  if (!ACTION_TAG_KEYS.has(key)) return;
  throw new AdminApiError(
    422,
    'AI_ANNOTATION_INVALID',
    `${kind} ${key} is an action key`,
    { errors: [`${kind} ${key} 是动作键，动作不能作为标签`] },
  );
}

function planAnnotationChanges(
  db: DatabaseSync,
  current: ServerRecord,
  patch: AnnotationPatch,
  settings: StoredSettings,
): AnnotationPlan {
  const plan: AnnotationPlan = {
    changed: [],
    warnings: [],
    toolUpdates: [],
    dictionaryWrites: [],
  };

  const categorySuggestion = patch.categorySuggestion ?? null;
  const tagSuggestions = patch.tagSuggestions ?? [];
  // Defense in depth: HTTP validation already drops these, but the low-level
  // apply must never write environment/provenance keys, mix category keys into
  // the tag vocabulary, or accept a category suggestion the model may not make.
  const categoryKeys = new Set(readCategoryDictionary(settings).map((entry) => entry.key));
  const tagKeys = new Set(readTagDictionary(settings).map((entry) => entry.key));
  const tagSuggestionKeys = new Set(tagSuggestions.map((suggestion) => suggestion.key));
  if (categorySuggestion !== null) {
    if (isAiForbiddenTag(categorySuggestion.key)) {
      throw new AdminApiError(
        422,
        'AI_ANNOTATION_INVALID',
        `category ${categorySuggestion.key} is maintained by the administrator`,
        { errors: [`分类建议 ${categorySuggestion.key} 由管理员维护，不能作为分类`] },
      );
    }
    if (tagKeys.has(categorySuggestion.key)) {
      throw new AdminApiError(
        422,
        'AI_ANNOTATION_INVALID',
        `category ${categorySuggestion.key} is an existing tag key`,
        { errors: [`分类建议 ${categorySuggestion.key} 已是标签 key，标签 key 不能作为分类`] },
      );
    }
    if (tagSuggestionKeys.has(categorySuggestion.key)) {
      throw new AdminApiError(
        422,
        'AI_ANNOTATION_INVALID',
        `category ${categorySuggestion.key} is also a tag suggestion`,
        { errors: [`分类建议 ${categorySuggestion.key} 与标签建议重名，不能同时写入两个字典`] },
      );
    }
  }
  for (const tag of patch.tags ?? []) {
    assertAiTagAllowed(tag, '标签');
    assertNotActionKey(tag, '标签');
    assertNotCategoryKey(tag, categoryKeys, '标签');
  }
  for (const override of patch.toolOverrides ?? []) {
    for (const tag of override.tags ?? []) {
      assertAiTagAllowed(tag, '工具标签');
      assertNotActionKey(tag, '工具标签');
      assertNotCategoryKey(tag, categoryKeys, '工具标签');
    }
  }
  for (const suggestion of tagSuggestions) {
    assertAiTagAllowed(suggestion.key, '标签建议');
    assertNotActionKey(suggestion.key, '标签建议');
    assertNotCategoryKey(suggestion.key, categoryKeys, '标签建议');
  }

  const categoryAppend = appendCategoryDictionary(
    settings,
    categorySuggestion === null ? [] : [categorySuggestion],
  );
  if (categoryAppend.added.length > 0) {
    plan.changed.push('dictionary.categories');
    plan.dictionaryWrites.push({
      key: CATEGORY_SETTING_KEY,
      value: categoryAppend.categories,
    });
  }
  const tagAppend = appendTagDictionary(settings, tagSuggestions);
  if (tagAppend.added.length > 0) {
    plan.changed.push('dictionary.tags');
    plan.dictionaryWrites.push({ key: TAG_SETTING_KEY, value: tagAppend.tags });
  }

  const summary = nullIfBlank(patch.summary);
  if (patch.summary !== undefined && summary !== current.summary) {
    plan.changed.push('server.summary');
    plan.summary = summary;
    // Only a real summary change may move its provenance.
    plan.summarySource = summary === null ? null : 'ai';
  }
  const nextCategory =
    categorySuggestion !== null ? categorySuggestion.key : patch.category;
  if (nextCategory !== undefined && nextCategory !== current.category) {
    plan.changed.push('server.category');
    plan.category = nextCategory;
  }
  // Tag suggestions enter the dictionary only; they are not server tags. A
  // server tag must already exist in the dictionary, so `patch.tags` is the
  // only source here.
  if (patch.tags !== undefined) {
    const merged = mergeTags(current.tags, patch.tags);
    const issues = evaluateServerTags(merged);
    if (issues.length > 0) {
      throw new AdminApiError(422, 'TAG_POLICY_VIOLATION', 'server tags violate the tag policy', {
        serverId: current.id,
        errors: formatTagPolicyIssues(issues),
      });
    }
    if (!sameStringArray(merged, current.tags)) {
      plan.changed.push('server.tags');
      plan.tags = merged;
    }
  }

  // Server tags are inherited by every tool, so a change must be checked against
  // each enabled tool, not only the overrides the model happened to list. This
  // mirrors `PATCH /servers/:id` (admin/servers.ts) and rejects the whole patch
  // before any write.
  if (plan.tags !== undefined) {
    const serverTags = plan.tags;
    const violations = listTools(db, current.id)
      .filter((tool) => tool.enabled)
      .map((tool) => ({
        name: tool.name,
        issues: evaluateTagPolicy(serverTags, tool.tags).issues,
      }))
      .filter((entry) => entry.issues.length > 0);
    if (violations.length > 0) {
      throw new AdminApiError(422, 'TAG_POLICY_VIOLATION', 'server tags break tool tag limits', {
        serverId: current.id,
        tools: violations.map((entry) => ({
          name: entry.name,
          errors: formatTagPolicyIssues(entry.issues),
        })),
      });
    }
  }

  if (patch.toolOverrides !== undefined) {
    const byName = new Map(listTools(db, current.id).map((tool) => [tool.name, tool]));
    const finalServerTags = plan.tags ?? current.tags;
    const unknown: string[] = [];
    for (const override of patch.toolOverrides) {
      const tool = byName.get(override.name);
      if (tool === undefined) {
        if (!unknown.includes(override.name)) unknown.push(override.name);
        continue;
      }

      const toolPatch: ToolPatch = {};
      let touched = false;
      if (override.tags !== undefined) {
        const merged = mergeTags(tool.tags, override.tags);
        const policy = evaluateTagPolicy(finalServerTags, merged, { repairInherited: true });
        if (policy.issues.length > 0) {
          throw new AdminApiError(
            422,
            'TAG_POLICY_VIOLATION',
            `tool ${override.name} violates the tag policy`,
            {
              serverId: current.id,
              tool: override.name,
              errors: formatTagPolicyIssues(policy.issues),
            },
          );
        }
        if (policy.inheritedDuplicates.length > 0) {
          plan.warnings.push(
            `工具 ${override.name} 的标签与 server 标签重复，已去重: ${policy.inheritedDuplicates.join(', ')}`,
          );
        }
        if (!sameStringArray(policy.toolTags, tool.tags)) {
          toolPatch.tags = policy.toolTags;
          plan.changed.push(`tools.${override.name}.tags`);
          touched = true;
        }
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

    const plan = planAnnotationChanges(db, current, input.patch, listSettings(db));
    if (plan.changed.length === 0) {
      return { changed: [], revision: getRevision(db), warnings: plan.warnings };
    }

    const metadataChanged =
      plan.summary !== undefined ||
      plan.category !== undefined ||
      plan.tags !== undefined ||
      plan.toolUpdates.length > 0;

    if (metadataChanged) {
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
    }

    // Accepted suggestions and the annotation they accompany commit together:
    // any later failure rolls the dictionary rows back with the rest.
    const writeSetting = db.prepare(
      'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const write of plan.dictionaryWrites) {
      writeSetting.run(write.key, jsonText(write.value));
    }

    const revision = bumpRevision(db);
    return { changed: plan.changed, revision, warnings: plan.warnings };
  });
}
