/**
 * import-auxiliary-degrade.test.ts —— 辅助向量降级与重试清单边界契约
 * （REQ-20261009-001 review 修复批：P0-2 / P1-3 / P1-4）
 *
 * 契约：
 *   1. **tag（自定义标签）向量阶段系统性停止 → 不再全批连坐**：正文照常提交（元数据 + 原文 + 向量
 *      可浏览/可检索），仅标签向量缺失，error 记账并给出 `ki rebuild-vector` 出路（P0-2）；
 *   2. `onlyRelPaths` 在**核心层**净化：绝对路径 / 含 `..` / 空值一律拒绝并计入
 *      `retryFilter.invalid`；全部非法时 fail-loud（不静默退化为「处理整批」）（P1-4）；
 *   3. 未完成清单跨源覆盖/清除前先备份为 `.ki-import-incomplete.prev.json`，
 *      不静默丢弃上一批的未完成项（P1-3）。
 *
 * 运行：npx jiti test/import-auxiliary-degrade.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { readAllGroupCaches } from '../src/lib/group-cache.js';
import { clearRelationMapCache } from '../src/lib/relation-map.js';
import { readImportIncompleteStatus, getImportIncompletePrevPath } from '../src/lib/import-retry.js';

const vectorClient = await import('../src/lib/vector-client.js');
const batchVectorize = await import('../src/lib/batch-vectorize.js');
const pathVectorize = await import('../src/lib/path-vectorize.js');
const { handleDirectImport } = await import('../src/lib/import.js');

type Entry = { path: string };

/** 正文向量：success=全部成功；stop=entries[0] 成功其余系统性停止（构造部分成功） */
let vectorizeMode: 'success' | 'stop' = 'success';
/** 标签向量阶段：stop 时只有第一条成功 + stopReason（模拟 tag 阶段 provider 不可用） */
let tagStageMode: 'success' | 'stop' = 'success';
let vectorDeleteCalls: string[][] = [];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-aux-degrade-'));

(vectorClient as any).vectorDelete = async (params: { ids: string[] }) => {
  vectorDeleteCalls.push([...params.ids]);
  return vectorClient.normalizeVectorDeleteResult(params.ids, { ok: params.ids.length, failed: 0, errors: [] });
};
(vectorClient as any).vectorDeleteScope = async () => {
  throw new Error('不得调用 Scope 级向量清空接口');
};
(vectorClient as any).vectorBulkStore = async (params: { scope: string; entries: { text: string; tags?: string }[] }) => {
  // 标签阶段 = 自定义 tag（既不是 ki-relation 也不是 ki-path）；路径阶段走 bulkStorePaths。
  const isTagStage = params.entries.length > 0
    && params.entries.every((entry) => !!entry.tags && entry.tags !== 'ki-relation' && entry.tags !== 'ki-path');
  const stopTagStage = isTagStage && tagStageMode === 'stop';
  const results = params.entries.map((entry, index) => {
    const success = !(stopTagStage && index > 0);
    return {
      index,
      success,
      memoryId: success
        ? (entry.tags === 'ki-relation' || entry.tags === 'ki-path'
          ? vectorClient.generateDocId(entry.text, params.scope, entry.tags)
          : `mock-${entry.tags ?? 'untagged'}-${params.scope}-${index}`)
        : undefined,
      error: success ? undefined : 'mock tag provider unavailable',
    };
  });
  if (!stopTagStage) return { results };
  return {
    total: params.entries.length,
    totalItems: params.entries.length,
    attempted: 1,
    succeeded: results.filter((item) => item.success).length,
    failed: results.length - 1,
    results,
    notProcessed: results.length - 1,
    cancelled: 0,
    cancelledItems: [],
    metadataPending: 0,
    status: 'failed',
    stopReason: {
      kind: 'provider-unavailable',
      code: 'HTTP_503',
      phase: 'embedding',
      reason: 'mock tag provider unavailable',
    },
  };
};
(batchVectorize as any).bulkVectorize = async (entries: Entry[]) => {
  if (vectorizeMode === 'stop') {
    const ok = new Map<string, string>();
    if (entries[0]) ok.set(entries[0].path, 'content-ok-first');
    return {
      ok,
      errors: entries.slice(1).map((entry) => ({ path: entry.path, error: 'mock systemic failure' })),
      notProcessed: Math.max(0, entries.length - 2),
      stopReason: { kind: 'provider-unavailable', code: 'HTTP_503', phase: 'embedding', reason: 'mock embedding unavailable' },
    };
  }
  const ok = new Map<string, string>();
  entries.forEach((entry, index) => ok.set(entry.path, `content-${index}-${entry.path}`));
  return { ok, errors: [] };
};
(pathVectorize as any).bulkStorePaths = async (entries: { text: string; scope: string; tag: string }[]) => ({
  ok: new Map(entries.map((entry) => [entry.text, vectorClient.generateDocId(entry.text, entry.scope, entry.tag)])),
  errors: [],
});

function mkSource(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'src-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}

function cleanup(scope: string): void {
  try {
    const kb = getKbDir(scope);
    if (fs.existsSync(kb)) fs.rmSync(kb, { recursive: true, force: true });
  } catch { /* ignore */ }
}

after(() => {
  clearRelationMapCache();
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('辅助向量降级与重试清单边界（review 修复批）', () => {
  it('tag 向量阶段系统性停止：正文照常提交，仅标签向量降级（P0-2）', async () => {
    const scope = `aux-tag-${Date.now()}`;
    registerTestScope(scope);
    vectorizeMode = 'success';
    tagStageMode = 'stop';
    vectorDeleteCalls = [];
    clearRelationMapCache();
    try {
      const src = mkSource({ 'a.md': '# a\n\na 正文', 'b.md': '# b\n\nb 正文' });
      const result = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true, tags: 'api' });

      // ① 不再全批连坐：零未完成文件，正文全部提交
      assert.equal(result.ok, true);
      assert.equal(result.partial, false, '标签向量失败不得产生未完成文件（P0-2）');
      assert.equal(result.stats.files.incomplete, 0);
      // unchanged: 增量导入（REQ-20261010-001）新增字段：本用例无"内容未变"文件 ⇒ 0
      assert.deepEqual(result.stats.files, { total: 2, completed: 2, incomplete: 0, scanned: 2, skipped: 0, unchanged: 0 });

      // ② 元数据 + 原文提交（= 文档列表/检索可用）
      const groups = readAllGroupCaches(scope);
      assert.deepEqual((groups.get('G')?.hot_relations ?? []).map((r) => r.text).sort(), ['a', 'b']);
      assert.equal(
        (groups.get('G')?.hot_relations ?? []).every((r) => (r.memoryIds ?? []).length > 0),
        true,
        '正文向量挂载（可检索）',
      );
      const kb = JSON.parse(fs.readFileSync(getLocalKbDir(scope, 'G'), 'utf-8')) as Record<string, string>;
      assert.match(kb.a ?? '', /a 正文/);
      assert.match(kb.b ?? '', /b 正文/);

      // ③ 不回滚正文向量 + 标签缺失显式记账（含重建出路）
      assert.equal(vectorDeleteCalls.flat().some((id) => id.startsWith('content-')), false, '不得回滚正文向量');
      assert.equal(result.errors.some((item) => /标签向量/.test(item.error)), true, '标签向量缺失必须记账');
      assert.equal(result.errors.some((item) => /rebuild-vector/.test(item.error)), true, '必须给出重建出路');
      assert.equal(result.stopReason?.code, 'HTTP_503', '停止原因保留在结果里供两端展示');
    } finally {
      tagStageMode = 'success';
      cleanup(scope);
    }
  });

  it('onlyRelPaths 非法路径被核心层拒绝并记账；全部非法时 fail-loud（P1-4）', async () => {
    const scope = `aux-sanitize-${Date.now()}`;
    const scope2 = `${scope}-x`;
    registerTestScope(scope);
    registerTestScope(scope2);
    vectorizeMode = 'success';
    tagStageMode = 'success';
    try {
      const src = mkSource({ 'a.md': '# a\n\na 正文', 'b.md': '# b\n\nb 正文' });
      const result = await handleDirectImport({
        scope,
        sourceDir: src,
        group: 'G',
        vector: false,
        onlyRelPaths: ['../evil.md', '/etc/passwd', 'b.md'],
      });

      assert.equal(result.retryFilter?.requested, 1, 'requested 只计净化后的合法路径');
      assert.equal(result.retryFilter?.matched, 1);
      assert.deepEqual(result.retryFilter?.invalid, ['../evil.md', '/etc/passwd'], '非法路径单独记账');
      assert.equal(result.stats.files.total, 1, '只处理清单内的合法文件');
      const kb = JSON.parse(fs.readFileSync(getLocalKbDir(scope, 'G'), 'utf-8')) as Record<string, string>;
      assert.match(kb.b ?? '', /b 正文/);
      assert.equal(kb.a, undefined, '名单外文件不处理');

      await assert.rejects(
        () => handleDirectImport({ scope: scope2, sourceDir: src, group: 'G', vector: false, onlyRelPaths: ['../a.md'] }),
        /全部非法/,
        '全部非法时必须 fail-loud，不得静默退化为处理整批',
      );
    } finally {
      cleanup(scope);
      cleanup(scope2);
    }
  });

  it('未完成清单跨源覆盖前备份为 prev，不静默丢弃上一批（P1-3）', async () => {
    const scope = `aux-cross-${Date.now()}`;
    registerTestScope(scope);
    tagStageMode = 'success';
    clearRelationMapCache();
    try {
      const srcA = mkSource({ 'a1.md': '# a1\n\na1 正文', 'a2.md': '# a2\n\na2 正文' });
      const srcB = mkSource({ 'b1.md': '# b1\n\nb1 正文' });

      // A 批部分成功 → 清单记录源目录 A
      vectorizeMode = 'stop';
      const first = await handleDirectImport({ scope, sourceDir: srcA, group: 'G', vector: true });
      assert.equal(first.partial, true);
      const afterA = readImportIncompleteStatus(scope);
      assert.equal(afterA.record?.sourceDir, srcA);
      assert.equal(afterA.previous, null, '首份清单没有 prev 备份');

      // B 批（另一源目录）全部成功 → 主清单不得被无声删除：备份到 prev
      vectorizeMode = 'success';
      const second = await handleDirectImport({ scope, sourceDir: srcB, group: 'G', vector: true });
      assert.equal(second.partial, false);
      const afterB = readImportIncompleteStatus(scope);
      assert.equal(afterB.record, null, '本批全成功 → 主清单不残留');
      assert.equal(afterB.previous?.sourceDir, srcA, '上一批清单被保留为 prev 备份');
      assert.equal(afterB.previous?.items.length, first.incomplete.length);
      assert.equal(fs.existsSync(getImportIncompletePrevPath(scope)), true);
    } finally {
      vectorizeMode = 'success';
      cleanup(scope);
    }
  });
});
