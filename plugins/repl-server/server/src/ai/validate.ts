/**
 * Shape and safety validation for AI drafts (08 §3.4, §4.3).
 *
 * Preview and apply run the same functions: the preview result is never a trust
 * boundary because the client may resubmit an edited `server` or `apply` body.
 * Errors use the admin API codes so the route layer can pass them through.
 * @module
 */

import { isAbsolute } from 'node:path';

import {
  AdminApiError,
  isPlainObject,
  type CommandArg,
  type SecretValue,
  type ServerConfig,
} from '../admin/servers.ts';
import { ACTION_TAG_KEYS } from '../catalog/tag-policy.ts';
import { PROVIDER_TOKEN_RULES } from './redact.ts';

export { PROVIDER_TOKEN_RULES } from './redact.ts';

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;
// Mirrors the category dictionary key rule in `admin/categories.ts`, so every
// key the administrator can store is also representable in an AI draft.
const CATEGORY_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const RESERVED_SERVER_IDS = new Set(['__official__', '__builtin__']);
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 8192;
const MAX_KEYS = 256;
const MAX_SERVER_TAGS = 2;
const MAX_TAG_SUGGESTIONS = 8;
const MAX_TOOL_OVERRIDES = 80;
const MAX_WARNINGS = 10;

// ---------------------------------------------------------------------------
// Secret literal scanning
// ---------------------------------------------------------------------------

/**
 * Defensive provider-token prefixes, shared with `redact.ts` so scanning and
 * redaction cannot drift.
 */
const SECRET_LITERAL_RULES: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/ },
  {
    name: 'credential_assignment',
    pattern: /(?:token|secret|password|passwd|api[_-]?key)\s*[:=]\s*\S+/i,
  },
  { name: 'jwt', pattern: /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/ },
  { name: 'url_userinfo', pattern: /https?:\/\/[^/\s:@]+:[^/\s@]+@/i },
  ...PROVIDER_TOKEN_RULES,
];

/** Names of the credential-shaped patterns found in `text`; empty when clean. */
export function scanSecretLiterals(text: string): string[] {
  const hits: string[] = [];
  for (const rule of SECRET_LITERAL_RULES) {
    if (rule.pattern.test(text)) hits.push(rule.name);
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function proposalInvalid(errors: string[], fields: string[] = []): AdminApiError {
  return new AdminApiError(422, 'AI_PROPOSAL_INVALID', errors.join('; '), { errors, fields });
}

function annotationInvalid(errors: string[], fields: string[] = []): AdminApiError {
  return new AdminApiError(422, 'AI_ANNOTATION_INVALID', errors.join('; '), { errors, fields });
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  prefix: string,
  fail: (errors: string[], fields: string[]) => AdminApiError,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw fail(
      unknown.map((key) => `unknown field ${key}`),
      unknown.map((key) => `${prefix}${key}`),
    );
  }
}

// ---------------------------------------------------------------------------
// Scalar helpers
// ---------------------------------------------------------------------------

/** Replaces control characters with spaces and trims; single-line fields use this. */
export function sanitizeSingleLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
}

function readBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw proposalInvalid([`${field} must be a boolean`], [field]);
  return value;
}

function readText(
  value: unknown,
  field: string,
  max: number,
  options: { multiline?: boolean } = {},
): string {
  if (typeof value !== 'string') throw proposalInvalid([`${field} must be a string`], [field]);
  const text = options.multiline === true ? value : sanitizeSingleLine(value);
  if (text.length > max) {
    throw proposalInvalid([`${field} must be at most ${max} characters`], [field]);
  }
  return text;
}

function readTags(value: unknown, field: string, prefix: string): string[] {
  if (!Array.isArray(value)) throw proposalInvalid([`${field} must be an array`], [prefix]);
  if (value.length > MAX_SERVER_TAGS) {
    throw proposalInvalid([`${field} must have at most ${MAX_SERVER_TAGS} items`], [prefix]);
  }
  const tags: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || !TAG_PATTERN.test(entry)) {
      throw proposalInvalid(
        [`${field}[${index}] must match ${String(TAG_PATTERN)}`],
        [`${prefix}[${index}]`],
      );
    }
    if (ACTION_TAG_KEYS.has(entry)) {
      throw proposalInvalid(
        [`${field}[${index}] must not be an action key (${entry})`],
        [`${prefix}[${index}]`],
      );
    }
    if (!tags.includes(entry)) tags.push(entry);
  }
  return tags;
}

function readKeyList(
  value: unknown,
  field: string,
  pattern: RegExp,
  prefix: string,
): string[] {
  if (!Array.isArray(value)) throw proposalInvalid([`${field} must be an array`], [prefix]);
  if (value.length > MAX_KEYS) {
    throw proposalInvalid([`${field} must have at most ${MAX_KEYS} items`], [prefix]);
  }
  const keys: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || !pattern.test(entry)) {
      throw proposalInvalid([`${field}[${index}] is not a valid key name`], [`${prefix}[${index}]`]);
    }
    if (!keys.includes(entry)) keys.push(entry);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// AI-specific command and URL rules (stricter than manual registration)
// ---------------------------------------------------------------------------

export function assertAiCommand(value: unknown, field = 'server.command'): string {
  if (typeof value !== 'string') {
    throw proposalInvalid([`${field} must be a string`], [field]);
  }
  const command = value.trim();
  if (command === '') throw proposalInvalid([`${field} must not be empty`], [field]);
  if (command.length > 4096) {
    throw proposalInvalid([`${field} must be at most 4096 characters`], [field]);
  }
  if (/[\u0000\r\n]/.test(command) || /[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(command)) {
    throw proposalInvalid([`${field} must not contain control characters`], [field]);
  }
  if (/[;&|`]/.test(command) || command.includes('$(')) {
    throw proposalInvalid(
      [`${field} must be a bare executable or absolute path without shell syntax`],
      [field],
    );
  }
  return command;
}

/** `localhost`, `127.0.0.1` and `::1` are the only hosts allowed over plain http. */
export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '::1';
}

export function assertAiUrl(value: unknown, field = 'server.url'): string {
  if (typeof value !== 'string') {
    throw proposalInvalid([`${field} must be a string`], [field]);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw proposalInvalid([`${field} is not a valid URL`], [field]);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw proposalInvalid([`${field} must use http or https`], [field]);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AdminApiError(422, 'URL_HAS_CREDENTIALS', `${field} must not embed credentials`, {
      field,
    });
  }
  if (parsed.protocol === 'http:' && !isLoopbackHost(parsed.hostname)) {
    throw proposalInvalid(
      [`${field} may use http only for localhost, 127.0.0.1 or ::1`],
      [field],
    );
  }
  return value;
}

function readArgs(value: unknown): CommandArg[] {
  if (!Array.isArray(value)) throw proposalInvalid(['server.args must be an array'], ['server.args']);
  if (value.length > MAX_ARGS) {
    throw proposalInvalid(
      [`server.args must have at most ${MAX_ARGS} items`],
      ['server.args'],
    );
  }

  const args: CommandArg[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const field = `server.args[${index}]`;
    if (typeof entry === 'string') {
      if (entry.length > MAX_ARG_LENGTH) {
        throw proposalInvalid([`${field} must be at most ${MAX_ARG_LENGTH} characters`], [field]);
      }
      if (/[\u0000\r\n]/.test(entry)) {
        throw proposalInvalid([`${field} must not contain NUL or newlines`], [field]);
      }
      if (scanSecretLiterals(entry).length > 0) {
        throw new AdminApiError(
          422,
          'AI_SECRET_LITERAL',
          'args contain a literal credential; use {"$secret":"NAME"} instead',
          { fields: [field] },
        );
      }
      args.push(entry);
      continue;
    }
    if (isPlainObject(entry)) {
      const name = entry['$secret'];
      if (
        typeof name === 'string' &&
        name !== '' &&
        name.length <= MAX_KEYS &&
        Object.keys(entry).length === 1
      ) {
        args.push({ $secret: name });
        continue;
      }
    }
    throw proposalInvalid([`${field} must be a string or { "$secret": "<name>" }`], [field]);
  }
  return args;
}

// ---------------------------------------------------------------------------
// Template A: proposal
// ---------------------------------------------------------------------------

export interface ProposalServer {
  id: string;
  label: string;
  transport: 'stdio' | 'http';
  command: string | null;
  args: CommandArg[];
  cwd: string | null;
  url: string | null;
  env: Record<string, string>;
  headers: Record<string, string>;
  envKeys: string[];
  headerKeys: string[];
  enabled: boolean;
  connectMode: 'lazy' | 'eager';
  tags: string[];
  category: string | null;
  summary: string | null;
}

export interface NormalizedProposal {
  server: ProposalServer | null;
  explanation: string;
  warnings: string[];
}

export interface ProposalDisplay {
  server: ProposalServer | null;
  explanation: string;
  warnings: string[];
  inputWarning: boolean;
}

const PROPOSAL_FIELDS: ReadonlySet<string> = new Set(['server', 'explanation', 'warnings']);
const PROPOSAL_SERVER_FIELDS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'transport',
  'command',
  'args',
  'cwd',
  'url',
  'env',
  'headers',
  'envKeys',
  'headerKeys',
  'enabled',
  'connectMode',
  'tags',
  'category',
  'summary',
]);

/**
 * Plain config for AI drafts: string values only. Credential-shaped values stay
 * rejected; references must use `envKeys`/`headerKeys`, so a draft never carries
 * secret material itself.
 */
function readLiteralRecord(
  value: unknown,
  key: 'env' | 'headers',
): Record<string, string> {
  const field = `server.${key}`;
  const keyList = key === 'env' ? 'envKeys' : 'headerKeys';
  const pattern = key === 'env' ? ENV_KEY_PATTERN : HEADER_KEY_PATTERN;
  if (!isPlainObject(value)) {
    throw proposalInvalid([`${field} must be an object`], [field]);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_KEYS) {
    throw proposalInvalid([`${field} must have at most ${MAX_KEYS} keys`], [field]);
  }
  const result: Record<string, string> = {};
  for (const [name, entry] of entries) {
    // `__proto__` would hit the prototype setter instead of creating an own key.
    if (name === '__proto__' || name.length > 256 || !pattern.test(name)) {
      throw proposalInvalid([`${field}.${name} is not a valid key name`], [`${field}.${name}`]);
    }
    if (typeof entry !== 'string') {
      throw proposalInvalid(
        [`${field}.${name} must be a literal string; use ${keyList} for secret references`],
        [`${field}.${name}`],
      );
    }
    if (entry.length > MAX_ARG_LENGTH) {
      throw proposalInvalid(
        [`${field}.${name} must be at most ${MAX_ARG_LENGTH} characters`],
        [`${field}.${name}`],
      );
    }
    if (scanSecretLiterals(entry).length > 0) {
      throw new AdminApiError(
        422,
        'AI_SECRET_LITERAL',
        'literal credentials are not accepted; use envKeys/headerKeys',
        { fields: [`${field}.${name}`] },
      );
    }
    result[name] = entry;
  }
  return result;
}

/** One key in both the literal object and the key list has no unambiguous value. */
function assertNoLiteralKeyOverlap(
  literals: Record<string, string>,
  keys: readonly string[],
  key: 'env' | 'headers',
): void {
  const keyList = key === 'env' ? 'envKeys' : 'headerKeys';
  const overlap = keys.filter((name) => Object.hasOwn(literals, name));
  if (overlap.length === 0) return;
  throw proposalInvalid(
    overlap.map(
      (name) => `server.${key}.${name} is both a literal and listed in server.${keyList}`,
    ),
    overlap.map((name) => `server.${key}.${name}`),
  );
}

export function normalizeProposalServer(value: unknown): ProposalServer {
  if (!isPlainObject(value)) {
    throw proposalInvalid(['server must be an object or null'], ['server']);
  }
  unknownFields(value, PROPOSAL_SERVER_FIELDS, 'server.', proposalInvalid);

  const rawId = value['id'];
  if (typeof rawId !== 'string' || rawId.trim() === '') {
    throw proposalInvalid(['server.id is required'], ['server.id']);
  }
  const id = rawId.trim();
  if (RESERVED_SERVER_IDS.has(id)) {
    throw new AdminApiError(422, 'BUILTIN_RESERVED', `${id} is reserved for seeded servers`);
  }
  if (!SERVER_ID_PATTERN.test(id)) {
    throw proposalInvalid(
      ['server.id must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}'],
      ['server.id'],
    );
  }

  const transport = value['transport'];
  if (transport !== 'stdio' && transport !== 'http') {
    throw proposalInvalid(['server.transport must be "stdio" or "http"'], ['server.transport']);
  }

  const label =
    value['label'] === undefined
      ? id
      : readText(value['label'], 'server.label', 128);
  if (label === '') throw proposalInvalid(['server.label must not be empty'], ['server.label']);

  const command =
    value['command'] === undefined || value['command'] === null
      ? null
      : assertAiCommand(value['command']);

  const url =
    value['url'] === undefined || value['url'] === null
      ? null
      : assertAiUrl(value['url']);

  let cwd: string | null = null;
  if (value['cwd'] !== undefined && value['cwd'] !== null) {
    if (typeof value['cwd'] !== 'string' || value['cwd'].includes('\u0000')) {
      throw proposalInvalid(['server.cwd must be a string without NUL'], ['server.cwd']);
    }
    const text = value['cwd'];
    if (text.length > 4096 || !isAbsolute(text)) {
      throw proposalInvalid(['server.cwd must be an absolute path'], ['server.cwd']);
    }
    cwd = text;
  }

  const args = value['args'] === undefined ? [] : readArgs(value['args']);
  const env = value['env'] === undefined ? {} : readLiteralRecord(value['env'], 'env');
  const headers =
    value['headers'] === undefined ? {} : readLiteralRecord(value['headers'], 'headers');
  const envKeys =
    value['envKeys'] === undefined
      ? []
      : readKeyList(value['envKeys'], 'server.envKeys', ENV_KEY_PATTERN, 'server.envKeys');
  const headerKeys =
    value['headerKeys'] === undefined
      ? []
      : readKeyList(
          value['headerKeys'],
          'server.headerKeys',
          HEADER_KEY_PATTERN,
          'server.headerKeys',
        );
  assertNoLiteralKeyOverlap(env, envKeys, 'env');
  assertNoLiteralKeyOverlap(headers, headerKeys, 'headers');

  const enabled =
    value['enabled'] === undefined ? true : readBoolean(value['enabled'], 'server.enabled');

  const connectMode = value['connectMode'] === undefined ? 'eager' : value['connectMode'];
  if (connectMode !== 'lazy' && connectMode !== 'eager') {
    throw proposalInvalid(['server.connectMode must be "lazy" or "eager"'], [
      'server.connectMode',
    ]);
  }

  const tags = value['tags'] === undefined ? [] : readTags(value['tags'], 'server.tags', 'server.tags');

  let category: string | null = null;
  if (value['category'] !== undefined && value['category'] !== null) {
    if (typeof value['category'] !== 'string' || !CATEGORY_PATTERN.test(value['category'])) {
      throw proposalInvalid(
        [`server.category must match ${String(CATEGORY_PATTERN)}`],
        ['server.category'],
      );
    }
    category = value['category'];
  }

  let summary: string | null = null;
  if (value['summary'] !== undefined && value['summary'] !== null) {
    summary = readText(value['summary'], 'server.summary', 160);
    if (summary === '') summary = null;
  }

  if (transport === 'stdio') {
    if (command === null) {
      throw proposalInvalid(['stdio servers require server.command'], ['server.command']);
    }
    if (url !== null) {
      throw proposalInvalid(['stdio servers cannot set server.url'], ['server.url']);
    }
  } else {
    if (url === null) {
      throw proposalInvalid(['http servers require server.url'], ['server.url']);
    }
    if (command !== null) {
      throw proposalInvalid(['http servers cannot set server.command'], ['server.command']);
    }
    if (cwd !== null) {
      throw proposalInvalid(['http servers cannot set server.cwd'], ['server.cwd']);
    }
    if (args.length > 0) {
      throw proposalInvalid(['http servers cannot set server.args'], ['server.args']);
    }
  }

  return {
    id,
    label,
    transport,
    command,
    args,
    cwd,
    url,
    env,
    headers,
    envKeys,
    headerKeys,
    enabled,
    connectMode,
    tags,
    category,
    summary,
  };
}

export function normalizeProposal(value: unknown): NormalizedProposal {
  if (!isPlainObject(value)) {
    throw proposalInvalid(['AI output must be a JSON object'], []);
  }
  // Models occasionally nest explanation/warnings under `server`. The contract
  // keeps them top-level; lift them instead of rejecting an otherwise valid plan.
  let normalized = value;
  const nestedServer = value['server'];
  if (
    isPlainObject(nestedServer) &&
    ('explanation' in nestedServer || 'warnings' in nestedServer)
  ) {
    const server = { ...nestedServer };
    const lifted: Record<string, unknown> = { ...value };
    if (lifted['explanation'] === undefined && typeof server['explanation'] === 'string') {
      lifted['explanation'] = server['explanation'];
    }
    if (lifted['warnings'] === undefined && Array.isArray(server['warnings'])) {
      lifted['warnings'] = server['warnings'];
    }
    delete server['explanation'];
    delete server['warnings'];
    lifted['server'] = server;
    normalized = lifted;
  }
  unknownFields(normalized, PROPOSAL_FIELDS, '', proposalInvalid);
  if (!('server' in normalized)) {
    throw proposalInvalid(['AI output is missing "server"'], ['server']);
  }

  const server =
    normalized['server'] === null ? null : normalizeProposalServer(normalized['server']);

  const explanation =
    normalized['explanation'] === undefined
      ? ''
      : readText(normalized['explanation'], 'explanation', 2000, { multiline: true });

  let warnings: string[] = [];
  if (normalized['warnings'] !== undefined) {
    if (!Array.isArray(normalized['warnings'])) {
      throw proposalInvalid(['warnings must be an array'], ['warnings']);
    }
    if (normalized['warnings'].length > MAX_WARNINGS) {
      throw proposalInvalid([`warnings must have at most ${MAX_WARNINGS} items`], ['warnings']);
    }
    warnings = normalized['warnings'].map((entry, index) => {
      if (typeof entry !== 'string') {
        throw proposalInvalid([`warnings[${index}] must be a string`], [`warnings[${index}]`]);
      }
      if (entry.length > 300) {
        throw proposalInvalid(
          [`warnings[${index}] must be at most 300 characters`],
          [`warnings[${index}]`],
        );
      }
      return entry;
    });
  }

  if (server === null && warnings.length === 0) {
    throw proposalInvalid(['server is null but warnings is empty'], ['warnings']);
  }

  return { server, explanation, warnings };
}

/** Draft keys may be `__proto__`; defineProperty keeps them own data. */
function defineOwn(target: Record<string, SecretValue>, key: string, value: SecretValue): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** Converts a normalized proposal into the shape `ServerStore.create` accepts. */
export function toServerConfig(server: ProposalServer): ServerConfig {
  const env: Record<string, SecretValue> = {};
  for (const [key, value] of Object.entries(server.env)) defineOwn(env, key, value);
  for (const key of server.envKeys) {
    if (!Object.hasOwn(env, key)) defineOwn(env, key, { $secret: key });
  }
  const headers: Record<string, SecretValue> = {};
  for (const [key, value] of Object.entries(server.headers)) defineOwn(headers, key, value);
  for (const key of server.headerKeys) {
    if (!Object.hasOwn(headers, key)) defineOwn(headers, key, { $secret: key });
  }

  return {
    id: server.id,
    label: server.label,
    transport: server.transport,
    command: server.command,
    args: server.args,
    env,
    cwd: server.cwd,
    url: server.url,
    headers,
    enabled: server.enabled,
    connectMode: server.connectMode,
    summary: server.summary,
    // Creating through AI apply marks the origin of a real summary (08 §3.5).
    // Without a summary there is no provenance to record, matching
    // `parseCreateServer` so both apply paths store the same value.
    summarySource: server.summary === null ? null : 'ai',
    category: server.category,
    tags: server.tags,
    timeoutMs: 60_000,
    maxConcurrency: 8,
  };
}

// ---------------------------------------------------------------------------
// Template B: annotation
// ---------------------------------------------------------------------------

export interface NormalizedToolOverride {
  name: string;
  tags?: string[];
}

/** A proposed dictionary entry the administrator may accept on apply. */
export interface DictionarySuggestion {
  key: string;
  zh: string;
  en: string;
}

export interface NormalizedAnnotation {
  summary?: string | null;
  category?: string | null;
  categorySuggestion?: DictionarySuggestion | null;
  tags?: string[];
  tagSuggestions?: DictionarySuggestion[];
  toolOverrides?: NormalizedToolOverride[];
  warnings: string[];
}

const ANNOTATION_FIELDS: ReadonlySet<string> = new Set([
  'summary',
  'category',
  'categorySuggestion',
  'tags',
  'tagSuggestions',
  'toolOverrides',
  'warnings',
]);
// `description` stays allowed but is ignored: models occasionally keep returning
// it from older prompts, and tool descriptions are never written by AI.
const TOOL_OVERRIDE_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'tags']);
const SUGGESTION_LABEL_MAX = 40;

/**
 * Validates a tag list, then applies the item cap. Model previews truncate the
 * overshoot (with a warning) because a single chatty field should not throw
 * away an otherwise valid annotation; apply keeps the hard rejection.
 */
function readTagList(
  value: unknown,
  field: string,
  prefix: string,
  limit: number,
  truncate: boolean,
): { tags: string[]; dropped: number } {
  if (!Array.isArray(value)) throw annotationInvalid([`${field} must be an array`], [prefix]);
  const tags: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (typeof entry !== 'string' || !TAG_PATTERN.test(entry)) {
      throw annotationInvalid(
        [`${field}[${index}] must match ${String(TAG_PATTERN)}`],
        [`${prefix}[${index}]`],
      );
    }
    if (!tags.includes(entry)) tags.push(entry);
  }
  if (tags.length <= limit) return { tags, dropped: 0 };
  if (!truncate) {
    throw annotationInvalid([`${field} must have at most ${limit} items`], [prefix]);
  }
  return { tags: tags.slice(0, limit), dropped: tags.length - limit };
}

function readToolOverrides(
  value: unknown,
  knownTools: ReadonlySet<string>,
  options: { truncate: boolean; notes: string[] },
): NormalizedToolOverride[] {
  if (!Array.isArray(value)) {
    throw annotationInvalid(['toolOverrides must be an array'], ['toolOverrides']);
  }
  if (value.length > MAX_TOOL_OVERRIDES) {
    throw annotationInvalid(
      [`toolOverrides must have at most ${MAX_TOOL_OVERRIDES} items`],
      ['toolOverrides'],
    );
  }

  const overrides: NormalizedToolOverride[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const field = `toolOverrides[${index}]`;
    if (!isPlainObject(entry)) {
      throw annotationInvalid([`${field} must be an object`], [field]);
    }
    unknownFields(entry, TOOL_OVERRIDE_FIELDS, `${field}.`, annotationInvalid);

    const name = entry['name'];
    if (typeof name !== 'string' || name === '') {
      throw annotationInvalid([`${field}.name is required`], [`${field}.name`]);
    }
    if (seen.has(name)) {
      throw annotationInvalid([`${field}.name is duplicated`], [`${field}.name`]);
    }
    seen.add(name);
    if (!knownTools.has(name)) {
      unknown.push(name);
      continue;
    }

    const override: NormalizedToolOverride = { name };
    if ('tags' in entry) {
      const read = readTagList(
        entry['tags'],
        `${field}.tags`,
        `${field}.tags`,
        MAX_TAG_SUGGESTIONS,
        options.truncate,
      );
      if (read.dropped > 0) {
        options.notes.push(
          `工具 ${name} 的标签超过 ${MAX_TAG_SUGGESTIONS} 个，已保留前 ${MAX_TAG_SUGGESTIONS} 个，其余 ${read.dropped} 个丢弃`,
        );
      }
      override.tags = read.tags;
    }
    overrides.push(override);
  }

  if (unknown.length > 0) {
    throw new AdminApiError(422, 'AI_UNKNOWN_TOOL', 'annotation references unknown tools', {
      names: unknown,
    });
  }
  return overrides;
}

function readSuggestion(
  value: unknown,
  field: string,
  pattern: RegExp,
): DictionarySuggestion {
  if (!isPlainObject(value)) {
    throw annotationInvalid([`${field} must be an object`], [field]);
  }
  const key = typeof value['key'] === 'string' ? value['key'].trim() : '';
  const zh = typeof value['zh'] === 'string' ? value['zh'].trim() : '';
  const en = typeof value['en'] === 'string' ? value['en'].trim() : '';
  if (!pattern.test(key)) {
    throw annotationInvalid([`${field}.key must match ${String(pattern)}`], [`${field}.key`]);
  }
  if (zh === '' || en === '') {
    throw annotationInvalid([`${field} requires both zh and en labels`], [field]);
  }
  if (zh.length > SUGGESTION_LABEL_MAX || en.length > SUGGESTION_LABEL_MAX) {
    throw annotationInvalid(
      [`${field} labels exceed ${SUGGESTION_LABEL_MAX} characters`],
      [field],
    );
  }
  return { key, zh, en };
}

function readTagSuggestions(
  value: unknown,
  options: { truncate: boolean; notes: string[] },
): DictionarySuggestion[] {
  if (!Array.isArray(value)) {
    throw annotationInvalid(['tagSuggestions must be an array'], ['tagSuggestions']);
  }
  const suggestions: DictionarySuggestion[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const suggestion = readSuggestion(value[index], `tagSuggestions[${index}]`, TAG_PATTERN);
    if (ACTION_TAG_KEYS.has(suggestion.key)) {
      options.notes.push(`标签建议 ${suggestion.key} 是动作键，已丢弃`);
      continue;
    }
    if (!suggestions.some((entry) => entry.key === suggestion.key)) suggestions.push(suggestion);
  }
  if (suggestions.length <= MAX_TAG_SUGGESTIONS) return suggestions;
  if (!options.truncate) {
    throw annotationInvalid(
      [`tagSuggestions must have at most ${MAX_TAG_SUGGESTIONS} items`],
      ['tagSuggestions'],
    );
  }
  const dropped = suggestions.length - MAX_TAG_SUGGESTIONS;
  options.notes.push(
    `建议标签超过 ${MAX_TAG_SUGGESTIONS} 个，已保留前 ${MAX_TAG_SUGGESTIONS} 个，其余 ${dropped} 个丢弃`,
  );
  return suggestions.slice(0, MAX_TAG_SUGGESTIONS);
}

export interface NormalizeAnnotationOptions {
  /** Preview-only: trim tag counts that exceed the caps instead of rejecting the draft. */
  truncateTagCounts?: boolean;
}

export function normalizeAnnotation(
  value: unknown,
  knownTools: readonly string[],
  options: NormalizeAnnotationOptions = {},
): NormalizedAnnotation {
  if (!isPlainObject(value)) {
    throw annotationInvalid(['annotation must be a JSON object'], []);
  }
  unknownFields(value, ANNOTATION_FIELDS, '', annotationInvalid);

  const truncate = options.truncateTagCounts === true;
  const notes: string[] = [];
  const result: NormalizedAnnotation = { warnings: [] };

  if ('summary' in value) {
    const summary = value['summary'];
    if (summary !== null && typeof summary !== 'string') {
      throw annotationInvalid(['summary must be a string or null'], ['summary']);
    }
    if (summary !== null) {
      const text = sanitizeSingleLine(summary);
      if (text.length > 160) {
        throw annotationInvalid(['summary must be at most 160 characters'], ['summary']);
      }
      result.summary = text === '' ? null : text;
    } else {
      result.summary = null;
    }
  }

  if ('category' in value) {
    const category = value['category'];
    if (category !== null && (typeof category !== 'string' || !CATEGORY_PATTERN.test(category))) {
      throw annotationInvalid(
        [`category must be null or match ${String(CATEGORY_PATTERN)}`],
        ['category'],
      );
    }
    result.category = category;
  }

  if ('categorySuggestion' in value) {
    const suggestion = value['categorySuggestion'];
    result.categorySuggestion =
      suggestion === null ? null : readSuggestion(suggestion, 'categorySuggestion', CATEGORY_PATTERN);
  }

  if ('tags' in value) {
    // Parse with the raw safety cap; the dictionary restriction and the final
    // 2-tag limit run after invalid keys are dropped, so a valid tag after an
    // invalid one is not lost to an early truncation.
    const read = readTagList(value['tags'], 'tags', 'tags', MAX_TAG_SUGGESTIONS, truncate);
    if (read.dropped > 0) {
      notes.push(
        `标签超过 ${MAX_TAG_SUGGESTIONS} 个，已保留前 ${MAX_TAG_SUGGESTIONS} 个，其余 ${read.dropped} 个丢弃`,
      );
    }
    result.tags = read.tags;
  }

  if ('tagSuggestions' in value) {
    result.tagSuggestions = readTagSuggestions(value['tagSuggestions'], { truncate, notes });
  }

  if ('toolOverrides' in value) {
    result.toolOverrides = readToolOverrides(
      value['toolOverrides'],
      new Set(knownTools),
      { truncate, notes },
    );
  }

  if ('warnings' in value) {
    const warnings = value['warnings'];
    if (!Array.isArray(warnings)) {
      throw annotationInvalid(['warnings must be an array'], ['warnings']);
    }
    if (warnings.length > MAX_WARNINGS) {
      throw annotationInvalid([`warnings must have at most ${MAX_WARNINGS} items`], ['warnings']);
    }
    result.warnings = warnings.map((entry, index) => {
      if (typeof entry !== 'string') {
        throw annotationInvalid([`warnings[${index}] must be a string`], [`warnings[${index}]`]);
      }
      if (entry.length > 300) {
        throw annotationInvalid(
          [`warnings[${index}] must be at most 300 characters`],
          [`warnings[${index}]`],
        );
      }
      return entry;
    });
  }

  result.warnings.push(...notes);
  return result;
}

/** True when no server-level, dictionary-suggestion or tool-level change was proposed. */
export function annotationIsEmpty(annotation: NormalizedAnnotation): boolean {
  return (
    (annotation.summary ?? null) === null &&
    (annotation.category ?? null) === null &&
    (annotation.categorySuggestion ?? null) === null &&
    (annotation.tags?.length ?? 0) === 0 &&
    (annotation.tagSuggestions?.length ?? 0) === 0 &&
    (annotation.toolOverrides?.some((override) => (override.tags?.length ?? 0) > 0) ?? false) === false
  );
}

export interface AnnotationDictionaryKeys {
  categories: ReadonlySet<string>;
  tags: ReadonlySet<string>;
}

export interface RestrictedAnnotation {
  annotation: NormalizedAnnotation;
  /** Human-readable reasons for every value dropped from the draft. */
  dropped: string[];
}

const AI_FORBIDDEN_TAGS: ReadonlySet<string> = new Set(['cross-env', 'official', 'builtin']);

/** Environment and provenance are deployment facts the model cannot see. */
export function isAiForbiddenTag(tag: string): boolean {
  return tag.startsWith('env.') || AI_FORBIDDEN_TAGS.has(tag);
}

/**
 * Splits a draft into existing values and new dictionary suggestions. Unknown
 * existing values are dropped with a warning; a suggestion whose key already
 * exists becomes an ordinary existing value. Forbidden environment/provenance
 * keys never become suggestions, and category keys are never accepted as tags
 * or tag suggestions. Tool override tags may reference either set.
 */
export function restrictAnnotationToDictionary(
  annotation: NormalizedAnnotation,
  keys: AnnotationDictionaryKeys,
): RestrictedAnnotation {
  const restricted: NormalizedAnnotation = {
    ...annotation,
    warnings: [...annotation.warnings],
  };
  const dropped: string[] = [];

  if (
    restricted.category !== undefined &&
    restricted.category !== null &&
    !keys.categories.has(restricted.category)
  ) {
    dropped.push(`分类 ${restricted.category} 不在分类字典中，已丢弃`);
    restricted.category = null;
  }

  if (restricted.categorySuggestion !== undefined && restricted.categorySuggestion !== null) {
    const suggestion = restricted.categorySuggestion;
    if (isAiForbiddenTag(suggestion.key)) {
      dropped.push(`分类建议 ${suggestion.key} 是环境或来源标签，由管理员维护，已丢弃`);
      restricted.categorySuggestion = null;
    } else if (keys.tags.has(suggestion.key)) {
      dropped.push(`分类建议 ${suggestion.key} 已是标签 key，标签 key 不能作为分类`);
      restricted.categorySuggestion = null;
    } else if (
      restricted.tagSuggestions?.some((entry) => entry.key === suggestion.key) === true
    ) {
      dropped.push(`分类建议 ${suggestion.key} 与标签建议重名，不能同时写入两个字典`);
      restricted.categorySuggestion = null;
    } else if (keys.categories.has(suggestion.key)) {
      if (restricted.category === undefined || restricted.category === null) {
        restricted.category = suggestion.key;
      }
      restricted.categorySuggestion = null;
    } else if (restricted.category !== undefined && restricted.category !== null) {
      dropped.push(`已给出分类 ${restricted.category}，建议分类 ${suggestion.key} 已忽略`);
      restricted.categorySuggestion = null;
    }
  }

  if (restricted.tags !== undefined) {
    restricted.tags = restricted.tags.filter((tag) => {
      if (isAiForbiddenTag(tag)) {
        dropped.push(`标签 ${tag} 是环境或来源标签，由管理员维护，AI 生成值已丢弃`);
        return false;
      }
      if (ACTION_TAG_KEYS.has(tag)) {
        dropped.push(`标签 ${tag} 是动作键，动作不能作为标签`);
        return false;
      }
      if (keys.categories.has(tag)) {
        dropped.push(`标签 ${tag} 是分类 key，分类 key 不能当标签，已丢弃`);
        return false;
      }
      if (!keys.tags.has(tag)) {
        dropped.push(`标签 ${tag} 不在标签字典中，已丢弃`);
        return false;
      }
      return true;
    });
  }

  if (restricted.tagSuggestions !== undefined) {
    const kept: DictionarySuggestion[] = [];
    for (const suggestion of restricted.tagSuggestions) {
      if (isAiForbiddenTag(suggestion.key)) {
        dropped.push(`标签 ${suggestion.key} 由管理员维护，不能作为建议新增`);
        continue;
      }
      if (ACTION_TAG_KEYS.has(suggestion.key)) {
        dropped.push(`标签建议 ${suggestion.key} 是动作键，动作不能作为标签`);
        continue;
      }
      if (keys.categories.has(suggestion.key)) {
        dropped.push(`标签建议 ${suggestion.key} 是分类 key，分类 key 不能当标签`);
        continue;
      }
      if (keys.tags.has(suggestion.key)) {
        // Already in the dictionary; a suggestion never becomes a server tag.
        continue;
      }
      if (!kept.some((entry) => entry.key === suggestion.key)) kept.push(suggestion);
    }
    restricted.tagSuggestions = kept;
  }

  if (restricted.toolOverrides !== undefined) {
    const allowed = new Set<string>([
      ...keys.tags,
      ...(restricted.tagSuggestions ?? []).map((suggestion) => suggestion.key),
    ]);
    restricted.toolOverrides = restricted.toolOverrides.map((override) => {
      if (override.tags === undefined) return override;
      const tags = override.tags.filter((tag) => {
        if (isAiForbiddenTag(tag)) {
          dropped.push(`工具标签 ${tag} 由管理员维护，AI 生成值已丢弃`);
          return false;
        }
        if (ACTION_TAG_KEYS.has(tag)) {
          dropped.push(`工具标签 ${tag} 是动作键，动作不能作为标签`);
          return false;
        }
        if (keys.categories.has(tag)) {
          dropped.push(`工具标签 ${tag} 是分类 key，分类 key 不能当标签，已丢弃`);
          return false;
        }
        if (!allowed.has(tag)) {
          dropped.push(`工具标签 ${tag} 不在标签字典或建议中，已丢弃`);
          return false;
        }
        return true;
      });
      return { ...override, tags };
    });
  }

  return { annotation: restricted, dropped };
}

// ---------------------------------------------------------------------------
// Settings (PUT /ai/config)
// ---------------------------------------------------------------------------

export { MODEL_PATTERN };
