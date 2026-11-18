/** JSON-RPC 2.0 error codes and the error type carried through the MCP layer. @module */

export const JSON_RPC_PARSE_ERROR = -32700;
export const JSON_RPC_INVALID_REQUEST = -32600;
export const JSON_RPC_METHOD_NOT_FOUND = -32601;
export const JSON_RPC_INVALID_PARAMS = -32602;
export const JSON_RPC_INTERNAL_ERROR = -32603;

/** Wire shape of the `error` member in a JSON-RPC response. */
export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** An error that must be serialized as a JSON-RPC error response rather than a result. */
export class JsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }

  toBody(): JsonRpcErrorBody {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export function isJsonRpcError(value: unknown): value is JsonRpcError {
  return value instanceof JsonRpcError;
}
