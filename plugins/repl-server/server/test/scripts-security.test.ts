/** Secret scanning/redaction for archived scripts (design 10 §11, P4). */
import assert from 'node:assert/strict';
import test from 'node:test';

import { redactSecrets, scanSecrets } from '../src/scripts/security/secrets.ts';

const GITHUB_TOKEN = 'ghp_' + 'A'.repeat(36);
const OPENAI_TOKEN = 'sk-proj-' + 'B'.repeat(30);
const JWT = 'eyJ' + 'a'.repeat(20) + '.eyJ' + 'b'.repeat(20) + '.' + 'c'.repeat(20);
const BEARER_TOKEN = 'Zx9' + 'Qm2' + 'Vt7' + 'Ks4' + 'Lp8' + 'Hb1' + 'Wn6' + 'Jd0' + 'Fc3' + 'Rg5';
const HIGH_ENTROPY = 'Q7' + 'k2' + 'M9' + 'v4' + 'X1' + 'b8' + 'N3' + 'w6' + 'T0' + 'p5' + 'R2' + 'c9' + 'V4' + 'h7' + 'L1' + 'q8';
const URL_PASSWORD = 'Rk8' + 'Wq3' + 'Zt7' + 'Np2' + 'Lm5';
const ENV_SECRET = 'Vc4' + 'Hb9' + 'Js2' + 'Yd6' + 'Fg1';
const AWS_TOKEN = 'AKIA' + 'A'.repeat(16);
const SLACK_TOKEN = 'xoxb-' + 'FakeSlack012';
const GOOGLE_TOKEN = 'AIza' + 'D'.repeat(35);
const GITLAB_TOKEN = 'glpat-' + 'G'.repeat(20);
const NPM_TOKEN = 'npm_' + 'C'.repeat(36);
const PEM_BEGIN = ['-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const PEM_END = ['-----END', 'RSA', 'PRIVATE', 'KEY-----'].join(' ');
const PRIVATE_KEY = [PEM_BEGIN, 'M'.repeat(40), PEM_END].join('\n');
const UUID = '550e8400-e29b-41d4-a716-446655440000';
const SHA256 = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

test('detects provider tokens and redacts them', () => {
  const text = `const value = '${GITHUB_TOKEN}';`;
  const findings = scanSecrets(text);

  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.kind, 'provider_token');
  assert.equal(finding.severity, 'high');
  assert.equal(text.slice(finding.start, finding.end), GITHUB_TOKEN);
  assert.ok(!finding.preview.includes(GITHUB_TOKEN));
  assert.equal(redactSecrets(text), "const value = '<redacted>';");
});

test('recognizes common provider token shapes', () => {
  const tokens = [OPENAI_TOKEN, AWS_TOKEN, SLACK_TOKEN, GOOGLE_TOKEN, GITLAB_TOKEN, NPM_TOKEN];
  for (const token of tokens) {
    assert.deepEqual(
      scanSecrets(`x ${token} y`).map((finding) => finding.kind),
      ['provider_token'],
      token,
    );
  }
});

test('detects private key blocks', () => {
  const text = `const key = \`${PRIVATE_KEY}\`;`;
  const findings = scanSecrets(text);

  assert.equal(findings.length, 1);
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.kind, 'private_key');
  assert.equal(finding.severity, 'high');
  assert.equal(finding.preview, '<private key>');
  assert.equal(text.slice(finding.start, finding.end), PRIVATE_KEY);
  assert.equal(redactSecrets(text), 'const key = `<redacted private key>`;');
});

test('treats an unterminated private key as secret to the end', () => {
  const text = 'const key = `-----BEGIN OPENSSH PRIVATE KEY-----\nFAKEbody`;';
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['private_key'],
  );
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.end, text.length);
  assert.ok(!redactSecrets(text).includes('FAKEbody'));
});

test('detects credentialed URLs and redacts only the password', () => {
  const text = `db = postgres://app:${URL_PASSWORD}@db.example.com:5432/app`;
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['credential_url'],
  );
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(
    text.slice(finding.start, finding.end),
    `postgres://app:${URL_PASSWORD}@db.example.com:5432`,
  );
  assert.ok(!finding.preview.includes(URL_PASSWORD));
  assert.equal(
    redactSecrets(text),
    'db = postgres://app:<redacted>@db.example.com:5432/app',
  );
});

test('detects sensitive assignments and keeps the key name', () => {
  const text = `const config = { DB_PASSWORD: "${ENV_SECRET}", max_tokens: 1024 };`;
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['env_assignment'],
  );
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.severity, 'medium');
  assert.equal(text.slice(finding.start, finding.end), `DB_PASSWORD: "${ENV_SECRET}"`);
  assert.ok(!finding.preview.includes(ENV_SECRET));
  assert.equal(
    redactSecrets(text),
    'const config = { DB_PASSWORD: <redacted>, max_tokens: 1024 };',
  );
});

test('matches quoted JSON assignment keys', () => {
  const text = `{"apiKey": "${OPENAI_TOKEN}"}`;
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['env_assignment'],
  );
  assert.equal(redactSecrets(text), '{"apiKey": <redacted>}');
});

test('ignores placeholders and non-secret assignments', () => {
  const text = [
    'API_KEY=${process.env.API_KEY}',
    "PASSWORD='<secret:db_password>'",
    'TOKEN=null',
    'max_tokens = 1024',
    'accessToken: process.env.ACCESS_TOKEN',
    'const token = await loadToken();',
    'let sessionToken = getSessionToken();',
  ].join('\n');

  assert.deepEqual(scanSecrets(text), []);
});

test('flags high-entropy strings but not UUIDs or hashes', () => {
  const text = [
    `const blob = '${HIGH_ENTROPY}';`,
    `const id = '${UUID}';`,
    `const hash = '${SHA256}';`,
  ].join('\n');
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['high_entropy'],
  );
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(finding.severity, 'low');
  assert.equal(text.slice(finding.start, finding.end), HIGH_ENTROPY);
  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(HIGH_ENTROPY));
  assert.ok(redacted.includes(UUID));
  assert.ok(redacted.includes(SHA256));
});

test('leaves ordinary identifiers alone', () => {
  const text = "const getUserProfile2FromDatabaseForTheTestRun = () => 'alice';";
  assert.deepEqual(scanSecrets(text), []);
});

test('detects a bare bearer token without swallowing the prefix', () => {
  const text = `header = 'Bearer ${BEARER_TOKEN}'`;
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['bearer_token'],
  );
  const finding = findings[0];
  assert.ok(finding);
  assert.equal(text.slice(finding.start, finding.end), BEARER_TOKEN);
  assert.equal(redactSecrets(text), "header = 'Bearer <redacted>'");
});

test('detects JWTs', () => {
  const text = `const auth = '${JWT}';`;
  const findings = scanSecrets(text);

  assert.deepEqual(
    findings.map((finding) => finding.kind),
    ['jwt'],
  );
  assert.equal(redactSecrets(text), "const auth = '<redacted>';");
});

test('findings are sorted, non-overlapping, and redacted together', () => {
  const text = [
    `const a = '${GITHUB_TOKEN}';`,
    `const b = "PASSWORD=${ENV_SECRET}";`,
    `const c = \`https://user:${URL_PASSWORD}@example.com/x\`;`,
  ].join('\n');
  const findings = scanSecrets(text);

  assert.ok(findings.length >= 3);
  for (let index = 1; index < findings.length; index += 1) {
    const previous = findings[index - 1];
    const current = findings[index];
    assert.ok(previous && current);
    assert.ok(previous.end <= current.start);
  }

  const redacted = redactSecrets(text);
  assert.ok(!redacted.includes(GITHUB_TOKEN));
  assert.ok(!redacted.includes(ENV_SECRET));
  assert.ok(!redacted.includes(URL_PASSWORD));
  assert.ok(redacted.includes('PASSWORD=<redacted>'));
});

test('empty input has no findings and redacts to itself', () => {
  assert.deepEqual(scanSecrets(''), []);
  assert.equal(redactSecrets(''), '');
});
