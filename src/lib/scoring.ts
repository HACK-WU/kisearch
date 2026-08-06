/**
 * 评分引擎
 * 
 * - calculateScore: 简化使用密度评分
 * - recordUse: 防刷分使用记录
 * - hybridPartition: 相对排名冷热分区 + 上限截断
 * - partitionByScore: 泛型冷热分区（供 query-group 等模块复用）
 * - boundaryDecay: 边界衰减（纯函数）
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

/**
 * 相对排名冷热分区
 * - 新兴热区：最近 recentHours 内使用过，有保留席位（排除 isImported）
 * - 历史热区：按评分排序填充
 * - 常温区 + 冷区：剩余内容按比例分配
 * - 上限截断（O4 决策）
 */
export function hybridPartition(
  items: Relation[],
  now: number,
  config: PartitionConfig
): { hot: Relation[]; warm: Relation[]; cold: Relation[] } {
  const { recentHours, halfLifeHours } = config;
  const recentThreshold = recentHours * 60 * 60 * 1000;

  const itemsWithScore = items.map((item) => ({
    ...item,
    score: calculateScore(item.useCount, item.lastUsedTime, now, halfLifeHours),
  }));

  const emergingIdSet = new Set(
    itemsWithScore
      .filter((r) => r.lastUsedTime && now - r.lastUsedTime < recentThreshold)
      .map((r) => r.id)
  );

  const { hot, warm, cold } = partitionByScore(itemsWithScore, {
    getId: (r) => r.id,
    getScore: (r) => r.score,
    isEmerging: (r) => emergingIdSet.has(r.id),
    getEmergingSortScore: (r) => r.lastUsedTime ?? 0,
  }, config);

  return { hot, warm, cold };
}

// ─── 泛型冷热分区 ───

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
 * 截断策略：优先保留新兴席位，再保留历史热门。
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

  const emergingHeldCount = hot.length;

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

  // 常温 + 冷区
  const remaining = scored.filter(({ item }) => !hotIdSet.has(accessors.getId(item)));
  const warmCount = Math.ceil(scored.length * warmPercent);
  const warm = remaining.slice(0, warmCount).map(({ item }) => item);
  const cold = remaining.slice(warmCount).map(({ item }) => item);

  // 上限截断：优先保留新兴席位
  if (maxHotCount && hot.length > maxHotCount) {
    if (emergingHeldCount >= maxHotCount) {
      hot.length = maxHotCount;
    } else {
      const emergingPart = hot.slice(0, emergingHeldCount);
      const historyPart = hot.slice(emergingHeldCount, maxHotCount);
      hot.length = 0;
      hot.push(...emergingPart, ...historyPart);
    }
  }
  if (maxWarmCount && warm.length > maxWarmCount) warm.length = maxWarmCount;
  if (maxColdCount && cold.length > maxColdCount) cold.length = maxColdCount;

  return { hot, warm, cold, emergingSet: emergingIdSet };
}

// ─── 边界衰减 ───

/**
 * 边界衰减（纯函数，返回新对象，不修改输入）
 * 
 * 当新内容要进入热区时触发：
 * 1. 保存常温区最高分
 * 2. 常温区最高分 - decayStep
 * 3. 热区最低分衰减到原常温区最高分
 * 4. 热区最高分 - decayStep
 */
export function boundaryDecay(
  hotItems: Relation[],
  warmItems: Relation[],
  newScore: number,
  decayStep: number = 5
): {
  hotItems: Relation[];
  warmItems: Relation[];
  triggered: boolean;
  originMax?: number;
} {
  // 不需要触发衰减
  if (
    hotItems.length === 0 ||
    newScore <= hotItems[hotItems.length - 1].score
  ) {
    return {
      hotItems: [...hotItems],
      warmItems: [...warmItems],
      triggered: false,
    };
  }

  // 深拷贝，不修改原始数据
  const newHot = hotItems.map((item) => ({ ...item }));
  const newWarm = warmItems.map((item) => ({ ...item }));

  // 步骤1：保存常温区最高分
  const originMax = newWarm.length > 0 ? newWarm[0].score : 0;

  // 步骤2：常温区最高分 - decayStep
  if (newWarm.length > 0) {
    newWarm[0].score = Math.max(0, newWarm[0].score - decayStep);
  }

  if (newHot.length === 1) {
    // 单元素退化：该元素既是最高也是最低，按“热区最高分 - decayStep”执行，
    // 不覆盖为 originMax，避免误将分数拉低到常温区水平
    newHot[0].score = Math.max(0, newHot[0].score - decayStep);
  } else {
    // 步骤3：热区最低分衰减到原常温区最高分
    newHot[newHot.length - 1].score = originMax;
    // 步骤4：热区最高分 - decayStep
    newHot[0].score = Math.max(0, newHot[0].score - decayStep);
  }

  return {
    hotItems: newHot,
    warmItems: newWarm,
    triggered: true,
    originMax,
  };
}
