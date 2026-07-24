/**
 * vector-cli-functions.test.ts —— search/store/bulk-store 纯函数测试
 *
 * 覆盖范围：
 *   - executeSearch（正常搜索 / scope 校验 / 向量不可用 / 空结果 / threshold）
 *   - executeStore（正常存储 / scope 校验 / 向量不可用 / 默认 tags）
 *   - executeBulkStore（正常批量 / 文件不存在 / 非数组 / 空数组 / scope 校验）
 *
 * Mock 策略：mock vector-client 模块的导出函数，测试纯函数的编排逻辑。
 *
 * 运行：npx jiti --test test/vector-cli-functions.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ─── 测试环境 ───

const testConfigPath = path.join(os.tmpdir(), `cli-fn-test-config-${Date.now()}.json`);
const testVectorDir = path.join(os.tmpdir(), `cli-fn-test-vector-${Date.now()}`);
fs.writeFileSync(testConfigPath, JSON.stringify({ vectorDir: testVectorDir }), 'utf-8');
process.env.KI_CONFIG_PATH = testConfigPath;

// ─── Mock vector-client ───
// 由于 executeSearch/executeStore/executeBulkStore 是通过 import vector-client 得到的，
// 我们需要在 import 之前 mock 模块。
// 使用 node:test 的 mock.module（实验性）或手动 mock。

// 用手动方式：先 import 真实模块，再 patch 其导出。
// 但这些是 TS 文件，需 jiti。直接 import 后 patch。

let searchModule: typeof import('../src/search.js');
let storeModule: typeof import('../src/store.js');
let bulkStoreModule: typeof import('../src/bulk-store.js');
let vectorClientModule: typeof import('../src/lib/vector-client.js');

// mock 状态
let mockAvailable = true;
let mockSearchResults: any[] = [];
let mockStoreResult = { docId: 'mock_doc_id_1234567890abcdef' };
let mockBulkResult = { total: 1, succeeded: 1, failed: 0, results: [{ index: 0, memoryId: 'mock_bulk_id', success: true }] };
let mockSearchCalls: any[] = [];
let mockStoreCalls: any[] = [];
let mockBulkCalls: any[] = [];

async function loadModulesWithMock() {
  // 先 import vector-client（会读 KI_CONFIG_PATH）
  vectorClientModule = await import('../src/lib/vector-client.js');

  // Patch vector-client 的导出函数
  // 注意：不能在 import CLI 模块后恢复。jiti/CJS interop 下，CLI 模块在
  // 调用时才从模块命名空间取函数，若恢复则 mock 立即失效（真实引擎被调用）。
  (vectorClientModule as any).ensureVectorAvailable = async () => {
    return mockAvailable
      ? { available: true }
      : { available: false, reason: 'mock: 不可用' };
  };

  (vectorClientModule as any).vectorSearch = async (params: any) => {
    mockSearchCalls.push(params);
    return mockSearchResults;
  };

  (vectorClientModule as any).vectorStore = async (params: any) => {
    mockStoreCalls.push(params);
    return mockStoreResult;
  };

  (vectorClientModule as any).vectorBulkStore = async (params: any) => {
    mockBulkCalls.push(params);
    return mockBulkResult;
  };

  // 现在 import CLI 模块（它们 import vector-client，但已被 patch）
  searchModule = await import('../src/search.js');
  storeModule = await import('../src/store.js');
  bulkStoreModule = await import('../src/bulk-store.js');
}

// ─── 测试 ───

describe('CLI 纯函数 · executeSearch', () => {

  before(async () => {
    fs.mkdirSync(testVectorDir, { recursive: true });
    await loadModulesWithMock();
  });

  after(() => {
    fs.rmSync(testVectorDir, { recursive: true, force: true });
    fs.rmSync(testConfigPath, { force: true });
  });

  it('正常搜索返回 ok + results', async () => {
    mockAvailable = true;
    mockSearchResults = [{ memoryId: 'id1', content: '测试', score: 0.5 }];
    mockSearchCalls = [];

    const r = await searchModule.executeSearch({
      scope: 'test',
      query: '测试查询',
      limit: 5,
      tags: 'ki-search',
    });

    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.results.length, 1);
      assert.equal(r.results[0].memoryId, 'id1');
    }
    // 验证参数传递
    assert.equal(mockSearchCalls.length, 1);
    assert.equal(mockSearchCalls[0].scope, 'test');
    assert.equal(mockSearchCalls[0].query, '测试查询');
    assert.equal(mockSearchCalls[0].limit, 5);
    assert.equal(mockSearchCalls[0].tags, 'ki-search');
  });

  it('非法字符 scope 校验失败返回 ok=false', async () => {
    const r = await searchModule.executeSearch({
      scope: 'bad/scope',  // 含非法字符应校验失败
      query: 'test',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('scope') || r.error.includes('Scope'), `error: ${r.error}`);
    }
  });

  it('default 模式下省略 scope 回退 default', async () => {
    mockAvailable = true;
    mockSearchResults = [];
    mockSearchCalls = [];
    const r = await searchModule.executeSearch({
      scope: '',  // 空 scope 在 default 模式下回退为 default
      query: 'test',
    });
    assert.equal(r.ok, true);
    assert.equal(mockSearchCalls[0].scope, 'default');
  });

  it('向量不可用返回 ok=false + degraded', async () => {
    mockAvailable = false;
    const r = await searchModule.executeSearch({
      scope: 'test',
      query: 'test',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.degraded, true);
      assert.ok(r.error.includes('不可用'));
    }
    mockAvailable = true; // 恢复
  });

  it('默认 tags = ki-search', async () => {
    mockSearchResults = [];
    mockSearchCalls = [];
    await searchModule.executeSearch({
      scope: 'test',
      query: 'test',
    });
    assert.equal(mockSearchCalls[0].tags, 'ki-search');
  });

  it('默认 limit = 10', async () => {
    mockSearchResults = [];
    mockSearchCalls = [];
    await searchModule.executeSearch({
      scope: 'test',
      query: 'test',
    });
    assert.equal(mockSearchCalls[0].limit, 10);
  });

  it('threshold 传递', async () => {
    mockSearchResults = [];
    mockSearchCalls = [];
    await searchModule.executeSearch({
      scope: 'test',
      query: 'test',
      threshold: 0.5,
    });
    assert.equal(mockSearchCalls[0].threshold, 0.5);
  });
});

describe('CLI 纯函数 · executeStore', () => {

  it('正常存储返回 ok + docId', async () => {
    mockAvailable = true;
    mockStoreResult = { docId: 'abc123' };
    mockStoreCalls = [];

    const r = await storeModule.executeStore({
      scope: 'test',
      text: '存储测试',
      tags: 'ki-search',
    });

    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.docId, 'abc123');
    }
    assert.equal(mockStoreCalls.length, 1);
    assert.equal(mockStoreCalls[0].scope, 'test');
    assert.equal(mockStoreCalls[0].text, '存储测试');
    assert.equal(mockStoreCalls[0].tags, 'ki-search');
  });

  it('非法字符 scope 校验失败返回 ok=false', async () => {
    const r = await storeModule.executeStore({
      scope: 'bad/scope',
      text: 'test',
    });
    assert.equal(r.ok, false);
  });

  it('default 模式下省略 scope 回退 default', async () => {
    mockAvailable = true;
    mockStoreResult = { docId: 'def123' };
    mockStoreCalls = [];
    const r = await storeModule.executeStore({
      scope: '',  // 空 scope 在 default 模式下回退为 default
      text: 'test',
    });
    assert.equal(r.ok, true);
    assert.equal(mockStoreCalls[0].scope, 'default');
  });

  it('向量不可用返回 ok=false', async () => {
    mockAvailable = false;
    const r = await storeModule.executeStore({
      scope: 'test',
      text: 'test',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('不可用'));
    }
    mockAvailable = true;
  });

  it('默认 tags = ki-search', async () => {
    mockStoreCalls = [];
    await storeModule.executeStore({
      scope: 'test',
      text: 'test',
    });
    assert.equal(mockStoreCalls[0].tags, 'ki-search');
  });
});

describe('CLI 纯函数 · executeBulkStore', () => {

  let tmpInput: string;

  before(() => {
    tmpInput = path.join(os.tmpdir(), `bulk-test-input-${Date.now()}.json`);
  });

  after(() => {
    fs.rmSync(tmpInput, { force: true });
  });

  it('正常批量存储返回 ok + 统计', async () => {
    mockAvailable = true;
    mockBulkResult = {
      total: 2, succeeded: 2, failed: 0,
      results: [
        { index: 0, memoryId: 'id1', success: true },
        { index: 1, memoryId: 'id2', success: true },
      ],
    };
    mockBulkCalls = [];

    fs.writeFileSync(tmpInput, JSON.stringify([
      { text: '条目1', tags: 'ki-search' },
      { text: '条目2', tags: 'ki-search' },
    ]), 'utf-8');

    const r = await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });

    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.total, 2);
      assert.equal(r.succeeded, 2);
      assert.equal(r.failed, 0);
    }
    // 验证参数
    assert.equal(mockBulkCalls.length, 1);
    assert.equal(mockBulkCalls[0].scope, 'test');
    assert.equal(mockBulkCalls[0].entries.length, 2);
  });

  it('文件不存在返回 ok=false', async () => {
    const r = await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: '/nonexistent/path.json',
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('不存在'));
    }
  });

  it('非 JSON 数组返回 ok=false', async () => {
    fs.writeFileSync(tmpInput, JSON.stringify({ not: 'array' }), 'utf-8');
    const r = await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('数组'));
    }
  });

  it('缺少 text 字段返回 ok=false', async () => {
    fs.writeFileSync(tmpInput, JSON.stringify([{ tags: 'ki-search' }]), 'utf-8');
    const r = await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('text'));
    }
  });

  it('空数组返回 ok + 0 计数', async () => {
    mockBulkResult = { total: 0, succeeded: 0, failed: 0, results: [] };
    fs.writeFileSync(tmpInput, JSON.stringify([]), 'utf-8');
    const r = await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.total, 0);
    }
  });

  it('非法字符 scope 校验失败返回 ok=false', async () => {
    fs.writeFileSync(tmpInput, JSON.stringify([{ text: 'test' }]), 'utf-8');
    const r = await bulkStoreModule.executeBulkStore({
      scope: 'bad/scope',
      inputFile: tmpInput,
    });
    assert.equal(r.ok, false);
  });

  it('default 模式下省略 scope 回退 default', async () => {
    mockAvailable = true;
    mockBulkResult = { total: 1, succeeded: 1, failed: 0, results: [{ index: 0, memoryId: 'id1', success: true }] };
    mockBulkCalls = [];
    fs.writeFileSync(tmpInput, JSON.stringify([{ text: 'test' }]), 'utf-8');
    const r = await bulkStoreModule.executeBulkStore({
      scope: '',  // 空 scope 在 default 模式下回退为 default
      inputFile: tmpInput,
    });
    assert.equal(r.ok, true);
    assert.equal(mockBulkCalls[0].scope, 'default');
  });

  it('向量不可用返回 ok=false', async () => {
    mockAvailable = false;
    fs.writeFileSync(tmpInput, JSON.stringify([{ text: 'test' }]), 'utf-8');
    const r = await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.equal(r.ok, false);
    mockAvailable = true;
  });

  it('默认 tags = ki-search', async () => {
    mockBulkCalls = [];
    fs.writeFileSync(tmpInput, JSON.stringify([{ text: '默认tag' }]), 'utf-8');
    await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.equal(mockBulkCalls[0].entries[0].tags, 'ki-search');
  });

  it('keywords 字符串逗号分隔解析', async () => {
    mockBulkCalls = [];
    fs.writeFileSync(tmpInput, JSON.stringify([
      { text: 'keyword测试', keywords: 'Redis, 缓存, TTL' },
    ]), 'utf-8');
    await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.deepEqual(mockBulkCalls[0].entries[0].keywords, ['Redis', '缓存', 'TTL']);
  });

  it('keywords 数组直接传递', async () => {
    mockBulkCalls = [];
    fs.writeFileSync(tmpInput, JSON.stringify([
      { text: 'keyword数组', keywords: ['A', 'B'] },
    ]), 'utf-8');
    await bulkStoreModule.executeBulkStore({
      scope: 'test',
      inputFile: tmpInput,
    });
    assert.deepEqual(mockBulkCalls[0].entries[0].keywords, ['A', 'B']);
  });
});

// ─── scope 护栏 · strict 模式 ───
//
// 覆盖 resolveScope 在 strict 档下的两条 fail-loud 分支（config.ts）：
//   1. 省略/空 scope   → 抛 "必须显式传入 scope"
//   2. 未注册 scope    → 抛 "unknown scope"
// 以及白名单内 scope 正常放行。
// 通过临时切换 KI_CONFIG_PATH 到 strict 配置 + resetConfigCache，
// 让 loadConfig 重新读取（前序用例已把 loadConfig 缓存为 default 档）。
describe('CLI 纯函数 · scope 护栏 strict 模式', () => {
  const strictConfigPath = path.join(os.tmpdir(), `cli-fn-strict-config-${Date.now()}.json`);
  let prevConfigPath: string | undefined;
  let resetConfigCache: () => void;
  let strictInput: string;

  before(async () => {
    // strict 配置：白名单仅注册 scope "registered"
    fs.writeFileSync(strictConfigPath, JSON.stringify({
      vectorDir: testVectorDir,
      scopeMode: 'strict',
      scopes: { registered: {} },
    }), 'utf-8');
    fs.mkdirSync(testVectorDir, { recursive: true });
    strictInput = path.join(os.tmpdir(), `strict-bulk-input-${Date.now()}.json`);
    fs.writeFileSync(strictInput, JSON.stringify([{ text: 'test' }]), 'utf-8');

    // 切换配置并清缓存，使 loadConfig 重新读取 strict 配置
    prevConfigPath = process.env.KI_CONFIG_PATH;
    process.env.KI_CONFIG_PATH = strictConfigPath;
    ({ resetConfigCache } = await import('../src/lib/config.js'));
    resetConfigCache();
  });

  after(() => {
    // 还原配置，避免污染同进程内其他用例
    if (prevConfigPath === undefined) delete process.env.KI_CONFIG_PATH;
    else process.env.KI_CONFIG_PATH = prevConfigPath;
    resetConfigCache();
    fs.rmSync(strictConfigPath, { force: true });
    fs.rmSync(strictInput, { force: true });
    fs.rmSync(testVectorDir, { recursive: true, force: true });
  });

  it('strict 模式省略 scope → ok=false（必须显式传入）', async () => {
    const r = await searchModule.executeSearch({ scope: '', query: 'test' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(
        r.error.includes('必须显式传入') || r.error.includes('strict'),
        `error: ${r.error}`
      );
    }
  });

  it('strict 模式未注册 scope → ok=false（unknown scope）', async () => {
    const r = await searchModule.executeSearch({ scope: 'unregistered', query: 'test' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('unknown scope'), `error: ${r.error}`);
    }
  });

  it('strict 模式白名单 scope → 正常放行', async () => {
    mockAvailable = true;
    mockSearchResults = [];
    mockSearchCalls = [];
    const r = await searchModule.executeSearch({ scope: 'registered', query: 'test' });
    assert.equal(r.ok, true);
    assert.equal(mockSearchCalls[0].scope, 'registered');
  });

  it('strict 护栏对 executeStore 生效（未注册 scope → ok=false）', async () => {
    const r = await storeModule.executeStore({ scope: 'unregistered', text: 'test' });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(r.error.includes('unknown scope'), `error: ${r.error}`);
    }
  });

  it('strict 护栏对 executeBulkStore 生效（省略 scope → ok=false）', async () => {
    const r = await bulkStoreModule.executeBulkStore({ scope: '', inputFile: strictInput });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.ok(
        r.error.includes('必须显式传入') || r.error.includes('strict'),
        `error: ${r.error}`
      );
    }
  });
});
