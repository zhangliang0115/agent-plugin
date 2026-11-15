import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { loadPlugins } from '../lib/plugin-meta.ts';
import { renderMatrix, main as matrixMain, MATRIX_PATH } from '../matrix.ts';

const fixtures = fileURLToPath(new URL('./fixtures/', import.meta.url));
const repoOk = join(fixtures, 'repo-ok');
const repoBad = join(fixtures, 'repo-bad');

const EXPECTED_DEMO_MATRIX = `# 能力矩阵

> 生成物，不要手改。由 \`pnpm matrix\` 从 \`plugins/*/plugin.meta.json\` 生成；\`pnpm matrix:check\` 检查它与提交内容一致。

| 插件 | 版本 | claude-code | dsh | pi |
|---|---|---|---|---|
| demo | 0.1.0 | supported (skill, mcp) | experimental (tool) | unsupported (没有对应扩展点 \\| 含管道符) |
`;

describe('renderMatrix', () => {
  it('renders the demo plugin row with components and escaped reason', async () => {
    const { plugins } = await loadPlugins(repoOk);
    assert.equal(renderMatrix(plugins), EXPECTED_DEMO_MATRIX);
  });

  it('renders a placeholder when there are no plugins', () => {
    const text = renderMatrix([]);
    assert.match(text, /暂无插件。/);
    assert.doesNotMatch(text, /\|---\|/);
  });
});

describe('matrix main', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-plugin-matrix-'));
    await cp(repoOk, root, { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const matrixFile = () => join(root, MATRIX_PATH);

  it('writes the generated matrix in write mode', async () => {
    assert.equal(await matrixMain([], root), 0);
    assert.equal(await readFile(matrixFile(), 'utf8'), EXPECTED_DEMO_MATRIX);
  });

  it('--check passes when the committed file matches the generated output', async () => {
    await writeFile(matrixFile(), EXPECTED_DEMO_MATRIX);
    assert.equal(await matrixMain(['--check'], root), 0);
  });

  it('--check fails when the committed file is out of date', async () => {
    await writeFile(matrixFile(), EXPECTED_DEMO_MATRIX.replace('0.1.0', '0.0.9'));
    assert.equal(await matrixMain(['--check'], root), 1);
    // 检查模式不改文件。
    assert.match(await readFile(matrixFile(), 'utf8'), /0\.0\.9/);
  });

  it('--check fails when the committed file is missing', async () => {
    assert.equal(await matrixMain(['--check'], root), 1);
  });

  it('refuses to write when plugin metadata is invalid', async () => {
    await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), 'agent-plugin-matrix-bad-'));
    await cp(repoBad, root, { recursive: true });
    await mkdir(join(root, 'docs'), { recursive: true });

    assert.equal(await matrixMain([], root), 1);
    await assert.rejects(readFile(matrixFile(), 'utf8'), { code: 'ENOENT' });
  });

  it('rejects unknown arguments', async () => {
    assert.equal(await matrixMain(['--bogus'], root), 2);
  });
});
