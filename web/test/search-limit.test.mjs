/**
 * 检索页「Limit」输入归一化单测（lib/searchLimit.ts）
 *
 * 锁住四条不变量：
 *   1) **空串 / 非数字回默认 10**：清空输入框后请求里不能出现 `limit: 0`（旧实现 `Number(limit) || 10` 的语义）；
 *   2) **上下界是 1 / 1000**：上界对齐后端 `SEARCH_TOPK_MAX`，超了后端也只会返回 1000 条；
 *   3) **步进不跳空**：非法中间态点一下 −/+ 就回到合法值，而不是产生 NaN；
 *   4) **边界处步进不越界**：1 上点减、1000 上点加都必须停住。
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
  SEARCH_LIMIT_MIN,
  SEARCH_LIMIT_MAX,
  SEARCH_LIMIT_DEFAULT,
  parseSearchLimit,
  normalizeSearchLimit,
  stepSearchLimit,
  isSearchLimitOutOfRange,
} = await vite.ssrLoadModule('/src/lib/searchLimit.ts');
after(async () => vite.close());

describe('searchLimit / 常量', () => {
  it('默认 10、范围 1–1000（上界对齐后端 SEARCH_TOPK_MAX）', () => {
    assert.equal(SEARCH_LIMIT_DEFAULT, 10);
    assert.equal(SEARCH_LIMIT_MIN, 1);
    assert.equal(SEARCH_LIMIT_MAX, 1000);
  });
});

describe('searchLimit / parseSearchLimit', () => {
  it('正常整数原样返回（下拉里没有的值也必须能填）', () => {
    for (const n of [1, 5, 10, 20, 30, 37, 200, 1000]) {
      assert.equal(parseSearchLimit(String(n)), n);
    }
  });

  it('空串 / 纯空白 / 非数字 → 默认 10（不产生 0 或 NaN）', () => {
    for (const raw of ['', '   ', 'abc', '1e', '-', '--3']) {
      assert.equal(parseSearchLimit(raw), SEARCH_LIMIT_DEFAULT, `输入 ${JSON.stringify(raw)} 应回默认`);
    }
  });

  it('0 与负数 → 下界 1', () => {
    assert.equal(parseSearchLimit('0'), SEARCH_LIMIT_MIN);
    assert.equal(parseSearchLimit('-5'), SEARCH_LIMIT_MIN);
  });

  it('超上界 → 上界 1000', () => {
    assert.equal(parseSearchLimit('5000'), SEARCH_LIMIT_MAX);
  });

  it('小数向下取整（后端要求 int）', () => {
    assert.equal(parseSearchLimit('12.9'), 12);
    assert.equal(parseSearchLimit('1.2'), 1);
  });

  it('首尾空格不影响解析', () => {
    assert.equal(parseSearchLimit('  30  '), 30);
  });
});

describe('searchLimit / normalizeSearchLimit', () => {
  it('NaN / Infinity → 默认值', () => {
    assert.equal(normalizeSearchLimit(Number.NaN), SEARCH_LIMIT_DEFAULT);
    assert.equal(normalizeSearchLimit(Number.POSITIVE_INFINITY), SEARCH_LIMIT_DEFAULT);
  });

  it('clamp 后落在闭区间内', () => {
    assert.equal(normalizeSearchLimit(0), SEARCH_LIMIT_MIN);
    assert.equal(normalizeSearchLimit(SEARCH_LIMIT_MAX + 1), SEARCH_LIMIT_MAX);
  });
});

describe('searchLimit / isSearchLimitOutOfRange（越界标红信号）', () => {
  it('界内值不标红', () => {
    for (const raw of ['1', '10', '1000', ' 30 ']) {
      assert.equal(isSearchLimitOutOfRange(raw), false, `${JSON.stringify(raw)} 不应标红`);
    }
  });

  it('超上下界标红（失焦会被改写，必须给可见信号）', () => {
    assert.equal(isSearchLimitOutOfRange('5000'), true);
    assert.equal(isSearchLimitOutOfRange('0'), true);
    assert.equal(isSearchLimitOutOfRange('-3'), true);
  });

  it('空串 / 非数字不标红（录入中间态，标红会一路闪）', () => {
    for (const raw of ['', '   ', 'abc']) {
      assert.equal(isSearchLimitOutOfRange(raw), false, `${JSON.stringify(raw)} 不应标红`);
    }
  });
});

describe('searchLimit / stepSearchLimit', () => {
  it('合法值 ±1', () => {
    assert.equal(stepSearchLimit('20', 1), 21);
    assert.equal(stepSearchLimit('20', -1), 19);
  });

  it('非法中间态也能步进出合法值（不产生 NaN）', () => {
    assert.equal(stepSearchLimit('', 1), SEARCH_LIMIT_DEFAULT + 1);
    assert.equal(stepSearchLimit('abc', -1), SEARCH_LIMIT_DEFAULT - 1);
  });

  it('边界处停住：1 再减仍是 1，1000 再加仍是 1000', () => {
    assert.equal(stepSearchLimit('1', -1), SEARCH_LIMIT_MIN);
    assert.equal(stepSearchLimit('1000', 1), SEARCH_LIMIT_MAX);
    assert.equal(stepSearchLimit('9999', 1), SEARCH_LIMIT_MAX);
  });
});
