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
import { resolveGroupPath } from './lib/group-resolve.js';
import type { ResolveResult } from './lib/group-resolve.js';
import { vectorSearch, ensureVectorAvailable, closeEngine } from './lib/vector-client.js';

// ─── 类型定义 ───

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
  return readGroupIndex(scope);
}

function loadRelationsCache(scope: string): RelationsCache | null {
  return readJson<RelationsCache>(getRelationsCachePath(scope));
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
    lines.push(`   ki sync-relation --scope <scope> --group "${groupPath}" --relation <描述> --module-info <内容> --keywords <词1,词2>`);
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
    lines.push(`关键词: ${data.keywords.join(', ')}`);
    return lines.join('\n');
  }

  const isFull = modes.includes('full');
  const hotIdSet = new Set(partition.hot.map((r) => r.id));
  const warmIdSet = new Set(partition.warm.map((r) => r.id));

  lines.push(`=== ${groupPath} ===`);
  lines.push('');

  if (isFull) {
    // full 模式：按分区展示全量 Relations，各分区上限 maxFullCount 防止输出过长
    const maxFullCount = 50;
    const sections: Array<{ title: string; rels: Relation[] }> = [
      { title: `🔥 热区 (全部 ${partition.hot.length})`, rels: partition.hot },
      { title: `🌡️ 常温区 (全部 ${partition.warm.length})`, rels: partition.warm },
      { title: `❄️ 冷区 (全部 ${partition.cold.length})`, rels: partition.cold },
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
        lines.push(`└── ... 还有 ${section.rels.length - maxFullCount} 个未展示，请缩小 groups 范围或用 hot/warm/cold 模式按需查看`);
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
      lines.push(`${title} (Top ${Math.min(hotCount, top.length)}):`);
      top.forEach((rel, i) => {
        const prefix = i === top.length - 1 ? '└──' : '├──';
        const label = getRelPartitionLabel(rel, hotIdSet, warmIdSet, partition.emergingSet);
        lines.push(`${prefix} ${rel.text} (score: ${fmtScore(rel.score)}) ${label}`);
      });
      lines.push('');
    }
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
  hotCount: number;
  depth: number;
  modes: string[];
  autoFallback?: boolean;  // 语义兜底开关，默认 true
}

export type QueryGroupResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export async function executeQueryGroup(params: QueryGroupParams): Promise<QueryGroupResult> {
  try {
    const { scope, depth, hotCount, modes, groupsParam } = params;
    const autoFallback = params.autoFallback ?? true;

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
          const baseOutput = `=== ${gp} ===\n\n(暂无 Relations)\n\n💡 可使用 sync-relation 写入知识条目：\n   ki sync-relation --scope ${scope} --group "${gp}" --relation <描述> --module-info <内容> --keywords <词1,词2>\n\n${resolved.hint}`;

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
          results.push(`=== ${resolved.resolvedPath} ===\n\n(该 Group 路径存在但暂无 Relations)\n\n💡 可使用 sync-relation 写入知识条目：\n   ki sync-relation --scope ${scope} --group "${resolved.resolvedPath}" --relation <描述> --module-info <内容> --keywords <词1,词2>`);
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

      return { ok: true, output: results.join('\n\n') };
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

    return { ok: true, output: lines.join('\n') };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
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
  .option('--no-auto-fallback', '禁用语义兜底（默认开启）')
  .action(async (opts) => {
    const result = await executeQueryGroup(parseCliOpts(opts));
    if (result.ok) {
      console.log(result.output);
    } else {
      output({ ok: false, error: result.error });
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
