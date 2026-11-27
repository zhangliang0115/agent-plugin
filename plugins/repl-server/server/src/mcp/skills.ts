/**
 * Built-in skill catalog for the MCP Skills extension
 * (`io.modelcontextprotocol/skills`). Only the server's own skill is served;
 * upstream skills are not aggregated.
 * @module
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JsonRpcError, JSON_RPC_INVALID_PARAMS } from './errors.ts';

export const SKILL_NAME = 'zl-repl-server';
export const SKILL_URI = `skill://${SKILL_NAME}/SKILL.md`;
export const SKILL_TTL_MS = 300_000;
export const SKILL_CACHE_SCOPE = 'public';

export interface SkillResource {
  uri: string;
  digest: string;
  size: number;
}

export interface Skill {
  uri: string;
  frontmatter: Record<string, string>;
  resources: SkillResource[];
}

export interface SkillsListResult {
  resultType: 'complete';
  skills: Skill[];
  ttlMs: number;
  cacheScope: 'public';
}

export interface SkillsGetResult {
  resultType: 'complete';
  skill: Skill;
  ttlMs: number;
  cacheScope: 'public';
}

export interface Resource {
  uri: string;
  name: string;
  description?: string;
  mimeType: string;
}

export interface ResourcesListResult {
  resultType: 'complete';
  resources: Resource[];
  ttlMs: number;
  cacheScope: 'public';
}

export interface ResourceContent {
  uri: string;
  mimeType: string;
  text?: string;
  blob?: string;
}

export interface ResourcesReadResult {
  resultType: 'complete';
  contents: ResourceContent[];
  ttlMs: number;
  cacheScope: 'public';
}

/** One file backing the skill; bytes are kept for `resources/read`. */
interface SkillFile {
  readonly uri: string;
  readonly relativePath: string;
  readonly mimeType: string;
  readonly text: string | null;
  readonly bytes: Buffer;
  readonly digest: string;
  readonly size: number;
}

interface SkillCatalog {
  readonly skill: Skill | null;
  readonly files: readonly SkillFile[];
}

const EXTENSION_MIME: Record<string, string> = {
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.py': 'text/x-python',
  '.sh': 'text/x-sh',
  '.ts': 'text/typescript',
};

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

let cachedCatalog: SkillCatalog | null = null;

/** Walks up from this module until `<dir>/skills/zl-repl-server/SKILL.md` exists. */
function findSkillRoot(): string | null {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = join(dir, 'skills', SKILL_NAME);
    if (existsSync(join(candidate, 'SKILL.md'))) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Recursive scan; hidden files and directories are skipped, SKILL.md sorts first. */
function scanFiles(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) found.push(relative(root, full).split(sep).join('/'));
    }
  };
  visit(root);
  return found.sort((a, b) => {
    if (a === 'SKILL.md') return -1;
    if (b === 'SKILL.md') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

function mimeTypeFor(relativePath: string, text: string | null): string {
  if (text === null) return 'application/octet-stream';
  return EXTENSION_MIME[extname(relativePath).toLowerCase()] ?? 'text/plain';
}

function loadFile(root: string, relativePath: string): SkillFile {
  const bytes = readFileSync(join(root, relativePath));
  const text = decodeUtf8(bytes);
  return {
    uri: `skill://${SKILL_NAME}/${relativePath}`,
    relativePath,
    mimeType: mimeTypeFor(relativePath, text),
    text,
    bytes,
    digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    size: bytes.length,
  };
}

// shortcut: 只支持单行标量 frontmatter，出现多行或嵌套字段时换 YAML 解析器
function parseFrontmatter(text: string): Record<string, string> {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') throw new Error(`${SKILL_URI} must start with a --- frontmatter block`);
  const end = lines.indexOf('---', 1);
  if (end === -1) throw new Error(`${SKILL_URI} frontmatter is not terminated`);

  const frontmatter: Record<string, string> = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) continue;
    if (/^\s/.test(line)) {
      throw new Error(`${SKILL_URI} frontmatter continuation lines are not supported: ${line.trim()}`);
    }
    const match = /^([\w.-]+):(.*)$/.exec(line);
    if (match === null) throw new Error(`${SKILL_URI} frontmatter line is not a key/value pair: ${line}`);
    const value = (match[2] ?? '').trim();
    const quote = value[0];
    const quoted =
      value.length >= 2 && (quote === '"' || quote === "'") && value.endsWith(quote);
    frontmatter[match[1] ?? ''] = quoted ? value.slice(1, -1) : value;
  }

  if (typeof frontmatter['name'] !== 'string' || typeof frontmatter['description'] !== 'string') {
    throw new Error(`${SKILL_URI} frontmatter must define string name and description`);
  }
  return frontmatter;
}

function loadCatalog(): SkillCatalog {
  const root = findSkillRoot();
  if (root === null) return { skill: null, files: [] };

  const files = scanFiles(root).map((relativePath) => loadFile(root, relativePath));
  const source = files.find((file) => file.relativePath === 'SKILL.md');
  if (source === undefined || source.text === null) {
    throw new Error(`${SKILL_URI} is missing or is not UTF-8 text`);
  }

  const frontmatter = parseFrontmatter(source.text);
  if (frontmatter['name'] !== basename(root)) {
    throw new Error(
      `${SKILL_URI} name ${frontmatter['name']} does not match its directory ${basename(root)}`,
    );
  }

  return {
    skill: {
      uri: SKILL_URI,
      frontmatter,
      resources: files.map((file) => ({ uri: file.uri, digest: file.digest, size: file.size })),
    },
    files,
  };
}

function catalog(): SkillCatalog {
  cachedCatalog ??= loadCatalog();
  return cachedCatalog;
}

function requireUri(params: Record<string, unknown>, method: string): string {
  const uri = params['uri'];
  if (typeof uri !== 'string' || uri.length === 0) {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, `${method} requires a non-empty uri string`);
  }
  return uri;
}

/** `skills/list`: params and cursor are ignored; the catalog is static. */
export function skillsListHandler(): SkillsListResult {
  const { skill } = catalog();
  return {
    resultType: 'complete',
    skills: skill === null ? [] : [skill],
    ttlMs: SKILL_TTL_MS,
    cacheScope: SKILL_CACHE_SCOPE,
  };
}

export function skillsGetHandler(params: Record<string, unknown>): SkillsGetResult {
  const uri = requireUri(params, 'skills/get');
  const { skill } = catalog();
  if (skill === null || uri !== skill.uri) {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, `No skill is served at ${uri}`);
  }
  return { resultType: 'complete', skill, ttlMs: SKILL_TTL_MS, cacheScope: SKILL_CACHE_SCOPE };
}

/**
 * `resources/list`: empty on purpose. Every file here belongs to a skill, and
 * `skills/list` already publishes that manifest; listing the same URIs again
 * would only make clients see each file twice.
 */
export function resourcesListHandler(): ResourcesListResult {
  return { resultType: 'complete', resources: [], ttlMs: SKILL_TTL_MS, cacheScope: SKILL_CACHE_SCOPE };
}

/** `resources/templates/list`: no URI templates are served, so the list is always empty. */
export function resourcesTemplatesListHandler(): {
  resultType: 'complete';
  resourceTemplates: [];
  ttlMs: number;
  cacheScope: string;
} {
  return { resultType: 'complete', resourceTemplates: [], ttlMs: SKILL_TTL_MS, cacheScope: SKILL_CACHE_SCOPE };
}

export function resourcesReadHandler(params: Record<string, unknown>): ResourcesReadResult {
  const uri = requireUri(params, 'resources/read');
  const file = catalog().files.find((candidate) => candidate.uri === uri);
  if (file === undefined) {
    throw new JsonRpcError(JSON_RPC_INVALID_PARAMS, `No resource is served at ${uri}`);
  }
  const content: ResourceContent =
    file.text === null
      ? { uri: file.uri, mimeType: file.mimeType, blob: file.bytes.toString('base64') }
      : { uri: file.uri, mimeType: file.mimeType, text: file.text };
  return {
    resultType: 'complete',
    contents: [content],
    ttlMs: SKILL_TTL_MS,
    cacheScope: SKILL_CACHE_SCOPE,
  };
}
