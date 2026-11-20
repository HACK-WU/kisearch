/**
 * doc-filters.test.ts —— `/api/doc/list` 过滤参数（REQ-20261120-001）
 *
 * 锁住四条不变量：
 *  1) `since` 只认枚举，非法值必须抛错（handler 转 400），**不得静默按"不过滤"**；
 *  2) `tags` 用重复参数（`?tags=a&tags=b`）为主，逗号串与旧的 `tag` 参数仍兼容；
 *  3) 缺时间字段的文档**一律不命中** `since`（老数据不臆造时间）；
 *  4) `sort=recent` 的排序把无时间的文档排在最后，且同时间按 group+name 稳定。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/doc-filters.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BadFilterError,
  hasDocTime,
  matchEvent,
  matchSince,
  matchTags,
  parseDocFilters,
  sortByRecent,
} from '../src/lib/doc-filters.js';

const NOW = 1_800_000_000_000;
const url = (qs: string): URL => new URL(`http://local/api/doc/list?${qs}`);

describe('parseDocFilters', () => {
  it('since / 重复 tags / event / sort 全量解析', () => {
    const f = parseDocFilters(url('scope=s&since=6h&tags=a&tags=b&event=evt_1&sort=recent'), NOW);
    assert.equal(f.since?.key, '6h');
    assert.equal(f.since?.fromMs, NOW - 6 * 3600_000);
    assert.deepEqual(f.tags, ['a', 'b']);
    assert.equal(f.event, 'evt_1');
    assert.equal(f.sort, 'recent');
  });

  it('兼容逗号串与旧的单 tag 参数（去重 + 小写归一）', () => {
    assert.deepEqual(parseDocFilters(url('tags=A,b'), NOW).tags, ['a', 'b']);
    assert.deepEqual(parseDocFilters(url('tag=UI'), NOW).tags, ['ui']);
    assert.deepEqual(parseDocFilters(url('tag=ui&tags=UI,api'), NOW).tags, ['ui', 'api']);
  });

  it('缺省 = 不过滤（sort default / 无 since / 无 event）', () => {
    const f = parseDocFilters(url('scope=s'), NOW);
    assert.equal(f.since, undefined);
    assert.equal(f.event, undefined);
    assert.equal(f.sort, 'default');
    assert.deepEqual(f.tags, []);
  });

  it('非法 since / sort 必须抛错（fail-loud，不降级）', () => {
    assert.throws(() => parseDocFilters(url('since=2h'), NOW), (err: unknown) => {
      assert.ok(err instanceof BadFilterError);
      assert.equal(err.code, 'INVALID_SINCE');
      return true;
    });
    assert.throws(() => parseDocFilters(url('sort=hot'), NOW), (err: unknown) => {
      assert.ok(err instanceof BadFilterError);
      assert.equal(err.code, 'INVALID_SORT');
      return true;
    });
  });

  it('纯分隔符的检索词视为"无检索词"', () => {
    assert.equal(parseDocFilters(url('q=%2F%2F'), NOW).q, '');
    assert.equal(parseDocFilters(url('q=Api'), NOW).q, 'api');
  });

  it('检索词归一复用 doc-path（前导/尾部斜杠、反斜杠都要吃掉）', () => {
    // 自写归一漏掉"去前导 /"⇒ `/api` 永远比不中候选路径（真实回归）
    assert.equal(parseDocFilters(url('q=%2Fapi'), NOW).q, 'api');
    assert.equal(parseDocFilters(url('q=wiki%2Fapi%2F'), NOW).q, 'wiki/api');
    assert.equal(parseDocFilters(url('q=wiki%5Capi'), NOW).q, 'wiki/api');
  });
});

describe('matchSince / hasDocTime', () => {
  it('窗口内命中，窗口外不命中', () => {
    const since = { key: '6h' as const, fromMs: NOW - 6 * 3600_000 };
    assert.equal(matchSince({ name: 'a', group: 'g', updatedAt: NOW - 3600_000 }, since), true);
    assert.equal(matchSince({ name: 'a', group: 'g', updatedAt: NOW - 7 * 3600_000 }, since), false);
    // createdAt 与 updatedAt 取较新者
    assert.equal(matchSince({ name: 'a', group: 'g', createdAt: NOW - 1000, updatedAt: NOW - 9 * 3600_000 }, since), true);
  });

  it('缺时间字段的老文档不命中（不臆造时间）', () => {
    const since = { key: '24h' as const, fromMs: NOW - 24 * 3600_000 };
    assert.equal(hasDocTime({ name: 'a', group: 'g' }), false);
    assert.equal(matchSince({ name: 'a', group: 'g' }, since), false);
  });
});

describe('matchTags / matchEvent', () => {
  const doc = { name: 'a', group: 'g', tags: ['UI', 'api'] };

  it('tags 是多值 OR；空数组不过滤', () => {
    assert.equal(matchTags(doc, ['ui']), true);
    assert.equal(matchTags(doc, ['api', 'memory']), true);
    assert.equal(matchTags(doc, ['memory']), false);
    assert.equal(matchTags(doc, []), true);
  });

  it('event 精确匹配；none = 未关联任何事件', () => {
    assert.equal(matchEvent({ name: 'a', group: 'g', eventId: 'evt_1' }, 'evt_1'), true);
    assert.equal(matchEvent({ name: 'a', group: 'g', eventId: 'evt_1' }, 'evt_2'), false);
    assert.equal(matchEvent({ name: 'a', group: 'g' }, 'none'), true);
    assert.equal(matchEvent({ name: 'a', group: 'g', eventId: 'evt_1' }, 'none'), false);
    assert.equal(matchEvent({ name: 'a', group: 'g' }, undefined), true);
  });
});

describe('sortByRecent', () => {
  it('按最近变更倒序；无时间排最后；同时间按 group+name 稳定', () => {
    const rows = [
      { name: 'old', group: 'g', updatedAt: NOW - 10_000 },
      { name: 'no-time', group: 'g' },
      { name: 'new', group: 'g', updatedAt: NOW },
      { name: 'b', group: 'g', updatedAt: NOW - 5_000 },
      { name: 'a', group: 'g', updatedAt: NOW - 5_000 },
    ];
    assert.deepEqual(sortByRecent(rows).map((r) => r.name), ['new', 'a', 'b', 'old', 'no-time']);
  });
});
