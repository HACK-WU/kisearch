#!/usr/bin/env node
/**
 * query-group.ts - 查询 Group + 词云生成 + 新兴热区展示 + 格式化输出
 *
 * 用法:
 *   npx jiti scripts/query-group.ts --scope <scope> [--groups <g1,g2>]
 *         [--hot-count <count>] [--depth <depth>] [--mode <mode>]
 *
 *   --mode 支持逗号分隔多值：hot|warm|cold|emerging|full
 *   例如：--mode hot,warm 或 --mode full
 */

import { Command } from 'commander';
import { readJson } from './lib/store.js';
import {
  getGroupIndexPath,
  getRelationsCachePath,
  validateScope,
} from './lib/scope.js';
import { ensureScopeDir } from './lib/store.js';
import { calculateScore, partitionByScore } from './lib/scoring.js';
import type { Relation, PartitionResult as ScoringPartitionResult } from './lib/scoring.js';
import { DEFAULT_PARTITION_CONFIG } from './lib/constants.js';

// ─── 类型定义 ───

interface GroupIndex {
  version: number;
  scope: string;
  roots: Record<string, Record<string, unknown>>;
  updatedAt: string | null;
}

interface GroupData {
  hot_relations: Relation[];
  keywords: string[];
  max_hot_count: number;
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
  return readJson<GroupIndex>(getGroupIndexPath(scope));
}

function loadRelationsCache(scope: string): RelationsCache | null {
  return readJson<RelationsCache>(getRelationsCachePath(scope));
}

// ─── 树操作 ───

function collectAllGroupPaths(
  roots: Record<string, Record<string, unknown>>
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
  walk(roots, '');
  return paths;
}

// ─── 评分聚合 ───

function getGroupAggregateScores(
  groups: Record<string, GroupData>,
  now: number,
  halfLifeHours: number
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const [path, data] of Object.entries(groups)) {
    const totalScore = data.hot_relations.reduce((sum, rel) => {
      return sum + calculateScore(rel.useCount, rel.lastUsedTime, now, halfLifeHours);
    }, 0);
    scores.set(path, totalScore);
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
      return `${prefix} ${item.groupPath} (score: ${fmtScore(item.score)}) ${label}`;
    })
    .join('\n');
}

// ─── 展示：树 ───

function renderTree(
  roots: Record<string, Record<string, unknown>>,
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

  const rootNames = Object.keys(roots);
  rootNames.forEach((rootName, rootIdx) => {
    const isLastRoot = rootIdx === rootNames.length - 1;
    const rootLabel = `${rootName}/`;
    const rootScore = groupScores.get(rootName) || 0;
    const rootLabel2 = getPartitionLabel(rootName, partition);

    if (!filterSet || hasVisibleDescendant(roots[rootName] as Record<string, unknown>, rootName, filterSet)) {
      lines.push(`${rootLabel} (score: ${fmtScore(rootScore)}) ${rootLabel2}`);
    }

    const childObj = roots[rootName] as Record<string, unknown>;
    renderTreeChildren(
      childObj, rootName, isLastRoot ? '' : '│   ', 1, depth,
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

function renderCompactTree(
  roots: Record<string, Record<string, unknown>>,
  depth: number
): string {
  const lines: string[] = [];
  const rootNames = Object.keys(roots);

  rootNames.forEach((rootName) => {
    lines.push(`${rootName}/`);
    renderCompactChildren(
      roots[rootName] as Record<string, unknown>,
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
  mode: string
): string {
  const lines: string[] = [];
  const relations = data.hot_relations;

  if (relations.length === 0) {
    lines.push(`=== ${groupPath} ===`);
    lines.push('');
    lines.push('(暂无 Relations)');
    return lines.join('\n');
  }

  // 分区
  const partition = partitionRelations(relations, now, config);

  if (mode === 'compact') {
    lines.push(`${groupPath}:`);
    lines.push('热门知识:');
    const top = partition.hot.slice(0, hotCount);
    top.forEach((rel) => lines.push(`├── ${rel.text}`));
    lines.push('');
    lines.push(`关键词: ${data.keywords.join(', ')}`);
    return lines.join('\n');
  }

  // full 模式
  lines.push(`=== ${groupPath} ===`);
  lines.push('');

  // 热门知识
  const hotIdSet = new Set(partition.hot.map((r) => r.id));
  const warmIdSet = new Set(partition.warm.map((r) => r.id));
  const top = partition.hot.slice(0, hotCount);
  if (top.length > 0) {
    lines.push(`🔥 热门知识 (Top ${hotCount}):`);
    top.forEach((rel, i) => {
      const prefix = i === top.length - 1 ? '└──' : '├──';
      const label = getRelPartitionLabel(rel, hotIdSet, warmIdSet, partition.emergingSet);
      lines.push(`${prefix} ${rel.text} (score: ${fmtScore(rel.score)}) ${label}`);
    });
    lines.push('');
  }

  // 词云：keywords 属于 Group 级，无法按 Relation 分区归类热度
  // 设计决策：接受简化，以换取数据模型清晰（详见 keywords-group-level-refactor_DESIGN §14）
  if (data.keywords.length > 0) {
    lines.push('🏷️ 关键词词云:');
    lines.push(`└── ${data.keywords.join(', ')}`);
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
}

function parseCliOpts(opts: Record<string, string>): CliOpts {
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

// ─── CLI ───

const program = new Command();

program
  .name('query-group')
  .description('查询 Group + 词云 + 格式化输出')
  .requiredOption('--scope <scope>', '项目隔离标识')
  .option('--groups <groups>', '逗号分隔的 Group 路径列表')
  .option('--hot-count <count>', '热门展示个数', '5')
  .option('--depth <depth>', '索引层级深度', '4')
  .option('--mode <mode>', '展示分区：hot|warm|cold|emerging|full（支持逗号分隔多值）', 'hot')
  .action(async (opts) => {
    try {
      const { scope, depth, hotCount, modes, groupsParam } = parseCliOpts(opts);

      // 验证每个 mode 值
      if (modes.length === 0) {
        output({ ok: false, error: '--mode 不能为空，有效值：hot | warm | cold | emerging | full' });
        process.exit(1);
      }
      for (const mode of modes) {
        if (!ALLOWED_MODES.includes(mode as typeof ALLOWED_MODES[number])) {
          output({ ok: false, error: `--mode 无效值：${mode}，有效值：hot | warm | cold | emerging | full` });
          process.exit(1);
        }
      }

      validateScope(scope);
      ensureScopeDir(scope);

      const groupIndex = loadGroupIndex(scope);
      const relationsCache = loadRelationsCache(scope);

      if (!groupIndex) {
        output({ ok: false, error: 'group-index.json 不存在' });
        process.exit(1);
      }

      const now = Date.now();
      const config = relationsCache?.partition_config || DEFAULT_PARTITION_CONFIG;
      const groupsData = relationsCache?.groups || {};

      // 指定 Group → 显示 Relations + 词云
      if (groupsParam) {
        const groupPaths = groupsParam.split(',').map((s: string) => s.trim());
        const results: string[] = [];

        for (const gp of groupPaths) {
          const data = groupsData[gp];
          if (!data) {
            results.push(`=== ${gp} ===\n\n(暂无 Relations)`);
            continue;
          }
          results.push(formatGroupRelations(gp, data, now, config, hotCount, modes[0]));
        }

        console.log(results.join('\n\n'));
        return;
      }

      // 完整展示格式（多分区索引 + 可选完整树 + 统计）
      const allPaths = collectAllGroupPaths(groupIndex.roots);
      const groupScores = getGroupAggregateScores(groupsData, now, config.halfLifeHours);
      const partition = partitionGroups(allPaths, groupScores, groupsData, now, config);
      const stats = computeStats(allPaths, partition);

      console.log(`=== 知识索引 [scope: ${scope}] ===`);
      console.log('');

      // 收集所有关系
      const allRelations = collectHotRelations(groupsData, now, config.halfLifeHours, partition.emergingSet);

      // 按顺序展示每个分区（hot → warm → cold → emerging）
      for (const mode of PARTITION_DISPLAY_ORDER) {
        if (!modes.includes(mode)) continue;

        const filteredRelations = filterRelationsByMode(allRelations, mode, partition);
        const title = getModeTitle(mode);
        
        if (filteredRelations.length > 0) {
          if (hotCount > filteredRelations.length) {
            console.warn(`警告：${title} --hot-count ${hotCount} 超过筛选后索引数 ${filteredRelations.length}，将显示全部`);
          }
          console.log(`🔥 ${title} (Top ${hotCount}):`);
          console.log(formatHotRelations(filteredRelations, hotCount));
          console.log('');
        }
      }

      // 仅当 modes 包含 'full' 时展示完整索引树
      if (modes.includes('full')) {
        console.log('📁 完整索引树:');
        console.log(renderTree(groupIndex.roots, groupScores, partition, depth, null));
        console.log('');
      }

      // 统计信息始终展示
      console.log('📊 统计信息:');
      console.log(`- 总索引数: ${stats.total}`);
      console.log(`- 热区索引: ${stats.hot} (新兴热: ${stats.emerging}, 历史热: ${stats.hot - stats.emerging})`);
      console.log(`- 常温区索引: ${stats.warm}`);
      console.log(`- 冷区索引: ${stats.cold}`);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
