/**
 * wiki-root-resolve.test.ts —— wiki 文档根目录解析 + Group 路径补全提示
 *
 * 背景（2026-10-27 线上报错）：
 *   单文件导入（`ki import <file>.md`）把 group-index.json 的 `source.dir` 记成**文件路径**，
 *   而 wiki 写回把它当目录拼 `<dir>/<group>/<relation>.md` → `ENOTDIR: not a directory`，
 *   该 scope 下所有 sync_relation 写回全部失败。
 *
 * 覆盖：
 *   A. resolveWikiRootDir 判定：source 块为目录 / 为文件 / 文件已删除（扩展名命中白名单）
 *   B. writeBackToWiki：source 块为文件 → 落到 wikiSync.sourceDir 正常写回
 *   C. backfillWiki：同上 targetDir 取 wikiSync.sourceDir
 *   D. 无兜底目录时 fail-loud 且文案给出被拒原因
 *   E. resolveGroupPath 部分匹配提示不再凭空"补全"到无关顶层组
 *
 * 运行：npx jiti test/wiki-root-resolve.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveWikiRootDir, writeBackToWiki, backfillWiki } from '../src/lib/wiki-sync.js';
import { resolveGroupPath } from '../src/lib/group-resolve.js';
import type { GroupIndex } from '../src/lib/scope.js';
import {
  registerTestScope, cleanupTestConfig, testConfigPath,
} from './test-config.js';
import {
  setSource, getRelationsCachePath, getLocalKbDir, getKbDir,
} from '../src/lib/scope.js';
import { resetConfigCache } from '../src/lib/config.js';
import { ensureScopeDir } from '../src/lib/store.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-wiki-root-'));
const scopes: string[] = [];
let seq = 0;

function setWikiSync(scope: string, wikiSync: Record<string, unknown> | null): void {
  const base = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
  base.scopes[scope] = wikiSync ? { wikiSync } : {};
  fs.writeFileSync(testConfigPath, JSON.stringify(base), 'utf-8');
  resetConfigCache();
}

/** wikiSync: null = 不配置；{sourceDir} = 启用并指向该目录 */
function freshScope(wikiSync: Record<string, unknown> | null): { scope: string; wikiDir: string } {
  const scope = `wiki-root-${Date.now()}-${seq++}`;
  const wikiDir = path.join(tmpRoot, `wiki-${seq}`);
  fs.mkdirSync(wikiDir, { recursive: true });
  registerTestScope(scope);
  setWikiSync(scope, wikiSync === null ? null : { enabled: true, ...wikiSync, sourceDir: wikiDir });
  ensureScopeDir(scope);
  scopes.push(scope);
  return { scope, wikiDir };
}

/** 单文件导入后的形态：source.dir 指向一个 .md 文件 */
function importSingleFile(sourceDir: string, name = 'ip-chooser-topo-trees-20261021.md'): string {
  fs.mkdirSync(sourceDir, { recursive: true });
  const file = path.join(sourceDir, name);
  fs.writeFileSync(file, '# 单文件导入源\n', 'utf-8');
  return file;
}

/** 最小 KB 数据：1 组 1 条 relation（供 backfill 写回） */
function seedKb(scope: string): void {
  const cachePath = getRelationsCachePath(scope);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    groups: { 'API 集成模式': { hot_relations: [{ text: '已有条目', score: 1, sourcePath: 'API 集成模式/已有条目.md' }], keywords: [] } },
    updatedAt: null,
  }));
  const kbPath = getLocalKbDir(scope, 'API 集成模式');
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  fs.writeFileSync(kbPath, JSON.stringify({ 已有条目: '历史正文' }));
}

after(() => {
  for (const scope of scopes) {
    try { fs.rmSync(getKbDir(scope), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('A. resolveWikiRootDir 判定 source 块能否当目录', () => {
  it('source.dir 是目录 → 采用 source 块', () => {
    const { scope, wikiDir } = freshScope(null);
    const dir = path.join(tmpRoot, `src-dir-${seq++}`);
    fs.mkdirSync(dir, { recursive: true });
    setSource(scope, { dir });
    const root = resolveWikiRootDir(scope);
    assert.equal(root.dir, path.resolve(dir));
    assert.equal(root.from, 'source');
    assert.equal(root.sourceRejected, undefined);
    assert.equal(fs.existsSync(wikiDir), true);
  });

  it('source.dir 是单文件导入的文件路径 → 跳过并兜底到 wikiSync.sourceDir', () => {
    const { scope, wikiDir } = freshScope({});
    const file = importSingleFile(path.join(tmpRoot, `src-file-${seq++}`));
    setSource(scope, { dir: file });
    const root = resolveWikiRootDir(scope);
    assert.equal(root.dir, path.resolve(wikiDir));
    assert.equal(root.from, 'wiki-sync');
    assert.match(String(root.sourceRejected), /文件而不是目录/);
    assert.match(String(root.sourceRejected), /ip-chooser-topo-trees-20261021\.md/);
  });

  it('源文件已被移走（扩展名命中导入白名单）→ 仍判为文件，不落到同名目录', () => {
    const { scope, wikiDir } = freshScope({});
    const file = importSingleFile(path.join(tmpRoot, `src-gone-${seq++}`));
    setSource(scope, { dir: file });
    fs.rmSync(file); // 用户"把文件移走"也修不好根目录
    const root = resolveWikiRootDir(scope);
    assert.equal(root.dir, path.resolve(wikiDir), '不得把已删除的文件路径当目录用');
    assert.match(String(root.sourceRejected), /已不存在/);
  });

  it('目录型 source 被临时移走（无文件扩展名）→ 维持原行为，写回时按需重建', () => {
    const { scope } = freshScope(null);
    const dir = path.join(tmpRoot, `src-moved-${seq++}`);
    setSource(scope, { dir });
    const root = resolveWikiRootDir(scope);
    assert.equal(root.dir, path.resolve(dir));
    assert.equal(root.from, 'source');
  });

  it('source 块为文件且未配置 wikiSync → 无可用目录 + 给出原因', () => {
    const { scope } = freshScope(null);
    const file = importSingleFile(path.join(tmpRoot, `src-nofb-${seq++}`));
    setSource(scope, { dir: file });
    const root = resolveWikiRootDir(scope);
    assert.equal(root.dir, null);
    assert.equal(root.from, null);
    assert.match(String(root.sourceRejected), /文件而不是目录/);
  });

  it('wikiSync 只配 sourceDir（未写 enabled）→ 视为启用，与写入门禁同口径', () => {
    const { scope, wikiDir } = freshScope(null);
    // 手工写入不带 enabled 的配置
    const base = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
    base.scopes[scope] = { wikiSync: { sourceDir: wikiDir } };
    fs.writeFileSync(testConfigPath, JSON.stringify(base), 'utf-8');
    resetConfigCache();

    const file = importSingleFile(path.join(tmpRoot, `src-noenabled-${seq++}`));
    setSource(scope, { dir: file });

    const root = resolveWikiRootDir(scope);
    assert.equal(root.from, 'wiki-sync');
    assert.equal(root.dir, path.resolve(wikiDir));
    const w = writeBackToWiki(scope, 'G', 'R', '内容');
    assert.equal(w.synced, true, `enabled 缺省应视为启用，实际：${w.reason}`);
    assert.equal(fs.existsSync(path.join(wikiDir, 'G', 'R.md')), true);
  });
});

describe('B. writeBackToWiki 走兜底目录（源报错的正向回归）', () => {
  it('source 块为文件 → 写回 wikiSync.sourceDir，不再 ENOTDIR', () => {
    const { scope, wikiDir } = freshScope({ autoBackfill: false });
    const file = importSingleFile(path.join(tmpRoot, `src-write-${seq++}`));
    setSource(scope, { dir: file });

    const r = writeBackToWiki(scope, '临时测试/wikiSync探针', '同步能力探针', '# 正文\n');
    assert.equal(r.synced, true, `应写回成功，实际：${r.reason}`);
    assert.equal(r.file, path.join(wikiDir, '临时测试', 'wikiSync探针', '同步能力探针.md'));
    assert.equal(fs.readFileSync(String(r.file), 'utf-8').includes('# 正文'), true);
    // 原文件不能被当成目录：既没被写入，也没有在旁边建出同名目录
    assert.equal(fs.statSync(file).isFile(), true);
  });

  it('source 块为文件 + 无 wikiSync → fail-loud，文案说明被拒原因', () => {
    const { scope } = freshScope(null);
    const file = importSingleFile(path.join(tmpRoot, `src-fl-${seq++}`));
    setSource(scope, { dir: file });
    const r = writeBackToWiki(scope, 'G', 'R', '内容');
    assert.equal(r.synced, false);
    assert.match(String(r.reason), /无可用 wiki 写回目录/);
    assert.match(String(r.reason), /文件而不是目录/);
    assert.match(String(r.reason), /wikiSync\.sourceDir/);
  });
});

describe('C. backfillWiki 走兜底目录', () => {
  it('source 块为文件 → targetDir 取 wikiSync.sourceDir，历史条目正常补齐', () => {
    const { scope, wikiDir } = freshScope({});
    const file = importSingleFile(path.join(tmpRoot, `src-bf-${seq++}`));
    setSource(scope, { dir: file });
    seedKb(scope);

    const r = backfillWiki(scope);
    assert.equal(r.ok, true, `backfill 应成功，实际：${r.error}`);
    assert.equal(r.targetDir, wikiDir);
    assert.equal(r.stats.written, 1);
    assert.equal(fs.existsSync(path.join(wikiDir, 'API 集成模式', '已有条目.md')), true);
  });

  it('source 块为文件 + 无 wikiSync → 整体拒绝并给出原因', () => {
    const { scope } = freshScope(null);
    const file = importSingleFile(path.join(tmpRoot, `src-bf2-${seq++}`));
    setSource(scope, { dir: file });
    seedKb(scope);
    const r = backfillWiki(scope);
    assert.equal(r.ok, false);
    assert.match(String(r.error), /无可用 wiki 写回目录/);
    assert.match(String(r.error), /文件而不是目录/);
  });
});

describe('D. resolveGroupPath 部分匹配提示', () => {
  const scope = 'group-resolve-hint';
  const groupIndex = (groups: Record<string, unknown>): GroupIndex => ({
    version: 2, scope, groups: groups as GroupIndex['groups'], updatedAt: null,
  });

  it('全新路径 + 顶层组无相关子树 → 不再凭空"补全为 <顶层组>/<输入>"', async () => {
    const r = await resolveGroupPath(
      '临时测试/wikiSync探针',
      groupIndex({ 'API 集成模式': {} }),
      {},
    );
    assert.equal(r.matched, false);
    assert.doesNotMatch(r.hint, /补全为/, `不得捏造补全落点，实际：${r.hint}`);
    assert.match(r.hint, /未匹配到任何 Group/);
    assert.match(r.hint, /API 集成模式/); // 仍给出可用顶层组
  });

  it('输入首段确实挂在某顶层组下 → 提示该相近前缀与缺失段', async () => {
    const r = await resolveGroupPath(
      '临时测试/wikiSync探针',
      groupIndex({ 'API 集成模式': { 临时测试: { 已有子组: {} } } }),
      {},
    );
    assert.equal(r.matched, false);
    assert.match(r.hint, /相近的是 "API 集成模式\/临时测试"/);
    assert.match(r.hint, /没有 "wikiSync探针"/);
  });

  it('多个顶层组都有前缀时取最长的一个', async () => {
    const r = await resolveGroupPath(
      '临时测试/wikiSync探针/额外段',
      groupIndex({
        '短前缀组': { 临时测试: {} },
        '长前缀组': { 临时测试: { wikiSync探针: {} } },
      }),
      {},
    );
    assert.equal(r.matched, false);
    assert.match(r.hint, /相近的是 "长前缀组\/临时测试\/wikiSync探针"/);
    assert.doesNotMatch(r.hint, /短前缀组/);
  });

  it('唯一整段命中仍自动补全（既有能力不回退）', async () => {
    const r = await resolveGroupPath(
      '临时测试/wikiSync探针',
      groupIndex({ 'API 集成模式': { 临时测试: { wikiSync探针: {} } } }),
      {},
    );
    assert.equal(r.matched, true);
    assert.equal(r.resolvedPath, 'API 集成模式/临时测试/wikiSync探针');
    assert.match(r.hint, /已自动补全/);
  });
});
