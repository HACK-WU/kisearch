/**
 * 语义检索「最近检索」历史去重单测
 *
 * 锁住四条不变量：
 *   1) 同一查询语句的「混合」与「全文」两次检索只留一条，且保留最近一次执行的参数
 *      （修复前身份键含 mode，会留下两条一模一样的 chip —— 本文件名即回归锚点）；
 *   1b) 同一查询语句、同一组标签但勾选顺序不同，同样视为一条（后端 tags 是 OR 集合语义）；
 *   2) 同身份重搜是覆盖而非新增（savedAt 刷新、参数取最新）；
 *   3) 不同 query / 不同标签组各自保留（去重不得误伤）；
 *   4) 老数据（跨模式重复）读取即归一，删除时同身份副本一并清除。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { dedupeSearchHistory, removeSearchHistoryEntry, searchHistoryIdentity, upsertSearchHistory } =
  await vite.ssrLoadModule('/src/lib/searchHistory.ts');
after(async () => vite.close());

const LIMIT = 10;

/** 造一条历史记录，只覆盖关心的字段 */
const entry = (over = {}) => ({
  query: '告警收敛策略是什么',
  mode: 'hybrid',
  selectedTags: [],
  threshold: 0,
  limit: 10,
  savedAt: 1_000,
  ...over,
});

describe('检索历史去重身份', () => {
  it('mode 不参与身份：同 query 的混合 / 全文视为同一条', () => {
    assert.equal(
      searchHistoryIdentity(entry({ mode: 'hybrid' })),
      searchHistoryIdentity(entry({ mode: 'fulltext' })),
    );
  });

  it('标签组参与身份：同 query 不同标签组各自保留', () => {
    assert.notEqual(
      searchHistoryIdentity(entry({ selectedTags: ['ops'] })),
      searchHistoryIdentity(entry({ selectedTags: [] })),
    );
  });

  it('标签顺序归一：同一组标签、不同点击顺序视为同一条（后端 tags 为 OR 集合语义）', () => {
    assert.equal(
      searchHistoryIdentity(entry({ selectedTags: ['ops', 'db'] })),
      searchHistoryIdentity(entry({ selectedTags: ['db', 'ops'] })),
    );
    const next = upsertSearchHistory(
      entry({ selectedTags: ['db', 'ops'], savedAt: 2_000 }),
      [entry({ selectedTags: ['ops', 'db'], savedAt: 1_000 })],
      LIMIT,
    );
    assert.equal(next.length, 1);
    // 归一只用于身份比较，条目里保留用户实际的勾选顺序
    assert.deepEqual(next[0].selectedTags, ['db', 'ops']);
  });
});

describe('写入 upsertSearchHistory', () => {
  it('先混合后全文搜同一句：只剩一条，且保留最近一次执行的模式与参数', () => {
    const previous = [entry({ mode: 'hybrid', savedAt: 1_000, threshold: 0 })];
    const next = upsertSearchHistory(entry({ mode: 'fulltext', savedAt: 2_000, threshold: 0.05 }), previous, LIMIT);
    assert.equal(next.length, 1);
    assert.equal(next[0].mode, 'fulltext');
    assert.equal(next[0].savedAt, 2_000);
    assert.equal(next[0].threshold, 0.05);
  });

  it('同身份重搜：覆盖而非新增，新的排在最前', () => {
    const previous = [entry({ savedAt: 1_000, limit: 5 }), entry({ query: '另一条', savedAt: 900 })];
    const next = upsertSearchHistory(entry({ savedAt: 3_000, limit: 20 }), previous, LIMIT);
    assert.equal(next.length, 2);
    assert.equal(next[0].savedAt, 3_000);
    assert.equal(next[0].limit, 20);
    assert.equal(next[1].query, '另一条');
  });

  it('不同 query / 不同标签组：各自保留，不被误删', () => {
    const previous = [entry({ query: 'A', savedAt: 1_000 }), entry({ query: 'B', savedAt: 900 })];
    assert.equal(upsertSearchHistory(entry({ query: 'C', savedAt: 2_000 }), previous, LIMIT).length, 3);
    const withTag = upsertSearchHistory(entry({ selectedTags: ['ops'], savedAt: 2_000 }), previous, LIMIT);
    assert.equal(withTag.length, 3);
    assert.deepEqual(withTag[0].selectedTags, ['ops']);
  });

  it('超过上限时截断，最旧的被挤出', () => {
    let history = [];
    for (let i = 0; i <= LIMIT; i += 1) {
      history = upsertSearchHistory(entry({ query: `q${i}`, savedAt: 1_000 + i }), history, LIMIT);
    }
    assert.equal(history.length, LIMIT);
    assert.equal(history[0].query, `q${LIMIT}`);
    assert.equal(history.some((item) => item.query === 'q0'), false);
  });
});

describe('读取归一与删除（老数据兼容）', () => {
  const legacy = [
    entry({ mode: 'fulltext', savedAt: 2_000 }),
    entry({ mode: 'hybrid', savedAt: 1_000 }),
    entry({ query: '另一条', savedAt: 900 }),
  ];

  it('老数据读取即归一：同 query 保留最近一条（数组按 savedAt 降序）', () => {
    const deduped = dedupeSearchHistory(legacy);
    assert.equal(deduped.length, 2);
    assert.equal(deduped[0].mode, 'fulltext');
    assert.equal(deduped[1].query, '另一条');
  });

  it('读取归一不修改原数组', () => {
    const snapshot = JSON.stringify(legacy);
    dedupeSearchHistory(legacy);
    assert.equal(JSON.stringify(legacy), snapshot);
  });

  it('删除一条记录时，同身份的遗留副本一并清除', () => {
    const left = removeSearchHistoryEntry(legacy[0], legacy);
    assert.equal(left.length, 1);
    assert.equal(left[0].query, '另一条');
  });
});
