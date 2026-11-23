/**
 * eventsSelection.ts —— 事件页「回到页面时选中哪条」的记忆与决策（2026-11-23）
 *
 * ═══ 为什么需要它 ═══
 * 侧栏导航链接是 `/governance/events`（**不带 query**），而选中态只写在 URL 的 `?event=`
 * 上（`EventsPage.selectEvent`）。于是「切到回收站 / 分类页再点侧栏回来」= 整页重挂 +
 * URL 里没有 event → 回落到列表第一条：用户以为「追问记录 / 分析卡丢了」，其实是
 * 眼睛已经换到另一条事件上了（真机复现见 `.debug/ask-gone-on-tab-switch-20261123/`）。
 *
 * 这里把「上次看的那条」按 scope 记在 localStorage，让选中态多一层兜底：
 *   深链（`?event=`）> 上次看的那条 > 列表第一条
 * 深链仍排第一：分享链接 / 新标签直达必须按链接来，记忆不能抢。
 *
 * ═══ 边界 ═══
 * · 只存 `evt_` id（视图下 shortId 跨库撞号，绝不能存编号）；
 * · 读失败 / 无 localStorage（隐私模式）一律当没记忆，不抛；
 * · 记忆里的 id 在当前列表里找不到（事件被删 / 换了库）→ 由调用方回落第一条。
 */

/** localStorage key 前缀；按 scope 分开，避免切库时把 A 库的事件带到 B 库 */
export const LAST_EVENT_STORAGE_PREFIX = 'ki-web:events:last-event:';

/** 最小存储接口：只用到 getItem/setItem，方便测试注入内存实现 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 该 scope 的记忆 key */
export function lastEventStorageKey(scope: string): string {
  return `${LAST_EVENT_STORAGE_PREFIX}${scope}`;
}

/** 默认存储：浏览器 localStorage；取不到（SSR / 隐私模式）返回 null */
function defaultStore(): KeyValueStore | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * 读「上次看的事件 id」。
 *
 * 空串按没有处理（`setItem` 之后被清空的情况），任何异常都吞掉 ——
 * 一个记不住选中态的浏览器，不该让事件页打不开。
 */
export function readLastEventId(scope: string, store: KeyValueStore | null = defaultStore()): string | null {
  if (!store) return null;
  try {
    const raw = store.getItem(lastEventStorageKey(scope));
    return raw && raw.trim() ? raw.trim() : null;
  } catch {
    return null;
  }
}

/** 记「上次看的事件 id」；写失败（配额 / 隐私模式）忽略 */
export function rememberLastEventId(
  scope: string,
  eventId: string,
  store: KeyValueStore | null = defaultStore(),
): void {
  if (!store || !eventId) return;
  try {
    store.setItem(lastEventStorageKey(scope), eventId);
  } catch {
    /* 记不住不影响本次浏览 */
  }
}

export interface PickInitialEventArgs {
  /** 页面已有的选中（非空即原样保留：只有首屏/换库才需要决策） */
  current: string | null;
  /** `?event=` 深链解析出的、**确实存在于当前列表**的事件 id */
  deepLinked: string | null;
  /** 记忆里那条解析后仍存在于当前列表的事件 id（找不到时传 null） */
  remembered: string | null;
  /** 列表第一条（都没有时的兜底） */
  firstId: string | null;
}

/**
 * 首屏选中决策：深链 > 记忆 > 第一条。
 *
 * 抽成纯函数是为了能单测优先级 —— 这个顺序一旦被改动，症状是
 * 「分享的链接打开却是别的事件」，只在真机上才看得出。
 */
export function pickInitialEventId(args: PickInitialEventArgs): string | null {
  const { current, deepLinked, remembered, firstId } = args;
  if (current) return current;
  if (deepLinked) return deepLinked;
  if (remembered) return remembered;
  return firstId ?? null;
}
