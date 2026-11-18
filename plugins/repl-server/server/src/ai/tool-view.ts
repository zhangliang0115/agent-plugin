/**
 * Tool metadata projection for the annotation prompt (08 §4.1). Only the
 * effective/upstream descriptions, tags and category leave the process; secret
 * values never appear in tool rows.
 * @module
 */

import { createHash } from 'node:crypto';

import type { ToolRecord } from '../admin/tools.ts';
import { truncateDescription, type PromptToolView } from './prompts.ts';

/** Sorted by name so the prompt and the hash are stable across refreshes. */
export function buildToolPromptViews(tools: readonly ToolRecord[]): PromptToolView[] {
  return [...tools]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .map((tool) => {
      const override = truncateDescription(tool.descriptionOverride);
      const upstream = truncateDescription(tool.description);
      return {
        name: tool.name,
        description: override ?? upstream,
        upstreamDescription: upstream,
        descriptionOverride: override,
        descriptionSource: tool.descriptionOverride !== null ? 'override' : 'upstream',
        tags: [...tool.tags],
        category: tool.category,
      };
    });
}

/** `(serverId, toolsHash)` attempt key; name plus upstream description, sorted. */
export function hashTools(tools: readonly ToolRecord[]): string {
  const lines = tools
    .map((tool) => [tool.name, tool.description ?? ''] as const)
    .sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0))
    .map(([name, description]) => `${name}\u0000${description}`)
    .join('\u0001');
  return createHash('sha256').update(lines).digest('hex');
}
