/**
 * find-targets.ts —— 「AI 查找」检索范围解析（REQ-20261116-005 · S-02 §3.1）
 *
 * 范围 = **当前事件所在库（恒定）** ∪ 配置里放开的额外 scope / 视图。
 * 当前库不写入配置：否则"默认当前库"要靠在每个库各配一次。
 *
 * 三条口径：
 *   1. **运行期剔除、保存期报错**：配置里出现无权 / 已不存在的名字时，查找不失败（其他库照常查），
 *      只放进 `skipped` 让前端如实提示；保存配置时才 400（用户得立刻知道自己配错了）。
 *   2. **视图全有或全无**：视图本身通过授权还不够，其**全部成员**也必须在授权集合内
 *      （判定复用 `scope-access.ts`，不另写一份 —— 两份判定必然漂移成越权口子）。
 *   3. **不自建缓存**：`views.json` 的读取复用 `scope-access` 的 mtime 快照；
 *      自建 TTL 缓存会出现「授权用旧成员、展开用新成员」的越权窗口（见 `scope-access.ts:42-48`）。
 *
 * 对外两个入口（**判定逻辑只有一份**，别在调用方重写）：
 *   - `resolveFindTargets(eventScope, cfg, deps)` —— 「AI 查找」：事件库恒在首位，配置里的额外库逐个判定；
 *   - `resolveScopeSet(bases, extras, deps)` —— 通用形态（REQ-20261118-003 的 `ki_recall` 复用）；
 *     两者语义差异只在 `bases`（视为已鉴权）与 `extras`（逐个判定）的划分上。
 */

import { loadConfig, type KiConfig } from '../config.js';
import { isScopeAccessAllowed } from '../scope-access.js';
import { readViews, type ViewConfig } from '../scope-view.js';
import { listAllScopes } from '../scope.js';
import type { FindConfig } from '../chat/prompt-config.js';

export type SkippedTargetReason = 'forbidden' | 'missing' | 'view-members-changed';

export interface SkippedTarget {
  name: string;
  reason: SkippedTargetReason;
}

export interface FindTargetResolution {
  /** 实际参与检索的单元，顺序 = `[eventScope, ...extraScopes]`（已去重） */
  targets: string[];
  /** 配置里存在但本次被剔除的项（前端据此提示"已按权限收窄"） */
  skipped: SkippedTarget[];
}

/**
 * 每个检索单元的文档数（多库面板的「共 N 篇」口径）。
 *
 * 视图不是物理库：`readAllGroupCaches(视图名)` 恒为空，必须按成员库求和，否则
 * 配了视图会显示成 0 篇（`total === 0` 还会把空态误判成"事件与文档不在同一库"）。
 *
 * @param deps.viewMembers 视图名 → 成员库；不是视图返回 `null`（**必填**：忘了传会静默算 0）
 * @param deps.cachesOf 分片读取；调用方注入带缓存的实现可避免同一库读多次
 */
export function countDocsByTargets(
  targets: string[],
  deps: {
    viewMembers: (name: string) => string[] | null;
    cachesOf: (scope: string) => Map<string, { hot_relations: unknown[] }>;
  },
): { rows: Array<{ scope: string; docs: number }>; total: number } {
  const count = (s: string): number => {
    let n = 0;
    for (const [, doc] of deps.cachesOf(s)) n += doc.hot_relations.length;
    return n;
  };
  const rows = targets.map((t) => {
    const members = deps.viewMembers(t);
    return { scope: t, docs: members === null ? count(t) : members.reduce((sum, m) => sum + count(m), 0) };
  });
  /*
   * ★ `total` 必须按**去重后的物理库**求和，不能把 rows 简单相加：
   *   事件库常常同时是某个视图的成员，rows 相加会把同一批文档算两遍
   *   （2026-11-17 真机：2 篇文档的两个库，`total` 报成 6）。
   */
  const expanded = new Set<string>();
  for (const t of targets) {
    const members = deps.viewMembers(t);
    if (members === null) expanded.add(t);
    else for (const m of members) expanded.add(m);
  }
  let total = 0;
  for (const s of expanded) total += count(s);
  return { rows, total };
}

export interface FindTargetDeps {
  /** 授权名字全集（`findTokenAuth` 已把 viewGrants 合并进来） */
  tokenScopes: string[];
  /** 已知库名（默认 `listAllScopes()`） */
  listScopes?: () => string[];
  /** 视图表（默认 `readViews(loadConfig())`） */
  listViews?: () => Record<string, Pick<ViewConfig, 'members'>>;
  /** 复用调用方已加载的 config，省掉一次 loadConfig */
  config?: KiConfig;
}

/**
 * 解析「一组可信基线 + 一组待判定名称」的检索范围。
 *
 * **两个入参的语义严格不同**（这是本函数存在的理由，也是唯一的契约）：
 *   - `bases`：**视为已鉴权**，原样纳入，只做去重。谁传谁负责（find 传事件库并由调用方单独鉴权；
 *     recall 传空数组，把所有请求库都当 extras 走判定）。
 *   - `extras`：逐个判定 —— 不存在 / 视图无成员 / 无权，各自进 `skipped` 并跳过，
 *     **不抛错**（配置里写了不可用的名字，不该让整个查找失败）。
 *
 * ⚠️ `extras` 为空时**提前返回、不读 views.json / 不列 scope**：
 *    这是热路径（每次查找都走），且保存期预检（`chat-routes`）依赖它不做多余 IO。
 *
 * @param bases 已鉴权的基线（如 find 的事件库）；顺序即结果顺序
 * @param extras 待判定并附加的名称（配置 / 调用方传入）
 */
export function resolveScopeSet(
  bases: readonly string[],
  extras: readonly string[],
  deps: FindTargetDeps,
): FindTargetResolution {
  const targets: string[] = [];
  const skipped: SkippedTarget[] = [];
  const seen = new Set<string>();
  for (const base of bases) {
    if (seen.has(base)) continue;
    seen.add(base);
    targets.push(base);
  }
  if (extras.length === 0) return { targets, skipped };

  let scopes: string[];
  let views: Record<string, Pick<ViewConfig, 'members'>>;
  try {
    scopes = deps.listScopes?.() ?? listAllScopes();
  } catch {
    scopes = [];
  }
  try {
    views = deps.listViews?.() ?? readViews(deps.config ?? loadConfig());
  } catch {
    // views.json 读不出来：**不能当成"没有视图"静默放行**（那会让越权成员展开通过）。
    // 这里只是"配置里的视图无法确认是否存在"，按 missing 剔除并让前端如实提示。
    views = {};
  }

  const known = new Set([...scopes, ...Object.keys(views)]);
  const viewMembers = (name: string): string[] | null => views[name]?.members ?? null;

  for (const raw of extras) {
    const name = raw.trim();
    if (!name || seen.has(name)) continue;
    if (!known.has(name)) {
      skipped.push({ name, reason: 'missing' });
      continue;
    }
    const members = viewMembers(name);
    if (members !== null && members.length === 0) {
      skipped.push({ name, reason: 'view-members-changed' });
      continue;
    }
    if (!isScopeAccessAllowed(deps.tokenScopes, name, { viewMembers })) {
      skipped.push({ name, reason: 'forbidden' });
      continue;
    }
    seen.add(name);
    targets.push(name);
  }

  return { targets, skipped };
}

/**
 * 解析「AI 查找」的检索范围。
 *
 * @param eventScope 事件所在库 —— **恒在范围内**，且由调用方在此之前单独鉴权（事件库无权 → 403）
 */
export function resolveFindTargets(
  eventScope: string,
  cfg: Pick<FindConfig, 'ranges'> | undefined,
  deps: FindTargetDeps,
): FindTargetResolution {
  return resolveScopeSet([eventScope], cfg?.ranges.extraScopes ?? [], deps);
}
