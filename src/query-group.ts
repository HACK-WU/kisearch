#!/usr/bin/env node
/**
 * query-group.ts - 查询 Group + 词云生成 + 新兴热区展示 + 格式化输出
 *
 * 用法:
 *   npx jiti src/query-group.ts --scope <scope> [--groups <g1,g2>]
 *         [--hot-count <count>] [--depth <depth>] [--mode <mode>]
 *
 *   --mode 支持逗号分隔多值：hot|warm|cold|emerging|full
 *   例如：--mode hot,warm 或 --mode full
 *   --subtree <path>：以指定 Group 为根输出子树结构（结构导航视角，与 --groups 互斥）
 */

import { Command } from 'commander';
import { readJson, ensureScopeDir, readGroupIndex } from './lib/store.js';
import {
  getGroupIndexPath,
  getRelationsCachePath,
  validateScope,
} from './lib/scope.js';
import type { GroupIndex } from './lib/scope.js';
import { calculateScore, partitionByScore } from './lib/scoring.js';
import type { Relation, PartitionResult as ScoringPartitionResult } from './lib/scoring.js';
import { DEFAULT_PARTITION_CONFIG } from './lib/constants.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import type { ResolveResult } from './lib/group-resolve.js';
import { vectorSearch, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';

// ─── 类型定义 ───

interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
}

interface RelationsCache {
  version: number;
  scope: string;
  partition_config: typeof DEFAULT_PARTITION_CONFIG;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

// ─── 数据加载 ───

function loadGroupIndex(scope: string): GroupIndex | null {
  return readGroupIndex(scope);
}

/**
 * 在加载边界一次性校验 relations-cache 的结构，使内部全部 hot_relations 访问点
 * （getGroupAggregateScores / isGroupEmerging / formatGroupRelations /
 *   collectHotRelations / 子树与 full 递归展示）无需各自防御。
 *
 * 为什么 fail-loud 而不是在各消费点 `?? []` 静默降级：
 * - GroupData.hot_relations 声明为必需字段，写入方（import.ts / sync-relation.ts 建组时
 *   即初始化为 []）保证其存在，故缺失/非数组只可能是文件被外部改坏或迁移中断；
 * - query-group 是只读展示主路径，把损坏的 Group 静默当成「0 分 / 0 条 Relation」会让
 *   用户与 AI 误判该模块没有知识，且据此算出的冷热分区本身就是错的；
 * - 与 readJson 的 CORRUPT_JSON（JSON 语法层）分层互补：语法正确 ≠ 结构合法，
 *   口径对齐 config.ts 的 CONFIG_FIELD_INVALID。
 *
 * 抛出点位于 executeQueryGroup 的 try 内，对外仍表现为 {ok:false, error}，
 * 不违背「executeXxx 不抛异常、失败以 ok:false 返回」的可复用纯函数契约
 * （MCP 层 ki_query_group 将其转为 isError:true + 同文案；web 前端不调用本工具）。
 *
 * ⚠ 口径差异是有意的，勿误「统一」：同一份 relations-cache，
 * `mcp-http-api.ts::buildDocList` 用宽松降级（`hot_relations?` + `?? []`）。因为那里只是
 * 枚举文档清单（name/group/path/tags）给前端列表页，缺字段仅使清单少几条、不产出错误结论；
 * 而本模块要算聚合评分与冷热分区，缺字段会得出「该 Group 0 分 / 全进冷区」的**错误结论**。
 * 同理 `relation-map.ts` 对 cache 损坏降级空 Map（它是检索的可选增强，缺了只丢
 * group/relation 标注）；而 `wiki-sync.ts::backfillWiki` 则 fail-loud（数据源不完整时
 * 写出的 wiki 是错的）。判据统一为：**降级后会不会产出错误结论**——会则 fail-loud。
 */
function assertCacheShape(cache: RelationsCache, scope: string, cachePath: string): void {
  const MAX_SHOW = 5;
  // 出路刻意不预置 --yes：restore.ts 对快照还原是「先预览总览 → 再加 --yes 执行」的两步门禁
  // （NEG-11，previewAndRequireYes）。预置 --yes 等于替使用者跳过预览，直接触发不可逆的
  // 「删除 + 覆盖 scope 目录」，且看不到将使用哪个快照（默认取最新，可能早于现有数据）；
  // 本文案还会经 MCP ki_query_group（isError:true）原样流给 AI agent，被照抄执行的风险更高。
  const hint = `建议：先执行 ki restore ${scope} --from-snapshot 查看快照总览（还原会删除并覆盖该 scope 目录，确认来源快照无误后再按提示加 --yes 执行）；`
    + `或手动修正下列 Group 的 hot_relations 字段（应为数组，无 Relation 时为 []）`;

  if (!cache.groups || typeof cache.groups !== 'object') {
    throw new Error(
      `CACHE_SHAPE_INVALID: relations-cache.json 缺少 groups 对象：${cachePath}\n${hint}`
    );
  }

  const broken = Object.entries(cache.groups)
    .filter(([, data]) => !data || typeof data !== 'object' || !Array.isArray(data.hot_relations))
    .map(([groupPath]) => groupPath);
  if (broken.length === 0) return;

  const lines = broken.slice(0, MAX_SHOW).map((p) => `  - ${p}：hot_relations 缺失或不是数组`);
  if (broken.length > MAX_SHOW) {
    lines.push(`  ...（另有 ${broken.length - MAX_SHOW} 个 Group 同样损坏，修正以上问题后继续检查）`);
  }
  throw new Error(
    `CACHE_SHAPE_INVALID: relations-cache.json 结构校验失败：${cachePath}`
    + `（共 ${broken.length} 个 Group 损坏）\n${lines.join('\n')}\n${hint}`
  );
}

function loadRelationsCache(scope: string): RelationsCache | null {
  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<RelationsCache>(cachePath);
  // cache 为 null 是合法状态（scope 只有 group-index、尚未写入任何 Relation），保持原降级语义；
  // JSON 语法损坏由 readJson 抛 CORRUPT_JSON，此处只补结构层校验。
  if (!cache) return null;
  assertCacheShape(cache, scope, cachePath);
  return cache;
}

// ─── 树操作 ───

function collectAllGroupPaths(
  groups: Record<string, Record<string, unknown>>
): string[] {
  const paths: string[] = [];
  function walk(
    obj: Record<string, unknown>,
    prefix: string
  ): void {
    for (const [key, value] of Object.entries(obj)) {
      const fullPath = prefix ? `${prefix}/${key}` : key;
      paths.push(fullPath);
      if (typeof value === 'object' && value !== null) {
        walk(value as Record<string, unknown>, fullPath);
      }
    }
  }
  walk(groups, '');
  return paths;
}

/**
 * 按路径提取树节点（子树根）；路径不存在返回 null，叶子节点返回空对象。
 * 与 group-resolve.getDirectChildren 同构，但返回节点本身供子树渲染。
 */
function getTreeNodeByPath(
  groups: Record<string, Record<string, unknown>>,
  groupPath: string
): Record<string, unknown> | null {
  const segments = groupPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  let current: unknown = groups;
  for (const seg of segments) {
    if (typeof current !== 'object' || current === null) return null;
    current = (current as Record<string, unknown>)[seg];
    if (current === undefined) return null;
  }
  return typeof current === 'object' && current !== null ? (current as Record<string, unknown>) : {};
}

// ─── 评分聚合 ───

/**
 * Group 聚合评分：取组内 Relation 评分的**均值**（非求和）。
 * 求和会让「条目多但冷」的 Group 仅凭规模压过「条目少但活跃」的 Group
 * （实测：30 条×useCount=5×150h 前 = 20.7 > 2 条×useCount=10×刚用 = 19.6），
 * 均值反映的是「该 Group 的平均活跃度」，与冷热语义一致。
 * 空 Group 记 0 分（避免 0/0 = NaN 污染排序）。
 * hot_relations 的存在性由加载边界的 assertCacheShape 保证，此处不再重复防御。
 */
function getGroupAggregateScores(
  groups: Record<string, GroupData>,
  now: number,
  halfLifeHours: number
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [path, data] of Object.entries(groups)) {
    const relations = data.hot_relations;
    if (relations.length === 0) {
      scores.set(path, 0);
      continue;
    }
    const totalScore = relations.reduce((sum, rel) => {
      return sum + calculateScore(rel.useCount, rel.lastUsedTime, now, halfLifeHours);
    }, 0);
    scores.set(path, totalScore / relations.length);
  }
  return scores;
}

// ─── 分区 ───

interface PartitionResult {
  hot: string[];
  warm: string[];
  cold: string[];
  emergingSet: Set<string>;
  hotSet: Set<string>;
  warmSet: Set<string>;
  coldSet: Set<string>;
}

function partitionGroups(
  allPaths: string[],
  groupScores: Map<string, number>,
  groupsData: Record<string, GroupData>,
  now: number,
  config: typeof DEFAULT_PARTITION_CONFIG
): PartitionResult {
  const recentThreshold = config.recentHours * 60 * 60 * 1000;

  const isGroupEmerging = (path: string): boolean => {
    const data = groupsData[path];
    if (!data) return false;
    return data.hot_relations.some(
      (r) => r.lastUsedTime !== null && now - r.lastUsedTime < recentThreshold
    );
  };

  const result = partitionByScore(allPaths, {
    getId: (p) => p,
    getScore: (p) => groupScores.get(p) || 0,
    isEmerging: isGroupEmerging,
  }, config);

  return {
    ...result,
    hotSet: new Set(result.hot),
    warmSet: new Set(result.warm),
    coldSet: new Set(result.cold),
  };
}

function getPartitionLabel(
  path: string,
  partition: PartitionResult
): string {
  if (partition.emergingSet.has(path) && partition.hotSet.has(path)) {
    return '[新兴热]';
  }
  if (partition.hotSet.has(path)) return '[热]';
  if (partition.warmSet.has(path)) return '[常温]';
  return '[冷]';
}

// ─── 格式化 ───

function fmtScore(score: number): string {
  return score % 1 === 0 ? score.toString() : score.toFixed(1);
}

function getRelPartitionLabel(
  rel: Relation,
  hotIdSet: Set<string>,
  warmIdSet: Set<string>,
  emergingSet: Set<string>
): string {
  if (rel.isImported) return '[📥]';
  if (emergingSet.has(rel.id) && hotIdSet.has(rel.id)) return '[新兴热]';
  if (hotIdSet.has(rel.id)) return '[热]';
  if (warmIdSet.has(rel.id)) return '[常温]';
  return '[冷]';
}

function partitionRelations(
  relations: Relation[],
  now: number,
  config: typeof DEFAULT_PARTITION_CONFIG
): ScoringPartitionResult<Relation> {
  const { recentHours, halfLifeHours } = config;
  const recentThreshold = recentHours * 60 * 60 * 1000;

  const itemsWithScore = relations.map((r) => ({
    ...r,
    score: calculateScore(r.useCount, r.lastUsedTime, now, halfLifeHours),
  }));

  const emergingIdSet = new Set(
    itemsWithScore
      .filter((r) => r.lastUsedTime && now - r.lastUsedTime < recentThreshold)
      .map((r) => r.id)
  );

  return partitionByScore(itemsWithScore, {
    getId: (r) => r.id,
    getScore: (r) => r.score,
    isEmerging: (r) => emergingIdSet.has(r.id),
    getEmergingSortScore: (r) => r.lastUsedTime ?? 0,
  }, config);
}

// ─── 展示：热门列表 ───

interface HotRelationItem {
  text: string;
  score: number;
  groupPath: string;
  isImported: boolean;
  isEmerging: boolean;
}

function formatHotRelations(
  allRelations: HotRelationItem[],
  hotCount: number
): string {
  const bestByGroup = new Map<string, typeof allRelations[number]>();
  for (const item of allRelations) {
    const existing = bestByGroup.get(item.groupPath);
    if (!existing || item.score > existing.score) {
      bestByGroup.set(item.groupPath, item);
    }
  }
  const sorted = [...bestByGroup.values()].sort((a, b) => b.score - a.score);
  const top = sorted.slice(0, hotCount);
  if (top.length === 0) return '(暂无热门索引)';

  return top
    .map((item, i) => {
      const prefix = i === top.length - 1 ? '└──' : '├──';
      const label = item.isImported
        ? '[📥]'
        : item.isEmerging
          ? '[新兴热]'
          : '[热]';
      return `${prefix} ${item.groupPath} → ${item.text} (score: ${fmtScore(item.score)}) ${label}`;
    })
    .join('\n');
}

// ─── 展示：树 ───

function renderTree(
  groups: Record<string, Record<string, unknown>>,
  groupScores: Map<string, number>,
  partition: PartitionResult,
  depth: number,
  partitionFilter: string | null
): string {
  const lines: string[] = [];

  // 过滤集合
  let filterSet: Set<string> | null = null;
  if (partitionFilter && partitionFilter !== 'all') {
    filterSet = new Set<string>();
    const source =
      partitionFilter === 'hot' ? partition.hot :
      partitionFilter === 'warm' ? partition.warm :
      partitionFilter === 'cold' ? partition.cold :
      partitionFilter === 'emerging' ? partition.hot.filter((p) => partition.emergingSet.has(p)) :
      [];
    for (const p of source) filterSet.add(p);
  }

  const topNames = Object.keys(groups);
  topNames.forEach((name, idx) => {
    const isLast = idx === topNames.length - 1;
    const score = groupScores.get(name) || 0;
    const label = getPartitionLabel(name, partition);

    if (!filterSet || hasVisibleDescendant(groups[name] as Record<string, unknown>, name, filterSet)) {
      lines.push(`${name}/ (score: ${fmtScore(score)}) ${label}`);
    }

    const childObj = groups[name] as Record<string, unknown>;
    renderTreeChildren(
      childObj, name, isLast ? '' : '│   ', 1, depth,
      groupScores, partition, filterSet, lines
    );
  });

  return lines.join('\n');
}

function hasVisibleDescendant(
  node: Record<string, unknown>,
  prefix: string,
  filterSet: Set<string>
): boolean {
  for (const [key, value] of Object.entries(node)) {
    const childPath = `${prefix}/${key}`;
    if (filterSet.has(childPath)) return true;
    if (typeof value === 'object' && value !== null) {
      if (hasVisibleDescendant(value as Record<string, unknown>, childPath, filterSet)) return true;
    }
  }
  return false;
}

function renderTreeChildren(
  node: Record<string, unknown>,
  parentPath: string,
  parentPrefix: string,
  currentDepth: number,
  maxDepth: number,
  groupScores: Map<string, number>,
  partition: PartitionResult,
  filterSet: Set<string> | null,
  lines: string[]
): void {
  if (currentDepth >= maxDepth) return;

  const children = Object.entries(node);
  const visibleChildren = filterSet
    ? children.filter(([key, value]) => {
        const childPath = `${parentPath}/${key}`;
        if (filterSet.has(childPath)) return true;
        if (typeof value === 'object' && value !== null) {
          return hasVisibleDescendant(value as Record<string, unknown>, childPath, filterSet);
        }
        return false;
      })
    : children;

  visibleChildren.forEach(([key, value], idx) => {
    const isLast = idx === visibleChildren.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = `${parentPath}/${key}`;
    const score = groupScores.get(childPrefix) || 0;
    const label = getPartitionLabel(childPrefix, partition);
    const childNode = value as Record<string, unknown>;
    const hasChildren = Object.keys(childNode).length > 0;

    lines.push(`${parentPrefix}${connector}${key} (score: ${fmtScore(score)}) ${label}`);

    if (hasChildren) {
      const childIndent = isLast ? '    ' : '│   ';
      if (currentDepth + 1 >= maxDepth) {
        lines.push(`${parentPrefix}${childIndent}...`);
      } else {
        renderTreeChildren(
          childNode, childPrefix, parentPrefix + childIndent,
          currentDepth + 1, maxDepth, groupScores, partition, filterSet, lines
        );
      }
    }
  });
}

/** 子树视图：以指定路径为根渲染结构树（节点带 score + 分区标签，深度从子树根起算） */
function renderSubtree(
  rootNode: Record<string, unknown>,
  rootPath: string,
  groupScores: Map<string, number>,
  partition: PartitionResult,
  depth: number
): string {
  const lines: string[] = [];
  const rootScore = groupScores.get(rootPath) || 0;
  lines.push(`${rootPath}/ (score: ${fmtScore(rootScore)}) ${getPartitionLabel(rootPath, partition)}`);
  renderTreeChildren(rootNode, rootPath, '', 1, depth, groupScores, partition, null, lines);
  return lines.join('\n');
}

function renderCompactTree(
  groups: Record<string, Record<string, unknown>>,
  depth: number
): string {
  const lines: string[] = [];
  const topNames = Object.keys(groups);

  topNames.forEach((name) => {
    lines.push(`${name}/`);
    renderCompactChildren(
      groups[name] as Record<string, unknown>,
      '', 1, depth, lines
    );
  });

  return lines.join('\n');
}

function renderCompactChildren(
  node: Record<string, unknown>,
  parentPrefix: string,
  currentDepth: number,
  maxDepth: number,
  lines: string[]
): void {
  if (currentDepth >= maxDepth) return;

  const children = Object.entries(node);
  children.forEach(([key, value], idx) => {
    const isLast = idx === children.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childNode = value as Record<string, unknown>;
    const hasChildren = Object.keys(childNode).length > 0;

    lines.push(`${parentPrefix}${connector}${key}`);

    if (hasChildren) {
      const childIndent = isLast ? '    ' : '│   ';
      if (currentDepth + 1 >= maxDepth) {
        lines.push(`${parentPrefix}${childIndent}...`);
      } else {
        renderCompactChildren(
          childNode, parentPrefix + childIndent,
          currentDepth + 1, maxDepth, lines
        );
      }
    }
  });
}

// ─── 展示：Group 详情 ───

function formatGroupRelations(
  groupPath: string,
  data: GroupData,
  now: number,
  config: typeof DEFAULT_PARTITION_CONFIG,
  hotCount: number,
  modes: string[]
): string {
  const lines: string[] = [];
  const relations = data.hot_relations;

  if (relations.length === 0) {
    lines.push(`=== ${groupPath} ===`);
    lines.push('');
    lines.push('(暂无 Relations)');
    lines.push('');
    lines.push('💡 可使用 sync-relation 写入知识条目：');
    lines.push(`   ki sync-relation --scope <scope> --group "${groupPath}" --relation <描述> --module-info <内容>`);
    return lines.join('\n');
  }

  // 分区
  const partition = partitionRelations(relations, now, config);

  if (modes.includes('compact')) {
    lines.push(`${groupPath}:`);
    lines.push('热门知识:');
    const top = partition.hot.slice(0, hotCount);
    top.forEach((rel) => lines.push(`├── ${rel.text}`));
    lines.push('');
    return lines.join('\n');
  }

  const isFull = modes.includes('full');
  const hotIdSet = new Set(partition.hot.map((r) => r.id));
  const warmIdSet = new Set(partition.warm.map((r) => r.id));

  lines.push(`=== ${groupPath} ===`);
  lines.push('');

  if (isFull) {
    // full 模式：按分区展示全量 Relations，各分区渲染上限 maxFullCount 防止输出过长
    // （分区本身守恒，此处的截断只是渲染层；提示需给出可执行的完整查看命令）
    const maxFullCount = 50;
    const sections: Array<{ title: string; mode: string; rels: Relation[] }> = [
      { title: `🔥 热区 (全部 ${partition.hot.length})`, mode: 'hot', rels: partition.hot },
      { title: `🌡️ 常温区 (全部 ${partition.warm.length})`, mode: 'warm', rels: partition.warm },
      { title: `❄️ 冷区 (全部 ${partition.cold.length})`, mode: 'cold', rels: partition.cold },
    ];
    for (const section of sections) {
      if (section.rels.length === 0) continue;
      const truncated = section.rels.length > maxFullCount;
      const shown = truncated ? section.rels.slice(0, maxFullCount) : section.rels;
      lines.push(section.title);
      shown.forEach((rel, i) => {
        const isLast = !truncated && i === shown.length - 1;
        const prefix = isLast ? '└──' : '├──';
        const label = getRelPartitionLabel(rel, hotIdSet, warmIdSet, partition.emergingSet);
        lines.push(`${prefix} ${rel.text} (score: ${fmtScore(rel.score)}) ${label}`);
      });
      if (truncated) {
        // hot/warm/cold 模式同样受 --hot-count（默认 5）截断，故出路必须带上放大后的 --hot-count
        lines.push(`└── ... 还有 ${section.rels.length - maxFullCount} 个未展示（full 模式每区最多渲染 ${maxFullCount} 条，分区数据本身无丢失）；查看该区完整列表：--mode ${section.mode} --hot-count ${section.rels.length}`);
      }
      lines.push('');
    }
  } else {
    // 非 full：按指定分区展示，截断到 hotCount
    for (const mode of modes) {
      const rels = mode === 'hot' ? partition.hot
        : mode === 'warm' ? partition.warm
        : mode === 'cold' ? partition.cold
        : mode === 'emerging' ? partition.hot.filter(r => partition.emergingSet.has(r.id))
        : [];
      if (rels.length === 0) continue;
      const title = getModeTitle(mode);
      const top = rels.slice(0, hotCount);
      // 截断必须可感知 + 给出路（与 full 模式同一口径）。默认 --hot-count 5 下，
      // 一个 120 条 Relation 的 Group 只渲染 5 条，而原标题 `(Top 5)` 不含本区总数 ——
      // 使用者（尤其是 AI）会据此误判「该 Group 只有 5 条知识」。实测：120 条时
      // cold 区有 60 条、默认只渲染 5 条且零提示（分区守恒保证了数据在，但看不见等于没召回）。
      const truncated = rels.length > top.length;
      lines.push(`${title} (Top ${Math.min(hotCount, top.length)}${truncated ? ` / 本区共 ${rels.length}` : ''}):`);
      top.forEach((rel, i) => {
        const prefix = !truncated && i === top.length - 1 ? '└──' : '├──';
        const label = getRelPartitionLabel(rel, hotIdSet, warmIdSet, partition.emergingSet);
        lines.push(`${prefix} ${rel.text} (score: ${fmtScore(rel.score)}) ${label}`);
      });
      if (truncated) {
        lines.push(`└── ... 还有 ${rels.length - top.length} 个未展示；查看本区完整列表：--mode ${mode} --hot-count ${rels.length}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── 统计 ───

function computeStats(
  allPaths: string[],
  partition: PartitionResult
): { total: number; hot: number; emerging: number; warm: number; cold: number } {
  return {
    total: allPaths.length,
    hot: partition.hot.length,
    emerging: partition.hot.filter((p) => partition.emergingSet.has(p)).length,
    warm: partition.warm.length,
    cold: partition.cold.length,
  };
}

// ─── 输出 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── CLI 辅助 ───

const ALLOWED_MODES = ['hot', 'warm', 'cold', 'emerging', 'full'] as const;
const PARTITION_DISPLAY_ORDER = ['hot', 'warm', 'cold', 'emerging'] as const;

interface CliOpts {
  scope: string;
  depth: number;
  hotCount: number;
  modes: string[];
  groupsParam?: string;
  /** 子树视图：以指定 Group 路径为根（与 groupsParam 互斥） */
  subtreeParam?: string;
  autoFallback?: boolean;
}

function parseCliOpts(opts: Record<string, any>): CliOpts {
  const scope = opts.scope;

  const rawDepth = parseInt(opts.depth, 10);
  const depth = Number.isFinite(rawDepth) && rawDepth > 0 ? Math.min(rawDepth, 10) : 4;
  if (!Number.isFinite(rawDepth) || rawDepth <= 0) {
    console.warn('警告：--depth 取值无效或非正整数，已回退为默认 4');
  } else if (rawDepth > 10) {
    console.warn(`警告：--depth ${rawDepth} 超过最大值，已限制为 10`);
  }

  const rawHotCount = parseInt(opts.hotCount, 10);
  const hotCount = Number.isFinite(rawHotCount) && rawHotCount > 0 ? rawHotCount : 5;
  if (!Number.isFinite(rawHotCount) || rawHotCount <= 0) {
    console.warn('警告：--hot-count 取值无效或非正整数，已回退为默认 5');
  }

  // 解析逗号分隔的 mode 值，过滤空字符串
  const modes = opts.mode.split(',').map((m: string) => m.trim()).filter((m: string) => m.length > 0);

  return {
    scope,
    depth,
    hotCount,
    modes,
    groupsParam: opts.groups,
    subtreeParam: opts.subtree,
    autoFallback: opts.autoFallback,
  };
}

function collectHotRelations(
  groupsData: Record<string, GroupData>,
  now: number,
  halfLifeHours: number,
  emergingSet: Set<string>
): HotRelationItem[] {
  const result: HotRelationItem[] = [];
  for (const [gp, data] of Object.entries(groupsData)) {
    for (const rel of data.hot_relations) {
      result.push({
        text: rel.text,
        score: calculateScore(rel.useCount, rel.lastUsedTime, now, halfLifeHours),
        groupPath: gp,
        isImported: rel.isImported,
        isEmerging: emergingSet.has(gp),
      });
    }
  }
  return result;
}

function filterRelationsByMode(
  relations: HotRelationItem[],
  mode: string,
  partition: PartitionResult
): HotRelationItem[] {
  if (mode === 'hot') {
    return relations.filter(r => partition.hotSet.has(r.groupPath));
  } else if (mode === 'warm') {
    return relations.filter(r => partition.warmSet.has(r.groupPath));
  } else if (mode === 'cold') {
    return relations.filter(r => partition.coldSet.has(r.groupPath));
  } else if (mode === 'emerging') {
    return relations.filter(r => partition.emergingSet.has(r.groupPath));
  }
  // mode === 'full' 或其他未知 mode，返回所有关系
  return relations;
}

function getModeTitle(mode: string): string {
  const titles: Record<string, string> = {
    hot: '热门索引',
    warm: '常温索引',
    cold: '冷区索引',
    emerging: '新兴热区索引',
  };
  return titles[mode] || '索引';
}

// ─── MCP / CLI 共享纯函数 ───

export interface QueryGroupParams {
  scope: string;
  groupsParam?: string;
  /** 子树视图：以指定 Group 路径为根输出结构树（与 groupsParam 互斥；不受 mode 过滤） */
  subtreeParam?: string;
  hotCount: number;
  depth: number;
  modes: string[];
  autoFallback?: boolean;  // 语义兜底开关，默认 true
}

export type QueryGroupResult =
  | { ok: true; scope: string; output: string }
  | { ok: false; error: string };

export async function executeQueryGroup(params: QueryGroupParams): Promise<QueryGroupResult> {
  try {
    const { scope, depth, hotCount, modes } = params;
    // groups 原样透传（存量行为零变化）；仅 subtree 做归一化（新参数，空串等价未传）
    const groupsParam = params.groupsParam;
    const subtreeParam = params.subtreeParam?.trim() || undefined;
    const autoFallback = params.autoFallback ?? true;

    // 互斥护栏：两种路径视角语义不同（Relations 视图 vs 结构子树），同时传时 fail-loud 避免歧义。
    // groups 侧独立 trim 判定：避免"纯空白 groups + subtree"被误放行落入子树以外的分支。
    if (groupsParam?.trim() && subtreeParam) {
      return { ok: false, error: 'groups 与 subtree 互斥：前者展示 Group 的 Relations，后者展示子树结构，请只传其一' };
    }

    if (modes.length === 0) {
      return { ok: false, error: '--mode 不能为空，有效值：hot | warm | cold | emerging | full' };
    }
    for (const mode of modes) {
      if (!ALLOWED_MODES.includes(mode as typeof ALLOWED_MODES[number])) {
        return { ok: false, error: `--mode 无效值：${mode}，有效值：hot | warm | cold | emerging | full` };
      }
    }

    validateScope(scope);
    ensureScopeDir(scope);

    const groupIndex = loadGroupIndex(scope);
    const relationsCache = loadRelationsCache(scope);

    if (!groupIndex) {
      return { ok: false, error: 'group-index.json 不存在' };
    }

    const now = Date.now();
    const config = relationsCache?.partition_config || DEFAULT_PARTITION_CONFIG;
    const groupsData = relationsCache?.groups || {};

    // 子树视图：以指定 Group 为根输出结构树（结构导航视角，不受 hot/warm/cold mode 过滤）
    if (subtreeParam) {
      const rawPath = subtreeParam.replace(/^\/+|\/+$/g, '');
      if (!rawPath) {
        return { ok: false, error: 'subtree 路径解析为空：请传入有效的 Group 路径' };
      }
      const resolved = await resolveGroupPath(rawPath, groupIndex, groupsData, scope);
      if (!resolved.matched) {
        let baseOutput = `=== 子树: ${rawPath} ===\n\n(Group 路径不存在)` + (resolved.hint ? `\n\n${resolved.hint}` : '');
        if (autoFallback) {
          try {
            const avail = await ensureVectorAvailable();
            if (avail.available) {
              const semResults = await vectorSearch({ scope, query: rawPath, limit: 5, tags: 'ki-path' });
              if (semResults.length > 0) {
                const fallbackLines = semResults.map(
                  r => `├── [score: ${r.score.toFixed(2)}] ${r.content.slice(0, 120)}${r.content.length > 120 ? '...' : ''}`
                );
                baseOutput += `\n\n💡 语义匹配结果（来自通用搜索）：\n${fallbackLines.join('\n')}`;
              }
            }
          } catch { /* 语义兜底失败，静默降级 */ }
        }
        return { ok: true, scope, output: baseOutput };
      }

      const rootPath = resolved.resolvedPath;
      const rootNode = getTreeNodeByPath(groupIndex.groups, rootPath) ?? {};
      const childCount = Object.values(rootNode).filter((v) => typeof v === 'object' && v !== null).length;

      const parts: string[] = [];
      if (resolved.hint) parts.push(resolved.hint);

      if (childCount === 0) {
        // REQ-03：无子 Group → 提示 + 自身 Relations 概要（空结果不丢上下文）。
        // 概要固定按热区展示：子树是结构导航视角，不受用户 --mode 过滤，
        // 避免 --mode cold 时热区 Relations 被滤空造成"有数据却显示空"的误导。
        const lines = [`=== 子树: ${rootPath} ===`, '', '该 Group 下无子 Group。'];
        const data = groupsData[rootPath];
        if (data && data.hot_relations.length > 0) {
          lines.push('', formatGroupRelations(rootPath, data, now, config, hotCount, ['hot']));
        } else {
          lines.push('', '(该 Group 也暂无 Relations)');
        }
        parts.push(lines.join('\n'));
      } else {
        const allPaths = collectAllGroupPaths(groupIndex.groups);
        const groupScores = getGroupAggregateScores(groupsData, now, config.halfLifeHours);
        const partition = partitionGroups(allPaths, groupScores, groupsData, now, config);
        parts.push(`=== 子树: ${rootPath} ===`);
        parts.push(renderSubtree(rootNode, rootPath, groupScores, partition, depth));
      }
      return { ok: true, scope, output: parts.join('\n\n') };
    }

    // 指定 Group → 显示 Relations + 词云
    if (groupsParam) {
      const groupPaths = groupsParam.split(',').map((s: string) => s.trim().replace(/^\/+|\/+$/g, ''));
      const results: string[] = [];
      // 预解析所有路径，记录已显式指定的路径，递归时跳过避免重复展示
      const explicitPaths = new Set<string>();
      const resolvedList = await Promise.all(groupPaths.map(gp => resolveGroupPath(gp, groupIndex, groupsData, scope)));
      for (const r of resolvedList) {
        if (r.matched) explicitPaths.add(r.resolvedPath);
      }

      for (let idx = 0; idx < resolvedList.length; idx++) {
        const resolved = resolvedList[idx];
        const gp = groupPaths[idx];

        if (!resolved.matched) {
          const baseOutput = `=== ${gp} ===\n\n(暂无 Relations)\n\n💡 可使用 sync-relation 写入知识条目：\n   ki sync-relation --scope ${scope} --group "${gp}" --relation <描述> --module-info <内容>\n\n${resolved.hint}`;

          // 语义兜底：精确匹配和 ki-path/ki-relation 兜底均未命中时尝试通用语义搜索
          if (autoFallback) {
            try {
              const avail = await ensureVectorAvailable();
              if (avail.available) {
                const semResults = await vectorSearch({ scope, query: gp, limit: 5, tags: 'ki-path' });
                if (semResults.length > 0) {
                  const fallbackLines = semResults.map(
                    r => `├── [score: ${r.score.toFixed(2)}] ${r.content.slice(0, 120)}${r.content.length > 120 ? '...' : ''}`
                  );
                  results.push(baseOutput + `\n\n💡 语义匹配结果（来自通用搜索）：\n${fallbackLines.join('\n')}`);
                  continue;
                }
              }
            } catch { /* 语义兜底失败，静默降级 */ }
          }

          results.push(baseOutput);
          continue;
        }

        const data = groupsData[resolved.resolvedPath];

        if (!data) {
          if (resolved.hint) results.push(resolved.hint);
          results.push(`=== ${resolved.resolvedPath} ===\n\n(该 Group 路径存在但暂无 Relations)\n\n💡 可使用 sync-relation 写入知识条目：\n   ki sync-relation --scope ${scope} --group "${resolved.resolvedPath}" --relation <描述> --module-info <内容>`);
          continue;
        }

        if (resolved.hint) results.push(resolved.hint);
        results.push(formatGroupRelations(resolved.resolvedPath, data, now, config, hotCount, modes));

        // full 模式：递归展示子 Group 的 Relations
        if (modes.includes('full')) {
          const childPrefix = resolved.resolvedPath + '/';
          const childPaths = Object.keys(groupsData)
            .filter(p => p.startsWith(childPrefix) && p !== resolved.resolvedPath && !explicitPaths.has(p))
            .sort();
          for (const childPath of childPaths) {
            const childData = groupsData[childPath];
            if (childData && childData.hot_relations.length > 0) {
              results.push(formatGroupRelations(childPath, childData, now, config, hotCount, modes));
            }
          }
        }
      }

      return { ok: true, scope, output: results.join('\n\n') };
    }

    // 完整展示：多分区索引 + 可选完整树 + 统计
    const allPaths = collectAllGroupPaths(groupIndex.groups);
    const groupScores = getGroupAggregateScores(groupsData, now, config.halfLifeHours);
    const partition = partitionGroups(allPaths, groupScores, groupsData, now, config);
    const stats = computeStats(allPaths, partition);

    const lines: string[] = [];
    lines.push(`=== 知识索引 [scope: ${scope}] ===`);
    lines.push('');

    const allRelations = collectHotRelations(groupsData, now, config.halfLifeHours, partition.emergingSet);

    for (const mode of PARTITION_DISPLAY_ORDER) {
      if (!modes.includes(mode)) continue;
      const filteredRelations = filterRelationsByMode(allRelations, mode, partition);
      const title = getModeTitle(mode);
      if (filteredRelations.length > 0) {
        lines.push(`🔥 ${title} (Top ${hotCount}):`);
        lines.push(formatHotRelations(filteredRelations, hotCount));
        lines.push('');
      }
    }

    if (modes.includes('full')) {
      lines.push('📁 完整索引树:');
      lines.push(renderTree(groupIndex.groups, groupScores, partition, depth, null));
      lines.push('');
    }

    lines.push('📊 统计信息:');
    lines.push(`- 总索引数: ${stats.total}`);
    lines.push(`- 热区索引: ${stats.hot} (新兴热: ${stats.emerging}, 历史热: ${stats.hot - stats.emerging})`);
    lines.push(`- 常温区索引: ${stats.warm}`);
    lines.push(`- 冷区索引: ${stats.cold}`);

    return { ok: true, scope, output: lines.join('\n') };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('query-group')
  .showHelpAfterError()
  .description('查询 Group + 格式化输出')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('-g, --groups <groups>', '逗号分隔的 Group 路径列表')
  .option('--subtree <path>', '以指定 Group 路径为根输出子树结构（与 --groups 互斥）')
  .option('--hot-count <count>', '热门展示个数', '5')
  .option('--depth <depth>', '索引层级深度', '4')
  .option('--mode <mode>', '展示分区：hot|warm|cold|emerging|full（支持逗号分隔多值）', 'hot')
  .option('--no-auto-fallback', '禁用语义兜底（默认开启）')
  .action(async (opts) => {
    const result = await executeQueryGroup(parseCliOpts({ ...opts, scope: resolveScope(loadConfig(), opts.scope) }));
    if (result.ok) {
      // 文本展示输出：开头标注 scope，保证输出内容自解释
      console.log(`[scope: ${result.scope}]\n${result.output}`);
    } else {
      output({ ok: false, scope: opts.scope, error: result.error });
    }
    // CLI per-call：关闭 engine（terminate worker + 释放 LOCK），否则进程无法退出
    await closeEngine();
    if (!result.ok) process.exit(1);
  });

// 仅在直接运行时解析参数（被 import 时不执行）
const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
