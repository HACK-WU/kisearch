/**
 * 浏览页筛选条件（前端投影）单测
 *
 * 锁住四条不变量：
 *  1) `tags` 走**重复参数**（tag 名可能含逗号，不能拼逗号串）；
 *  2) 只在有筛选时才带 `sort=recent`（无筛选时保持既有顺序，不能顺手改口径）；
 *  3) 缓存键对 tags 顺序不敏感（否则同一组条件会分裂成两套缓存）；
 *  4) 老数据（无 createdAt）判为「更新」，不得冒充「新增」。
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
const {
  EMPTY_FILTERS,
  docChangeKind,
  docLatestTime,
  filterCount,
  filterKey,
  isFilterEmpty,
  sumUndated,
  toDocListParams,
} = await vite.ssrLoadModule('/src/lib/browseFilters.ts');
after(async () => vite.close());

describe('toDocListParams', () => {
  it('空条件 → 空参数（不带 sort，不改变既有顺序）', () => {
    assert.deepEqual(toDocListParams(EMPTY_FILTERS), {});
    assert.equal(isFilterEmpty(EMPTY_FILTERS), true);
  });

  it('tags 以数组交给调用方（由 httpApi 展开成重复参数）', () => {
    const p = toDocListParams({ tags: ['ui', 'api'] });
    assert.deepEqual(p.tags, ['ui', 'api']);
    assert.equal(p.sort, 'recent');
  });

  it('since / event 透传；检索词与筛选可共存', () => {
    const p = toDocListParams({ since: '24h', tags: [], event: 'none' }, { q: 'auth' });
    assert.equal(p.since, '24h');
    assert.equal(p.event, 'none');
    assert.equal(p.q, 'auth');
    assert.equal(p.sort, 'recent');
  });
});

describe('filterKey / filterCount', () => {
  it('缓存键对 tags 顺序不敏感', () => {
    assert.equal(filterKey({ tags: ['b', 'a'] }), filterKey({ tags: ['a', 'b'] }));
  });

  it('条件计数按"维度"而不是"标签个数"', () => {
    assert.equal(filterCount({ tags: ['a', 'b', 'c'] }), 1);
    assert.equal(filterCount({ since: '6h', tags: ['a'], event: 'evt_1' }), 3);
  });
});

describe('undatedExcluded 汇总', () => {
  it('单库取顶层；视图累加各桶', () => {
    assert.equal(sumUndated({ undatedExcluded: 196 }), 196);
    assert.equal(sumUndated({ buckets: [{ undatedExcluded: 40 }, { undatedExcluded: 2 }, {}] }), 42);
    assert.equal(sumUndated(undefined), 0);
  });
});

describe('新增 / 更新判定', () => {
  it('createdAt 与 updatedAt 接近 → 新增', () => {
    assert.equal(docChangeKind({ createdAt: 1000, updatedAt: 1000 }), 'new');
  });

  it('时间差较大 → 更新', () => {
    assert.equal(docChangeKind({ createdAt: 0, updatedAt: 10 * 60_000 }), 'updated');
  });

  it('老数据缺 createdAt → 更新（不得冒充新增）', () => {
    assert.equal(docChangeKind({ updatedAt: 1000 }), 'updated');
    assert.equal(docChangeKind({}), 'updated');
  });

  it('取两者较新作为展示时间', () => {
    assert.equal(docLatestTime({ createdAt: 1, updatedAt: 9 }), 9);
    assert.equal(docLatestTime({ createdAt: 5 }), 5);
    assert.equal(docLatestTime({}), undefined);
  });
});
