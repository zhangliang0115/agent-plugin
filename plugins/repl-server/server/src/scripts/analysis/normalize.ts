/**
 * Formatting-tolerant tokenizer and digests for script analysis. It is not a
 * JavaScript parser: it only needs stable keys for clustering, so comments,
 * whitespace and literal values are handled conservatively.
 * @module
 */

import { createHash } from 'node:crypto';

export type CodeTokenType = 'identifier' | 'number' | 'string' | 'regex' | 'punct';

export interface CodeToken {
  readonly type: CodeTokenType;
  readonly value: string;
}

/** Keywords after which a `/` starts a regex literal rather than division. */
const REGEX_KEYWORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);

const PUNCTUATORS = [
  '>>>=',
  '===',
  '!==',
  '>>>',
  '**=',
  '&&=',
  '||=',
  '??=',
  '<<=',
  '>>=',
  '...',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
  '++',
  '--',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '&=',
  '|=',
  '^=',
  '**',
  '<<',
  '>>',
] as const;

function isWhitespace(ch: string): boolean {
  return /\s/u.test(ch);
}

function isDigit(ch: string | undefined): boolean {
  return ch !== undefined && ch >= '0' && ch <= '9';
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch !== undefined && (/[A-Za-z_$]/u.test(ch) || ch.charCodeAt(0) > 0x7f);
}

function isIdentifierPart(ch: string | undefined): boolean {
  return ch !== undefined && (/[A-Za-z0-9_$]/u.test(ch) || ch.charCodeAt(0) > 0x7f);
}

function readQuoted(code: string, start: number): number {
  const quote = code[start];
  let index = start + 1;
  while (index < code.length) {
    const ch = code[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    index += 1;
    if (ch === quote || ch === '\n') break;
  }
  return Math.min(index, code.length);
}

function skipTemplateExpression(code: string, start: number): number {
  let depth = 0;
  let index = start;
  while (index < code.length) {
    const ch = code[index];
    if (ch === '{') {
      depth += 1;
      index += 1;
      continue;
    }
    if (ch === '}') {
      depth -= 1;
      index += 1;
      if (depth === 0) return index;
      continue;
    }
    if (ch === "'" || ch === '"') {
      index = readQuoted(code, index);
      continue;
    }
    if (ch === '`') {
      index = readTemplate(code, index);
      continue;
    }
    if (ch === '/' && code[index + 1] === '/') {
      index += 2;
      while (index < code.length && code[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && code[index + 1] === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1;
      index = Math.min(code.length, index + 2);
      continue;
    }
    index += 1;
  }
  return index;
}

function readTemplate(code: string, start: number): number {
  let index = start + 1;
  while (index < code.length) {
    const ch = code[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '`') return index + 1;
    if (ch === '$' && code[index + 1] === '{') {
      index = skipTemplateExpression(code, index + 1);
      continue;
    }
    index += 1;
  }
  return Math.min(index, code.length);
}

function readRegex(code: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < code.length) {
    const ch = code[index];
    if (ch === '\\') {
      index += 2;
      continue;
    }
    if (ch === '\n') break;
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      index += 1;
      while (isIdentifierPart(code[index])) index += 1;
      return index;
    }
    index += 1;
  }
  return Math.min(index, code.length);
}

function readNumber(code: string, start: number): number {
  let index = start;
  const radix = code[index] === '0' ? code[index + 1]?.toLowerCase() : undefined;
  if (radix === 'x' || radix === 'b' || radix === 'o') {
    index += 2;
    while (index < code.length && /[0-9a-fA-F_]/u.test(code[index] ?? '')) index += 1;
    if (code[index] === 'n') index += 1;
    return index;
  }
  let seenDot = false;
  if (code[index] === '.') {
    seenDot = true;
    index += 1;
  }
  while (index < code.length && (isDigit(code[index]) || code[index] === '_')) index += 1;
  if (!seenDot && code[index] === '.') {
    index += 1;
    while (index < code.length && (isDigit(code[index]) || code[index] === '_')) index += 1;
  }
  if (code[index] === 'e' || code[index] === 'E') {
    let exponent = index + 1;
    if (code[exponent] === '+' || code[exponent] === '-') exponent += 1;
    if (isDigit(code[exponent])) {
      index = exponent + 1;
      while (index < code.length && (isDigit(code[index]) || code[index] === '_')) index += 1;
    }
  }
  if (code[index] === 'n') index += 1;
  return index;
}

function readPunctuator(code: string, start: number): number {
  for (const punctuator of PUNCTUATORS) {
    if (code.startsWith(punctuator, start)) return start + punctuator.length;
  }
  return start + 1;
}

function regexAllowed(previous: CodeToken | undefined): boolean {
  if (previous === undefined) return true;
  if (previous.type === 'identifier') return REGEX_KEYWORDS.has(previous.value);
  if (previous.type === 'punct') {
    return previous.value !== ')' && previous.value !== ']' && previous.value !== '}';
  }
  return false;
}

/**
 * Splits code into significant tokens, dropping whitespace and comments.
 * shortcut: `/` after `)`/`]`/`}` is read as division, so a regex literal in
 * statement position may be scanned as punctuation; upgrade to a real parser
 * if that ever causes visible false merges.
 */
export function tokenizeScriptCode(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let index = 0;
  while (index < code.length) {
    const ch = code[index] ?? '';
    if (isWhitespace(ch)) {
      index += 1;
      continue;
    }
    if (ch === '/' && code[index + 1] === '/') {
      index += 2;
      while (index < code.length && code[index] !== '\n') index += 1;
      continue;
    }
    if (ch === '/' && code[index + 1] === '*') {
      index += 2;
      while (index < code.length && !(code[index] === '*' && code[index + 1] === '/')) index += 1;
      index = Math.min(code.length, index + 2);
      continue;
    }
    if (ch === "'" || ch === '"') {
      const end = readQuoted(code, index);
      tokens.push({ type: 'string', value: code.slice(index, end) });
      index = end;
      continue;
    }
    if (ch === '`') {
      const end = readTemplate(code, index);
      tokens.push({ type: 'string', value: code.slice(index, end) });
      index = end;
      continue;
    }
    if (ch === '/' && regexAllowed(tokens[tokens.length - 1])) {
      const end = readRegex(code, index);
      tokens.push({ type: 'regex', value: code.slice(index, end) });
      index = end;
      continue;
    }
    if (isDigit(ch) || (ch === '.' && isDigit(code[index + 1]))) {
      const end = readNumber(code, index);
      tokens.push({ type: 'number', value: code.slice(index, end) });
      index = end;
      continue;
    }
    if (isIdentifierStart(ch)) {
      let end = index + 1;
      while (isIdentifierPart(code[end])) end += 1;
      tokens.push({ type: 'identifier', value: code.slice(index, end) });
      index = end;
      continue;
    }
    const end = readPunctuator(code, index);
    tokens.push({ type: 'punct', value: code.slice(index, end) });
    index = end;
  }
  return tokens;
}

/** Comment- and formatting-insensitive form used to recognise the same source. */
export function normalizeScriptCode(code: string): string {
  return tokenizeScriptCode(code)
    .map((token) => token.value)
    .join(' ');
}

/** SHA-256 of raw source; matches the `script_runs.code_sha256` convention. */
export function hashScriptCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

function isLiteral(token: CodeToken): boolean {
  if (token.type === 'string' || token.type === 'number' || token.type === 'regex') return true;
  return token.type === 'identifier' && (token.value === 'true' || token.value === 'false' || token.value === 'null');
}

/**
 * Structure key: normalized tokens with every literal replaced by `<lit>`.
 * Runs sharing this shape differ only in constant values, which is the signal
 * that the code is a parameterization candidate (design 10 §10.2).
 */
export function literalShape(tokens: readonly CodeToken[]): string {
  return tokens.map((token) => (isLiteral(token) ? '<lit>' : token.value)).join(' ');
}

/** Values of the literals in order; distinct signatures inside one shape are variants. */
export function literalSignature(tokens: readonly CodeToken[]): string {
  return tokens
    .filter(isLiteral)
    .map((token) => token.value)
    .join(' ');
}

const DECLARATION_KEYWORDS = new Set(['const', 'let', 'var']);

/** Count of `const` / `let` / `var` declarations; a soft parameterization signal. */
export function countDeclarations(tokens: readonly CodeToken[]): number {
  let count = 0;
  for (const token of tokens) {
    if (token.type === 'identifier' && DECLARATION_KEYWORDS.has(token.value)) count += 1;
  }
  return count;
}

/** Count of literal tokens; hardcoded values are what a parameterized rewrite replaces. */
export function countLiterals(tokens: readonly CodeToken[]): number {
  return tokens.filter(isLiteral).length;
}
