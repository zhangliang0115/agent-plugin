/**
 * The `tools/pre-execute` listener that refuses calls to disabled tools. It is the only denial
 * path for MCP tools: every executor runs its calls through this pipeline stage. Kept free of DSH
 * imports so it runs under node:test with a fake call. @module
 */
import { denialMessage } from '@zhangliang0115/mcp-ui-core';
import { isDisabledNow } from './disabled-service.ts';

/** The part of a DSH tool call the listener reads. */
export interface ToolCallLike {
  /** Model-facing tool name, `mcp__<server>__<tool>` for MCP tools. */
  readonly name: string;
}

/** The refusal a pre-execute listener returns; the tool body does not run. */
export interface DenyDecision {
  readonly kind: 'deny';
  readonly reason: string;
}

/**
 * @param read - returns the current disabled list; called on every call.
 * @returns a waterfall listener. It returns a deny decision for a disabled tool and otherwise
 * the result of `next()`, unchanged.
 */
export function createDisabledToolGate(read: () => readonly string[]) {
  return async function gateToolCall<Decision>(
    call: ToolCallLike,
    next: () => Promise<Decision>,
  ): Promise<Decision | DenyDecision> {
    if (!isDisabledNow(call.name, read)) return next();
    return { kind: 'deny', reason: denialMessage(call.name) };
  };
}
