/**
 * relation-map.ts —— dense memoryId / FTS ID → { group, relation } 反查映射（带 TTL 缓存）
 *
 * 用途：ki search 命中索引层结果后，按 dense memoryId 或 FTS ID 反查 relations-cache.json，
 * 给每条结果附加所属 Group、文件级 relation 名（方案 D：原文经 original 字段召回，此处仅定位）。
 * 批次 3（REQ-05/09）：keywords 与 isFullText 字段已删除。
 *
 * 缓存策略（方案 A + TTL，身份戳优先失效；批次 2 R10 身份升级）：
 *   - 模块级单例 Map<scope, { builtAt, mtimeMs, size, revision, map }>
 *   - 身份戳布局感知（group-cache.getRelationsCacheIdentity）：新布局 = manifest
 *     (mtime,size,revision)，旧布局 = relations-cache.json (mtime,size,revision=-1)
 *   - 命中条件：身份三元组均未变 且 距构建时间未超 TTL（默认 10 分钟）
 *   - 失效条件：
 *       1. 任一写路径落盘（身份变化 → 立即失效，避免 sync-relation/import 后
 *          10 分钟内反查到陈旧映射；新布局 revision 每次 bump 递增）
 *       2. TTL 过期（兜底：极端情况下文件内容被等长原地改写、身份均未变）
 *   - 懒构建：无定时器，首次访问 O(N)（N = 全部 hot_relation 条数），后续 O(1)
 *   - 数据**缺失**（两布局皆无）：返回空 Map（search 降级为不带附加字段），不抛错
 *   - 数据**损坏**（manifest 无法解析）：抛错 fail-loud（批次 2 审查 P2 对齐口径：
 *     静默返回空 Map 会让"索引命中了但反查不到定位字段"，用户无从知道数据坏了；
 *     MCP 工具层会把该错误转成 isError 返回，CLI 直接以错误退出）
 */

import { getRelationsCacheIdentity, readAllGroupCaches, onScopeRelationsInvalidated } from './group-cache.js';
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
  /** 批次 2（R10）：布局感知身份 revision（新布局 manifest revision / 旧布局 -1） */
  revision: number;
  map: Map<string, RelationMapEntry>;
}

/** scope → 缓存条目 */
const cache = new Map<string, ScopeCacheEntry>();

// 批次 2（D3）写后主动失效：任一写路径落盘（group-cache 三步曲）后立即丢弃本 scope 缓存，
// 免去"下次访问靠 stat + revision 才发现变了"的一次全量聚合；跨进程/绕过写路径的场景
// 仍由身份三元组兜底（getRelationMap 每次核身份）。
onScopeRelationsInvalidated((scope) => {
  cache.delete(scope);
});

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
  // 批次 2（R10）：布局感知身份（旧实现锚定旧单文件——新布局下恒空 Map，search
  // 反查静默降级）。两布局均无数据：清缓存返回空 Map。
  const identity = getRelationsCacheIdentity(scope);
  if (!identity) {
    cache.delete(scope);
    return new Map();
  }

  const entry = cache.get(scope);

  // 命中：身份三元组均未变（新布局 revision 每次 bump 递增，覆盖毫秒精度下
  // mtime 未变的原地改写场景）且未过期
  if (
    entry &&
    entry.mtimeMs === identity.mtimeMs &&
    entry.size === identity.size &&
    entry.revision === identity.revision &&
    Date.now() - entry.builtAt < ttlMs
  ) {
    return entry.map;
  }

  // 失效/冷启动：重建
  const map = buildRelationMap(scope);
  cache.set(scope, { builtAt: Date.now(), mtimeMs: identity.mtimeMs, size: identity.size, revision: identity.revision, map });
  return map;
}

function buildRelationMap(scope: string): Map<string, RelationMapEntry> {
  const map = new Map<string, RelationMapEntry>();
  {
    // 批次 2（R10）：双轨全量读（新布局分片聚合 / 旧布局旧文件）。
    // 第二轮审查 P1 修复：原实现整体 catch → 返回空 Map 且被身份三元组「认证」缓存
    // 10 分钟，把「分片/manifest 损坏」降级成"该 scope 全部检索结果丢失定位字段"；
    // 与本文件头「数据损坏 → fail-loud」的声明矛盾。此处不再吞异常：
    // 「两布局皆无数据」已在 getRelationMap 前置判定（identity 为 null → 空 Map）。
    for (const [group, gd] of readAllGroupCaches(scope)) {
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
  }
  return map;
}

/** 测试辅助：清空全部缓存 */
export function clearRelationMapCache(): void {
  cache.clear();
}
