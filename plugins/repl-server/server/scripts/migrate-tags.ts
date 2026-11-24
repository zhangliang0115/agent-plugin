/**
 * One-off tag cleanup: remove action keys from tags, cap server tags at 2 and
 * tool effective tags at 4, and keep at least one descriptive tag per enabled
 * tool. Dry-run by default; `--apply` writes after a consistent backup.
 *
 * Usage:
 *   node server/scripts/migrate-tags.ts [--db <state.db>] [--apply]
 * @module
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

import { TAG_SETTING_KEY, readTagDictionary } from '../src/admin/tags.ts';
import {
  ACTION_TAG_KEYS,
  TOOL_TAG_LIMIT,
  evaluateServerTags,
  evaluateTagPolicy,
} from '../src/catalog/tag-policy.ts';
import { createLayout } from '../src/layout.ts';
import { openStateDb, withTransaction } from '../src/db/migrate.ts';
import { getRevision, bumpRevision, listSettings } from '../src/db/meta.ts';
import { listServers, type ServerRecord } from '../src/db/servers.ts';
import { listTools, refreshServerIndex, type ToolRecord } from '../src/db/tools.ts';
import { isoNow, jsonText } from '../src/db/schema.ts';

interface ServerPlan {
  server: ServerRecord;
  tags: string[];
  oldTags: string[];
}

interface ToolPlan {
  tool: ToolRecord;
  tags: string[];
  oldTags: string[];
}

/** Server-level tags that hold for every tool of the known servers. */
const COMMON_SERVER_TAGS: Readonly<Record<string, readonly string[]>> = {
  __builtin__: ['builtin'],
  __official__: ['official'],
  'codegraph-engine': ['code-graph'],
  'codegraph-ica': ['code-graph'],
  'elasticsearch-uat-log': ['elasticsearch'],
  'gitlab-engine': ['gitlab'],
  'grafana-engine': ['grafana'],
  'idea-os-code': ['intellij'],
  'kimi-cu': ['computer-use'],
  'magpie-memory': ['memory'],
  'prod-prometheus': ['prometheus'],
  sentry: ['sentry'],
  'sentry-shinho': ['sentry'],
  hexhub: [],
};

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function descriptive(tags: readonly string[]): string[] {
  return tags.filter((tag) => !ACTION_TAG_KEYS.has(tag));
}

function tokens(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((part) => part !== '');
}

function scoreTag(tag: string, toolName: string, description: string): number {
  const key = tag.toLowerCase();
  const name = toolName.toLowerCase();
  const nameTokens = new Set(tokens(name));
  let score = 0;
  if (tokens(key).some((part) => nameTokens.has(part))) score += 3;
  if (name.includes(key) || key.includes(name)) score += 2;
  if (description.toLowerCase().includes(key)) score += 1;
  return score;
}

function commonTags(server: ServerRecord, tools: readonly ToolRecord[]): string[] {
  const curated = COMMON_SERVER_TAGS[server.id];
  if (curated !== undefined) return descriptive(curated).slice(0, 2);
  if (tools.length === 0) return [];
  let intersection = new Set(descriptive(server.tags));
  for (const tool of tools) {
    const own = new Set(descriptive([...server.tags, ...tool.tags]));
    intersection = new Set([...intersection].filter((tag) => own.has(tag)));
  }
  return [...intersection].slice(0, 2);
}

function chooseToolTags(
  tool: ToolRecord,
  serverTags: readonly string[],
  oldServerTags: readonly string[],
): string[] {
  const room = Math.max(0, TOOL_TAG_LIMIT - serverTags.length);
  const serverSet = new Set(serverTags);
  const candidates = unique(descriptive(tool.tags).filter((tag) => !serverSet.has(tag)));
  const ranked = candidates
    .map((tag, index) => ({
      tag,
      index,
      score: scoreTag(tag, tool.name, tool.description ?? ''),
    }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.tag);
  const kept = ranked.slice(0, room);
  if (kept.length > 0 || serverTags.length > 0) return kept;

  // Server tags are empty and the tool has no descriptive tag left: pull one
  // from the old server tag set or the dictionary-shaped name, never leave it
  // silently untagged.
  const fallback = descriptive(oldServerTags).find((tag) => !serverSet.has(tag));
  if (fallback !== undefined) return [fallback];
  const byName = ranked[0] ?? descriptive(tool.tags)[0];
  return byName === undefined ? [] : [byName];
}

function buildPlan(db: DatabaseSync): { servers: ServerPlan[]; tools: ToolPlan[] } {
  const servers = listServers(db);
  const serverPlans: ServerPlan[] = [];
  const toolPlans: ToolPlan[] = [];
  for (const server of servers) {
    const tools = listTools(db, server.id);
    const tags = commonTags(server, tools.filter((tool) => tool.enabled));
    serverPlans.push({ server, tags, oldTags: descriptive(server.tags) });
    for (const tool of tools) {
      toolPlans.push({
        tool,
        tags: chooseToolTags(tool, tags, descriptive(server.tags)),
        oldTags: descriptive(tool.tags),
      });
    }
  }
  return { servers: serverPlans, tools: toolPlans };
}

function validatePlan(serverPlans: readonly ServerPlan[], toolPlans: readonly ToolPlan[]): string[] {
  const issues: string[] = [];
  const byServer = new Map(serverPlans.map((plan) => [plan.server.id, plan.tags]));
  for (const plan of serverPlans) {
    for (const issue of evaluateServerTags(plan.tags)) {
      issues.push(`${plan.server.id}: ${issue.code}: ${issue.message}`);
    }
  }
  for (const plan of toolPlans) {
    if (!plan.tool.enabled) continue;
    const serverTags = byServer.get(plan.tool.serverId) ?? [];
    for (const issue of evaluateTagPolicy(serverTags, plan.tags).issues) {
      issues.push(`${plan.tool.serverId}/${plan.tool.name}: ${issue.code}: ${issue.message}`);
    }
  }
  return issues;
}

function summarize(planServer: ServerPlan, planTools: readonly ToolPlan[]): string {
  const own = planTools.filter((entry) => entry.tool.serverId === planServer.server.id);
  const changed = own.filter(
    (entry) =>
      JSON.stringify(entry.tags) !== JSON.stringify(descriptive(entry.tool.tags)),
  );
  return `${planServer.server.id}: [${planServer.oldTags.join(', ')}] -> [${planServer.tags.join(', ')}], tools ${own.length}, changed ${changed.length}`;
}

function applyPlan(
  db: DatabaseSync,
  serverPlans: readonly ServerPlan[],
  toolPlans: readonly ToolPlan[],
  tagDictionary: readonly { key: string }[],
): void {
  const now = isoNow();
  withTransaction(db, () => {
    for (const plan of serverPlans) {
      db.prepare('UPDATE servers SET tags_json = ?, updated_at = ? WHERE id = ?').run(
        jsonText(plan.tags),
        now,
        plan.server.id,
      );
    }
    for (const plan of toolPlans) {
      db.prepare('UPDATE tools SET tags_json = ? WHERE server_id = ? AND name = ?').run(
        jsonText(plan.tags),
        plan.tool.serverId,
        plan.tool.name,
      );
    }
    for (const plan of serverPlans) refreshServerIndex(db, plan.server.id);
    db.prepare(
      `INSERT INTO settings(key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(TAG_SETTING_KEY, jsonText(tagDictionary));
    bumpRevision(db);
  });
}

function backup(db: DatabaseSync, dbPath: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const dir = join(dirname(dbPath), '..', 'backup');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `state-before-tag-migration-${stamp}.db`);
  const literal = path.replace(/'/gu, "''");
  db.exec(`VACUUM INTO '${literal}'`);
  return path;
}

function usage(): void {
  process.stderr.write(
    'usage: node server/scripts/migrate-tags.ts [--db <state.db>] [--apply]\n',
  );
}

const argv = process.argv.slice(2);
let apply = false;
let dbPath = createLayout().stateDb;
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index];
  if (arg === '--apply') {
    apply = true;
  } else if (arg === '--db') {
    const next = argv[index + 1];
    if (next === undefined || next === '') {
      usage();
      process.exit(2);
    }
    dbPath = next;
    index += 1;
  } else if (arg === '--help' || arg === '-h') {
    usage();
    process.exit(0);
  } else {
    process.stderr.write(`unknown argument: ${arg}\n`);
    usage();
    process.exit(2);
  }
}

const db = openStateDb(dbPath, { createDirectory: false, tightenPermissions: false });
try {
  const settings = listSettings(db);
  const dictionary = readTagDictionary(settings);
  const dictionaryAfter = dictionary.filter((entry) => !ACTION_TAG_KEYS.has(entry.key));
  const storedDictionary = settings[TAG_SETTING_KEY];
  const storedCount = Array.isArray(storedDictionary)
    ? storedDictionary.length
    : dictionaryAfter.length;
  const { servers, tools } = buildPlan(db);
  const issues = validatePlan(servers, tools);

  process.stdout.write(`db: ${dbPath}\n`);
  process.stdout.write(`revision: ${getRevision(db)}\n`);
  process.stdout.write(
    `tag dictionary: stored ${storedCount} -> ${dictionaryAfter.length} (actions removed: ${storedCount - dictionaryAfter.length})\n`,
  );
  for (const server of servers) {
    const ownTools = tools.filter((entry) => entry.tool.serverId === server.server.id);
    process.stdout.write(summarize(server, ownTools) + '\n');
  }
  const changedTools = tools.filter(
    (entry) => JSON.stringify(entry.tags) !== JSON.stringify(descriptive(entry.tool.tags)),
  );
  process.stdout.write(`tools changed: ${changedTools.length}/${tools.length}\n`);
  for (const entry of changedTools.slice(0, 5)) {
    process.stdout.write(
      `  sample ${entry.tool.serverId}/${entry.tool.name}: [${entry.oldTags.join(', ')}] -> [${entry.tags.join(', ')}]\n`,
    );
  }
  const distinct = new Set(servers.flatMap((entry) => entry.tags));
  for (const entry of tools) for (const tag of entry.tags) distinct.add(tag);
  process.stdout.write(`distinct descriptive tags after migration: ${distinct.size}\n`);

  if (issues.length > 0) {
    process.stdout.write(`policy issues: ${issues.length}\n`);
    for (const issue of issues) process.stdout.write(`  ${issue}\n`);
    process.exitCode = 1;
  }

  if (!apply) {
    process.stdout.write('dry-run only; pass --apply to write\n');
  } else if (issues.length > 0) {
    process.stdout.write('refusing to apply while policy issues remain\n');
  } else {
    const backupPath = backup(db, dbPath);
    process.stdout.write(`backup: ${backupPath}\n`);
    applyPlan(db, servers, tools, dictionaryAfter);
    process.stdout.write(`applied at revision ${getRevision(db)}\n`);
  }
} finally {
  db.close();
}
