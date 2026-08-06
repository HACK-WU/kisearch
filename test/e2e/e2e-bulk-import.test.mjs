#!/usr/bin/env node
/**
 * E2E 集成测试：scan-kb import 全量直导 + 增量直连（原文直导，无 AI）
 *
 * 测试场景：
 *   1. 全量直导 5 个文件 → 验证导入成功 + chunk 切分 + source 块
 *   2. 增量直连 add + modify + delete → 验证 git diff 驱动链路
 *
 * 批次 3（REQ-04）：ai-results 输入契约已删除，改为 --source 直导 / git diff 直连。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

import { registerTestScope, getTestEnv } from '../test-config.ts';

// ─── 工具函数 ─────────────────────────────────────────────

const GIT_ENV = ' -c user.email=t@t -c user.name=t -c commit.gpgsign=false -c tag.gpgsign=false ';

function makeRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-kb-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  execSync('git init -q', { cwd: dir });
  execSync(`git${GIT_ENV}add . && git${GIT_ENV}commit -q -m init`, { cwd: dir, shell: '/bin/bash' });
  return dir;
}

function runImport(scope, sourceDir, rootName, mode = 'full') {
  const args = [
    'jiti', 'src/scan-kb.ts', 'import',
    '--scope', scope,
    '--source', sourceDir,
    '--root-name', rootName,
    '--mode', mode,
  ];
  const stdout = execFileSync('npx', args, {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env: getTestEnv(),
  });
  return JSON.parse(stdout);
}

function cleanupScope(scope) {
  // 清理 kb 目录
  const kbDir = path.resolve(__dirname, '..', '..', 'kb', scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  // 清理 scope 配置
  const scopeFile = path.resolve(__dirname, '..', '..', 'kb', `${scope}.json`);
  if (fs.existsSync(scopeFile)) fs.unlinkSync(scopeFile);
}

// ─── 测试 ─────────────────────────────────────────────────

const TEST_SCOPE = 'e2e-bulk-' + Date.now();
registerTestScope(TEST_SCOPE);

describe('E2E: 全量直导', () => {
  let sourceDir;

  before(() => {
    // 创建测试仓库：5 个 markdown 文件
    sourceDir = makeRepo({
      'README.md': '# 测试项目\n这是根 README',
      'guides/setup.md': '# 安装指南\nnpm install && npm run dev',
      'guides/deploy.md': '# 部署指南\n使用 Docker 部署',
      'api/auth.md': '# 认证 API\nJWT token 认证',
      'api/data.md': '# 数据 API\nCRUD 操作接口',
    });
  });

  after(() => {
    cleanupScope(TEST_SCOPE);
    if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  test('全量直导 5 个文件，全部成功', () => {
    const result = runImport(TEST_SCOPE, sourceDir, 'TestWiki', 'full');

    assert.equal(result.ok, true, `导入应成功: ${JSON.stringify(result)}`);
    assert.equal(result.mode, 'full');
    assert.equal(result.stats.total, 5, `chunks 应为 5（每文件 1 chunk）: ${JSON.stringify(result.stats)}`);
    assert.equal(result.stats.errors, 0);

    // groups 包含 rootName + 子目录
    assert.ok(result.groups.includes('TestWiki'));
    assert.ok(result.groups.includes('TestWiki/guides'));
    assert.ok(result.groups.includes('TestWiki/api'));

    // source 块写入（含切分参数持久化 H-18）
    assert.ok(result.source.commit);
    assert.match(result.source.commit, /^[0-9a-f]{40}$/);
    assert.equal(result.source.chunkSize, 1000);
    assert.equal(result.source.chunkOverlap, 150);

    // 验证 relations-cache：原文直导 relation 命名为 文件名-N
    const kbDir = path.resolve(__dirname, '..', '..', 'kb', TEST_SCOPE);
    const cache = JSON.parse(fs.readFileSync(path.join(kbDir, 'relations-cache.json'), 'utf-8'));
    const readmeRel = cache.groups['TestWiki'].hot_relations.find((r) => r.text === 'README-01');
    assert.ok(readmeRel, 'README.md 应切分为 README-01');
    assert.equal(readmeRel.sourcePath, 'README.md#1');
    assert.equal(readmeRel.isImported, true);

    console.log('  ✓ 全量直导 5 文件成功，chunks=5');
  });
});

describe('E2E: 增量直连（git diff 驱动）', () => {
  let sourceDir;
  let baseCommit;

  const SCOPE = TEST_SCOPE + '-inc';
  registerTestScope(SCOPE);

  before(() => {
    sourceDir = makeRepo({
      'a.md': '# 文件 A v1',
      'b.md': '# 文件 B v1',
      'sub/c.md': '# 文件 C v1',
    });

    const fullResult = runImport(SCOPE, sourceDir, 'IncWiki', 'full');
    assert.equal(fullResult.stats.total, 3);
    baseCommit = fullResult.source.commit;
  });

  after(() => {
    cleanupScope(SCOPE);
    if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  test('增量直连：add + modify + delete', () => {
    // 修改 a.md，新增 d.md，删除 b.md
    fs.writeFileSync(path.join(sourceDir, 'a.md'), '# 文件 A v2 改了');
    fs.writeFileSync(path.join(sourceDir, 'd.md'), '# 新文件 D');
    fs.unlinkSync(path.join(sourceDir, 'b.md'));
    execSync(`git${GIT_ENV}add -A && git${GIT_ENV}commit -q -m v2`, { cwd: sourceDir, shell: '/bin/bash' });

    // 增量直连（不传 root-name，复用 source 块）
    const result = runImport(SCOPE, sourceDir, 'IncWiki', 'incremental');

    assert.equal(result.ok, true, `增量直连应成功: ${JSON.stringify(result)}`);
    assert.equal(result.mode, 'incremental');
    assert.equal(result.stats.added, 1, `added=${result.stats.added}`);
    assert.equal(result.stats.modified, 1, `modified=${result.stats.modified}`);
    assert.equal(result.stats.deleted, 1, `deleted=${result.stats.deleted}`);
    assert.equal(result.stats.errors, 0, `errors=${JSON.stringify(result.errors)}`);

    // source.commit 应更新
    assert.notEqual(result.newCommit, baseCommit);
    assert.equal(result.previousCommit, baseCommit);

    // 验证 cache 状态
    const kbDir = path.resolve(__dirname, '..', '..', 'kb', SCOPE);
    const cacheFile = path.join(kbDir, 'relations-cache.json');
    const newCache = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));

    // a.md 仍在 cache 中（modify 后为新 chunk）
    const aRel = newCache.groups['IncWiki'].hot_relations.find((r) => r.text === 'a-01');
    assert.ok(aRel, 'a.md 仍在 cache 中（chunk 名 a-01）');
    assert.ok(aRel.memoryId, 'modify 后应有 memoryId');
    assert.equal(aRel.sourcePath, 'a.md#1');

    // d.md 应新增
    const dRel = newCache.groups['IncWiki'].hot_relations.find((r) => r.text === 'd-01');
    assert.ok(dRel, 'd.md 应在 cache 中（chunk 名 d-01）');
    assert.ok(dRel.memoryId, '新增条目应有 memoryId');

    // b.md 应已删除
    const bRel = newCache.groups['IncWiki'].hot_relations.find((r) => r.text === 'b-01');
    assert.equal(bRel, undefined, 'b.md 应从 cache 移除');

    // c.md 仍保留
    const cRel = newCache.groups['IncWiki/sub'].hot_relations.find((r) => r.text === 'c-01');
    assert.ok(cRel, 'c.md 应保留（chunk 名 c-01）');

    console.log('  ✓ 增量直连 add+modify+delete 成功');
  });
});
