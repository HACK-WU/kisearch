/**
 * 检索页 URL 契约单测
 *
 * 锁住四条不变量：
 *   1) `q` 是唯一必填：缺 q 一律返回 null（不自动检索）；
 *   2) 默认值不写进 URL（hybrid / threshold=0 / limit=10 / 空 tags）—— 链接保持简短，
 *      且往返（searchUrlSearch → parseSearchUrl）结果等价；
 *   3) 非法参数值一律退回默认（脏 URL 不触发莫名查询）；
 *   4) scope 参数不属于检索态：写入时原样保留，state=null 时只留 scope。
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
const { DEFAULT_SEARCH_LIMIT, parseSearchUrl, searchUrlSearch } =
  await vite.ssrLoadModule('/src/lib/searchUrl.ts');
after(async () => vite.close());

describe('parseSearchUrl', () => {
  it('缺 q / 空 q → null（非检索态）', () => {
    assert.equal(parseSearchUrl(''), null);
    assert.equal(parseSearchUrl('scope=kisearch'), null);
    assert.equal(parseSearchUrl('q=%20%20'), null);
  });

  it('q 单独出现 → 其余取默认值', () => {
    assert.deepEqual(parseSearchUrl('q=告警收敛'), {
      query: '告警收敛', mode: 'hybrid', tags: [], threshold: 0, limit: DEFAULT_SEARCH_LIMIT,
    });
  });

  it('完整参数解析（tags 去空去重）', () => {
    assert.deepEqual(parseSearchUrl('q=a&mode=fulltext&tags=x,,y,x&threshold=0.05&limit=20'), {
      query: 'a', mode: 'fulltext', tags: ['x', 'y'], threshold: 0.05, limit: 20,
    });
  });

  it('非法值退回默认（脏 URL 不产生莫名查询）', () => {
    assert.deepEqual(parseSearchUrl('q=a&mode=hyrid&threshold=-1&limit=0'), {
      query: 'a', mode: 'hybrid', tags: [], threshold: 0, limit: DEFAULT_SEARCH_LIMIT,
    });
    assert.equal(parseSearchUrl('q=a&limit=9999999').limit, DEFAULT_SEARCH_LIMIT);
    assert.equal(parseSearchUrl('q=a&limit=2.5').limit, DEFAULT_SEARCH_LIMIT);
  });

  it('scope 参数被忽略（不属于检索态）', () => {
    assert.equal(parseSearchUrl('scope=kisearch&q=a').query, 'a');
  });
});

describe('searchUrlSearch', () => {
  it('默认值不写进 URL，只留 q', () => {
    assert.equal(searchUrlSearch({ query: 'a', mode: 'hybrid', tags: [], threshold: 0, limit: 10 }), 'q=a');
  });

  it('非默认值全部写出', () => {
    assert.equal(
      searchUrlSearch({ query: '告警 收敛', mode: 'fulltext', tags: ['x', 'y'], threshold: 0.05, limit: 20 }),
      'q=%E5%91%8A%E8%AD%A6+%E6%94%B6%E6%95%9B&mode=fulltext&tags=x%2Cy&threshold=0.05&limit=20',
    );
  });

  it('往返等价：写出后再解析得到同一状态', () => {
    const state = { query: 'a b', mode: 'fulltext', tags: ['t1'], threshold: 0.02, limit: 30 };
    assert.deepEqual(parseSearchUrl(searchUrlSearch(state)), state);
    const defaults = { query: 'a b', mode: 'hybrid', tags: [], threshold: 0, limit: 10 };
    assert.deepEqual(parseSearchUrl(searchUrlSearch(defaults)), defaults);
  });

  it('scope 参数原样保留；state=null 时只留 scope', () => {
    const state = { query: 'a', mode: 'hybrid', tags: [], threshold: 0, limit: 10 };
    assert.equal(searchUrlSearch(state, 'kisearch'), 'q=a&scope=kisearch');
    assert.equal(searchUrlSearch(null, 'kisearch'), 'scope=kisearch');
  });

  it('state=null 且无 scope → 空串（清空检索参数）', () => {
    assert.equal(searchUrlSearch(null, null), '');
    assert.equal(searchUrlSearch(null), '');
  });
});
