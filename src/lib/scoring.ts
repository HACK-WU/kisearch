/**
 * 评分引擎
 * 
 * - calculateScore: 简化使用密度评分
 * - recordUse: 防刷分使用记录
 * - partitionByScore: 泛型冷热分区（供 query-group 等模块复用）
 *
 * 分区不变量：hot + warm + cold 与输入条目守恒。上限截断只改变条目所属分区
 * （热区溢出回流到常温/冷区），不会让条目凭空消失；唯一例外是显式配置
 * maxColdCount 时对冷区末端的截断（冷区是最后一层，无处回流）。
 */

import {
  MIN_RECORD_INTERVAL_MINUTES,
  MAX_USE_COUNT,
  type PartitionConfig,
} from './constants.js';

// ─── 类型定义 ───

export interface Relation {
  id: string;
  text: string;
  score: number;
  useCount: number;
  lastUsedTime: number | null;
  isImported: boolean;
  /** S-04+ 新增：关联到 memory store 的 ID，用于增量 diff/delete */
  memoryId?: string;
  /** S-04+ 新增：原始文件相对路径（meta.sourceDir 的相对 posix 路径），用于 diff 关联 memoryId */
  sourcePath?: string;
  /** 方案 D（REQ-20260807-001）新增：文件级 relation 的全部 chunk memoryId（多值）；
   *  导入链路使用多值；sync-relation 等旧链路仍用单值 memoryId */
  memoryIds?: string[];
  /** 文档级自定义标签（如 ['api', 'auth']）。持久化到 KB 层，供 rebuild-vector/restore 恢复 tag 向量。
   *  缺省 undefined 或 [] 表示无自定义 tag（仅有默认的 ki-search）。 */
  tags?: string[];
}

// ─── 评分计算 ───

/**
 * 计算评分
 * score = useCount / (1 + hoursSinceLastUse / halfLifeHours)
 */
export function calculateScore(
  useCount: number,
  lastUsedTime: number | null,
  now: number,
  halfLifeHours: number = 24
): number {
  if (useCount === 0) return 0;

  const hoursSinceLastUse = lastUsedTime
    ? (now - lastUsedTime) / (60 * 60 * 1000)
    : 0;

  return useCount / (1 + hoursSinceLastUse / halfLifeHours);
}

// ─── 使用记录 ───

/**
 * 记录一次使用（5分钟防刷 + maxUseCount 上限）
 * 返回新对象，不修改输入
 */
export function recordUse(relation: Relation, now: number): Relation {
  // 防刷：与上次使用间隔小于 5 分钟，忽略
  if (
    relation.lastUsedTime &&
    now - relation.lastUsedTime < MIN_RECORD_INTERVAL_MINUTES * 60 * 1000
  ) {
    return relation;
  }

  return {
    ...relation,
    useCount: Math.min(relation.useCount + 1, MAX_USE_COUNT),
    lastUsedTime: now,
  };
}

// ─── 冷热分区 ───

export interface PartitionResult<T> {
  hot: T[];
  warm: T[];
  cold: T[];
  emergingSet: Set<string>;
}

/**
 * 泛型冷热分区算法
 *
 * 将新兴识别、评分排序、热/温/冷分配、上限截断统一为一个函数，
 * 通过 accessor 回调适配不同 item 类型（Group 路径、Relation 等）。
 *
 * 截断策略：优先保留新兴席位，再保留历史热门；被上限挤出的条目回流到候选池
 * 重新参与常温/冷区分配（保证分区守恒，条目不会因截断而在任何分区都查不到）。
 *
 * 守恒前提：`getId` 返回的 id 在 items 内唯一（真实调用方均满足：Group 路径唯一、
 * Relation 为 rel_NNN）。违约传入重复 id 时**不保证守恒**，具体表现分两种：
 * ① 重复项中有一个进了热区 → 其余同 id 项在热区填充时被 hotIdSet 跳过，又因该 id
 *    已在候选池排除集里而被过滤，最终彻底不出现（hot + warm + cold < items.length）；
 * ② 重复项全部落在热区之外 → 候选池只按「已入热区的 id」过滤、不对池内重复二次去重，
 *    故全部保留（三区之和 == items.length），但同一 id 会分散到不同分区，展示时
 *    分区标签按 hot > warm > cold 优先级只取其一。
 * 两种均属输入违约下的兜底表现、非契约（情形②选择「保留全部」而非「静默丢弃」）；
 * 回归锁见 test/lib.test.ts「重复 id 全部落在热区外时不丢条目」。
 */
export function partitionByScore<T>(
  items: T[],
  accessors: {
    getId: (item: T) => string;
    getScore: (item: T) => number;
    isEmerging: (item: T) => boolean;
    /** 新兴项排序依据（默认用 getScore），如 Relation 按 lastUsedTime 降序 */
    getEmergingSortScore?: (item: T) => number;
  },
  config: PartitionConfig
): PartitionResult<T> {
  const {
    hotPercent, warmPercent, reservedEmerging,
    minHotCount, maxHotCount, maxWarmCount, maxColdCount,
  } = config;

  const scored = items.map((item) => ({ item, score: accessors.getScore(item) }));
  scored.sort((a, b) => b.score - a.score);

  const emergingItems = items.filter(accessors.isEmerging);
  const emergingIdSet = new Set(emergingItems.map(accessors.getId));

  // 新兴热区：按 getEmergingSortScore（或 getScore）降序
  const hot: T[] = [];
  const hotIdSet = new Set<string>();
  const emergingSortFn = accessors.getEmergingSortScore ?? accessors.getScore;

  const emergingSorted = [...emergingItems].sort(
    (a, b) => emergingSortFn(b) - emergingSortFn(a)
  );
  const emergingSeats = Math.min(reservedEmerging, emergingSorted.length);
  for (let i = 0; i < emergingSeats; i++) {
    const id = accessors.getId(emergingSorted[i]);
    if (!hotIdSet.has(id)) {
      hot.push(emergingSorted[i]);
      hotIdSet.add(id);
    }
  }

  // 历史热区：按评分填充
  const totalHotSeats = Math.max(minHotCount, Math.ceil(scored.length * hotPercent));
  for (const { item } of scored) {
    if (hot.length >= totalHotSeats) break;
    const id = accessors.getId(item);
    if (!hotIdSet.has(id)) {
      hot.push(item);
      hotIdSet.add(id);
    }
  }

  // 上限截断：砍尾即可。新兴项恒位于 hot 前部（先按 recency 填新兴席位，再按 score 填历史），
  // 故砍尾天然保留新兴席位。此处刻意不写 if/else 分支做「防御」：填充顺序一旦改变，
  // 「hot 前部的新兴项数」这个量本身也不再成立，两个分支会一起失效——真正的护栏是
  // test/lib.test.ts「新兴数超过 maxHotCount 而触发截断」的顺序断言（改坏即刻红）。
  // 用 != null 判断而非 falsy：maxHotCount = 0 表示「热区不展示」，不能被当成「不限制」
  if (maxHotCount != null && hot.length > maxHotCount) {
    hot.length = maxHotCount;
  }

  // 候选池 = 未入热区的全部条目。scored 已含全量，过滤掉最终热区 id 即可；
  // 被上限挤出的项本就不在 hot 中，天然被这里接住 → 分区守恒（hot + warm + cold == items）。
  // 同分顺序 = items 输入顺序（sort 稳定），刻意不引入隐式 tie-break：原先单独前置 overflow
  // 会使「曾被挤出热区的同分项」排到其他同分项之前，实测（3000 轮随机差分）仅影响 score
  // 相同的条目、分区归属零差异，属实现副产物而非契约，故移除以让顺序可解释、可复现。
  const seen = new Set(hot.map(accessors.getId));
  const pool = scored.filter(({ item }) => !seen.has(accessors.getId(item)));
  // 降序不变量显式化。实测（mutation test：删掉本行后 lib 37/37 仍全绿）表明它**当前冗余**：
  // scored 已降序、filter 保序，故 pool 天然有序。保留是有意权衡：成本仅 O(N)（TimSort
  // 对已排序输入接近线性），收益是将来有人改动 scored 的排序方向或 pool 的构建方式时，
  // 不会静默产出乱序分区（warm/cold 的切分直接依赖 pool 有序，乱了会分错层且不报错）。
  pool.sort((a, b) => b.score - a.score);

  // 常温 + 冷区：warmPercent 以「热区之外的候选池」为基准，
  // 使常温/冷区配比与热区规模解耦（原实现以全量为基准，热区越大冷区被挤占越多）
  const warmCount = Math.ceil(pool.length * warmPercent);
  let warm = pool.slice(0, warmCount).map(({ item }) => item);
  let cold = pool.slice(warmCount).map(({ item }) => item);

  // 常温区截断：溢出项回流冷区（同样不得丢弃）
  if (maxWarmCount != null && warm.length > maxWarmCount) {
    cold = [...warm.slice(maxWarmCount), ...cold];
    warm = warm.slice(0, maxWarmCount);
  }
  // 冷区截断：唯一的展示丢弃点（冷区已是最后一层，无处回流；默认 null 不截断）
  if (maxColdCount != null && cold.length > maxColdCount) {
    cold = cold.slice(0, maxColdCount);
  }

  return { hot, warm, cold, emergingSet: emergingIdSet };
}
