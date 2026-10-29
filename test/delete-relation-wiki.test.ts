/**
 * delete-relation-wiki.test.ts —— 文档级硬删（D7）
 *
 * 契约（REQ-20261019-005）：
 *   - 源目录已配置且 sourcePath 匹配 → unlink 源 .md；
 *   - sourcePath 不匹配 → 拒绝（source-mismatch），文件零变化；
 *   - 无 sourcePath（历史数据）→ 按文件名删除并标 legacy-name。
 *
 * 运行：npx jiti test/delete-relation-wiki.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';

const vectorClient = await import('../src/lib/vector-client.js');
(vectorClient as any).ensureVectorAvailable = async () => ({ available: true, reason: undefined });
(vectorClient as any).vectorDelete = async () => ({ deleted: 1, failedIds: [], errors: [] });

const { executeDeleteRelation } = await import('../src/delete-relation.js');
const { ensureScopeDir } = await import('../src/lib/store.js');
const { getKbDir, setSource } = await import('../src/lib/scope.js');
const { resetConfigCache } = await import('../src/lib/config.js');

function setup(scope: string, sourcePath?: string) {
  ensureScopeDir(scope);
  const kbDir = getKbDir(scope);
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-dr-src-'));
  setSource(scope, { dir: sourceDir });

  fs.writeFileSync(path.join(kbDir, 'group-index.json'), JSON.stringify({
    version: 1, scope, groups: { wiki: {} }, source: { dir: sourceDir }, updatedAt: new Date().toISOString(),
  }), 'utf-8');

  const rel: Record<string, unknown> = {
    id: 'rel_1', text: 'a', score: 1, useCount: 0, lastUsedTime: null, isImported: true, memoryIds: ['m1'],
  };
  if (sourcePath) rel.sourcePath = sourcePath;
  fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), JSON.stringify({
    version: 1, scope, partition_config: {}, groups: { wiki: { hot_relations: [rel], keywords: [] } },
    updatedAt: new Date().toISOString(),
  }), 'utf-8');

  fs.mkdirSync(path.join(kbDir, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'wiki', 'index.json'), JSON.stringify({ a: '# body' }), 'utf-8');

  fs.mkdirSync(path.join(sourceDir, 'wiki'), { recursive: true });
  const file = path.join(sourceDir, 'wiki', 'a.md');
  fs.writeFileSync(file, '# body', 'utf-8');
  return { sourceDir, file };
}

let seq = 0;
function freshScope(): string {
  const s = `dr-wiki-${Date.now()}-${seq++}`;
  registerTestScope(s);
  return s;
}

function configureWikiSync(scope: string, wikiDir: string): void {
  const base = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
  base.scopes[scope] = { ...(base.scopes[scope] ?? {}), wikiSync: { enabled: true, sourceDir: wikiDir } };
  fs.writeFileSync(testConfigPath, JSON.stringify(base), 'utf-8');
  resetConfigCache();
}

/**
 * 单文件导入形态：`source` 块 = **一个 .md 文件**（不是目录），wiki 根只能由
 * wikiSync.sourceDir 提供。用于验证 wiki 根解析退化后的删除口径。
 */
function setupSingleFileScope(scope: string, sourcePath?: string): { wikiDir: string; srcFile: string } {
  ensureScopeDir(scope);
  const kbDir = getKbDir(scope);
  const srcFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ki-dr-one-')), 'imported.md');
  fs.writeFileSync(srcFile, '# imported', 'utf-8');
  const wikiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-dr-wiki-'));

  setSource(scope, { dir: srcFile });
  fs.writeFileSync(path.join(kbDir, 'group-index.json'), JSON.stringify({
    version: 1, scope, groups: { wiki: {} }, source: { dir: srcFile }, updatedAt: new Date().toISOString(),
  }), 'utf-8');

  const rel: Record<string, unknown> = {
    id: 'rel_1', text: 'a', score: 1, useCount: 0, lastUsedTime: null, isImported: true, memoryIds: ['m1'],
  };
  if (sourcePath) rel.sourcePath = sourcePath;
  fs.writeFileSync(path.join(kbDir, 'relations-cache.json'), JSON.stringify({
    version: 1, scope, partition_config: {}, groups: { wiki: { hot_relations: [rel], keywords: [] } },
    updatedAt: new Date().toISOString(),
  }), 'utf-8');

  fs.mkdirSync(path.join(kbDir, 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'wiki', 'index.json'), JSON.stringify({ a: '# body' }), 'utf-8');

  configureWikiSync(scope, wikiDir);
  return { wikiDir, srcFile };
}

after(() => cleanupTestConfig());

describe('delete-relation · 文档级硬删', () => {
  it('sourcePath 匹配 → 删除源文件', async () => {
    const s = freshScope();
    const { file } = setup(s, 'wiki/a.md');
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, true);
    assert.equal(r.result.wikiMatch, 'sourcePath');
    assert.equal(fs.existsSync(file), false);
  });

  it('sourcePath 不匹配 → 拒绝删除，文件仍在', async () => {
    const s = freshScope();
    const { file } = setup(s, 'other/a.md');
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, false);
    assert.equal(r.result.wikiSkipReason, 'source-mismatch');
    assert.equal(fs.existsSync(file), true);
  });

  it('软链逃逸 → 拒绝删除（outside-source-dir）', async () => {
    const s = freshScope();
    const { sourceDir, file } = setup(s);
    const outside = path.join(os.tmpdir(), `ki-outside-${Date.now()}.md`);
    fs.writeFileSync(outside, '# outside', 'utf-8');
    fs.rmSync(file);
    fs.symlinkSync(outside, file);
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, false);
    assert.equal(r.result.wikiSkipReason, 'outside-source-dir');
    assert.equal(fs.existsSync(outside), true);
    fs.rmSync(outside, { force: true });
  });

  it('无 sourcePath（历史数据）→ 按文件名删除并标 legacy-name', async () => {
    const s = freshScope();
    const { file } = setup(s);
    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, true);
    assert.equal(r.result.wikiMatch, 'legacy-name');
    assert.equal(fs.existsSync(file), false);
  });

  // 2026-10-27：source 块指向单文件时，wiki 根退化为 wikiSync.sourceDir（见 wiki-sync.ts
  // resolveWikiRootDir）。此前该场景一律 wikiSkipReason='file-not-found'，什么都不删。
  it('单文件导入（source 块为文件）→ 按命名约定删掉 wikiSync 下的镜像', async () => {
    const s = freshScope();
    const { wikiDir } = setupSingleFileScope(s);
    const mirror = path.join(wikiDir, 'wiki', 'a.md');
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.writeFileSync(mirror, '# wiki 镜像', 'utf-8');

    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.result.wikiRemoved, true);
    assert.equal(r.result.wikiMatch, 'legacy-name');
    assert.equal(fs.existsSync(mirror), false);
  });

  it('sourcePath 相对的是导入源，不得套到 wiki 根上误删同名文件', async () => {
    const s = freshScope();
    const { wikiDir } = setupSingleFileScope(s, 'a.md');
    // wiki 根下的同名手工文档（与导入源无关，绝不能因 sourcePath 命中被删）
    const decoy = path.join(wikiDir, 'a.md');
    fs.writeFileSync(decoy, '# 手工 wiki 文档', 'utf-8');
    const mirror = path.join(wikiDir, 'wiki', 'a.md');
    fs.mkdirSync(path.dirname(mirror), { recursive: true });
    fs.writeFileSync(mirror, '# wiki 镜像', 'utf-8');

    const r = await executeDeleteRelation({ scope: s, group: 'wiki', relation: 'a' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(fs.existsSync(decoy), true, 'wiki 根下同名文件必须保留');
    assert.equal(fs.existsSync(mirror), false, '命名约定镜像应被删除');
    assert.equal(r.result.wikiMatch, 'legacy-name');
  });
});
