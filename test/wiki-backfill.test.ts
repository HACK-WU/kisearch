/**
 * wiki-backfill 单元测试
 *
 * 覆盖：
 *   A. writeBackToWiki enabled 门禁：显式 false 拒绝一切写回
 *      （修复前 source.dir 存在时 enabled=false 仍写文件——开关失效）
 *   B. backfillWiki 历史补齐：cache+localKB → wiki 文件落盘（含 group 层级）、幂等
 *   C. backfillWiki fail-fast：enabled=false / 无目标目录 / 无数据
 *
 * 运行：npx jiti test/wiki-backfill.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { writeBackToWiki, backfillWiki } from '../src/lib/wiki-sync.js';
import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';
import { getRelationsCachePath, getLocalKbDir, setSource, getGroupIndexPath } from '../src/lib/scope.js';
import { resetConfigCache } from '../src/lib/config.js';
import { ensureScopeDir } from '../src/lib/store.js';

// ─── 测试隔离：临时 HOME（wiki 目标目录 + 独立配置） ───

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-wbf-'));
const savedHome = process.env.HOME;
let savedCfg: string | undefined = process.env.KI_CONFIG_PATH;

const scope = `wbf-test-${Date.now()}`;
const wikiDir = path.join(tmpHome, 'wiki');

/** 覆盖测试配置：写 scopes.<scope>.wikiSync */
function setWikiSync(cfg: { enabled?: boolean; sourceDir?: string } | null): void {
  const base = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
  if (cfg === null) delete base.scopes[scope];
  else base.scopes[scope] = { ...(base.scopes[scope] ?? {}), wikiSync: cfg };
  fs.writeFileSync(testConfigPath, JSON.stringify(base), 'utf-8');
  resetConfigCache();
}

/** 清空 group-index 的 source 块（setSource 不接受空 dir，直接编辑 JSON） */
function clearSource(): void {
  const p = getGroupIndexPath(scope);
  const data = JSON.parse(fs.readFileSync(p, 'utf-8'));
  data.source = null;
  fs.writeFileSync(p, JSON.stringify(data), 'utf-8');
}

/** 手工构造 KB 数据：relations-cache + local KB（不经 sync-relation CLI） */
function seedKb(): void {
  const cachePath = getRelationsCachePath(scope);
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    groups: {
      'docs': { hot_relations: [
        { text: 'api-design', score: 1, sourcePath: 'docs/api.md' },
        { text: 'unsafe/name', score: 1, sourcePath: 'docs/x.md' },
      ], keywords: [], max_hot_count: 0 },
      'guide/intro': { hot_relations: [
        { text: 'quickstart', score: 1, sourcePath: 'guide/intro.md' },
      ], keywords: [], max_hot_count: 0 },
    },
    updatedAt: null,
  }));

  fs.mkdirSync(path.dirname(getLocalKbDir(scope, 'docs')), { recursive: true });
  fs.writeFileSync(getLocalKbDir(scope, 'docs'), JSON.stringify({
    'api-design': { moduleInfo: 'API 设计说明内容' },
    'unsafe/name': '脏数据',
  }));
  fs.mkdirSync(path.dirname(getLocalKbDir(scope, 'guide/intro')), { recursive: true });
  fs.writeFileSync(getLocalKbDir(scope, 'guide/intro'), JSON.stringify({
    quickstart: '快速上手内容',
  }));
}

before(() => {
  process.env.HOME = tmpHome;
  savedCfg = process.env.KI_CONFIG_PATH;
  registerTestScope(scope);
  ensureScopeDir(scope); // 确保 group-index.json 存在（setSource 前置）
  setWikiSync(null); // 初始：无 wikiSync 配置
});

after(() => {
  process.env.HOME = savedHome;
  if (savedCfg === undefined) delete process.env.KI_CONFIG_PATH;
  else process.env.KI_CONFIG_PATH = savedCfg;
  cleanupTestConfig();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('A. writeBackToWiki enabled 门禁', () => {
  it('wikiSync.enabled=false → 拒绝写回（含 source.dir 存在的场景）', () => {
    // 模拟"导入过"：写 source 块（优先级 1 路径）——修复前 enabled=false 也会写
    setSource(scope, { dir: wikiDir, chunkSize: 1000, chunkOverlap: 150 });
    setWikiSync({ enabled: false, sourceDir: wikiDir });

    const r = writeBackToWiki(scope, 'docs', 'gate-test', '内容');
    assert.equal(r.synced, false);
    assert.ok(r.reason?.includes('已禁用'), `reason 应说明禁用，实际：${r.reason}`);
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'gate-test.md')), false);
  });

  it('wikiSync 未配置（null）→ 维持原行为，可写回', () => {
    setWikiSync(null);
    const r = writeBackToWiki(scope, 'docs', 'default-on', '内容');
    assert.equal(r.synced, true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'default-on.md')), true);
  });
});

describe('B. backfillWiki 历史补齐', () => {
  it('cache + localKB 全量写回 wiki（含多级 group、跳过非法 relation）', () => {
    seedKb();
    setWikiSync(null); // 走 source.dir 优先级
    const r = backfillWiki(scope);
    assert.equal(r.ok, true);
    assert.equal(r.stats.total, 3);
    assert.equal(r.stats.written, 2);
    assert.equal(r.stats.skipped, 1); // unsafe/name 路径字符拦截
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'api-design.md')), true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'guide', 'intro', 'quickstart.md')), true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'unsafe')), false); // 无穿越产物
  });

  it('幂等：重复执行已存在文件跳过（内容不变，exportedAt 不刷新）', () => {
    const target = path.join(wikiDir, 'docs', 'api-design.md');
    const before = fs.readFileSync(target, 'utf-8');
    const r = backfillWiki(scope);
    assert.equal(r.ok, true);
    assert.equal(r.stats.written, 0);
    assert.equal(r.stats.existed, 2); // api-design + quickstart 均已存在
    assert.equal(fs.readFileSync(target, 'utf-8'), before); // 内容零变化
  });

  it('force=true：覆盖已存在文件（exportedAt 刷新）', () => {
    const target = path.join(wikiDir, 'docs', 'api-design.md');
    const before = fs.readFileSync(target, 'utf-8');
    const r = backfillWiki(scope, { force: true });
    assert.equal(r.ok, true);
    assert.equal(r.stats.written, 2);
    assert.equal(r.stats.existed, 0);
    assert.notEqual(fs.readFileSync(target, 'utf-8'), before); // 时间戳已刷新
  });

  it('走 wikiSync.sourceDir fallback（清掉 source 块后）', () => {
    clearSource();
    setWikiSync({ enabled: true, sourceDir: wikiDir });
    const r = backfillWiki(scope);
    assert.equal(r.ok, true);
    assert.equal(r.targetDir, wikiDir);
  });
});

describe('C. backfillWiki fail-fast', () => {
  it('enabled=false → 整体拒绝', () => {
    setWikiSync({ enabled: false, sourceDir: wikiDir });
    const r = backfillWiki(scope);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('已禁用'));
  });

  it('无目标目录（source 清空 + 无 wikiSync）→ 拒绝并给出指引', () => {
    clearSource();
    setWikiSync(null);
    const r = backfillWiki(scope);
    assert.equal(r.ok, false);
    assert.ok(r.error?.includes('无可用 wiki 写回目录'));
  });
});

describe('D. 写回时自动补齐（目标目录不存在/为空触发）', () => {
  /** 清空 wiki 目标目录（保留目录本身或彻底删除由参数控制） */
  function resetWikiDir(keepEmptyDir: boolean): void {
    fs.rmSync(wikiDir, { recursive: true, force: true });
    if (keepEmptyDir) fs.mkdirSync(wikiDir, { recursive: true });
  }

  it('wiki 目录为空 → writeBackToWiki 自动补齐历史 + 写入本条', () => {
    resetWikiDir(true); // 空目录
    setWikiSync(null);
    setSource(scope, { dir: wikiDir, chunkSize: 1000, chunkOverlap: 150 });
    const r = writeBackToWiki(scope, 'newgrp', 'fresh-entry', '新内容');
    assert.equal(r.synced, true);
    // 历史关系被自动补齐（B 组 seedKb 的数据：docs/api-design.md、guide/intro/quickstart.md）
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'api-design.md')), true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'guide', 'intro', 'quickstart.md')), true);
    // 本次条目也写入
    assert.equal(fs.existsSync(path.join(wikiDir, 'newgrp', 'fresh-entry.md')), true);
  });

  it('wiki 目录不存在 → 同样自动补齐', () => {
    resetWikiDir(false); // 目录整个删除
    const r = writeBackToWiki(scope, 'another', 'entry2', '内容');
    assert.equal(r.synced, true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'api-design.md')), true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'another', 'entry2.md')), true);
  });

  it('autoBackfill: false → 不自动补齐，只写本条', () => {
    resetWikiDir(true);
    setWikiSync({ enabled: true, sourceDir: wikiDir, autoBackfill: false });
    clearSource();
    const r = writeBackToWiki(scope, 'solo', 'only-this', '内容');
    assert.equal(r.synced, true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'solo', 'only-this.md')), true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'api-design.md')), false, '历史不应被补齐');
  });

  it('非空目录 → 不触发自动补齐（只写本条）', () => {
    resetWikiDir(true);
    fs.writeFileSync(path.join(wikiDir, 'unrelated.txt'), 'x'); // 使目录非空
    setWikiSync(null);
    setSource(scope, { dir: wikiDir, chunkSize: 1000, chunkOverlap: 150 });
    const r = writeBackToWiki(scope, 'nomore', 'just-this', '内容');
    assert.equal(r.synced, true);
    assert.equal(fs.existsSync(path.join(wikiDir, 'docs', 'api-design.md')), false, '非空目录不应触发补齐');
    assert.equal(fs.existsSync(path.join(wikiDir, 'nomore', 'just-this.md')), true);
  });
});
