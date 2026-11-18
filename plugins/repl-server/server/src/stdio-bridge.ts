// hook-allow: forwards JSON-RPC to the local repl-server daemon only
import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';

export interface StdioBridgeOptions {
  url: string;
  token?: string;
  tokenFile?: string;
  log?: (line: string) => void;
}

/** Newline-delimited JSON-RPC on stdin/stdout, forwarded to the HTTP /mcp endpoint. */
export async function runStdioBridge(options: StdioBridgeOptions): Promise<number> {
  const token =
    options.token ??
    (options.tokenFile === undefined ? undefined : (await readFile(options.tokenFile, 'utf8')).trim());
  let sessionId: string | null = null;

  return await new Promise<number>((resolve) => {
    const lines = createInterface({ input: process.stdin });
    let chain = Promise.resolve();

    lines.on('line', (line) => {
      chain = chain.then(async () => {
        if (line.trim() === '') return;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (token !== undefined && token !== '') headers['authorization'] = `Bearer ${token}`;
        if (sessionId !== null) headers['mcp-session-id'] = sessionId;

        try {
          const response = await fetch(options.url, { method: 'POST', headers, body: line });
          const next = response.headers.get('mcp-session-id');
          if (next !== null) sessionId = next;
          if (response.status === 202) return;
          const text = await response.text();
          if (text !== '') process.stdout.write(`${text}\n`);
        } catch (error) {
          options.log?.(`repl-server bridge: ${(error as Error).message}`);
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32000, message: 'bridge cannot reach the daemon' },
            })}\n`,
          );
        }
      });
    });

    lines.on('close', () => {
      void chain.finally(() => resolve(0));
    });
  });
}
