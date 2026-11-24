/**
 * Preview-time repair for AI tag proposals. The same rules run hard in
 * `apply.ts`; this module only trims the proposed view so the administrator
 * sees a compliant draft instead of a rejection after editing.
 * @module
 */

import {
  ACTION_TAG_KEYS,
  SERVER_TAG_LIMIT,
  TOOL_TAG_LIMIT,
  effectiveTags,
} from '../catalog/tag-policy.ts';
import type { NormalizedAnnotation } from './validate.ts';

export interface RepairedAnnotation {
  annotation: NormalizedAnnotation;
  warnings: string[];
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Order-preserving union; matches `mergeTags` in `apply.ts`. */
function mergeTags(current: readonly string[], added: readonly string[]): string[] {
  const merged = [...current];
  for (const tag of added) {
    if (!merged.includes(tag)) merged.push(tag);
  }
  return merged;
}

export function repairAnnotationTags(
  annotation: NormalizedAnnotation,
  currentServerTags: readonly string[],
  currentToolTags: ReadonlyMap<string, readonly string[]>,
): RepairedAnnotation {
  const warnings: string[] = [];

  const proposedServerTags = (annotation.tags ?? []).filter((tag) => {
    if (!ACTION_TAG_KEYS.has(tag)) return true;
    warnings.push(`标签 ${tag} 是动作键，已丢弃`);
    return false;
  });
  const serverRoom = Math.max(0, SERVER_TAG_LIMIT - unique(currentServerTags).length);
  const keptServerTags = proposedServerTags.slice(0, serverRoom);
  if (keptServerTags.length < proposedServerTags.length) {
    const dropped = proposedServerTags.slice(serverRoom);
    warnings.push(
      `server 标签最多 ${SERVER_TAG_LIMIT} 个（当前 ${unique(currentServerTags).length} 个），已丢弃: ${dropped.join(', ')}`,
    );
  }
  const finalServerTags = unique([...currentServerTags, ...keptServerTags]);

  const toolOverrides = annotation.toolOverrides?.map((override) => {
    if (override.tags === undefined) return override;
    const serverSet = new Set(finalServerTags);
    const inherited = override.tags.filter((tag) => serverSet.has(tag));
    if (inherited.length > 0) {
      warnings.push(`工具 ${override.name} 的标签与 server 标签重复，已去重: ${inherited.join(', ')}`);
    }
    const additions = unique(override.tags.filter((tag) => !serverSet.has(tag)));
    const existing = (currentToolTags.get(override.name) ?? []).filter((tag) => !serverSet.has(tag));
    const room = Math.max(0, TOOL_TAG_LIMIT - finalServerTags.length);
    if (existing.length > room) {
      warnings.push(
        `工具 ${override.name} 现有标签叠加 server 后已超过 ${TOOL_TAG_LIMIT} 个，应用时会被拒绝`,
      );
    }
    // Apply merges existing tool tags with the submission before validating, so
    // capacity here must start from the existing set or the preview lies.
    const kept = mergeTags(existing, additions)
      .slice(0, room)
      .filter((tag) => additions.includes(tag));
    const dropped = additions.filter((tag) => !kept.includes(tag));
    if (dropped.length > 0) {
      warnings.push(
        `工具 ${override.name} 叠加现有标签后最多 ${TOOL_TAG_LIMIT} 个，已丢弃: ${dropped.join(', ')}`,
      );
    }
    if (effectiveTags(finalServerTags, mergeTags(existing, kept)).length === 0) {
      warnings.push(`工具 ${override.name} 叠加后没有标签，应用时会被拒绝`);
    }
    return { ...override, tags: kept };
  });

  return {
    annotation: {
      ...annotation,
      ...(annotation.tags === undefined ? {} : { tags: keptServerTags }),
      ...(toolOverrides === undefined ? {} : { toolOverrides }),
    },
    warnings,
  };
}
