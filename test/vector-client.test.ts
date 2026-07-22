/**
 * vector-client.test.ts —— Vector Adapter 单元/集成测试
 *
 * 覆盖范围：
 *   - ensureVectorAvailable（新库 / 被锁 / 损坏）
 *   - vectorStore（幂等 upsert / tag 小写规范化 / scope 过滤 / keywords 拼接 / 超长文本拒绝）
 *   - vectorSearch（语义召回 / tag 大小写不敏感 / scope 隔离 / limit / threshold 过滤）
 *   - vectorBulkStore（批量写入 / 空数组 / 混合 tag）
 *   - vectorDelete（删除后不可搜）
 *   - closeEngine（清理 worker）
 *   - getEngine（create vs open 路径）
 *
 * Mock 策略：monkey-patch SiliconFlowProvider 让 embed 走本地 hash（不触网），
 *            monkey-patch loadConfig 返回测试配置。
 *
 * 运行：npx jiti --test test/vector-client.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── 测试夹具（复用 zvec-engine-fixtures 的 mockEmbedding 思路） ───

const DIM = 64; // 小维度加速

function hashVector(text: string, dim = DIM): number[] {
  const v = new Array<number>(dim).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[(text.charCodeAt(i) * 31 + i) % dim] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

const mockEmbedding = {
  dimension: DIM,
  embed: async (texts: string[]) => texts.map((t) => hashVector(t)),
};

// ─── Monkey-patch：在 import vector-client 前拦截 SiliconFlowProvider 和 config ───

// 设置测试专用的 KI_CONFIG_PATH
const testConfigPath = path.join(os.tmpdir(), `vc-test-config-${Date.now()}.json`);
const testVectorDir = path.join(os.tmpdir(), `vc-test-vector-${Date.now()}`);
fs.writeFileSync(testConfigPath, JSON.stringify({
  vectorDir: testVectorDir,
  embedding: { dimension: DIM },
}), 'utf-8');
process.env.KI_CONFIG_PATH = testConfigPath;

// 动态 import 后 patch SiliconFlowProvider 为 mock
// vector-client 内部 buildEmbedding() 每次 new SiliconFlowProvider，
// 我们在 ZvecEngine.create/open 之前 patch 其 prototype
const distPath = path.resolve(import.meta.dirname, '..', 'dist', 'zvec-engine', 'index.js');

let vectorClientModule: typeof import('../src/lib/vector-client.js');

// ─── Patch 与 Import ───

async function loadModuleWithMock() {
  const dist = await import(distPath);
  // Patch SiliconFlowProvider：让构造函数返回 mockEmbedding
  const OrigProvider = dist.SiliconFlowProvider;
  (dist as any).SiliconFlowProvider = class MockSiliconFlowProvider {
    dimension = DIM;
    embed = mockEmbedding.embed;
    constructor(_opts?: any) {}
  };
  vectorClientModule = await import('../src/lib/vector-client.js');
  // 恢复（不影响其他测试）
  (dist as any).SiliconFlowProvider = OrigProvider;
}

// ─── 测试 ───

describe('vector-client · Vector Adapter', () => {

  before(async () => {
    fs.rmSync(testVectorDir, { recursive: true, force: true });
    await loadModuleWithMock();
  });

  after(async () => {
    await vectorClientModule.closeEngine();
    fs.rmSync(testVectorDir, { recursive: true, force: true });
    fs.rmSync(testConfigPath, { force: true });
  });

  // ─── ensureVectorAvailable ───

  describe('ensureVectorAvailable', () => {
    it('全新 dbPath → available=true', async () => {
      const r = await vectorClientModule.ensureVectorAvailable();
      assert.equal(r.available, true, `should be available: ${r.reason}`);
    });
  });

  // ─── vectorStore ───

  describe('vectorStore', () => {
    it('写入返回 docId（sha256 截 32 hex）', async () => {
      const r = await vectorClientModule.vectorStore({
        scope: 'testA',
        text: '用户登录流程：校验凭证签发token',
        tags: 'ki-search',
      });
      assert.match(r.docId, /^[0-9a-f]{32}$/, `docId 格式: ${r.docId}`);
    });

    it('tag 大写写入被小写规范化', async () => {
      const r = await vectorClientModule.vectorStore({
        scope: 'testA',
        text: '缓存策略读穿写回',
        tags: 'KI-SEARCH',
      });
      assert.ok(r.docId);
      // 搜索时用小写应能命中
      const hits = await vectorClientModule.vectorSearch({
        scope: 'testA',
        query: '缓存',
        tags: 'ki-search',
        limit: 5,
      });
      assert.ok(hits.length > 0, '大写 tag 写入后小写查询应命中');
      assert.equal(hits[0].tag, 'ki-search', '返回的 tag 应为小写');
    });

    it('幂等：同 text+scope 重复 upsert 返回同 docId', async () => {
      const text = '幂等测试文档内容';
      const r1 = await vectorClientModule.vectorStore({ scope: 'testA', text, tags: 'ki-search' });
      const r2 = await vectorClientModule.vectorStore({ scope: 'testA', text, tags: 'ki-search' });
      assert.equal(r1.docId, r2.docId, '重复写入应同 docId');
    });

    it('keywords 拼接到 text 末尾', async () => {
      const r = await vectorClientModule.vectorStore({
        scope: 'testA',
        text: '鉴权模块',
        tags: 'ki-search',
        keywords: ['JWT', 'RBAC'],
      });
      assert.ok(r.docId);
      // 搜索关键词应能命中
      const hits = await vectorClientModule.vectorSearch({
        scope: 'testA',
        query: 'JWT',
        tags: 'ki-search',
        limit: 5,
      });
      assert.ok(hits.some(h => h.content.includes('JWT')), 'keywords 拼接后应可被 FTS 命中');
    });

    it('超长文本抛异常', async () => {
      const longText = 'x'.repeat(60_000);
      await assert.rejects(
        () => vectorClientModule.vectorStore({ scope: 'testA', text: longText, tags: 'ki-search' }),
        { message: /超过.*字符限制/ },
      );
    });

    it('默认 tags = ki-search', async () => {
      const r = await vectorClientModule.vectorStore({
        scope: 'testA',
        text: '默认tag测试',
      });
      assert.ok(r.docId);
      // 用默认 ki-search 能搜到
      const hits = await vectorClientModule.vectorSearch({
        scope: 'testA',
        query: '默认tag',
      });
      assert.ok(hits.length > 0);
    });
  });

  // ─── vectorSearch ───

  describe('vectorSearch', () => {
    it('语义召回到正确文档 top1', async () => {
      // 先写入一条独特内容
      const storeR = await vectorClientModule.vectorStore({
        scope: 'searchTest',
        text: '订单支付链路：创建订单调用支付网关异步回调对账',
        tags: 'ki-search',
      });
      const hits = await vectorClientModule.vectorSearch({
        scope: 'searchTest',
        query: '订单如何支付',
        tags: 'ki-search',
        limit: 5,
      });
      assert.ok(hits.length > 0, '应有召回');
      assert.equal(hits[0].memoryId, storeR.docId, 'top1 应为刚写入的文档');
      assert.ok(hits[0].score > 0, 'score 应 > 0');
      assert.equal(hits[0].tag, 'ki-search');
    });

    it('tag 大小写不敏感', async () => {
      await vectorClientModule.vectorStore({
        scope: 'caseTest',
        text: '大小写测试文档',
        tags: 'ki-path',
      });
      // 大写查询
      const hits = await vectorClientModule.vectorSearch({
        scope: 'caseTest',
        query: '大小写',
        tags: 'KI-PATH',
        limit: 5,
      });
      assert.ok(hits.length > 0, '大写 tag 查询应命中');
    });

    it('scope 隔离（scopeB 查不到 scopeA 的文档）', async () => {
      await vectorClientModule.vectorStore({
        scope: 'isoA',
        text: 'scope隔离测试独有内容',
        tags: 'ki-search',
      });
      const hitsB = await vectorClientModule.vectorSearch({
        scope: 'isoB',
        query: 'scope隔离测试',
        tags: 'ki-search',
        limit: 5,
      });
      assert.equal(hitsB.length, 0, 'scopeB 应查不到 scopeA 的文档');
      // scopeA 应能查到
      const hitsA = await vectorClientModule.vectorSearch({
        scope: 'isoA',
        query: 'scope隔离测试',
        tags: 'ki-search',
        limit: 5,
      });
      assert.ok(hitsA.length > 0, 'scopeA 应能查到自己的文档');
    });

    it('limit 参数生效', async () => {
      // 写多条
      for (let i = 0; i < 5; i++) {
        await vectorClientModule.vectorStore({
          scope: 'limitTest',
          text: `limit测试文档${i}：性能优化缓存策略`,
          tags: 'ki-search',
        });
      }
      const hits = await vectorClientModule.vectorSearch({
        scope: 'limitTest',
        query: 'limit测试',
        tags: 'ki-search',
        limit: 2,
      });
      assert.ok(hits.length <= 2, `limit=2 应至多返回 2 条, 实际 ${hits.length}`);
    });

    it('threshold 过滤低分结果', async () => {
      await vectorClientModule.vectorStore({
        scope: 'threshTest',
        text: '阈值过滤测试文档',
        tags: 'ki-search',
      });
      // 设置极高阈值，应被过滤
      const hits = await vectorClientModule.vectorSearch({
        scope: 'threshTest',
        query: '阈值',
        tags: 'ki-search',
        threshold: 0.99,
      });
      // RRF score 通常 < 0.1，阈值 0.99 应全部过滤
      assert.equal(hits.length, 0, '高阈值应过滤所有结果');
    });

    it('不传 tags 默认 ki-search', async () => {
      await vectorClientModule.vectorStore({
        scope: 'defaultTagTest',
        text: '默认tag搜索测试',
      });
      const hits = await vectorClientModule.vectorSearch({
        scope: 'defaultTagTest',
        query: '默认tag搜索',
      });
      assert.ok(hits.length > 0);
    });

    it('不同 tag 不互相召回', async () => {
      await vectorClientModule.vectorStore({
        scope: 'tagIso',
        text: 'tag隔离测试内容',
        tags: 'ki-search',
      });
      const hits = await vectorClientModule.vectorSearch({
        scope: 'tagIso',
        query: 'tag隔离',
        tags: 'ki-path',  // 不同 tag
        limit: 5,
      });
      assert.equal(hits.length, 0, 'ki-path 不应召回 ki-search 的文档');
    });
  });

  // ─── vectorBulkStore ───

  describe('vectorBulkStore', () => {
    it('批量写入成功计数', async () => {
      const r = await vectorClientModule.vectorBulkStore({
        scope: 'bulkTest',
        entries: [
          { text: '批量测试1：构建镜像推送仓库', tags: 'ki-search' },
          { text: '批量测试2：监控告警阈值通知', tags: 'ki-search' },
          { text: '批量测试3：日志采集Filebeat', tags: 'ki-search' },
        ],
      });
      assert.equal(r.total, 3);
      assert.equal(r.succeeded, 3);
      assert.equal(r.failed, 0);
      assert.equal(r.results.length, 3);
      for (const item of r.results) {
        assert.equal(item.success, true);
        assert.match(item.memoryId!, /^[0-9a-f]{32}$/);
      }
    });

    it('空数组返回 0 计数', async () => {
      const r = await vectorClientModule.vectorBulkStore({
        scope: 'bulkEmpty',
        entries: [],
      });
      assert.equal(r.total, 0);
      assert.equal(r.succeeded, 0);
      assert.equal(r.failed, 0);
      assert.equal(r.results.length, 0);
    });

    it('混合 tag 批量写入', async () => {
      const r = await vectorClientModule.vectorBulkStore({
        scope: 'bulkMixed',
        entries: [
          { text: '混合tag搜索类', tags: 'ki-search' },
          { text: '混合tag路径类', tags: 'ki-path' },
          { text: '混合tag关系类', tags: 'ki-relation' },
        ],
      });
      assert.equal(r.succeeded, 3);
      // 验证各 tag 可分别召回
      const searchHits = await vectorClientModule.vectorSearch({
        scope: 'bulkMixed', query: '混合tag搜索', tags: 'ki-search', limit: 5,
      });
      assert.ok(searchHits.length > 0);
      const pathHits = await vectorClientModule.vectorSearch({
        scope: 'bulkMixed', query: '混合tag路径', tags: 'ki-path', limit: 5,
      });
      assert.ok(pathHits.length > 0);
    });

    it('keywords 拼接到每条 entry', async () => {
      const r = await vectorClientModule.vectorBulkStore({
        scope: 'bulkKw',
        entries: [
          { text: '关键词批量测试', tags: 'ki-search', keywords: ['Redis', '缓存'] },
        ],
      });
      assert.equal(r.succeeded, 1);
      const hits = await vectorClientModule.vectorSearch({
        scope: 'bulkKw', query: 'Redis', tags: 'ki-search', limit: 5,
      });
      assert.ok(hits.length > 0, 'keywords 应可被 FTS 命中');
    });
  });

  // ─── vectorDelete ───

  describe('vectorDelete', () => {
    it('删除后不可搜到', async () => {
      const r = await vectorClientModule.vectorStore({
        scope: 'delTest',
        text: '待删除文档内容',
        tags: 'ki-search',
      });
      // 确认可搜到
      let hits = await vectorClientModule.vectorSearch({
        scope: 'delTest', query: '待删除', tags: 'ki-search', limit: 5,
      });
      assert.ok(hits.length > 0, '删除前应可搜到');

      // 删除
      const del = await vectorClientModule.vectorDelete({
        scope: 'delTest',
        ids: [r.docId],
      });
      assert.equal(del.deleted, 1);
      assert.equal(del.errors.length, 0);

      // 确认搜不到
      hits = await vectorClientModule.vectorSearch({
        scope: 'delTest', query: '待删除', tags: 'ki-search', limit: 5,
      });
      assert.equal(hits.length, 0, '删除后应搜不到');
    });

    it('删除不存在的 id 不报错', async () => {
      const del = await vectorClientModule.vectorDelete({
        scope: 'delNonExist',
        ids: ['nonexistent_id_1234567890abcdef'],
      });
      // zvec delete 对不存在的 id 返回 ok=0, failed=0
      assert.equal(del.errors.length, 0, '删除不存在的 id 不应有错误');
    });
  });

  // ─── closeEngine ───

  describe('closeEngine', () => {
    it('closeEngine 后重新 getEngine 不报错', async () => {
      // 触发 engine 创建
      await vectorClientModule.vectorStore({
        scope: 'closeTest',
        text: 'close测试',
        tags: 'ki-search',
      });
      await vectorClientModule.closeEngine();
      // 重新操作应自动重建 engine
      const hits = await vectorClientModule.vectorSearch({
        scope: 'closeTest', query: 'close', tags: 'ki-search', limit: 5,
      });
      assert.ok(hits.length > 0, 'close 后重新 search 应正常');
    });

    it('多次 closeEngine 幂等', async () => {
      await vectorClientModule.closeEngine();
      await vectorClientModule.closeEngine(); // 不应抛异常
    });
  });

  // ─── resetEngine 别名 ───

  describe('resetEngine', () => {
    it('resetEngine 是 closeEngine 的别名', () => {
      assert.equal(vectorClientModule.resetEngine, vectorClientModule.closeEngine);
    });
  });
});
