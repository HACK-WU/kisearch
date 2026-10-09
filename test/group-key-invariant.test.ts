/**
 * group-key-invariant.test.ts —— 「分片键 = group-index 树路径 = local-kb 目录」不变量回归
 * （REQ-20260930-002 批次 2 第二轮审查 P0 修复）。
 *
 * 缺陷背景（修复前）：新布局把组键无条件剥掉历史 `项目根/` 前缀，而树与 local-kb
 * 目录不剥 → 三者分叉：
 *   - `ki export` 以树路径查元数据 → 未命中 → 静默导出 0 条；
 *   - `query-group --group 项目根/X` 报「暂无 Relations」；
 *   - `delete-group` 收集不到 relation（向量/FTS 残留）且分片不删；
 *   - `delete-relation` 报 ok 但 cacheRemoved=false（KB 已删、元数据留档）；
 *   - 且 `项目根/X` 与 `X` 撞同一分片（非单射），后写覆盖前写。
 *
 * 修复不变量：组键**原样**进分片路径；唯一合法的前缀剥离时机是 `store.ts` 的
 * roots→groups 迁移（树里的 `项目根` 节点消失时，分片键一起改名）。
 *
 * 隔离：独立 KI_CONFIG_PATH + 临时 dataDir（不触真实数据/daemon，护栏 #4）。
 * 运行：npx jiti test/group-key-invariant.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerTestScope, cleanupTestConfig } from './test-config.js';

process.env.KI_DAEMON_OWNER = '1';

const { handleDirectImport } = await import('../src/lib/import.js');
const { handleExport } = await import('../src/export.js');
const { executeQueryGroup } = await import('../src/query-group.js');
const { executeDeleteGroup } = await import('../src/delete-relation.js');
const { initScope, writeJson, readJson, readGroupIndex } = await import('../src/lib/store.js');
const { getKbDir, getRelationsCachePath, getGroupIndexPath, getLocalKbDir } = await import('../src/lib/scope.js');
const gc = await import('../src/lib/group-cache.js');
const { closeFtsEngine } = await import('../src/lib/fts-client.js');

const tempRoot = path.resolve(process.cwd(), 'temp');
const PREFIXED = '项目根/测试模块';

function mkSource(fileName: string, body: string): string {
  const dir = fs.mkdtempSync(path.join(tempRoot, 'gki-src-'));
  fs.writeFileSync(path.join(dir, `${fileName}.md`), body);
  return dir;
}

/** 干净 scope：登记 + initScope，可选「抹掉历史」到新布局出生（manifest 在、0 组、无 .bak） */
function freshScope(tag: string, newLayoutBirth = false): string {
  const scope = `gki-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  registerTestScope(scope);
  initScope(scope);
  if (newLayoutBirth) {
    const legacy = getRelationsCachePath(scope);
    if (fs.existsSync(legacy)) fs.rmSync(legacy);
    if (fs.existsSync(`${legacy}.bak`)) fs.rmSync(`${legacy}.bak`);
    gc.writeGroupCache(scope, 'bootstrap', { version: 1, scope, hot_relations: [], keywords: [] } as never);
    gc.deleteGroupCache(scope, 'bootstrap');
  }
  return scope;
}

function cleanupScope(scope: string): void {
  try {
    const kbDir = getKbDir(scope);
    if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  } catch { /* ignore */ }
}

function treeTopKeys(scope: string): string[] {
  const raw = readJson<{ groups?: Record<string, unknown> }>(getGroupIndexPath(scope));
  return Object.keys(raw?.groups ?? {}).sort();
}

function exportProducts(scope: string): string[] {
  const out = fs.mkdtempSync(path.join(tempRoot, 'gki-out-'));
  const r = handleExport({ scope, output: out } as never);
  const files: string[] = [];
  const walk = (d: string, p: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = p ? `${p}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), rel); else files.push(rel);
    }
  };
  if (fs.existsSync(out)) walk(out, '');
  return files.map((f) => f.split('/').slice(1).join('/')).filter(Boolean).concat([`__stats:${JSON.stringify(r.stats)}`]);
}

after(async () => {
  await closeFtsEngine();
  cleanupTestConfig();
});

describe('分片键不变量（第二轮审查 P0）', () => {
  it('组路径以 `项目根/` 开头时：分片键 / 树路径 / local-kb 目录三者一致，export 不丢组', async () => {
    const scope = freshScope('consistency');
    try {
      const imported = await handleDirectImport({
        scope, sourceDir: mkSource('DocA', '# DocA\n\n正文A'), group: PREFIXED, vector: false,
      } as never);
      assert.equal(imported.ok, true);

      // ① 分片键原样（不剥前缀）
      assert.deepEqual(gc.listGroupPaths(scope), [PREFIXED], '分片键必须与组路径一致');
      // ② 树路径（顶层节点即 `项目根`）
      assert.deepEqual(treeTopKeys(scope), ['项目根'], '树路径保持原样');
      // ③ local-kb 目录（分片键可直接拼出 KB 路径）
      assert.ok(fs.existsSync(getLocalKbDir(scope, PREFIXED)), 'local-kb 目录存在');
      assert.ok(fs.existsSync(getLocalKbDir(scope, gc.listGroupPaths(scope)[0])), '分片键可拼出 KB 路径（同键）');
      // ④ export 不丢组（修复前 total=0）
      const products = exportProducts(scope);
      const stats = products.find((p) => p.startsWith('__stats:'));
      assert.ok(stats, '导出应返回 stats');
      assert.ok(products.some((p) => p.endsWith('DocA.md')), `导出应含 DocA.md，实得 ${JSON.stringify(products)}`);
      assert.ok(stats!.includes('"exported":1'), `导出条数应为 1，实得 ${stats}`);
    } finally {
      cleanupScope(scope);
    }
  });

  it('零历史新布局 scope 同样一致（缺陷与历史兼容无关）', async () => {
    const scope = freshScope('freshbirth', true);
    try {
      const imported = await handleDirectImport({
        scope, sourceDir: mkSource('DocB', '# DocB\n\n正文B'), group: PREFIXED, vector: false,
      } as never);
      assert.equal(imported.ok, true);
      assert.deepEqual(gc.listGroupPaths(scope), [PREFIXED]);
      const products = exportProducts(scope);
      assert.ok(products.some((p) => p.endsWith('DocB.md')), `导出应含 DocB.md，实得 ${JSON.stringify(products)}`);
    } finally {
      cleanupScope(scope);
    }
  });

  it('`项目根/X` 与 `X` 是两个独立组：各自独立分片，互不覆盖（映射单射）', async () => {
    const scope = freshScope('injective');
    try {
      await handleDirectImport({ scope, sourceDir: mkSource('DocA', '# DocA\n\nA'), group: '测试模块', vector: false } as never);
      await handleDirectImport({ scope, sourceDir: mkSource('DocB', '# DocB\n\nB'), group: PREFIXED, vector: false } as never);

      const keys = gc.listGroupPaths(scope).sort();
      assert.deepEqual(keys, ['测试模块', PREFIXED].sort(), '两个组必须各有一份分片');
      assert.notEqual(
        gc.getGroupCachePath(scope, '测试模块'),
        gc.getGroupCachePath(scope, PREFIXED),
        '两个组的分片路径不得相同',
      );
      assert.deepEqual(gc.loadGroupCache(scope, '测试模块')!.hot_relations.map((r) => r.text), ['DocA']);
      assert.deepEqual(gc.loadGroupCache(scope, PREFIXED)!.hot_relations.map((r) => r.text), ['DocB']);
    } finally {
      cleanupScope(scope);
    }
  });

  it('query-group 与 delete-group 按原始组路径工作（不空查、不留残留分片）', async () => {
    const scope = freshScope('querydelete');
    try {
      await handleDirectImport({ scope, sourceDir: mkSource('DocA', '# DocA\n\n正文A'), group: PREFIXED, vector: false } as never);

      const q = await executeQueryGroup({
        scope, groupsParam: PREFIXED, hotCount: 5, depth: 1, modes: ['hot'], autoFallback: false,
      } as never);
      assert.equal(q.ok, true);
      assert.ok(q.ok && q.output.includes('DocA'), `query-group 应返回该组 relation，实际：${q.ok ? q.output : q.error}`);

      const del = await executeDeleteGroup({ scope, group: PREFIXED } as never);
      assert.equal(del.ok, true);
      assert.equal(
        (del as { result: { relationCount: number } }).result.relationCount, 1,
        'delete-group 必须收集到该组 relation（否则向量/FTS 残留）',
      );
      assert.deepEqual(gc.listGroupPaths(scope), [], '删除后不得残留分片（否则幽灵组复活）');
    } finally {
      cleanupScope(scope);
    }
  });

  it('roots→groups 迁移时键同步改名（唯一合法的前缀剥离时机，树/键一起动）', () => {
    const scope = freshScope('rootsmigration');
    try {
      // 新布局已就位且键带前缀（先于树读取被惰性迁移的形态）
      gc.writeGroupCache(scope, PREFIXED, {
        version: 1, scope, hot_relations: [{ id: 'rel_1', text: '文档', score: 0, useCount: 0, lastUsedTime: null, isImported: true }] as never, keywords: [],
      } as never);
      assert.deepEqual(gc.listGroupPaths(scope), [PREFIXED]);

      // 树仍是 roots 旧格式（顶层 root 名恰为默认 `项目根`）→ 迁移把 root 的子节点提升为顶层
      writeJson(getGroupIndexPath(scope), {
        version: 1, scope, roots: { 项目根: { 测试模块: {} } }, updatedAt: new Date().toISOString(),
      } as unknown as Record<string, unknown>);

      const tree = readGroupIndex(scope);
      assert.ok(tree, '迁移后应可读树');
      assert.deepEqual(Object.keys(tree!.groups), ['测试模块'], '树提升后顶层为 测试模块（项目根 节点消失）');
      assert.deepEqual(gc.listGroupPaths(scope), ['测试模块'], '分片键必须随树一起改名（否则再次分叉）');
      assert.deepEqual(gc.loadGroupCache(scope, '测试模块')!.hot_relations.map((r) => r.text), ['文档'], '数据守恒');
      assert.ok(fs.existsSync(`${getRelationsCachePath(scope)}.bak`) || !fs.existsSync(getRelationsCachePath(scope)), '旧文件不残留原位');
    } finally {
      cleanupScope(scope);
    }
  });
});
