/**
 * Validates one payload from `ctx.remote.mcpTools.watch`. The payload crosses the
 * remote boundary as untyped data, so every field is checked before the page uses it. @module
 */
import type { ServerToolsView, ServerToolView, StatusLike } from '@zhangliang0115/mcp-ui-core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolView(value: unknown): value is ServerToolView {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.rawName === 'string'
    && typeof value.description === 'string'
    && typeof value.descriptionTruncated === 'boolean';
}

function isStatus(value: unknown): value is StatusLike {
  return isRecord(value) && typeof value.state === 'string';
}

function isServerView(value: unknown): value is ServerToolsView {
  return isRecord(value)
    && typeof value.name === 'string'
    && typeof value.configured === 'boolean'
    && isStatus(value.status)
    && Array.isArray(value.tools)
    && value.tools.every(isToolView)
    && typeof value.truncated === 'boolean';
}

/**
 * Check one stream payload. A payload with any malformed server is rejected whole,
 * so the page never mixes a bad snapshot with the last good one.
 * @param value - the value the stream yielded.
 * @returns the servers, or undefined when the payload does not have the expected shape.
 */
export function parseToolsPayload(value: unknown): ServerToolsView[] | undefined {
  if (!Array.isArray(value) || !value.every(isServerView)) return undefined;
  return value;
}
