import { CodeMode, type CodeLimits } from '../src/index.ts';

export interface EnvelopeParts {
  evalIndex: number;
  log?: string;
  result?: string;
  error?: string;
}

/** Parses one `<repl-output>` envelope. Element bodies are returned as escaped in the envelope. */
export function parseEnvelope(text: string): EnvelopeParts {
  const head = /^<repl-output eval="(\d+)">/.exec(text);
  if (head === null || !text.endsWith('</repl-output>')) throw new Error(`not an envelope: ${text}`);
  const body = text.slice(head[0].length, -'</repl-output>'.length);
  const element = (tag: string): string | undefined => {
    const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(body);
    return match === null ? undefined : match[1];
  };
  return { evalIndex: Number(head[1]), log: element('log'), result: element('result'), error: element('error') };
}

export function newMode(limits: Partial<CodeLimits> = {}): CodeMode {
  return new CodeMode(limits);
}

export const noTools = { tools: [], invoke: async (): Promise<never> => { throw new Error('no tools'); } };
