/**
 * import-vector-rebuild.test.ts —— import 覆盖导入时向量清空重建逻辑验证
 *
 * 契约：
 *   - vector=true 且 scope 已有向量（vectorCountScope > 0）→ 调用 vectorDeleteScope 清空后重建
 *   - vector=true 且 scope 无向量（首次导入）→ 不调用 vectorDeleteScope
 *   - vector=false（--no-vector）→ 不触碰向量层（不调 vectorCountScope / vectorDeleteScope）
 *
 * 策略：patch vector-client 的 vectorCountScope/vectorDeleteScope 与 batch-vectorize 的 bulkVectorize，
 *       验证 handleDirectImport 在三种场景下的调用序列（不依赖真实向量库/embedding）。
 *       文件系统侧走真实临时目录（KB 写入真实发生，与 import-scheme-d 一致）。
 *
 * 运行：npx jiti test/import-vector-rebuild.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

// ─── 被测模块（先 import 以便 patch 导出）───
const vectorClient = await import('../src/lib/vector-client.js');
const batchVectorize = await import('../src/lib/batch-vectorize.js');

// ─── mock 状态 ───
let mockVecCount = 0;
let deleteCalls: { scope: string; onProgress?: (d: number) => void }[] = [];
let vectorizeCalls = 0;

// patch（CJS interop 下消费方按命名空间动态取属性，patch 生效）
(vectorClient as any).vectorCountScope = async (params: { scope: string }) => {
  return mockVecCount;
};
(vectorClient as any).vectorDeleteScope = async (
  params: { scope: string },
  onProgress?: (d: number) => void
) => {
  deleteCalls.push({ ...params, onProgress });
  // 模拟分批删除进度（每批 10 条）
  for (let done = 0; done < mockVecCount; done += 10) {
    onProgress?.(Math.min(done + 10, mockVecCount));
  }
  return { deleted: mockVecCount };
};
(batchVectorize as any).bulkVectorize = async () => {
  vectorizeCalls++;
  const ok = new Map<string, string>();
  ok.set('file.md#1', 'mock-docid-1');
  return { ok, errors: [] };
};

// ─── 动态 import 被测函数（patch 之后再 import，消费方取 patch 后的引用）───
const { handleDirectImport } = await import('../src/lib/import.js');

const scope = `import-vec-rebuild-${Date.now()}`;

function mkSource(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-vr-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

describe('import 覆盖导入：向量清空重建逻辑', () => {
  before(() => {
    registerTestScope(scope);
  });

  after(() => {
    cleanupTestConfig();
  });

  it('vector=true 且已有向量 → 调用 vectorDeleteScope 清空后重建', async () => {
    mockVecCount = 42;
    deleteCalls = [];
    vectorizeCalls = 0;
    const src = mkSource({ 'a.md': '# 测试文档\n\n内容用于向量化验证。' });

    const r = await handleDirectImport({
      scope,
      sourceDir: src,
      rootName: 'TestWiki',
      vector: true,
    });

    assert.equal(r.ok, true);
    assert.equal(deleteCalls.length, 1, '应调用一次 vectorDeleteScope');
    assert.equal(deleteCalls[0].scope, scope);
    assert.equal(typeof deleteCalls[0].onProgress, 'function', '删除阶段应传入进度回调（动态展示）');
    assert.equal(vectorizeCalls, 1, '清空后应重新向量化');
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('vector=true 且无向量（首次导入）→ 不调用 vectorDeleteScope', async () => {
    mockVecCount = 0;
    deleteCalls = [];
    vectorizeCalls = 0;
    const src = mkSource({ 'b.md': '# 另一文档\n\n内容用于验证首次导入不清空。' });

    const r = await handleDirectImport({
      scope,
      sourceDir: src,
      rootName: 'TestWiki',
      vector: true,
    });

    assert.equal(r.ok, true);
    assert.equal(deleteCalls.length, 0, '首次导入不应清空向量');
    assert.equal(vectorizeCalls, 1, '仍应正常向量化');
    fs.rmSync(src, { recursive: true, force: true });
  });

  it('vector=false（--no-vector）→ 不触碰向量层', async () => {
    mockVecCount = 10;
    deleteCalls = [];
    vectorizeCalls = 0;
    const src = mkSource({ 'c.md': '# 纯 KB 文档\n\n--no-vector 模式不应触碰向量。' });

    const r = await handleDirectImport({
      scope,
      sourceDir: src,
      rootName: 'TestWiki',
      vector: false,
    });

    assert.equal(r.ok, true);
    assert.equal(deleteCalls.length, 0, '--no-vector 不应清空向量');
    assert.equal(vectorizeCalls, 0, '--no-vector 不应向量化');
    fs.rmSync(src, { recursive: true, force: true });
  });
});
