/** AI proposal drawer helpers: input limits, secret args and the apply body. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_INPUT_MAX_BYTES,
  argsForEditing,
  buildProposalApplyBody,
  draftRows,
  parseArgs,
  proposalInputError,
  utf8ByteLength,
  type ProposalDraftValues,
  type ProposalServerDraft,
} from '../src/lib/ai-proposal.ts';
import { formatNumber } from '../src/lib/format.ts';

const base: ProposalDraftValues = {
  id: 'github',
  label: 'GitHub',
  transport: 'stdio',
  command: 'npx',
  args: '-y\n@modelcontextprotocol/server-github\n<secret:GITHUB_TOKEN>',
  cwd: '/Users/me/work',
  url: '',
  env: [{ key: 'GITHUB_TOKEN', source: 'secret', value: 'GITHUB_TOKEN' }],
  headers: [],
  enabled: true,
  connectMode: 'lazy',
  category: 'devtools',
  tags: ['devops'],
  summary: 'GitHub MCP',
};

test('utf8ByteLength counts UTF-8 bytes, not characters', () => {
  assert.equal(utf8ByteLength('abc'), 3);
  assert.equal(utf8ByteLength('中'), 3);
  assert.equal(utf8ByteLength(''), 0);
});

test('proposalInputError rejects empty and over-limit input', () => {
  assert.equal(proposalInputError('   '), '输入不能为空。');
  assert.equal(proposalInputError('配一个 github MCP'), null);
  const tooLarge = '中'.repeat(Math.ceil(AI_INPUT_MAX_BYTES / 3) + 1);
  assert.ok(
    proposalInputError(tooLarge)?.includes(`上限 ${formatNumber(AI_INPUT_MAX_BYTES)} 字节`),
  );
});

test('parseArgs keeps <secret:NAME> as a $secret reference and round-trips', () => {
  const args = parseArgs('--token\n<secret:GITHUB_TOKEN>\n<secret:>');
  assert.deepEqual(args, ['--token', { $secret: 'GITHUB_TOKEN' }, '<secret:>']);
  assert.equal(argsForEditing(args), '--token\n<secret:GITHUB_TOKEN>\n<secret:>');
});

test('buildProposalApplyBody sends the full stdio draft with confirmStdio', () => {
  const body = buildProposalApplyBody('proposal-1', base);
  assert.equal(body['proposalId'], 'proposal-1');
  assert.equal(body['confirmStdio'], true);
  assert.deepEqual(body['server'], {
    id: 'github',
    label: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github', { $secret: 'GITHUB_TOKEN' }],
    cwd: '/Users/me/work',
    url: null,
    env: {},
    headers: {},
    envKeys: ['GITHUB_TOKEN'],
    headerKeys: [],
    enabled: true,
    connectMode: 'lazy',
    category: 'devtools',
    tags: ['devops'],
    summary: 'GitHub MCP',
  });
});

test('buildProposalApplyBody drops stdio fields for http and omits confirmStdio', () => {
  const body = buildProposalApplyBody('proposal-2', {
    ...base,
    transport: 'http',
    label: '  ',
    url: 'https://example.com/mcp',
  });
  assert.equal(body['confirmStdio'], undefined);
  const server = body['server'] as Record<string, unknown>;
  assert.equal(server['label'], 'github');
  assert.equal(server['command'], null);
  assert.deepEqual(server['args'], []);
  assert.equal(server['cwd'], null);
  assert.equal(server['url'], 'https://example.com/mcp');
});

test('buildProposalApplyBody sends literal env/headers and secret rows as key lists', () => {
  const body = buildProposalApplyBody('proposal-3', {
    ...base,
    env: [
      { key: 'GHIDRA_INSTALL_DIR', source: 'literal', value: '/Users/me/tools/ghidra' },
      { key: 'GITHUB_TOKEN', source: 'secret', value: 'GITHUB_TOKEN' },
    ],
    headers: [{ key: 'X-Env', source: 'literal', value: 'dev' }],
  });
  const server = body['server'] as Record<string, unknown>;
  assert.deepEqual(server['env'], { GHIDRA_INSTALL_DIR: '/Users/me/tools/ghidra' });
  assert.deepEqual(server['headers'], { 'X-Env': 'dev' });
  assert.deepEqual(server['envKeys'], ['GITHUB_TOKEN']);
  assert.deepEqual(server['headerKeys'], []);
});

test('draftRows splits key lists and literal env/headers', () => {
  const draft: ProposalServerDraft = {
    id: 'github',
    label: 'GitHub',
    transport: 'stdio',
    command: 'npx',
    args: [],
    cwd: null,
    url: null,
    envKeys: ['GITHUB_TOKEN'],
    headerKeys: [],
    enabled: true,
    connectMode: 'lazy',
    tags: [],
    category: null,
    summary: null,
  };
  assert.deepEqual(
    draftRows(
      { ...draft, env: { GHIDRA_INSTALL_DIR: '/opt/ghidra' }, headers: { 'X-Env': 'dev' } },
      'env',
    ),
    [
      { key: 'GITHUB_TOKEN', source: 'secret', value: 'GITHUB_TOKEN' },
      { key: 'GHIDRA_INSTALL_DIR', source: 'literal', value: '/opt/ghidra' },
    ],
  );
  assert.deepEqual(draftRows({ ...draft, envKeys: [], headers: { 'X-Env': 'dev' } }, 'headers'), [
    { key: 'X-Env', source: 'literal', value: 'dev' },
  ]);
});
