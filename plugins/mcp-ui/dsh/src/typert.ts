/**
 * Host face of the `mcpTools` remote, exported from the package as `./typert`. DSH's Typert loader
 * imports it when this package's row mounts and registers `TYPERT` into `ctx.typert`. @module
 */
import { REMOTE_NAMESPACE, REMOTE_PACKAGE, mcpToolsRemote } from './mcp-tools-remote.ts';

const WATCH_SIGNATURE = 'watch(signal: AbortSignal): AsyncIterable<ServerToolsView[]>';

export const TYPERT = {
  package: REMOTE_PACKAGE,
  face: 'host',
  schemas: [],
  get invocations() { return mcpToolsRemote.descriptors; },
  model: {
    services: [
      {
        description: 'MCP servers with live status and tools, for the MCP management page.',
        summary: 'MCP servers with live status and tools.',
        tags: [],
        jsDoc: '/** MCP servers with live status and tools, for the MCP management page. */',
        key: REMOTE_NAMESPACE,
        exportName: 'default',
        members: [
          {
            kind: 'method',
            name: 'watch',
            signature: WATCH_SIGNATURE,
            summary: 'Stream the complete server list on subscription and after each change.',
            jsDoc: '/** Stream the complete server list on subscription and after each change. */',
          },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
} as const;
