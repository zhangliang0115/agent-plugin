/**
 * Decides whether a `Bash` call may run in parallel with its siblings.
 *
 * The official answer is `isReadOnly(command)` inside the agent loop's
 * `canExecuteTool`; that function is not exported through `claude mcp serve`, so
 * the gateway has to approximate it. The approximation is deliberately
 * one-sided: only a command that parses as "read-only by construction" is
 * parallel, everything else — including anything this file cannot parse — is
 * serial. A wrong "parallel" corrupts a file; a wrong "serial" only costs time.
 *
 * @module
 */

export type BashConcurrency = 'parallel' | 'serial';

/** Commands that never mutate the workspace when given no writable flags. */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'stat',
  'file',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'whoami',
  'date',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'md5',
  'md5sum',
  'sha256sum',
  'shasum',
  'du',
  'df',
  'tree',
  'jq',
  'diff',
  'cmp',
  'sort',
  'uniq',
  'cut',
  'tr',
  'column',
  'nl',
  'od',
  'xxd',
  'grep',
  'rg',
  'ag',
  'ack',
  'ps',
  'uname',
  'git',
  'npm',
  'pnpm',
]);

/** Flags that turn an otherwise read-only command into a writer. */
const WRITE_FLAGS: readonly RegExp[] = [
  /\s-(?:i|o|O|delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)\b/, // sed -i, find -delete/-exec
  /\s--in-place\b/,
  /\s--output\b/,
  /\s--follow\b(?!\s*=)/,
];

/** Subcommands of `git`/`npm`/`pnpm` that only read. */
const READ_ONLY_SUBCOMMANDS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['git', new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'blame', 'ls-files', 'describe', 'shortlog', 'whatchanged'])],
  ['npm', new Set(['ls', 'list', 'view', 'outdated', 'root', 'prefix'])],
  ['pnpm', new Set(['ls', 'list', 'view', 'outdated', 'root', 'why'])],
]);

/** Shell metacharacters that start a new command, a pipe, or a redirect. */
const SEGMENT_SPLIT = /\s*(?:&&|\|\||[;|])\s*/u;
const SUBSTITUTION = /\$\(|`|<\(|>\(/u;

function firstWords(segment: string): { command: string; rest: string } {
  const trimmed = segment.trim().replace(/^[({]\s*/u, '');
  const match = /^([A-Za-z0-9_./-]+)\s*([\s\S]*)$/u.exec(trimmed);
  if (match === null) return { command: '', rest: trimmed };
  // `/usr/bin/ls` and `./script.sh` both reduce to their last path segment.
  const command = (match[1] as string).split('/').pop() ?? '';
  return { command, rest: match[2] ?? '' };
}

/**
 * `parallel` only when every segment of the command line is a known read-only
 * invocation with no write flag, no output redirect and no command
 * substitution.
 */
export function bashConcurrency(args: { command?: unknown }): BashConcurrency {
  const command = args.command;
  if (typeof command !== 'string' || command.trim() === '') return 'serial';
  // A redirect or substitution can do anything, including write files.
  if (/(^|[^0-9])>{1,2}(?![&(])/u.test(command)) return 'serial';
  if (SUBSTITUTION.test(command)) return 'serial';
  // Background jobs escape the ordering the gate is trying to provide.
  if (/(^|[^&])&(\s|$)/u.test(command)) return 'serial';

  const segments = command.split(SEGMENT_SPLIT).filter((part) => part.trim() !== '');
  if (segments.length === 0) return 'serial';
  for (const segment of segments) {
    if (WRITE_FLAGS.some((pattern) => pattern.test(segment))) return 'serial';
    const { command: head, rest } = firstWords(segment);
    if (head === '') return 'serial';
    if (!READ_ONLY_COMMANDS.has(head)) return 'serial';
    const allowed = READ_ONLY_SUBCOMMANDS.get(head);
    if (allowed === undefined) continue;
    const sub = rest.trim().split(/\s+/u)[0] ?? '';
    if (!allowed.has(sub)) return 'serial';
  }
  return 'parallel';
}
