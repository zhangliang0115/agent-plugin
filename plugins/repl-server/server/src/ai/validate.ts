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
import { PROVIDER_TOKEN_RULES } from './redact.ts';

export { PROVIDER_TOKEN_RULES } from './redact.ts';

const SERVER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_KEY_PATTERN = /^[A-Za-z0-9-]+$/;
const CATEGORY_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]-]{0,127}$/;
const RESERVED_SERVER_IDS = new Set(['__official__', '__builtin__']);
const MAX_ARGS = 256;
const MAX_ARG_LENGTH = 8192;
const MAX_KEYS = 256;
const MAX_TAGS = 8;
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
  if (value.length > MAX_TAGS) {
    throw proposalInvalid([`${field} must have at most ${MAX_TAGS} items`], [prefix]);
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
  'envKeys',
  'headerKeys',
  'enabled',
  'connectMode',
  'tags',
  'category',
  'summary',
]);

function readEnvOrHeaderLiteral(
  value: Record<string, unknown>,
  key: 'env' | 'headers',
): void {
  const field = `server.${key}`;
  const raw = value[key];
  if (!isPlainObject(raw)) {
    throw proposalInvalid([`${field} must be an object`], [field]);
  }
  let secretFound = false;
  for (const entry of Object.values(raw)) {
    if (typeof entry === 'string' && scanSecretLiterals(entry).length > 0) secretFound = true;
  }
  if (secretFound) {
    throw new AdminApiError(
      422,
      'AI_SECRET_LITERAL',
      'literal credentials are not accepted here; use envKeys/headerKeys',
      { fields: [field] },
    );
  }
  throw proposalInvalid([`${field} is not accepted; use envKeys/headerKeys`], [field]);
}

export function normalizeProposalServer(value: unknown): ProposalServer {
  if (!isPlainObject(value)) {
    throw proposalInvalid(['server must be an object or null'], ['server']);
  }
  // `env`/`headers` get the dedicated literal-vs-secret rejection; without this
  // ordering the generic unknown-field check would mask `AI_SECRET_LITERAL`.
  if ('env' in value) readEnvOrHeaderLiteral(value, 'env');
  if ('headers' in value) readEnvOrHeaderLiteral(value, 'headers');
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

  const enabled =
    value['enabled'] === undefined ? true : readBoolean(value['enabled'], 'server.enabled');

  const connectMode = value['connectMode'] === undefined ? 'lazy' : value['connectMode'];
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

/** Converts a normalized proposal into the shape `ServerStore.create` accepts. */
export function toServerConfig(server: ProposalServer): ServerConfig {
  const env: Record<string, SecretValue> = {};
  for (const key of server.envKeys) env[key] = { $secret: key };
  const headers: Record<string, SecretValue> = {};
  for (const key of server.headerKeys) headers[key] = { $secret: key };

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
    // Creating through AI apply marks the origin even when the draft has no
    // summary yet (08 §3.5).
    summarySource: 'ai',
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
  description?: string | null;
  tags?: string[];
}

export interface NormalizedAnnotation {
  summary?: string | null;
  category?: string | null;
  tags?: string[];
  toolOverrides?: NormalizedToolOverride[];
  warnings: string[];
}

const ANNOTATION_FIELDS: ReadonlySet<string> = new Set([
  'summary',
  'category',
  'tags',
  'toolOverrides',
  'warnings',
]);
const TOOL_OVERRIDE_FIELDS: ReadonlySet<string> = new Set(['name', 'description', 'tags']);

function annotationTags(value: unknown, field: string, prefix: string): string[] {
  if (!Array.isArray(value)) throw annotationInvalid([`${field} must be an array`], [prefix]);
  if (value.length > MAX_TAGS) {
    throw annotationInvalid([`${field} must have at most ${MAX_TAGS} items`], [prefix]);
  }
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
  return tags;
}

function readToolOverrides(
  value: unknown,
  knownTools: ReadonlySet<string>,
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
    if ('description' in entry) {
      const description = entry['description'];
      if (description !== null && typeof description !== 'string') {
        throw annotationInvalid(
          [`${field}.description must be a string or null`],
          [`${field}.description`],
        );
      }
      override.description =
        description === null
          ? null
          : (() => {
              const text = sanitizeSingleLine(description);
              if (text.length > 200) {
                throw annotationInvalid(
                  [`${field}.description must be at most 200 characters`],
                  [`${field}.description`],
                );
              }
              return text;
            })();
    }
    if ('tags' in entry) {
      override.tags = annotationTags(entry['tags'], `${field}.tags`, `${field}.tags`);
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

export function normalizeAnnotation(
  value: unknown,
  knownTools: readonly string[],
): NormalizedAnnotation {
  if (!isPlainObject(value)) {
    throw annotationInvalid(['annotation must be a JSON object'], []);
  }
  unknownFields(value, ANNOTATION_FIELDS, '', annotationInvalid);

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
      result.summary = text;
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

  if ('tags' in value) {
    result.tags = annotationTags(value['tags'], 'tags', 'tags');
  }

  if ('toolOverrides' in value) {
    result.toolOverrides = readToolOverrides(
      value['toolOverrides'],
      new Set(knownTools),
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

  return result;
}

/** True when no server-level or tool-level change was proposed. */
export function annotationIsEmpty(annotation: NormalizedAnnotation): boolean {
  return (
    (annotation.summary ?? null) === null &&
    (annotation.category ?? null) === null &&
    (annotation.tags?.length ?? 0) === 0 &&
    (annotation.toolOverrides?.length ?? 0) === 0
  );
}

// ---------------------------------------------------------------------------
// Settings (PUT /ai/config)
// ---------------------------------------------------------------------------

export { MODEL_PATTERN };
