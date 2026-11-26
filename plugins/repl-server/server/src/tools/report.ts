/** `report_problem` tool handler: the MCP entry into the shared report pipeline. @module */

import type { RequestIdentity } from '../ports.ts';
import {
  ReportRateLimitError,
  ReportValidationError,
  type ReportService,
} from '../reports/service.ts';
import type { Severity } from '../reports/types.ts';
import {
  jsonResult,
  toolFailure,
  validateToolArguments,
  type CallToolResult,
} from './registry.ts';

interface ReportProblemArguments {
  title: string;
  detail: string;
  severity: Severity;
  context?: unknown;
}

export interface ReportProblemContext {
  identity: RequestIdentity;
  reports?: ReportService;
}

/**
 * Always returns synchronously: the report is stored and the alert dispatch is
 * kicked in the background (06 §3.1). Failures map to the frozen result shapes.
 */
export async function reportProblemCall(
  input: unknown,
  ctx: ReportProblemContext,
): Promise<CallToolResult> {
  const validation = validateToolArguments('report_problem', input);
  if (!validation.ok) return toolFailure(validation.code, validation.message);

  const args = validation.value as unknown as ReportProblemArguments;
  if (ctx.reports === undefined) {
    return toolFailure('REPORT_UNAVAILABLE', 'report service is not wired');
  }

  const identity = ctx.identity;
  const reportInput = {
    source: 'mcp' as const,
    title: args.title,
    detail: args.detail,
    severity: args.severity,
    binding: identity.binding,
    client: identity.client,
    clientName: identity.clientName ?? '',
    clientVersion: identity.clientVersion ?? '',
    mcp: identity.mcp,
    exec: null,
    evalId: null,
    ownerKey: identity.binding ?? identity.mcp,
    ...(args.context === undefined ? {} : { context: args.context }),
  };

  try {
    const result = await ctx.reports.create(reportInput);
    return jsonResult(
      { ok: true, reportId: result.report.id, duplicate: result.duplicate },
      false,
    );
  } catch (error) {
    if (error instanceof ReportRateLimitError) {
      return jsonResult(
        {
          ok: false,
          error: {
            code: 'REPORT_RATE_LIMITED',
            message: error.message,
            retryAfterMs: error.retryAfterMs,
          },
        },
        true,
      );
    }
    if (error instanceof ReportValidationError) {
      return toolFailure('INVALID_ARGUMENT', error.message);
    }
    return toolFailure(
      'REPORT_FAILED',
      error instanceof Error ? error.message : String(error),
    );
  }
}
