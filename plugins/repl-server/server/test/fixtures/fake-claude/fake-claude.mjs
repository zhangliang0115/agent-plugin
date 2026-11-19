#!/usr/bin/env node
/**
 * Deterministic stand-in for `claude -p --output-format json`.
 *
 * The runner is invoked with a fixed argv, so the test selects behavior through
 * FAKE_CLAUDE_MODE. `payload` reads FAKE_CLAUDE_PAYLOAD (inline JSON or a file)
 * to inject arbitrary proposal/annotation values. `pidfile` lets the timeout
 * test confirm the process group is gone.
 *
 * The CLI gate probes `--version` and `--help` before the first spawn:
 * - FAKE_CLAUDE_PROBE_LOG appends one line per probe (`version` / `help`);
 * - FAKE_CLAUDE_HELP_MISSING (comma separated) omits flags from `--help`;
 * - FAKE_CLAUDE_VERSION_FAIL=1 makes `--version` exit non-zero.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const REQUIRED_FLAGS = [
  '--safe-mode',
  '--mcp-config',
  '--strict-mcp-config',
  '--no-session-persistence',
];

if (argv.includes('--version')) {
  if (process.env.FAKE_CLAUDE_PROBE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_PROBE_LOG, 'version\n');
  }
  if (process.env.FAKE_CLAUDE_VERSION_FAIL === '1') process.exit(3);
  process.stdout.write('claude 9.9.9 (fake)\n');
  process.exit(0);
}

if (argv.includes('--help')) {
  if (process.env.FAKE_CLAUDE_PROBE_LOG) {
    appendFileSync(process.env.FAKE_CLAUDE_PROBE_LOG, 'help\n');
  }
  const missing = new Set(
    (process.env.FAKE_CLAUDE_HELP_MISSING ?? '').split(',').filter((flag) => flag !== ''),
  );
  const lines = ['Usage: claude [options]'];
  for (const flag of REQUIRED_FLAGS) {
    if (!missing.has(flag)) lines.push(`  ${flag}`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(0);
}

if (process.env.FAKE_CLAUDE_PIDFILE) {
  writeFileSync(process.env.FAKE_CLAUDE_PIDFILE, String(process.pid));
}

function okProposal() {
  return {
    server: {
      id: 'github',
      label: 'GitHub',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      cwd: null,
      url: null,
      envKeys: ['GITHUB_TOKEN'],
      headerKeys: [],
      enabled: true,
      connectMode: 'lazy',
      tags: ['git', 'github'],
      category: 'devtools',
      summary: 'GitHub 仓库与 issue 操作 (github git repository issue pull-request)',
    },
    explanation: '输入明确要求 GitHub MCP；使用社区 server 并用 GITHUB_TOKEN 作为密钥引用。',
    warnings: ['需要在密钥页写入 GITHUB_TOKEN'],
  };
}

function okAnnotation() {
  return {
    summary: 'PostgreSQL 查询与写入 (postgres sql database query write)',
    category: 'database',
    tags: ['db', 'sql', 'write'],
    toolOverrides: [
      {
        name: 'query',
        description: 'Run a read-only SQL query; 执行只读 SQL 查询',
        tags: ['read', 'sql'],
      },
    ],
    warnings: [],
  };
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
});

process.stdin.on('end', () => {
  const mode = process.env.FAKE_CLAUDE_MODE ?? 'ok';

  if (mode === 'exit1') {
    process.stderr.write(process.env.FAKE_CLAUDE_STDERR ?? 'boom\n');
    process.exit(1);
  }
  if (mode === 'sleep') {
    setTimeout(() => {}, 60_000);
    return;
  }
  if (mode === 'huge') {
    process.stdout.write('x'.repeat(300 * 1024));
    return;
  }
  if (mode === 'stderr-flood') {
    process.stderr.write('E'.repeat(9 * 1024) + '\n');
    process.stdout.write(
      JSON.stringify({
        is_error: false,
        subtype: 'success',
        num_turns: 1,
        result: JSON.stringify(okProposal()),
      }),
    );
    return;
  }
  if (mode === 'error') {
    process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error', result: 'auth failed' }));
    return;
  }
  if (mode === 'error-no-result') {
    process.stdout.write(JSON.stringify({ is_error: true, subtype: 'error' }));
    return;
  }
  if (mode === 'error-nonstring-result') {
    process.stdout.write(
      JSON.stringify({ is_error: true, subtype: 'error', result: { message: 'auth failed' } }),
    );
    return;
  }
  if (mode === 'invalid') {
    process.stdout.write(JSON.stringify({ is_error: false, result: 'not json' }));
    return;
  }
  if (mode === 'envelope') {
    process.stdout.write(process.env.FAKE_CLAUDE_ENVELOPE ?? '{}');
    return;
  }

  const isAnnotate = input.includes('MCP 元数据标注器');
  let payload;
  if (mode === 'payload') {
    const raw = process.env.FAKE_CLAUDE_PAYLOAD ?? '{}';
    payload =
      raw.trim().startsWith('{') || raw.trim().startsWith('[')
        ? raw
        : readFileSync(raw, 'utf8');
  } else {
    payload = JSON.stringify(isAnnotate ? okAnnotation() : okProposal());
  }

  const result = mode === 'fence' ? '```json\n' + payload + '\n```' : payload;
  process.stdout.write(
    JSON.stringify({ is_error: false, subtype: 'success', num_turns: 1, result }),
  );
});
