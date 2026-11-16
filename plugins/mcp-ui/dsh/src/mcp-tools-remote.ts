/**
 * The `mcpTools` remote: one stream that carries every MCP server with its live status and its
 * tools (name and description). The host half serves it, the browser half mounts it. DSH generates
 * this kind of descriptor from decorated services; this one is written by hand because the
 * generator is not part of the runtime. Both halves import this file. @module
 */
import { createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol/remote-info';
import { z } from 'zod';

/** npm name of this package; the Typert registry matches descriptors to it. */
export const REMOTE_PACKAGE = '@zhangliang0115/mcp-ui';
/** Remote namespace, which is also the Cordis service the host provides. */
export const REMOTE_NAMESPACE = 'mcpTools';

const TypeSymbol = `${REMOTE_PACKAGE}#${REMOTE_NAMESPACE}/watch:result`;

const toolSchema = z.object({
  name: z.string(),
  rawName: z.string(),
  description: z.string(),
  descriptionTruncated: z.boolean(),
});

const statusSchema = z.object({
  state: z.string(),
  toolCount: z.number().optional(),
  attempt: z.number().optional(),
  reason: z.string().optional(),
  lastError: z.string().optional(),
});

const serverSchema = z.object({
  name: z.string(),
  configured: z.boolean(),
  status: statusSchema,
  tools: z.array(toolSchema),
  truncated: z.boolean(),
});

const resultSchema = z.array(serverSchema);

let cachedResult: z.ZodType | undefined;
const createResult = (): z.ZodType => (cachedResult ??= resultSchema);

const jsonSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      configured: { type: 'boolean' },
      status: {
        type: 'object',
        properties: {
          state: { type: 'string' },
          toolCount: { type: 'number' },
          attempt: { type: 'number' },
          reason: { type: 'string' },
          lastError: { type: 'string' },
        },
        required: ['state'],
      },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            rawName: { type: 'string' },
            description: { type: 'string' },
            descriptionTruncated: { type: 'boolean' },
          },
          required: ['name', 'rawName', 'description', 'descriptionTruncated'],
        },
      },
      truncated: { type: 'boolean' },
    },
    required: ['name', 'configured', 'status', 'tools', 'truncated'],
  },
};

/** Lazy remote info for both halves; nothing is registered or sent until it is mounted. */
export const mcpToolsRemote = createTypertRemoteInfo({
  package: REMOTE_PACKAGE,
  methods: {
    'mcpTools/watch': {
      service: REMOTE_NAMESPACE,
      description: 'Stream every MCP server with its live status and tools: the current list on subscription, then the complete list again after each status or tool change.',
      mode: 'stream',
      invocation: { kind: 'direct' },
      parameters: [],
      cancellation: { parameter: 'signal' },
      result: {
        mode: 'strict',
        typeSymbol: TypeSymbol,
        create: createResult,
        description: 'coalesced server lists until the subscriber or the host stops.',
        jsonSchema,
      },
    },
  },
}, z);
