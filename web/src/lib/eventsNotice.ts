/**
 * 侧栏「事件」红点的判据与本机已读记录（2026-11-25 用户需求）。
 *
 * 需求：事件有**任何动态**（上报 / 修改 / AI 分析完成未查看）时，侧栏「事件」入口
 * 亮一个红点，不展示具体内容。本模块只放「判据 + 本地存储」，渲染在 `AppShell`。
 *
 * 为什么放 localStorage：与事件列表「分析完成」徽标同一套口径
 * （`ki-web:analysis-seen`，见 `pages/EventsPage.tsx` 的历史注释），跨设备不同步可接受；
 * 放后端就要按账号存游标、改契约与 DTO，代价远大于收益。
 *
 * 两个「已读」概念**必须分开存**，否则互相覆盖：
 *   · `seenAnalysis` —— 按条：`eventId → runId`，点开那条事件才算看过（重新分析换 runId）
 *   · `seenAt`       —— 按库：时间水位，事件被新建 / 修改 / 收口后它就落后于最新改动
 */

/**
 * 「这条事件的分析结果我看过了」的本地记录（`eventId → runId`）。
 *
 * 原定义在 `pages/EventsPage.tsx`，侧栏红点也要判「有没有未看的分析」故上移到本模块；
 * 两个消费方共用一个键，语义一旦分叉就会出现「列表徽标已消、侧栏还亮」。
 */
export const SEEN_ANALYSIS_KEY = 'ki-web:analysis-seen';

/**
 * 事件「已看到哪儿了」的时间水位（`scope → updatedAt`）。
 *
 * **按 scope 存**：单库与知识视图各自独立，切库不会互相清零。
 * 值为 0 / 缺键 = 本机没有记录，此时**不点亮**（见 `hasEventNotice`）。
 */
export const EVENTS_SEEN_AT_KEY = 'ki-web:events-seen-at';

/** 侧栏红点的轮询间隔：30s 足够「明显提示」，又不会把 counts 的磁盘扫描变成负担 */
export const EVENT_NOTICE_POLL_MS = 30_000;

/** 算作「有未看结论」的分析终态。`cancelled` 用户主动取消，不给提示 */
const NOTICE_ANALYSIS_STATUS = new Set(['ready', 'partial', 'failed']);

/**
 * 本机存储是否可用（隐私模式 / 企业策略会把 `localStorage` 直接抛异常）。
 *
 * **不可用时整只红点必须关掉**：已读记不住 ⇒「有未看的分析」那一路永远成立，
 * 用户点开、点烂都清不掉，变成一只永不熄灭的点。宁可没有提示，也不要这种点。
 * 只探测一次并缓存结果（探测本身有副作用：写一个键再删）。
 */
let storageAvailable: boolean | null = null;
export function isStorageAvailable(): boolean {
  if (storageAvailable !== null) return storageAvailable;
  try {
    const probe = '__ki_events_notice_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    storageAvailable = true;
  } catch {
    storageAvailable = false;
  }
  return storageAvailable;
}

export function readSeenAnalysis(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SEEN_ANALYSIS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    // 存储不可用（隐私模式 / 配额）只是记不住已读，不影响其它行为
    return {};
  }
}

export function persistSeenAnalysis(map: Record<string, string>): void {
  try {
    localStorage.setItem(SEEN_ANALYSIS_KEY, JSON.stringify(map));
  } catch {
    /* 同上：记不住已读不阻断任何操作 */
  }
}

/**
 * 读某个 scope 的事件已读水位；**无记录返回 0**，由调用方决定兜底（见 `AppShell`）。
 */
export function readEventsSeenAt(scope: string): number {
  try {
    const raw = localStorage.getItem(EVENTS_SEEN_AT_KEY);
    if (!raw) return 0;
    const map = JSON.parse(raw) as Record<string, number>;
    const value = map?.[scope];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * 推进某 scope 的事件已读水位。
 *
 * **只增不减**：并发（事件页 loadList 与侧栏轮询）时后到的旧值不能把水位拉回去，
 * 否则刚清掉的红点会自己亮回来。
 */
export function writeEventsSeenAt(scope: string, at: number): void {
  if (!Number.isFinite(at) || at <= 0) return;
  try {
    const raw = localStorage.getItem(EVENTS_SEEN_AT_KEY);
    const map = raw ? (JSON.parse(raw) as Record<string, number>) : {};
    if (typeof map[scope] === 'number' && map[scope] >= at) return;
    map[scope] = at;
    localStorage.setItem(EVENTS_SEEN_AT_KEY, JSON.stringify(map));
  } catch {
    /* 记不住水位最多是红点反复出现，不阻断操作 */
  }
}

export interface EventNoticeInput {
  /** counts 的 `eventsMaxUpdatedAt`；`undefined` = 旧 daemon 无该字段（按「无动态」处理） */
  maxUpdatedAt?: number | null;
  /** 本机已读水位；0 = 从没记录过（此时不依据它点亮） */
  seenAt?: number | null;
  /** `/governance/events/running` 的 `finished` 列表（进程内缓存，重启后由磁盘补齐） */
  finished?: ReadonlyArray<{ eventId: string; runId?: string; status?: string }> | null;
  /** 已看过的分析（`eventId → runId`） */
  seenAnalysis?: Record<string, string> | null;
}

/**
 * 侧栏「事件」是否该亮红点。纯函数，便于用真值表覆盖各类组合。
 *
 * 两个来源任一成立即亮：
 *   ① 有终态分析（ready / partial / failed）且该 `runId` 没被点开过
 *   ② 最近一次事件改动晚于本机已读水位（上报 / 编辑 / 阶段流转 / 收口都算，
 *      它们都会写 `updatedAt`；置顶不算 —— 后端明确不把 `pinnedAt` 混进 `updatedAt`）
 *
 * ① 对 `failed` 也按「看过即消」判：列表徽标对失败是常亮的，但侧栏红点若常亮就再也不会灭。
 */
export function hasEventNotice(input: EventNoticeInput): boolean {
  const seenAnalysis = input.seenAnalysis ?? {};
  for (const run of input.finished ?? []) {
    if (!run?.eventId || !NOTICE_ANALYSIS_STATUS.has(String(run.status))) continue;
    const seen = run.runId
      ? seenAnalysis[run.eventId] === run.runId
      // 没有 runId 的旧记录退化为「这条看过就算」——否则会永久点亮
      : Boolean(seenAnalysis[run.eventId]);
    if (!seen) return true;
  }
  const max = typeof input.maxUpdatedAt === 'number' ? input.maxUpdatedAt : 0;
  const seenAt = typeof input.seenAt === 'number' ? input.seenAt : 0;
  return seenAt > 0 && max > seenAt;
}
