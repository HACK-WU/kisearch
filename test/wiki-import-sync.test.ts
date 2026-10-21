/**
 * wiki-import-sync.test.ts —— wikiSync 开启时 group create / CLI import 的写回
 *
 * 覆盖：
 *   A. group create → 在 wikiSync.sourceDir 下建同名目录（含嵌套）
 *   B. import（wikiWriteback:true）→ 按 wiki 格式写 <sourceDir>/<group>/<relation>.md
 *      （剥离源 frontmatter；已存在文件跳过，不覆盖手工修改）
 *   C. 未配置 / enabled=false / 未传 wikiWriteback → 零写入
 *   D. 导入源位于 wiki 目录内 → 不自我复制
 *
 * 运行：npx jiti test/wiki-import-sync.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';
import { executeGroupCreate } from '../src/lib/group-create.js';
import { handleDirectImport } from '../src/lib/import.js';
import { getKbDir } from '../src/lib/scope.js';
import { ensureScopeDir } from '../src/lib/store.js';
import { resetConfigCache } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-wiki-import-'));
const scopes: string[] = [];
let seq = 0;

function setWikiSync(scope: string, wikiSync: Record<string, unknown> | null): void {
  const base = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
  base.scopes[scope] = wikiSync ? { wikiSync } : {};
  fs.writeFileSync(testConfigPath, JSON.stringify(base), 'utf-8');
  resetConfigCache();
}

/**
 * @param wikiSync `null` = 不配置 wikiSync；`{}` = 默认开启；
 *                 `{enabled:false}` = 显式关闭
 */
function freshScope(wikiSync: Record<string, unknown> | null): { scope: string; wikiDir: string } {
  const scope = `wiki-import-${Date.now()}-${seq++}`;
  const wikiDir = path.join(tmpRoot, `wiki-${seq}`);
  fs.mkdirSync(wikiDir, { recursive: true });
  registerTestScope(scope);
  setWikiSync(scope, wikiSync === null ? null : { enabled: true, ...wikiSync, sourceDir: wikiDir });
  ensureScopeDir(scope);
  scopes.push(scope);
  return { scope, wikiDir };
}

function writeSource(name: string, content: string): string {
  // 独立目录 + 原文件名：relation 名由文件名派生，前缀会污染断言
  const dir = path.join(tmpRoot, `src-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, 'utf-8');
  return file;
}

after(() => {
  for (const scope of scopes) {
    try { fs.rmSync(getKbDir(scope), { recursive: true, force: true }); } catch { /* best effort */ }
  }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('A. group create 同步建 wiki 目录', () => {
  it('wikiSync 开启：建组即建目录（含嵌套），返回 wikiDir', async () => {
    const { scope, wikiDir } = freshScope({});
    const top = await executeGroupCreate({ scope, path: '性能优化分析' });
    assert.equal(top.ok, true);
    if (!top.ok) return;
    assert.equal(top.wikiDir, path.join(wikiDir, '性能优化分析'));
    assert.equal(fs.statSync(path.join(wikiDir, '性能优化分析')).isDirectory(), true);

    const nested = await executeGroupCreate({ scope, path: '性能优化分析/子组' });
    assert.equal(nested.ok, true);
    if (!nested.ok) return;
    assert.equal(fs.statSync(path.join(wikiDir, '性能优化分析', '子组')).isDirectory(), true);
  });

  it('未配置 wikiSync：不建目录，结果无 wikiDir', async () => {
    const { scope } = freshScope(null);
    const r = await executeGroupCreate({ scope, path: '无同步组' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.wikiDir, undefined);
  });

  it('enabled=false：不建目录', async () => {
    const { scope, wikiDir } = freshScope({ enabled: false });
    const r = await executeGroupCreate({ scope, path: '关闭同步组' });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.wikiDir, undefined);
    assert.equal(fs.existsSync(path.join(wikiDir, '关闭同步组')), false);
  });
});

describe('B. import 写回 wiki 文档', () => {
  it('成功导入后按 wiki 格式写回；源 frontmatter 不重复', async () => {
    const { scope, wikiDir } = freshScope({});
    const src = writeSource('report.md', '---\ntitle: 自带头\n---\n# 性能优化分析报告\n\n测试内容。\n');

    const r = await handleDirectImport({ scope, sourceDir: src, group: '性能优化分析', vector: false, wikiWriteback: true });
    assert.equal(r.ok, true);
    assert.equal(r.wikiWriteback?.written, 1);
    assert.equal(r.wikiWriteback?.skipped, 0);

    const dest = path.join(wikiDir, '性能优化分析', 'report.md');
    const text = fs.readFileSync(dest, 'utf-8');
    assert.match(text, /^---\ngroupPath: 性能优化分析\nrelation: report\nexportedAt: /);
    assert.equal(text.includes('title: 自带头'), false, '源 frontmatter 应被替换，不能出现双 frontmatter');
    assert.ok(text.includes('# 性能优化分析报告'));
  });

  it('目标文件已存在：跳过，不覆盖手工修改', async () => {
    const { scope, wikiDir } = freshScope({});
    const src = writeSource('report.md', '# 第一版\n');
    await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: false, wikiWriteback: true });
    const dest = path.join(wikiDir, 'G', 'report.md');
    fs.appendFileSync(dest, '\n手工修改\n', 'utf-8');

    fs.writeFileSync(src, '# 第二版\n', 'utf-8');
    const r = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: false, wikiWriteback: true });
    assert.equal(r.wikiWriteback?.written, 0);
    assert.equal(r.wikiWriteback?.skipped, 1);
    const text = fs.readFileSync(dest, 'utf-8');
    assert.ok(text.includes('手工修改'));
    assert.equal(text.includes('第二版'), false);
  });

  it('未传 wikiWriteback（Web / 数据源同步口径）：零写回', async () => {
    const { scope, wikiDir } = freshScope({});
    const src = writeSource('report.md', '# 内容\n');
    const r = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: false });
    assert.equal(r.ok, true);
    assert.equal(r.wikiWriteback, undefined);
    assert.equal(fs.existsSync(path.join(wikiDir, 'G', 'report.md')), false);
  });
});

describe('C. 边界', () => {
  it('导入源位于 wiki 目录内：不自我复制', async () => {
    const { scope, wikiDir } = freshScope({});
    fs.mkdirSync(path.join(wikiDir, '已有'), { recursive: true });
    fs.writeFileSync(path.join(wikiDir, '已有', 'a.md'), '# 已存在的 wiki 文档\n', 'utf-8');

    const r = await handleDirectImport({ scope, sourceDir: path.join(wikiDir, '已有'), group: 'G', vector: false, wikiWriteback: true });
    assert.equal(r.wikiWriteback?.written, 0);
    assert.equal(r.wikiWriteback?.skipped, 1);
    assert.equal(fs.existsSync(path.join(wikiDir, 'G', 'a.md')), false);
  });

  it('enabled=false：import 不写回且结果无 wikiWriteback 字段', async () => {
    const { scope, wikiDir } = freshScope({ enabled: false });
    const src = writeSource('report.md', '# 内容\n');
    const r = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: false, wikiWriteback: true });
    assert.equal(r.wikiWriteback, undefined);
    assert.equal(fs.existsSync(path.join(wikiDir, 'G', 'report.md')), false);
  });

  it('wikiSync.sourceDir 误配到 KB 数据目录内：建组与导入均拒绝写回', async () => {
    const scope = `wiki-import-kb-${Date.now()}-${seq++}`;
    registerTestScope(scope);
    ensureScopeDir(scope);
    scopes.push(scope);
    const kbDir = getKbDir(scope);
    setWikiSync(scope, { enabled: true, sourceDir: kbDir });

    const g = await executeGroupCreate({ scope, path: 'G' });
    assert.equal(g.ok, true);
    if (!g.ok) return;
    assert.match(g.wikiWarning ?? '', /KB 数据目录/);
    assert.equal(fs.existsSync(path.join(kbDir, 'G')), false, '不得在 KB 内建组目录');

    const src = writeSource('report.md', '# 内容\n');
    const r = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: false, wikiWriteback: true });
    assert.equal(r.wikiWriteback, undefined);
    assert.equal(fs.existsSync(path.join(kbDir, 'G', 'report.md')), false);
  });
});
