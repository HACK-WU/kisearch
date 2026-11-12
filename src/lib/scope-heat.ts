/**
 * scope 冷热分档与窗口聚合（REQ-20261112-001 S-02）。
 *
 * 输入是 S-01 的原始统计（key 可能是视图名），输出是每个 scope 的三档窗口结果
 * （数字 + heat + coveredDays），直接塞进 `ScopeEntry.usage`。
 *
 * 两条与 group 冷热**刻意不同**的口径（不要照抄 `query-group.ts`）：
 *
 * 1. **`unused` 先剔除再分档**：`partitionByScore` 是按相对百分位分的（hotPercent=0.3）。
 *    162 个 scope 里若只有 5 个有调用，全塞进去会算出 49 个「热」，其中 44 个是 0 调用。
 * 2. **`reservedEmerging = 0`**（见 `SCOPE_HEAT_CONFIG`）：「最近 48h 用过」不占保底席位，
 *    否则一个刚被调用 1 次的新库会把调用千次的老库挤出热区。
 */
import type { KiConfig } from './config.js';
import { partitionByScore } from './scoring.js';
import { SCOPE_HEAT_CONFIG, SCOPE_USAGE_WINDOWS } from './constants.js';
import { isViewName, resolveScopeTargets } from './scope-view.js';
import {
  formatLocalDate,
  readScopeUsage,
  readScopeUsageMeta,
  type ScopeUsageSnapshot,
} from './scope-usage.js';

/*
 * 三档窗口与 `ScopeUsage` 的 d7/d30/d90 字段一一对应，加档位必须同时改接口与前端。
 *
 * ★ 断言放在**模块加载期**而不是 `buildScopeUsageMap()` 内部：后者跑在
 *   `executeScopeListLocal()` 的请求路径上，在那里抛错会让整个 scope 列表 500 ——
 *   而「统计不可用不得拖垮列表」是本需求的硬约束。开发者写错常量应立即崩，
 *   但应该崩在启动期，不是崩在用户的列表请求上。
 */
if (SCOPE_USAGE_WINDOWS.length !== 3) {
  throw new Error('SCOPE_USAGE_WINDOWS 必须恰好 3 档（d7/d30/d90），改档位需同步 ScopeUsage 接口与前端');
}

export type ScopeHeat = 'hot' | 'warm' | 'cold' | 'unused';

/** 单个窗口档位的聚合结果 */
export interface ScopeUsageWindow {
  read: number;
  write: number;
  /** 窗口内最近一次调用（毫秒）；0 = 窗口内无调用 */
  lastUsedAt: number;
  /**
   * `'unused'` 的准确含义是「**本窗口内** read+write 为 0」，**不是「从未使用」**。
   * 「从未使用」由外层 `usage` 缺失表达，二者不可混用（前端文案也不同：
   * 'unused' 渲染「无调用」，无统计数据渲染 `—`）。
   */
  heat: ScopeHeat;
  /** `min(窗口天数, today - firstSeen + 1)`；用于前端给未填满窗口的数字加角标 */
  coveredDays: number;
}

/** 调用量与冷热（`ScopeEntry.usage`） */
export interface ScopeUsage {
  d7: ScopeUsageWindow;
  d30: ScopeUsageWindow;
  d90: ScopeUsageWindow;
  /** 统计起始日期（全局最早 firstSeen），YYYY-MM-DD */
  since: string;
  /** 最近一次 flush 时间（ISO） */
  updatedAt: string;
}

interface HeatEntry {
  scope: string;
  read: number;
  write: number;
  lastUsedAt: number;
}

/**
 * 计算冷热档位。
 *
 * 评分沿用 group 的形态（`total / (1 + 距上次使用小时 / halfLifeHours)`），但
 * 数据源是**调用量**而非 group 的 `useCount`（后者只在读原文时 +1、且上限 10）。
 */
export function computeHeat(entries: HeatEntry[], now: number = Date.now()): Map<string, ScopeHeat> {
  const heat = new Map<string, ScopeHeat>();
  const active: HeatEntry[] = [];
  for (const entry of entries) {
    if (entry.read + entry.write > 0) active.push(entry);
    else heat.set(entry.scope, 'unused');
  }
  if (active.length === 0) return heat;

  const halfLife = SCOPE_HEAT_CONFIG.halfLifeHours;
  const recentMs = SCOPE_HEAT_CONFIG.recentHours * 3_600_000;
  const { hot, warm, cold } = partitionByScore(
    active,
    {
      getId: (entry) => entry.scope,
      getScore: (entry) => {
        const total = entry.read + entry.write;
        // clamp：时钟回拨时 lastUsedAt 可能在未来，负的 hours 会让分母 < 1 把分数放大
        const hours = entry.lastUsedAt > 0 ? Math.max(0, (now - entry.lastUsedAt) / 3_600_000) : 0;
        return total / (1 + hours / halfLife);
      },
      // reservedEmerging = 0 ⇒ 下面两个 accessor 不产生席位，保持 partitionByScore 的
      // 契约完整（它要求四件套），将来若要「新兴」单列可直接复用。
      isEmerging: (entry) => entry.lastUsedAt > 0 && now - entry.lastUsedAt <= recentMs,
      getEmergingSortScore: (entry) => entry.lastUsedAt,
    },
    SCOPE_HEAT_CONFIG,
  );

  for (const entry of hot) heat.set(entry.scope, 'hot');
  for (const entry of warm) heat.set(entry.scope, 'warm');
  for (const entry of cold) heat.set(entry.scope, 'cold');
  return heat;
}

/**
 * 把统计里的原始名摊到真实 scope：视图名 → 成员库各 +1 份，其余直接计入。
 *
 * ★ 已知偏差（设计 S-02 §3.2 已声明）：按**当前**视图成员展开，而请求当时该 Token
 *   可能只被授权部分成员 ⇒ 计数会摊到用户当时无权访问的成员上。不构成泄露
 *   （`ki_scope_list` 已按 RBAC 裁剪行），仅数字偏移；埋点阶段记快照会让记账从 O(1)
 *   变成需解析视图配置，成本不成比例。
 */
function expandViews(
  config: KiConfig,
  raw: Map<string, ScopeUsageSnapshot>,
): Map<string, ScopeUsageSnapshot> {
  const merged = new Map<string, ScopeUsageSnapshot>();
  const merge = (name: string, snap: ScopeUsageSnapshot) => {
    const cur = merged.get(name);
    if (!cur) {
      merged.set(name, { ...snap });
      return;
    }
    cur.read += snap.read;
    cur.write += snap.write;
    if (snap.lastUsedAt > cur.lastUsedAt) cur.lastUsedAt = snap.lastUsedAt;
    if (snap.firstSeen < cur.firstSeen) cur.firstSeen = snap.firstSeen;
  };

  for (const [name, snap] of raw) {
    let members: string[] | null = null;
    try {
      if (isViewName(config, name)) members = resolveScopeTargets(config, name).scopes;
    } catch {
      // 视图定义损坏时按「不是视图」处理（与 scope-view.ts 的既有口径一致）
      members = null;
    }
    if (!members) {
      // 不是视图：本身就是真实 scope，直接计入
      merge(name, snap);
      continue;
    }
    // 是视图但成员为空（成员库全被删/配置损坏）：**丢弃**，不记到视图名本身。
    // 记了会让 byScope 出现「不在 scope 列表里的幽灵节点」——`executeScopeListLocal`
    // 只遍历真实 scope，它不会展示，但会成为统计文件里的死数据（设计 S-02 §5）。
    for (const member of members) merge(member, snap);
  }
  return merged;
}

function coveredDaysOf(firstSeen: string, windowDays: number, now: number): number {
  const start = dayStartMs(firstSeen);
  if (!start) return windowDays;
  const days = Math.round((dayStartMs(formatLocalDate(now)) - start) / 86_400_000) + 1;
  return Math.max(1, Math.min(windowDays, days));
}

function dayStartMs(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  if (!y || !m || !d) return 0;
  return new Date(y, m - 1, d).getTime();
}

/** 一次聚合的产物：按 scope 的用量 + 文件级元信息（供未出现的 scope 兜底） */
export interface ScopeUsageBundle {
  byScope: Map<string, ScopeUsage>;
  meta: { since: string; updatedAt: string };
}

/**
 * 组装每个 scope 的 `usage`。
 *
 * 返回 `null` = 统计整体不可用（文件缺失/损坏）⇒ 调用方给所有 scope 的 `usage` 设 null，
 * 前端渲染 `—`。**绝不返回全 0 的对象** —— 0 会被读成「确实没人用」（需求 R5）。
 * 统计可用但某 scope 未出现在 `byScope` 里 ⇒ 调用方用 `makeEmptyScopeUsage` 兜底。
 */
export function buildScopeUsageMap(
  config: KiConfig,
  now: number = Date.now(),
): ScopeUsageBundle | null {
  const meta = readScopeUsageMeta(config);
  if (!meta) return null;

  const perWindow = new Map<number, Map<string, ScopeUsageSnapshot>>();
  for (const days of SCOPE_USAGE_WINDOWS) {
    const raw = readScopeUsage(config, days);
    if (!raw) return null;
    perWindow.set(days, expandViews(config, raw));
  }

  const result = new Map<string, ScopeUsage>();
  for (const [days, map] of perWindow) {
    // 每个窗口单独分档：切窗口时数字与冷热必须一起重算（需求 D10）
    const heat = computeHeat([...map].map(([scope, snap]) => ({
      scope,
      read: snap.read,
      write: snap.write,
      lastUsedAt: snap.lastUsedAt,
    })), now);

    for (const [scope, snap] of map) {
      const win: ScopeUsageWindow = {
        read: snap.read,
        write: snap.write,
        lastUsedAt: snap.lastUsedAt,
        heat: heat.get(scope) ?? 'unused',
        coveredDays: coveredDaysOf(snap.firstSeen, days, now),
      };
      const existing = result.get(scope);
      if (existing) {
        existing[`d${days}` as 'd7' | 'd30' | 'd90'] = win;
      } else {
        // 先占位再用实际窗口覆盖：三档循环结束后 d7/d30/d90 都会被赋成真实值，
        // 占位值不会外泄（SCOPE_USAGE_WINDOWS 固定三档，与字段一一对应）。
        result.set(scope, {
          d7: emptyWindow(),
          d30: emptyWindow(),
          d90: emptyWindow(),
          since: meta.since,
          updatedAt: meta.updatedAt,
          [`d${days}`]: win,
        } as ScopeUsage);
      }
    }
  }
  return { byScope: result, meta };
}

/** 占位：三档循环期间的临时值，循环结束后会被真实窗口结果覆盖 */
function emptyWindow(): ScopeUsageWindow {
  return { read: 0, write: 0, lastUsedAt: 0, heat: 'unused', coveredDays: 0 };
}

/**
 * 统计**可用**、但该 scope 从未被记录过时的全 0 结构。
 *
 * ★ 与 `usage: null`（统计不可用 ⇒ 前端 `—`）必须区分：
 *   这里表达的是「统计在正常工作，只是这个库窗口内 0 次调用」⇒ 前端渲染 `0` + 「无调用」。
 *   `coveredDays` 用全局 `since` 算 —— 统计才跑 3 天时，不能声称覆盖了 7 天。
 */
export function makeEmptyScopeUsage(
  meta: { since: string; updatedAt: string },
  now: number = Date.now(),
): ScopeUsage {
  const win = (days: number): ScopeUsageWindow => ({
    read: 0,
    write: 0,
    lastUsedAt: 0,
    heat: 'unused',
    coveredDays: coveredDaysOf(meta.since, days, now),
  });
  return {
    d7: win(7),
    d30: win(30),
    d90: win(90),
    since: meta.since,
    updatedAt: meta.updatedAt,
  };
}
