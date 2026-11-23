#!/usr/bin/env node
/**
 * One-shot switch from the flat data root to the `run/ log/ cache/ backup/`
 * layout. Runtime state is moved (never copied), legacy history is archived,
 * and nothing is deleted until the archive exists.
 *
 *   node server/scripts/layout-switch.mjs           # dry run, prints the plan
 *   node server/scripts/layout-switch.mjs --apply   # performs it
 *
 * Safe to re-run: a root that already has `run/state.db` is reported as done.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const RUNTIME_ENTRIES = [
  'state.json',
  'pool.json',
  'ai-runs.json',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'state.db.lock',
  'mcp-token',
  'admin-token',
  'secrets.json',
  'sessions',
  'official-workspace',
];

const LEGACY_ENTRIES = ['audit', 'metrics', 'ledger', 'repl.db'];
const LEGACY_FILE_PATTERNS = [/^state-bak-/, /^state\.db\.bak-/, /^state\.db\.bak\.v\d/i];
/** Root-level files that no build in the four-domain layout reads. */
const ORPHAN_ENTRIES = ['server.log', 'server.pid', 'notify-webhook', 'reports-poll-marker'];

function layout(homeArg) {
  const home = homeArg ?? process.env.AGENTS_HOME ?? join(homedir(), '.agents');
  const root = join(resolve(home), 'repl-server');
  return {
    root,
    run: join(root, 'run'),
    log: join(root, 'log'),
    cache: join(root, 'cache'),
    backup: join(root, 'backup'),
  };
}

function entriesIn(dir, pattern) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (pattern === undefined ? true : pattern(entry)))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * PID of a live instance holding this root, or null. Migrating while a server
 * is running renames files out from under it: its sqlite handles keep working
 * but every other path it recomputes (`pool.json`, `audit/`) is re-created at
 * the old root. Refusing is the only safe option.
 */
function liveInstancePid(root) {
  for (const lockPath of [join(root, 'state.db.lock'), join(root, 'run', 'state.db.lock')]) {
    if (!existsSync(lockPath)) continue;
    try {
      const record = JSON.parse(readFileSync(lockPath, 'utf8'));
      const pid = typeof record === 'object' && record !== null ? record.pid : undefined;
      if (typeof pid !== 'number' || pid <= 0) continue;
      try {
        process.kill(pid, 0);
        return pid;
      } catch (error) {
        // EPERM means the process exists but belongs to someone else.
        if (error && error.code === 'EPERM') return pid;
      }
    } catch {
      // An unreadable or malformed lock is treated as stale.
    }
  }
  return null;
}

function planFor(root) {
  const moves = [];
  const archives = [];
  for (const name of RUNTIME_ENTRIES) {
    if (existsSync(join(root, name))) moves.push(name);
  }
  for (const name of entriesIn(root, (entry) => entry.isDirectory() && entry.name.startsWith('ai-run-'))) {
    moves.push(name);
  }
  for (const name of [...LEGACY_ENTRIES, ...ORPHAN_ENTRIES]) {
    if (existsSync(join(root, name))) archives.push(name);
  }
  for (const name of entriesIn(root, (entry) => LEGACY_FILE_PATTERNS.some((re) => re.test(entry.name)))) {
    archives.push(name);
  }
  return { moves, archives };
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const days = new Date().toISOString().slice(0, 10);
  const l = layout(args.find((arg) => !arg.startsWith('--')));

  if (!existsSync(l.root)) {
    console.log(`nothing to switch: ${l.root} does not exist`);
    return;
  }

  const livePid = liveInstancePid(l.root);
  if (livePid !== null) {
    console.error(`refusing to touch a live instance: pid ${livePid} holds this root; stop the server first`);
    process.exitCode = 1;
    return;
  }

  if (existsSync(join(l.run, 'state.db'))) {
    const strays = [...RUNTIME_ENTRIES, ...ORPHAN_ENTRIES].filter((name) => existsSync(join(l.root, name)));
    console.log(`already switched: ${join(l.run, 'state.db')} exists`);
    if (strays.length === 0) return;
    console.log(`stray root entries: ${strays.join(', ')}`);
    if (!apply) {
      console.log(`\ndry run: re-run with --apply to archive them into backup/strays-${days}/`);
      return;
    }
    const dest = join(l.backup, `strays-${days}`);
    mkdirSync(dest, { recursive: true, mode: 0o700 });
    for (const name of strays) {
      const to = join(dest, name);
      if (existsSync(to)) {
        console.log(`skip ${name}: ${to} already exists`);
        continue;
      }
      renameSync(join(l.root, name), to);
    }
    console.log(`archived ${strays.length} stray entries -> ${dest}`);
    return;
  }

  const plan = planFor(l.root);
  if (plan.moves.length === 0 && plan.archives.length === 0) {
    console.log(`nothing to do: ${l.root} is empty`);
    return;
  }

  console.log(`root: ${l.root}`);
  console.log(`move into run/: ${plan.moves.join(', ') || '(none)'}`);
  console.log(`archive into backup/: ${plan.archives.join(', ') || '(none)'}`);
  if (!apply) {
    console.log('\ndry run: re-run with --apply to perform it');
    return;
  }

  for (const dir of [l.run, l.log, l.cache, l.backup]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(dir, 0o700);
    } catch {
      // Non-fatal: an existing directory may live on a filesystem without chmod.
    }
  }

  for (const name of plan.moves) {
    const from = join(l.root, name);
    const to = join(l.run, name);
    if (existsSync(to)) {
      console.log(`skip ${name}: ${to} already exists`);
      continue;
    }
    renameSync(from, to);
  }

  let archivePath = null;
  if (plan.archives.length > 0) {
    archivePath = join(l.backup, `legacy-${days}.tar.gz`);
    try {
      execFileSync('tar', ['-czf', archivePath, '-C', l.root, ...plan.archives], { stdio: 'inherit' });
    } catch {
      const fallback = join(l.backup, `legacy-${days}`);
      mkdirSync(fallback, { recursive: true, mode: 0o700 });
      for (const name of plan.archives) {
        const from = join(l.root, name);
        if (!existsSync(from)) continue;
        renameSync(from, join(fallback, name));
      }
      archivePath = fallback;
    }
  }

  const manifest = [
    `# layout switch ${new Date().toISOString()}`,
    `root: ${l.root}`,
    '',
    'runtime state (moved, still live):',
    ...plan.moves.map((name) => `  ${name} -> run/${name}`),
    '',
    'history (archived, no longer read by the server):',
    ...plan.archives.map((name) => `  ${name} -> ${archivePath}`),
    '',
    'restore: stop the server, move run/* back to the root, unpack the archive at the root,',
    'then start the previous build.',
  ].join('\n');
  writeFileSync(join(l.backup, `legacy-${days}.MANIFEST.txt`), `${manifest}\n`, { mode: 0o600 });

  if (archivePath !== null && statSync(archivePath).isFile()) {
    for (const name of plan.archives) {
      const target = join(l.root, name);
      if (existsSync(target)) rmSync(target, { recursive: true, force: true });
    }
  }

  // Keep at most two legacy archives.
  const archives = entriesIn(l.backup, (entry) => entry.name.startsWith('legacy-') && !entry.name.endsWith('.txt'))
    .sort()
    .reverse();
  for (const stale of archives.slice(2)) {
    rmSync(join(l.backup, stale), { recursive: true, force: true });
  }

  console.log(`\ndone. state.db -> ${join(l.run, 'state.db')}`);
  if (archivePath !== null) console.log(`archived -> ${archivePath}`);
}

main();
