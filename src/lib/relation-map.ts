/**
 * relation-map.ts —— dense memoryId / FTS ID → { group, relation } 反查映射（带 TTL 缓存）
 *
 * 用途：ki search 命中索引层结果后，按 dense memoryId 或 FTS ID 反查 relations-cache.json，
 * 给每条结果附加所属 Group、文件级 relation 名（方案 D：原文经 original 字段召回，此处仅定位）。
 * 批次 3（REQ-05/09）：keywords 与 isFullText 字段已删除。
 *
 * 缓存策略（方案 A + TTL，mtime/size 优先失效）：
 *   - 模块级单例 Map<scope, { builtAt, mtimeMs, size, map }>
 *   - 命中条件：relations-cache.json 的 mtime + size 均未变 且 距构建时间未超 TTL（默认 10 分钟）
 *   - 失效条件：
 *       1. 文件被写入（mtime 或 size 变化 → 立即失效，避免 sync-relation/import 后
 *          10 分钟内反查到陈旧映射；size 兜底毫秒精度下 mtime 未变的情况）
 *       2. TTL 过期（兜底：极端情况下文件内容被等长原地改写、mtime+size 均未变）
 *   - 懒构建：无定时器，首次访问 O(N)（N = 全部 hot_relation 条数），后续 O(1)
 *   - 文件缺失/损坏：返回空 Map（search 降级为不带附加字段），不抛错
 */

import fs from 'node:fs';
import { getRelationsCachePath } from './scope.js';
import type { Relation } from './scoring.js';
import type { FtsLocator } from './original-locator.js';

export interface RelationMapEntry {
  /** 所属 Group 路径 */
  group: string;
  /** 文件级 relation 名（relations-cache 的 hot_relation.text，文件名去扩展名） */
  relation: string;
  /** local KB/导入源的相对文件路径；旧 sync-relation 资产可能没有。 */
  sourcePath?: string;
  /** 文档级自定义标签（来自 relation.tags，缺省/空数组无自定义 tag） */
  tags?: string[];
  /** FTS-only 命中对应的原文 chunk 行范围（历史数据可能没有）。 */
  ftsLocator?: FtsLocator;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface ScopeCacheEntry {
  builtAt: number;
  mtimeMs: number;
  size: number;
  map: Map<string, RelationMapEntry>;
}

/** scope → 缓存条目 */
const cache = new Map<string, ScopeCacheEntry>();

/**
 * 获取指定 scope 的索引 ID 反查映射。
 *
 * @param scope 项目隔离标识
 * @param ttlMs 缓存有效期（默认 10 分钟；测试可注入小值验证过期重建）
 */
export function getRelationMap(
  scope: string,
  ttlMs: number = DEFAULT_TTL_MS
): Map<string, RelationMapEntry> {
  const cachePath = getRelationsCachePath(scope);

  // 文件不存在：缓存失去意义，清除后返回空 Map
  if (!fs.existsSync(cachePath)) {
    cache.delete(scope);
    return new Map();
  }

  const stat = fs.statSync(cachePath);
  const entry = cache.get(scope);

  // 命中：文件 mtime + size 均未变（mtime 在毫秒精度下可能相同，
  // 叠加 size 校验兜底原地改写场景）且未过期
  if (
    entry &&
    entry.mtimeMs === stat.mtimeMs &&
    entry.size === stat.size &&
    Date.now() - entry.builtAt < ttlMs
  ) {
    return entry.map;
  }

  // 失效/冷启动：重建
  const map = buildRelationMap(cachePath);
  cache.set(scope, { builtAt: Date.now(), mtimeMs: stat.mtimeMs, size: stat.size, map });
  return map;
}

function buildRelationMap(cachePath: string): Map<string, RelationMapEntry> {
  const map = new Map<string, RelationMapEntry>();
  try {
    const raw = fs.readFileSync(cachePath, 'utf-8');
    const data = JSON.parse(raw) as {
      groups?: Record<string, { hot_relations?: Relation[] }>;
    };
    const groups = data.groups || {};
    for (const [group, gd] of Object.entries(groups)) {
      const hot = gd?.hot_relations || [];
      for (const rel of hot) {
        if (!rel) continue;
        const baseEntry = {
          group,
          relation: rel.text,
          ...(rel.sourcePath ? { sourcePath: rel.sourcePath } : {}),
          ...(rel.tags?.length ? { tags: rel.tags } : {}),
        };
        // 方案 D：优先多值 memoryIds（文件级 relation 全部 chunk memoryId → 同一文件级 relation）
        if (Array.isArray(rel.memoryIds) && rel.memoryIds.length > 0) {
          for (const mid of rel.memoryIds) {
            if (mid && !map.has(mid)) map.set(mid, baseEntry);
          }
        } else if (rel.memoryId) {
          // 回退旧数据：单值 memoryId
          map.set(rel.memoryId, baseEntry);
        }

        // FTS-only 关系独立于 dense memoryIds，必须始终建立第二套反查映射。
        const locatorById = new Map((rel.ftsLocators ?? []).map((locator) => [locator.ftsId, locator]));
        for (const ftsId of rel.ftsIds ?? []) {
          if (!ftsId || map.has(ftsId)) continue;
          map.set(ftsId, {
            ...baseEntry,
            ...(locatorById.has(ftsId) ? { ftsLocator: locatorById.get(ftsId) } : {}),
          });
        }
      }
    }
  } catch {
    // 读取失败/JSON 损坏：返回空 Map，调用方降级（不带附加字段）
  }
  return map;
}

/** 测试辅助：清空全部缓存 */
export function clearRelationMapCache(): void {
  cache.clear();
}
