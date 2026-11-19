/** AI proposal drawer helpers: input limits, secret args and the apply body. */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AI_INPUT_MAX_BYTES,
  argsForEditing,
  buildProposalApplyBody,
  parseArgs,
  proposalInputError,
  utf8ByteLength,
  type ProposalDraftValues,
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
  envKeys: 'GITHUB_TOKEN\n',
  headerKeys: '',
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
