/**
 * events-selection.test.mjs —— 事件页「切页回来仍停在同一条事件」的选中恢复（2026-11-23）
 *
 * 锁住的不变量：
 *   1) 优先级：深链（`?event=`）> 上次看的那条 > 列表第一条 —— 分享链接不能被记忆抢走；
 *   2) 记忆按 scope 分开（切库不能把 A 库的事件带到 B 库）；
 *   3) 存储不可用 / 读失败一律当没记忆，不抛（隐私模式也要能打开页面）；
 *   4) 页面真的用上了这套逻辑（源码契约：loadList 不再直接 `list.events[0]`）。
 *
 * 背景：侧栏链接是 `/governance/events`（不带 query），选中态只写 `?event=`，
 * 于是「切到回收站再点侧栏回来」会回落到第一条 → 右栏变成另一条事件，
 * 用户以为追问记录丢了。真机复现见 `.debug/ask-gone-on-tab-switch-20261123/`。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
  LAST_EVENT_STORAGE_PREFIX,
  lastEventStorageKey,
  pickInitialEventId,
  readLastEventId,
  rememberLastEventId,
} = await vite.ssrLoadModule('/src/lib/eventsSelection.ts');
after(async () => vite.close());

/** 内存版 localStorage（含可注入的抛错开关） */
function memoryStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
  };
}

describe('① 记忆读写：按 scope 分开，失败不抛', () => {
  it('写入后能按同一个 scope 读回', () => {
    const store = memoryStore();
    rememberLastEventId('kisearch-memory', 'evt_a', store);
    assert.equal(readLastEventId('kisearch-memory', store), 'evt_a');
  });

  it('不同 scope 互不干扰（切库不会串选中）', () => {
    const store = memoryStore();
    rememberLastEventId('lib-a', 'evt_a', store);
    rememberLastEventId('lib-b', 'evt_b', store);
    assert.equal(readLastEventId('lib-a', store), 'evt_a');
    assert.equal(readLastEventId('lib-b', store), 'evt_b');
    assert.equal(readLastEventId('lib-c', store), null);
  });

  it('key 带固定前缀 + scope', () => {
    assert.equal(lastEventStorageKey('lib-a'), `${LAST_EVENT_STORAGE_PREFIX}lib-a`);
  });

  it('空 id 不写入（不能把选中态清成空串）', () => {
    const store = memoryStore();
    rememberLastEventId('lib-a', '', store);
    assert.equal(store.map.size, 0);
  });

  it('存储抛错时读返回 null、写静默忽略', () => {
    const boom = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    };
    assert.equal(readLastEventId('lib-a', boom), null);
    assert.doesNotThrow(() => rememberLastEventId('lib-a', 'evt_a', boom));
  });

  it('没有存储（隐私模式 / SSR）时返回 null 且不抛', () => {
    assert.equal(readLastEventId('lib-a', null), null);
    assert.doesNotThrow(() => rememberLastEventId('lib-a', 'evt_a', null));
  });

  it('存量空串按「没有记忆」处理', () => {
    const store = memoryStore({ [lastEventStorageKey('lib-a')]: '   ' });
    assert.equal(readLastEventId('lib-a', store), null);
  });
});

describe('② 首屏选中优先级：深链 > 记忆 > 第一条', () => {
  const base = { current: null, deepLinked: null, remembered: null, firstId: 'evt_first' };

  it('已有选中时原样保留（切筛选不该改选中）', () => {
    assert.equal(pickInitialEventId({ ...base, current: 'evt_now', deepLinked: 'evt_link' }), 'evt_now');
  });

  it('深链优先于记忆（分享链接直达必须按链接来）', () => {
    assert.equal(pickInitialEventId({ ...base, deepLinked: 'evt_link', remembered: 'evt_last' }), 'evt_link');
  });

  it('没有深链时恢复上次看的那条（核心修复）', () => {
    assert.equal(pickInitialEventId({ ...base, remembered: 'evt_last' }), 'evt_last');
  });

  it('记忆指向的事件已不存在 → 调用方传 null，回落第一条', () => {
    assert.equal(pickInitialEventId(base), 'evt_first');
  });

  it('列表为空时返回 null（不返回 undefined）', () => {
    assert.equal(pickInitialEventId({ ...base, firstId: null }), null);
  });
});

describe('③ 页面接入契约（防回退）', () => {
  const page = fs.readFileSync(path.join(webRoot, 'src/pages/EventsPage.tsx'), 'utf-8');

  it('loadList 的选中走 pickInitialEventId，而不是直接回落第一条', () => {
    assert.match(page, /pickInitialEventId\(\{[\s\S]{0,200}firstId: list\.events\[0\]\?\.id \?\? null/);
    assert.doesNotMatch(page, /prev \?\? matchDeepLink\(list\.events, viewNow\) \?\? list\.events\[0\]\?\.id/);
  });

  it('选中变化时写入记忆（否则切页回来仍然恢复不了）', () => {
    assert.match(page, /useEffect\(\(\) => \{\s*if \(activeId\) rememberLastEventId\(scope, activeId\);/);
  });
});
