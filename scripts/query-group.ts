#!/usr/bin/env node
/**
 * query-group.ts - 查询 Group + 词云生成 + 新兴热区展示 + 格式化输出
 *
 * 用法:
 *   npx jiti scripts/query-group.ts --scope <scope> [--groups <g1,g2>]
 *         [--hot-count <count>] [--depth <depth>] [--partition <partition>]
 *         [--mode <mode>]
 */

import { Command } from 'commander';
import { readJson } from './lib/store.js';
import {
  getGroupIndexPath,
  getRelationsCachePath,
  validateScope,
} from './lib/scope.js';
import { ensureScopeDir } from './lib/store.js';
import { calculateScore } from './lib/scoring.js';
import type { Relation } from './lib/scoring.js';
import type { PartitionConfig } from './lib/constants.js';
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
  partition_config: PartitionConfig;
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

function findGroupInTree(
  roots: Record<string, Record<string, unknown>>,
  groupPath: string
): Record<string, unknown> | null {
  const segments = groupPath.split('/').filter(Boolean);
  if (segments.length === 0) return null;

  let current: Record<string, unknown> | undefined = roots[segments[0]];
  if (current === undefined) return null;

  for (let i = 1; i < segments.length; i++) {
    const child = current[segments[i]];
    if (typeof child !== 'object' || child === null) return null;
    current = child as Record<string, unknown>;
  }
  return current;
}

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
}

function partitionGroups(
  allPaths: string[],
  groupScores: Map<string, number>,
  groupsData: Record<string, GroupData>,
  now: number,
  config: PartitionConfig
): PartitionResult {
  const {
    hotPercent, warmPercent, reservedEmerging, recentHours,
    minHotCount, maxHotCount, maxWarmCount, maxColdCount,
  } = config;

  const recentThreshold = recentHours * 60 * 60 * 1000;

  // 识别有最近使用的 group（新兴候选）
  const emergingPaths = new Set<string>();
  for (const path of allPaths) {
    const data = groupsData[path];
    if (!data) continue;
    const hasRecent = data.hot_relations.some(
      (r) =>
        !r.isImported &&
        r.lastUsedTime &&
        now - r.lastUsedTime < recentThreshold
    );
    if (hasRecent) emergingPaths.add(path);
  }

  // 按评分排序
  const sorted = allPaths
    .map((p) => ({ path: p, score: groupScores.get(p) || 0 }))
    .sort((a, b) => b.score - a.score);

  const hot: string[] = [];
  const hotSet = new Set<string>();

  // 新兴热区
  const emergingSeats = Math.min(reservedEmerging, emergingPaths.size);
  let added = 0;
  for (const item of sorted) {
    if (added >= emergingSeats) break;
    if (emergingPaths.has(item.path) && !hotSet.has(item.path)) {
      hot.push(item.path);
      hotSet.add(item.path);
      added++;
    }
  }

  // 历史热区
  const totalHotSeats = Math.max(minHotCount, Math.ceil(sorted.length * hotPercent));
  for (const item of sorted) {
    if (hot.length >= totalHotSeats) break;
    if (!hotSet.has(item.path)) {
      hot.push(item.path);
      hotSet.add(item.path);
    }
  }

  // 常温 + 冷区
  const remaining = sorted.filter((item) => !hotSet.has(item.path));
  const warmCount = Math.ceil(sorted.length * warmPercent);
  const warm = remaining.slice(0, warmCount).map((i) => i.path);
  const cold = remaining.slice(warmCount).map((i) => i.path);

  // 上限截断
  if (maxHotCount && hot.length > maxHotCount) hot.length = maxHotCount;
  if (maxWarmCount && warm.length > maxWarmCount) warm.length = maxWarmCount;
  if (maxColdCount && cold.length > maxColdCount) cold.length = maxColdCount;

  return { hot, warm, cold, emergingSet: emergingPaths };
}

function getPartitionLabel(
  path: string,
  partition: PartitionResult
): string {
  if (partition.emergingSet.has(path) && partition.hot.includes(path)) {
    return '[新兴热]';
  }
  if (partition.hot.includes(path)) return '[热]';
  if (partition.warm.includes(path)) return '[常温]';
  return '[冷]';
}

// ─── 格式化 ───

function fmtScore(score: number): string {
  return score % 1 === 0 ? score.toString() : score.toFixed(1);
}

function getRelPartitionLabel(
  rel: Relation,
  hotRels: Relation[],
  warmRels: Relation[],
  emergingSet: Set<string>
): string {
  if (rel.isImported) return '[📥]';
  if (emergingSet.has(rel.id) && hotRels.some((r) => r.id === rel.id)) return '[新兴热]';
  if (hotRels.some((r) => r.id === rel.id)) return '[热]';
  if (warmRels.some((r) => r.id === rel.id)) return '[常温]';
  return '[冷]';
}

function partitionRelations(
  relations: Relation[],
  now: number,
  config: PartitionConfig
): { hot: Relation[]; warm: Relation[]; cold: Relation[]; emergingSet: Set<string> } {
  const {
    hotPercent, warmPercent, reservedEmerging, recentHours,
    minHotCount, halfLifeHours, maxHotCount, maxWarmCount, maxColdCount,
  } = config;

  const itemsWithScore = relations.map((r) => ({
    ...r,
    score: calculateScore(r.useCount, r.lastUsedTime, now, halfLifeHours),
  }));

  const recentThreshold = recentHours * 60 * 60 * 1000;
  const emergingItems = itemsWithScore.filter(
    (item) =>
      !item.isImported &&
      item.lastUsedTime &&
      now - item.lastUsedTime < recentThreshold
  );

  itemsWithScore.sort((a, b) => b.score - a.score);

  const hot: Relation[] = [];
  const hotSet = new Set<string>();
  const emergingIdSet = new Set(emergingItems.map((r) => r.id));

  // 新兴热区优先按 lastUsedTime 降序，确保“最近用过的先上”
  const emergingSorted = [...emergingItems].sort(
    (a, b) => (b.lastUsedTime ?? 0) - (a.lastUsedTime ?? 0)
  );
  const emergingSeats = Math.min(reservedEmerging, emergingSorted.length);
  for (let i = 0; i < emergingSeats; i++) {
    if (!hotSet.has(emergingSorted[i].id)) {
      hot.push(emergingSorted[i]);
      hotSet.add(emergingSorted[i].id);
    }
  }

  const totalHotSeats = Math.max(minHotCount, Math.ceil(itemsWithScore.length * hotPercent));
  for (const item of itemsWithScore) {
    if (hot.length >= totalHotSeats) break;
    if (!hotSet.has(item.id)) {
      hot.push(item);
      hotSet.add(item.id);
    }
  }

  const remaining = itemsWithScore.filter((item) => !hotSet.has(item.id));
  const warmCount = Math.ceil(itemsWithScore.length * warmPercent);
  const warm = remaining.slice(0, warmCount);
  const cold = remaining.slice(warmCount);

  if (maxHotCount && hot.length > maxHotCount) hot.length = maxHotCount;
  if (maxWarmCount && warm.length > maxWarmCount) warm.length = maxWarmCount;
  if (maxColdCount && cold.length > maxColdCount) cold.length = maxColdCount;

  return { hot, warm, cold, emergingSet: emergingIdSet };
}

// ─── 展示：热门列表 ───

function formatHotRelations(
  allRelations: { text: string; score: number; groupPath: string; isImported: boolean; isEmerging: boolean }[],
  hotCount: number
): string {
  const sorted = [...allRelations].sort((a, b) => b.score - a.score);
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
    const rootLabel2 = partition ? getPartitionLabel(rootName, partition) : '';

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
    const label = partition ? getPartitionLabel(childPrefix, partition) : '';
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
  config: PartitionConfig,
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
  const top = partition.hot.slice(0, hotCount);
  if (top.length > 0) {
    lines.push(`🔥 热门知识 (Top ${hotCount}):`);
    top.forEach((rel, i) => {
      const prefix = i === top.length - 1 ? '└──' : '├──';
      const label = getRelPartitionLabel(rel, partition.hot, partition.warm, partition.emergingSet);
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

// ─── 帮助信息 ───

function showHelp(): void {
  console.log(`=== 知识索引帮助 ===

📖 查询命令:
- 查询 <路径>     查看具体 Group 的详细内容
- 热门索引        查看热门索引
- 索引层级 <N>    查看特定层级的索引

🔧 参数说明:
--scope <scope>       项目隔离标识（必填）
--groups <group1,group2>  逗号分隔的 Group 路径列表
--hot-count <count>   热门索引展示个数（默认 5）
--depth <depth>       索引层级深度（默认 4，最大 10）
--partition <partition>  分区过滤：hot | warm | cold | emerging | all
--mode <mode>         展示模式：full | hot | compact | help`);
}

// ─── 输出 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
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
  .option('--partition <partition>', '分区过滤：hot|warm|cold|emerging|all', 'all')
  .option('--mode <mode>', '展示模式：full|hot|compact|help', 'full')
  .action(async (opts) => {
    try {
      const { scope } = opts;
      const rawDepthInput = parseInt(opts.depth, 10);
      const rawDepth = Number.isFinite(rawDepthInput) && rawDepthInput > 0 ? rawDepthInput : 4;
      if (!Number.isFinite(rawDepthInput) || rawDepthInput <= 0) {
        console.warn(`警告：--depth 取值无效或非正整数，已回退为默认 4`);
      }
      const depth = Math.min(rawDepth, 10);
      if (rawDepth > 10) {
        console.warn(`警告：--depth ${rawDepth} 超过最大值，已限制为 10`);
      }
      const hotCountInput = parseInt(opts.hotCount, 10);
      const hotCount = Number.isFinite(hotCountInput) && hotCountInput > 0 ? hotCountInput : 5;
      if (!Number.isFinite(hotCountInput) || hotCountInput <= 0) {
        console.warn(`警告：--hot-count 取值无效或非正整数，已回退为默认 5`);
      }
      const rawHotCount = hotCount;
      const partitionFilter: string = opts.partition;
      const mode: string = opts.mode;
      const groupsParam: string | undefined = opts.groups;

      // 验证 partition 值
      const ALLOWED_PARTITIONS = ['hot', 'warm', 'cold', 'emerging', 'all'];
      if (!ALLOWED_PARTITIONS.includes(partitionFilter)) {
        output({ ok: false, error: `--partition 无效值：${partitionFilter}，有效值：hot | warm | cold | emerging | all` });
        process.exit(1);
      }

      // 验证 mode 值
      const ALLOWED_MODES = ['full', 'hot', 'compact', 'help'];
      if (!ALLOWED_MODES.includes(mode)) {
        output({ ok: false, error: `--mode 无效值：${mode}，有效值：full | hot | compact | help` });
        process.exit(1);
      }

      validateScope(scope);
      ensureScopeDir(scope);

      if (mode === 'help') {
        showHelp();
        return;
      }

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
        const outputs: string[] = [];

        for (const gp of groupPaths) {
          const data = groupsData[gp];
          if (!data) {
            outputs.push(`=== ${gp} ===\n\n(暂无 Relations)`);
            continue;
          }
          outputs.push(formatGroupRelations(gp, data, now, config, hotCount, mode));
        }

        console.log(outputs.join('\n\n'));
        return;
      }

      // 树视图
      const allPaths = collectAllGroupPaths(groupIndex.roots);
      const groupScores = getGroupAggregateScores(groupsData, now, config.halfLifeHours);
      const partition = partitionGroups(allPaths, groupScores, groupsData, now, config);
      const stats = computeStats(allPaths, partition);

      switch (mode) {
        case 'hot': {
          console.log(`=== 热门索引 [scope: ${scope}] ===`);
          console.log('');
          const allRelations: { text: string; score: number; groupPath: string; isImported: boolean; isEmerging: boolean }[] = [];
          for (const [gp, data] of Object.entries(groupsData)) {
            for (const rel of data.hot_relations) {
              const score = calculateScore(rel.useCount, rel.lastUsedTime, now, config.halfLifeHours);
              allRelations.push({
                text: rel.text, score, groupPath: gp,
                isImported: rel.isImported,
                isEmerging: partition.emergingSet.has(gp),
              });
            }
          }
          if (rawHotCount > allRelations.length) {
            console.warn(`警告：--hot-count ${rawHotCount} 超过总索引数 ${allRelations.length}，将显示全部`);
          }
          console.log(`🔥 热门索引 (Top ${hotCount}):`);
          console.log(formatHotRelations(allRelations, hotCount));
          console.log('');
          console.log(`📊 统计: 总索引 ${stats.total} | 热区 ${stats.hot} | 常温区 ${stats.warm} | 冷区 ${stats.cold}`);
          break;
        }

        case 'compact': {
          console.log(renderCompactTree(groupIndex.roots, depth));
          break;
        }

        case 'full':
        default: {
          console.log(`=== 知识索引 [scope: ${scope}] ===`);
          console.log('');

          // 热门索引
          const allRelations: { text: string; score: number; groupPath: string; isImported: boolean; isEmerging: boolean }[] = [];
          for (const [gp, data] of Object.entries(groupsData)) {
            for (const rel of data.hot_relations) {
              const score = calculateScore(rel.useCount, rel.lastUsedTime, now, config.halfLifeHours);
              allRelations.push({
                text: rel.text, score, groupPath: gp,
                isImported: rel.isImported,
                isEmerging: partition.emergingSet.has(gp),
              });
            }
          }
          if (allRelations.length > 0) {
            if (rawHotCount > allRelations.length) {
              console.warn(`警告：--hot-count ${rawHotCount} 超过总索引数 ${allRelations.length}，将显示全部`);
            }
            console.log(`🔥 热门索引 (Top ${hotCount}):`);
            console.log(formatHotRelations(allRelations, hotCount));
            console.log('');
          }

          // 完整索引树
          console.log('📁 完整索引树:');
          console.log(renderTree(groupIndex.roots, groupScores, partition, depth, partitionFilter));
          console.log('');

          // 帮助信息
          console.log('💡 帮助信息:');
          console.log('- 查询具体 Group: "查询 <路径>" (如 "查询 监控/告警中心")');
          console.log('- 查看热门索引: "热门索引"');
          console.log('- 查看特定层级: "索引层级 <N>"');
          console.log('');

          // 统计信息
          console.log('📊 统计信息:');
          console.log(`- 总索引数: ${stats.total}`);
          console.log(`- 热区索引: ${stats.hot} (新兴热: ${stats.emerging}, 历史热: ${stats.hot - stats.emerging})`);
          console.log(`- 常温区索引: ${stats.warm}`);
          console.log(`- 冷区索引: ${stats.cold}`);
          break;
        }
      }
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

program.parse();
