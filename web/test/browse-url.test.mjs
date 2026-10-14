/**
 * 浏览页阅读态 ⇄ URL 查询串单测
 *
 * 锁住五条不变量：
 *   1) 文档阅读态写出 `scope/group/relation`（与 lib/kiLinks.ts::deepLink 同一契约），
 *      参数顺序稳定 —— 页面用字符串比较判断「URL 是否已是最新」，顺序抖动会造成无谓导航；
 *   2) 全屏阅读额外写出 `reader=1`，且只有伴随文档时才写出；
 *   3) 无文档 / 缺 group 时返回空串（浏览入口），不排出半截深链接；
 *   4) `reader` 读回：只有 `1` 为真；
 *   5) `browseLinkKey` 剔除 AI 面板标记（`chat=1`）—— 面板开关不属于阅读态，不得让深链接
 *      effect 误判「URL 目标变了」而重放阅读态（2026-10-14 面板开合改由 URL 承载后新增）。
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
  FULLSCREEN_PARAM,
  browseFullscreenFromSearch,
  browseLinkKey,
  browseSearch,
  isBrowseUrlSelfWritten,
  markBrowseUrlSelfWritten,
} = await vite.ssrLoadModule('/src/lib/browseUrl.ts');
after(async () => vite.close());

const view = (over = {}) => ({ scope: 'kisearch', group: 'stages/1-核心架构', module: '架构总览', ...over });

describe('browseSearch', () => {
  it('文档阅读态 → scope/group/relation（顺序固定）', () => {
    assert.equal(browseSearch(view(), false), 'scope=kisearch&group=stages%2F1-%E6%A0%B8%E5%BF%83%E6%9E%B6%E6%9E%84&relation=%E6%9E%B6%E6%9E%84%E6%80%BB%E8%A7%88');
  });

  it('带锚点时追加 anchor；与 deepLink 契约一致', () => {
    const search = browseSearch(view({ anchor: 'h-0123456789abcdef' }), false);
    assert.match(search, /&anchor=h-0123456789abcdef$/);
  });

  it('全屏阅读写出 reader=1', () => {
    assert.match(browseSearch(view(), true), /&reader=1$/);
    assert.equal(FULLSCREEN_PARAM, 'reader');
  });

  it('无文档 → 空串（浏览入口，全屏标记不单独写出）', () => {
    assert.equal(browseSearch(null, false), '');
    assert.equal(browseSearch(null, true), '');
  });

  it('缺 group 的脏阅读态退化为空串，不排出半截深链接', () => {
    assert.equal(browseSearch(view({ group: undefined }), true), '');
  });

  it('参数顺序稳定：同一阅读态重复构造结果相同', () => {
    const a = browseSearch(view({ anchor: 'p-ffffffffffffffff' }), true);
    const b = browseSearch(view({ anchor: 'p-ffffffffffffffff' }), true);
    assert.equal(a, b);
  });
});

describe('self-written 标记（区分刷新恢复与外部深链接）', () => {
  it('标记后仅同一查询串命中；其他串不命中', () => {
    const store = new Map();
    globalThis.sessionStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
    };
    markBrowseUrlSelfWritten('scope=a&group=g&relation=r');
    assert.equal(isBrowseUrlSelfWritten('scope=a&group=g&relation=r'), true);
    assert.equal(isBrowseUrlSelfWritten('scope=a&group=g&relation=其他'), false);
    assert.equal(isBrowseUrlSelfWritten(''), false);
  });

  it('sessionStorage 不可用（隐私模式 / Node 环境）→ 一律按外部深链接处理，且不抛异常', () => {
    delete globalThis.sessionStorage;
    assert.equal(isBrowseUrlSelfWritten('scope=a'), false);
    markBrowseUrlSelfWritten('scope=a');
    assert.equal(isBrowseUrlSelfWritten('scope=a'), false);
  });
});

describe('browseFullscreenFromSearch', () => {
  it('reader=1 为真', () => {
    assert.equal(browseFullscreenFromSearch('scope=kisearch&group=g&relation=r&reader=1'), true);
  });

  it('缺省 / 其他取值一律为否', () => {
    assert.equal(browseFullscreenFromSearch('scope=kisearch&group=g&relation=r'), false);
    assert.equal(browseFullscreenFromSearch('reader=0'), false);
    assert.equal(browseFullscreenFromSearch(''), false);
  });
});

describe('browseLinkKey（深链接比较键剔除面板标记）', () => {
  it('剔除 chat，其余参数与顺序保持不变', () => {
    assert.equal(
      browseLinkKey('scope=kisearch&group=g&relation=r&chat=1'),
      'scope=kisearch&group=g&relation=r',
    );
    assert.equal(
      browseLinkKey('scope=kisearch&group=g&relation=r&anchor=h-1&reader=1&chat=1'),
      'scope=kisearch&group=g&relation=r&anchor=h-1&reader=1',
    );
  });

  it('开关面板前后键相同 —— 这才是「URL 目标没变」的正确判据', () => {
    const withPanel = browseLinkKey('scope=kisearch&group=g&relation=r&chat=1');
    const without = browseLinkKey('scope=kisearch&group=g&relation=r');
    assert.equal(withPanel, without);
  });

  it('只有面板标记 → 空键（等价于浏览入口）', () => {
    assert.equal(browseLinkKey('chat=1'), '');
    assert.equal(browseLinkKey(''), '');
  });

  it('阅读目标真的变化时键仍不同（不能把差异一并抹掉）', () => {
    assert.notEqual(
      browseLinkKey('scope=kisearch&group=g&relation=r1&chat=1'),
      browseLinkKey('scope=kisearch&group=g&relation=r2&chat=1'),
    );
  });
});
