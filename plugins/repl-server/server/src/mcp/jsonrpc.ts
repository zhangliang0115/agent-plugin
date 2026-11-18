/** Minimal JSON-RPC 2.0 dispatcher backing the MCP endpoint. @module */

import {
  JsonRpcError,
  JSON_RPC_INTERNAL_ERROR,
  JSON_RPC_INVALID_PARAMS,
  JSON_RPC_INVALID_REQUEST,
  JSON_RPC_METHOD_NOT_FOUND,
  JSON_RPC_PARSE_ERROR,
  isJsonRpcError,
  type JsonRpcErrorBody,
} from './errors.ts';

export type JsonRpcId = string | number | null;

export interface JsonRpcSuccessResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorBody;
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;

/** Called with the request params (never undefined) and the per-transport context. */
export type JsonRpcHandler<Context = undefined> = (
  params: Record<string, unknown>,
  context: Context,
) => unknown | Promise<unknown>;

/**
 * Registers method handlers and turns one parsed JSON-RPC message into one
 * response. Notifications (no `id` member) always yield `null`; batch requests
 * are rejected with `-32600` because the MCP layer does not support them.
 */
export class JsonRpcDispatcher<Context = undefined> {
  private readonly handlers = new Map<string, JsonRpcHandler<Context>>();

  register(method: string, handler: JsonRpcHandler<Context>): this {
    if (method.length === 0) throw new TypeError('JSON-RPC method must not be empty');
    if (this.handlers.has(method)) throw new Error(`Duplicate JSON-RPC method: ${method}`);
    this.handlers.set(method, handler);
    return this;
  }

  has(method: string): boolean {
    return this.handlers.has(method);
  }

  methods(): string[] {
    return [...this.handlers.keys()];
  }

  async handle(message: unknown, context?: Context): Promise<JsonRpcResponse | null> {
    if (Array.isArray(message)) {
      return errorResponse(null, new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Batch requests are not supported'));
    }
    if (!isRecord(message)) {
      return errorResponse(null, new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Invalid Request'));
    }

    const hasId = Object.hasOwn(message, 'id');
    let id: JsonRpcId = null;
    if (hasId) {
      const rawId = message['id'];
      if (typeof rawId === 'string' || rawId === null || (typeof rawId === 'number' && Number.isFinite(rawId))) {
        id = rawId;
      } else {
        return errorResponse(
          null,
          new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Invalid Request: id must be a string, number or null'),
        );
      }
    }

    if (message['jsonrpc'] !== '2.0') {
      return errorResponse(null, new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Invalid Request: jsonrpc must be "2.0"'));
    }

    const method = message['method'];
    if (typeof method !== 'string' || method.length === 0) {
      return errorResponse(null, new JsonRpcError(JSON_RPC_INVALID_REQUEST, 'Invalid Request: method must be a string'));
    }

    let params: Record<string, unknown> = {};
    const rawParams = message['params'];
    if (rawParams !== undefined) {
      if (!isRecord(rawParams)) {
        return hasId
          ? errorResponse(id, new JsonRpcError(JSON_RPC_INVALID_PARAMS, 'Invalid params: params must be an object'))
          : null;
      }
      params = rawParams;
    }

    if (!hasId) {
      const handler = this.handlers.get(method);
      if (handler !== undefined) {
        try {
          await handler(params, context as Context);
        } catch {
          // Notifications never receive a response, including when the handler throws.
        }
      }
      return null;
    }

    const handler = this.handlers.get(method);
    if (handler === undefined) {
      return errorResponse(id, new JsonRpcError(JSON_RPC_METHOD_NOT_FOUND, `Method not found: ${method}`));
    }

    try {
      const result = await handler(params, context as Context);
      return { jsonrpc: '2.0', id, result: result === undefined ? null : result };
    } catch (error) {
      return errorResponse(
        id,
        isJsonRpcError(error) ? error : new JsonRpcError(JSON_RPC_INTERNAL_ERROR, errorMessage(error)),
      );
    }
  }

  async handleText(text: string, context?: Context): Promise<JsonRpcResponse | null> {
    let message: unknown;
    try {
      message = JSON.parse(text);
    } catch {
      return errorResponse(null, new JsonRpcError(JSON_RPC_PARSE_ERROR, 'Parse error'));
    }
    return this.handle(message, context);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'Internal error';
}

function errorResponse(id: JsonRpcId, error: JsonRpcError): JsonRpcErrorResponse {
  return { jsonrpc: '2.0', id, error: error.toBody() };
}
