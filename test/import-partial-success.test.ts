/**
 * import-partial-success.test.ts —— R1：系统性向量故障下的「文件级部分成功」契约
 * （REQ-20261009-001；用户拍板 Q1 文件级完成 / Q2 CLI-Web 同口径 / D1 删向量 / D2 取消统一）
 *
 * 契约：
 *   1. 成功单元 = **文件**：任一 chunk 未成功 → 该文件不算完成、不写元数据（守 #1/#4）；
 *   2. 系统性停止**不再全批回滚**：文件级已完成的部分提交并可用（元数据 + 原文 + 向量）；
 *   3. 未完成文件新写入的向量被回滚删除（D1），不产生孤儿向量；
 *   4. 零完成仍是失败（不把"全失败"当成功）；
 *   5. 取消与系统停止走同一条提交语义（D2）：已完成部分提交，并标记 cancelled。
 *
 * 可用性判据（R1 的用户可见口径）用三个数据源代理：
 *   - 元数据聚合 `readAllGroupCaches`（= `/api/doc/list` 的同一数据源，见 mcp-http-api.ts:321）；
 *   - `getRelationMap`（= `ki search` 命中后反查 group/relation 定位）；
 *   - `executeQueryGroup`（= `ki query-group`）。
 *
 * 运行：npx jiti test/import-partial-success.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { readAllGroupCaches, loadCacheShape } from '../src/lib/group-cache.js';
import { clearRelationMapCache, getRelationMap } from '../src/lib/relation-map.js';

const vectorClient = await import('../src/lib/vector-client.js');
const batchVectorize = await import('../src/lib/batch-vectorize.js');
const pathVectorize = await import('../src/lib/path-vectorize.js');
const { handleDirectImport } = await import('../src/lib/import.js');
const { executeQueryGroup } = await import('../src/query-group.js');

type Entry = { path: string };

/** mock 模式：entries[0] 成功、其余报错并给出系统性停止原因（模拟 embedding 中途不可用） */
let vectorizeMode: 'stop' | 'all-fail' | 'cancel-mid' | 'half' = 'stop';
let abortRef: AbortController | null = null;
let vectorDeleteCalls: string[][] = [];

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-partial-success-'));

(vectorClient as any).vectorDelete = async (params: { ids: string[] }) => {
  vectorDeleteCalls.push([...params.ids]);
  return vectorClient.normalizeVectorDeleteResult(params.ids, { ok: params.ids.length, failed: 0, errors: [] });
};
(vectorClient as any).vectorDeleteScope = async () => {
  throw new Error('不得调用 Scope 级向量清空接口');
};
(vectorClient as any).vectorBulkStore = async (params: { scope: string; entries: { text: string; tags?: string }[] }) => ({
  results: params.entries.map((entry, index) => ({
    index,
    success: true,
    memoryId: entry.tags === 'ki-relation' || entry.tags === 'ki-path'
      ? vectorClient.generateDocId(entry.text, params.scope, entry.tags)
      : `mock-${entry.tags ?? 'untagged'}-${params.scope}-${index}`,
  })),
});
(batchVectorize as any).bulkVectorize = async (entries: Entry[]) => {
  if (vectorizeMode === 'all-fail') {
    return { ok: new Map<string, string>(), errors: entries.map((entry) => ({ path: entry.path, error: 'mock provider down' })), notProcessed: 0, stopReason: { kind: 'provider-unavailable', code: 'HTTP_503', phase: 'embedding', reason: 'mock provider down' } };
  }
  if (vectorizeMode === 'half') {
    // D1 场景：**同一文件的部分 chunk 已成功写入**（ok 里有 id），其余 chunk 报错 →
    // 该文件判定未完成，已写入的向量必须被回滚删除
    const ok = new Map<string, string>();
    const errors: { path: string; error: string }[] = [];
    let bChunk = 0;
    let aChunk = 0;
    for (const entry of entries) {
      if (entry.path.startsWith('b.md')) {
        if (bChunk === 0) ok.set(entry.path, 'half-ok-b-1');
        else errors.push({ path: entry.path, error: 'mock provider failure' });
        bChunk += 1;
        continue;
      }
      if (entry.path.startsWith('a.md')) {
        ok.set(entry.path, aChunk === 0 ? 'ok-first-id' : `ok-a-${aChunk}`);
        aChunk += 1;
      }
    }
    return {
      ok,
      errors,
      notProcessed: 0,
      stopReason: { kind: 'provider-unavailable', code: 'HTTP_503', phase: 'embedding', reason: 'mock provider failure' },
    };
  }
  if (vectorizeMode === 'cancel-mid') {
    // 取消场景：首个文件已写入，随后用户取消（无 stopReason，只有 notProcessed）
    const ok = new Map<string, string>();
    if (entries[0]) ok.set(entries[0].path, 'ok-first-id');
    abortRef?.abort();
    return { ok, errors: [], notProcessed: Math.max(0, entries.length - 1) };
  }
  // stop：仅 entries[0] 成功，其余报错并带系统性停止原因
  const ok = new Map<string, string>();
  if (entries[0]) ok.set(entries[0].path, 'ok-first-id');
  return {
    ok,
    errors: entries.slice(1).map((entry) => ({ path: entry.path, error: 'mock systemic failure' })),
    notProcessed: Math.max(0, entries.length - 2),
    stopReason: { kind: 'provider-unavailable', code: 'HTTP_503', phase: 'embedding', reason: 'mock embedding unavailable' },
  };
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

describe('R1：系统性向量故障下的文件级部分成功', () => {
  it('已完成文件提交并可用（元数据/原文/向量），未完成文件回滚且不写元数据', async () => {
    const scope = `partial-${Date.now()}`;
    registerTestScope(scope);
    vectorizeMode = 'stop';
    vectorDeleteCalls = [];
    clearRelationMapCache();
    try {
      const src = mkSource({
        'a.md': '# a\n\na 的正文（会被向量化成功）',
        'b.md': '# b\n\nb 的正文（provider 失败）',
        'c.md': '# c\n\nc 的正文（未处理）',
      });
      const result = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true });

      // ① 结果口径（CLI/Web 同源）
      assert.equal(result.ok, true);
      assert.equal(result.partial, true, '部分成功必须显式标记');
      assert.equal(result.stopReason?.code, 'HTTP_503');
      assert.deepEqual(result.stats.files, { total: 3, completed: 1, incomplete: 2, scanned: 3, skipped: 0 }, '完成 1 / 未完成 2（文件级）');
      assert.deepEqual(result.incomplete.map((i) => i.path).sort(), ['b.md', 'c.md'], '未完成清单只含未完成文件');

      // ② 元数据（= /api/doc/list 数据源，`mcp-http-api.buildDocList` 直接投影该分片）：
      // 只有 a 可见；未完成文件不得出现在文档列表
      const groups = readAllGroupCaches(scope);
      const texts = (groups.get('G')?.hot_relations ?? []).map((r) => r.text).sort();
      assert.deepEqual(texts, ['a'], '仅已完成文件写入元数据（守 #1）');
      assert.deepEqual(
        [...groups.keys()].sort(),
        ['G'],
        '元数据只含被提交的文件所属组（未完成文件不产生任何组条目）',
      );

      // ③ 原文：a 保留，b/c 清理
      const kb = JSON.parse(fs.readFileSync(getLocalKbDir(scope, 'G'), 'utf-8')) as Record<string, string>;
      assert.match(kb.a ?? '', /向量化成功/);
      assert.equal(kb.b, undefined, '未完成文件原文被清理');
      assert.equal(kb.c, undefined, '未处理文件原文被清理');

      // ④ 可用性三件套：query-group / 元数据 / search 反查定位
      const q = await executeQueryGroup({ scope, groupsParam: 'G', hotCount: 5, depth: 1, modes: ['hot'], autoFallback: false } as never);
      assert.equal(q.ok, true);
      assert.ok(q.ok && q.output.includes('a'), 'query-group 应能看到已完成文件');

      const map = getRelationMap(scope);
      const hit = map.get('ok-first-id');
      assert.equal(hit?.group, 'G', 'ki search 命中后应能反查 group');
      assert.equal(hit?.relation, 'a', 'ki search 命中后应能反查 relation');

      // ⑤ D1：已完成文件的向量不得被回滚删除；未完成文件必须**搜不到**（无孤儿向量）。
      // 本场景（系统停止）未完成文件从未写入成功 → 删除清单为空是正确的；
      // 「已写入部分 chunk 的向量必须被删」由下一条用例直证。
      assert.equal(vectorDeleteCalls.flat().includes('ok-first-id'), false, '已完成文件的向量必须保留');
      assert.equal(
        [...map.values()].every((entry) => entry.relation === 'a'),
        true,
        '未完成文件不得出现在检索映射里（否则就是搜得到、点不开的孤儿向量）',
      );
    } finally {
      cleanup(scope);
    }
  });

  it('未完成文件的「部分 chunk 已写入」向量被回滚删除（D1：不留孤儿）', async () => {
    // 与上一条的区别：这次失败文件**有一个 chunk 的向量已写入成功**（`ok` 里有它的 id）——
    // 必须被回滚删除，否则会留下"全文/关系搜得到、文档列表点不开"的孤儿向量。
    const scope = `partial-orphan-${Date.now()}`;
    registerTestScope(scope);
    vectorizeMode = 'half';
    vectorDeleteCalls = [];
    clearRelationMapCache();
    try {
      // b 需要 ≥2 个 chunk 才能构造"部分 chunk 已写入"：内容加长 + chunkSize 调小
      const src = mkSource({ 'a.md': '# a\n\na 成功', 'b.md': `# b\n\n${'半成品正文。'.repeat(40)}` });
      const result = await handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true, chunkSize: 60 });

      assert.equal(result.partial, true);
      assert.deepEqual(result.incomplete.map((i) => i.path), ['b.md'], 'b 为未完成文件');
      const deletedIds = vectorDeleteCalls.flat();
      assert.ok(
        deletedIds.some((id) => id.startsWith('half-ok-b-')),
        `b 已成功写入的那部分 chunk 向量必须被回滚删除（实际删除：${JSON.stringify(deletedIds)}）`,
      );
      assert.equal(
        vectorDeleteCalls.flat().includes('ok-first-id'),
        false,
        'a 的向量不得被连带删除',
      );
      const map = getRelationMap(scope);
      assert.equal(
        [...map.values()].some((entry) => entry.relation === 'b'),
        false,
        '未完成文件不得可检索（无孤儿向量）',
      );
      assert.equal(
        [...map.values()].some((entry) => entry.relation === 'a'),
        true,
        '已完成文件仍可检索',
      );
    } finally {
      cleanup(scope);
    }
  });

  it('零完成仍是失败：不得把"全批未完成"当成功提交', async () => {
    const scope = `partial-zero-${Date.now()}`;
    registerTestScope(scope);
    vectorizeMode = 'all-fail';
    try {
      const src = mkSource({ 'a.md': '# a\n\n正文', 'b.md': '# b\n\n正文' });
      await assert.rejects(
        () => handleDirectImport({ scope, sourceDir: src, group: 'G', vector: true }),
        /均未完成向量化/,
        '零完成必须 fail-loud',
      );
      const groups = readAllGroupCaches(scope);
      assert.equal((groups.get('G')?.hot_relations ?? []).length, 0, '零完成不得写入任何元数据');
      const cache = loadCacheShape(scope);
      assert.equal(Object.keys(cache.groups).length, 0, 'scope 元数据保持为空');
    } finally {
      cleanup(scope);
    }
  });

  it('取消（D2）与系统停止同一条提交语义：已完成部分提交并标记 cancelled', async () => {
    const scope = `partial-cancel-${Date.now()}`;
    registerTestScope(scope);
    vectorizeMode = 'cancel-mid';
    abortRef = new AbortController();
    clearRelationMapCache();
    try {
      const src = mkSource({ 'a.md': '# a\n\na 已完成', 'b.md': '# b\n\nb 未处理', 'c.md': '# c\n\nc 未处理' });
      const result = await handleDirectImport({
        scope, sourceDir: src, group: 'G', vector: true, abortSignal: abortRef.signal,
      } as never);

      assert.equal(result.ok, true, '取消不再以异常收场（已完成部分已提交）');
      assert.equal(result.cancelled, true, '必须标记 cancelled');
      assert.equal(result.partial, true);
      assert.deepEqual(result.stats.files, { total: 3, completed: 1, incomplete: 2, scanned: 3, skipped: 0 });
      const groups = readAllGroupCaches(scope);
      assert.deepEqual((groups.get('G')?.hot_relations ?? []).map((r) => r.text), ['a'], '取消后已完成文件仍可用');
      const map = getRelationMap(scope);
      assert.equal(map.get('ok-first-id')?.relation, 'a', '取消后已完成文件可被检索定位');
    } finally {
      abortRef = null;
      cleanup(scope);
    }
  });
});
