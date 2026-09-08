#!/usr/bin/env node
/**
 * E2E 集成测试：ki import 幂等追加直导（原文直导，无 AI）
 *
 * 测试场景：
 *   1. 全量直导 5 个文件 → 验证导入成功 + 文件级 relation（方案 D）+ source 块
 *   2. 重复追加（幂等）：同文件重导不新增、不冲突
 *   3. 新文档追加：新增文件落入已有 group
 *
 * 批次 3（REQ-04）：ai-results 输入契约已删除，改为 --source 直导。
 * 后续迭代：废弃 --mode incremental（git diff 驱动），统一为幂等追加语义。
 *
 * 运行：npm run test:e2e:bulk-import（缺 embedding apiKey 时整套 skip，不失败）
 * 2026-09-07：命令由 `ki scan-kb import` 扁平化为 `ki import`，参数数组不再带 'import' 元素。
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

import { registerTestScope, getTestEnv } from '../test-config.ts';

// ─── apiKey 守卫（对齐同目录 *.e2e.network.mjs 惯例）──────────────────────
// 本套件的 runImport 不带 --no-vector，会真实调用 embedding；缺 key 时导入在 apiKey
// 预检 fail-loud，整套必然红。此前本文件既无守卫、也不在任何 npm script 里 →
// 「孤儿测试」：无 key 环境永久红，永久红的测试等于没有测试，也解释了它为何被排除在 script 之外。
// 现补守卫（缺 key 跳过而非失败）+ 纳入 npm run test:e2e:bulk-import。
// SKIP 挂在各 test() 而非 describe() 上：node:test 跳过 suite 时子测试根本不注册，
// 汇总会变成 `tests 0 / skipped 0`（跳过不可见，读 CI 输出会以为文件是空的）；
// 挂 test 级则汇总为 `tests 3 / skipped 3`，与同目录 *.e2e.network.mjs 口径一致。
const API_KEY = process.env.GITNEXUS_EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY;
const RUN = Boolean(API_KEY);
const SKIP = RUN ? {} : { skip: '缺少 embedding apiKey（SILICONFLOW_API_KEY / GITNEXUS_EMBEDDING_API_KEY），跳过真实向量化 e2e' };
if (!RUN) console.warn('[E2E-bulk-import] 未检测到 apiKey，整套真实向量化用例已跳过（CI 安全）。');

// ─── 工具函数 ─────────────────────────────────────────────

function makeDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-kb-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  return dir;
}

function runImport(scope, sourceDir, group = 'default') {
  const args = [
    'jiti', 'src/import.ts',
    '--scope', scope,
    '--source', sourceDir,
    '--group', group,
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
  const kbDir = path.resolve(__dirname, '..', '..', 'kb', scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  const scopeFile = path.resolve(__dirname, '..', '..', 'kb', `${scope}.json`);
  if (fs.existsSync(scopeFile)) fs.unlinkSync(scopeFile);
}

// ─── 测试 ─────────────────────────────────────────────────

const TEST_SCOPE = 'e2e-bulk-' + Date.now();
registerTestScope(TEST_SCOPE);

describe('E2E: 全量直导', () => {
  let sourceDir;

  before(() => {
    // 创建测试目录：5 个 markdown 文件
    sourceDir = makeDir({
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

  test('全量直导 5 个文件，全部成功', { ...SKIP }, () => {
    const result = runImport(TEST_SCOPE, sourceDir, 'TestWiki');

    assert.equal(result.ok, true, `导入应成功: ${JSON.stringify(result)}`);
    assert.equal(result.stats.total, 5, `chunks 应为 5（每文件 1 chunk）: ${JSON.stringify(result.stats)}`);
    assert.equal(result.stats.errors, 0);

    // groups 包含 group + 子目录
    assert.ok(result.groups.includes('TestWiki'));
    assert.ok(result.groups.includes('TestWiki/guides'));
    assert.ok(result.groups.includes('TestWiki/api'));

    // source 块写入（含切分参数持久化 H-18；rootName 已移除）
    assert.ok(!result.source.rootName, 'source.rootName 应已移除');
    assert.equal(result.source.chunkSize, 1000);
    assert.equal(result.source.chunkOverlap, 150);

    // 验证 relations-cache：**方案 D 为文件级 relation**，text = 文件名去 .md、sourcePath = 相对源根路径（无 #N 后缀）。
    // 旧断言写的是 chunk 级命名（README-01 / README.md#1），该 scheme 已随方案 D 移除。
    // kbDir 走 test-config.ts 设的 dataDir = PROJECT_ROOT/kb（子进程经 getTestEnv 继承同一 KI_CONFIG_PATH）。
    const kbDir = path.resolve(__dirname, '..', '..', 'kb', TEST_SCOPE);
    const cache = JSON.parse(fs.readFileSync(path.join(kbDir, 'relations-cache.json'), 'utf-8'));
    const readmeRel = cache.groups['TestWiki'].hot_relations.find((r) => r.text === 'README');
    assert.ok(readmeRel, 'README.md 应产生文件级 relation README');
    assert.equal(readmeRel.sourcePath, 'README.md');
    assert.equal(readmeRel.isImported, true);

    console.log('  ✓ 全量直导 5 文件成功，chunks=5');
  });
});

describe('E2E: 幂等追加', () => {
  let sourceDir;
  const SCOPE = TEST_SCOPE + '-append';
  registerTestScope(SCOPE);

  before(() => {
    sourceDir = makeDir({
      'a.md': '# 文件 A v1',
      'b.md': '# 文件 B v1',
      'sub/c.md': '# 文件 C v1',
    });
    const fullResult = runImport(SCOPE, sourceDir, 'Wiki');
    assert.equal(fullResult.ok, true, JSON.stringify(fullResult));
    assert.equal(fullResult.stats.total, 3);
  });

  after(() => {
    cleanupScope(SCOPE);
    if (sourceDir) fs.rmSync(sourceDir, { recursive: true, force: true });
  });

  test('同文件重复追加：幂等覆盖，不新增、不冲突', { ...SKIP }, () => {
    const result = runImport(SCOPE, sourceDir, 'Wiki');
    assert.equal(result.ok, true, `重复追加应成功: ${JSON.stringify(result)}`);
    // 幂等：同 sourcePath 重导覆盖，不跳过、不新增
    assert.equal(result.stats.total, 3, '同文件重导 total 应仍为 3');
    assert.equal(result.stats.skipped, 0, '幂等重导不应计入 skipped');
    console.log('  ✓ 同文件重复追加幂等');
  });

  test('新增文档追加到已有 group', { ...SKIP }, () => {
    // 新增 d.md + 修改 a.md
    fs.writeFileSync(path.join(sourceDir, 'd.md'), '# 文件 D 新增');
    fs.writeFileSync(path.join(sourceDir, 'a.md'), '# 文件 A v2 已改');

    const result = runImport(SCOPE, sourceDir, 'Wiki');
    assert.equal(result.ok, true, JSON.stringify(result));
    // 3 个旧文件（a 覆盖 + b 幂等 + sub/c 幂等）+ 1 新增 = 4 chunks
    assert.equal(result.stats.total, 4, `total 应为 4；实际=${result.stats.total}`);

    const kbDir = path.resolve(__dirname, '..', '..', 'kb', SCOPE);
    const cache = JSON.parse(fs.readFileSync(path.join(kbDir, 'relations-cache.json'), 'utf-8'));
    const dRel = cache.groups['Wiki'].hot_relations.find((r) => r.text === 'd');
    assert.ok(dRel, 'd.md 应新增（文件级 relation 名 d）');
    console.log('  ✓ 新文档追加成功');
  });
});
