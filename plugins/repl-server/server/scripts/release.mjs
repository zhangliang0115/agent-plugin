#!/usr/bin/env node
/**
 * Publishes `dist/` as the GitHub release asset the Claude Code plugin downloads
 * (`cc-plugins/repl-server/scripts/ensure-server.mjs` in learn-ai). Run after
 * `pnpm build`; the tag is `v<server version>`, and the plugin pins that version.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(readFileSync(join(serverDir, 'package.json'), 'utf8'));
const tag = `v${version}`;
const asset = `repl-server-${version}.tar.gz`;
const work = mkdtempSync(join(tmpdir(), 'repl-server-release-'));
const archive = join(work, asset);

execFileSync('tar', ['-czf', archive, '-C', serverDir, 'dist'], { stdio: 'inherit' });
const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
writeFileSync(`${archive}.sha256`, `${digest}  ${asset}\n`);

const released = (() => {
  try {
    execFileSync('gh', ['release', 'view', tag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const files = [archive, `${archive}.sha256`];
if (released) {
  execFileSync('gh', ['release', 'upload', tag, ...files, '--clobber'], { stdio: 'inherit' });
} else {
  execFileSync(
    'gh',
    ['release', 'create', tag, ...files, '--title', `repl-server ${version}`, '--notes', 'Claude Code 插件的预构建产物（dist，含 web 面板与 skills）。'],
    { stdio: 'inherit' },
  );
}
rmSync(work, { recursive: true, force: true });
console.log(`released ${tag}: ${asset} sha256=${digest}`);
