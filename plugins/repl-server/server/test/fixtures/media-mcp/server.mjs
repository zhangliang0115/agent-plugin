#!/usr/bin/env node
// Minimal stdio MCP server for the pool media tests: one `fetch` tool answers
// with a text block, a PNG image block and a PDF resource block. Frames are
// newline-delimited JSON-RPC on stdout; nothing is logged there.

import process from 'node:process';
import readline from 'node:readline';

const TOOL = {
  name: 'fetch',
  description: 'Return one text block, one image and one PDF resource.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: true },
};

const RESULT = {
  content: [
    { type: 'text', text: 'saved' },
    { type: 'image', data: 'aW1n', mimeType: 'image/png' },
    {
      type: 'resource',
      resource: { uri: 'file:///report.pdf', mimeType: 'application/pdf', blob: 'cGRm' },
    },
  ],
};

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  if (line.trim() === '') return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame === null || typeof frame !== 'object' || typeof frame.method !== 'string') return;
  if (frame.id === undefined || frame.id === null) return;

  const { id, method, params } = frame;
  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion:
          typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'media-mcp', version: '0.0.0' },
      },
    });
    return;
  }
  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }
  if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: [TOOL] } });
    return;
  }
  if (method === 'tools/call') {
    if (params?.name === 'fetch') {
      send({ jsonrpc: '2.0', id, result: RESULT });
      return;
    }
    send({
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: `unknown tool ${String(params?.name)}` },
    });
    return;
  }
  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `method not found: ${method}` },
  });
});
