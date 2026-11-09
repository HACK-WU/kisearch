/**
 * relation-map.ts —— dense memoryId / FTS ID → { group, relation } 反查映射（带 TTL 缓存）
 *
 * 用途：ki search 命中索引层结果后，按 dense memoryId 或 FTS ID 反查 relations-cache.json，
 * 给每条结果附加所属 Group、文件级 relation 名（方案 D：原文经 original 字段召回，此处仅定位）。
 * 批次 3（REQ-05/09）：keywords 与 isFullText 字段已删除。
 *
 * 第二套能力（辅助通道定位，`getRelationAuxIndex` / `resolveAuxHit`）：
 * `ki-relation` / `ki-path` 向量的 docId 按设计不入 relations-cache，按 id 反查必然 miss，
 * 结果表现为「group 有值、relation 为空」。该部分用向量自带的可读字段（chunk 名 / 路径文本）
 * 反推父文档，与 id 映射**同批构建、共用同一份缓存**，不额外产生一次分片全量读。
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

/**
 * 辅助通道（`ki-relation` / `ki-path`）命中的定位索引。
 *
 * 必要性：辅助向量的 docId **按设计不写入 relations-cache**（重建/导入只回写内容向量
 * 与自定义 tag 向量的 docId，见 `updateMemoryIds` 注释），因此检索结果落到这两个 tag 时
 * 按 id 反查必然 miss —— 表现为「group 有值、relation 为空」，用户无法定位到文件。
 * 这里不新增 id 映射（会给每个 chunk 多存一条记录、cache 体积翻倍），而是用向量自带的
 * 可读字段反推父文档：`ki-relation` 的 content 是 chunk 名、`ki-path` 的 content 是路径文本。
 *
 * ⚠️ 本接口的返回值**只读**（`getRelationAuxIndex` 在无数据时返回共享空索引，
 * 有数据时返回缓存内的同一实例）：调用方不得修改其中的 Map 或数组，否则会污染
 * 同 scope 的后续反查。
 */
export interface AuxRelationIndex {
  /**
   * group 路径 → 该组下的文件级 relation 条目（按 relation 名长度**降序**）。
   *
   * 供 `resolveAuxHit` 做 chunk 名最长前缀匹配：`ki-relation` 的 content 形如
   * `<文件级 relation>-<chunk 序号>`（`chunk-entries.buildChunkEntries`），而文件级
   * relation 名本身也可能以 `-NN` 结尾（如 `迁移方案-12`），必须取最长匹配才能避免
   * 解析到更短的同名前缀（`迁移方案`）。
   */
  byGroup: Map<string, RelationMapEntry[]>;
  /**
   * `ki-path` 向量 content（group 路径以空格分隔）→ group 路径。
   *
   * 用「content 精确匹配」而不是「空格转回斜杠」：group 段名本身可能含空格，
   * 反向还原会有歧义。
   */
  byPathContent: Map<string, string>;
}

const EMPTY_AUX_INDEX: AuxRelationIndex = { byGroup: new Map(), byPathContent: new Map() };

/** 辅助通道 tag 常量（与 rebuild-vector / path-vectorize 写入侧同值） */
export const AUX_RELATION_TAG = 'ki-relation';
export const AUX_PATH_TAG = 'ki-path';

const DEFAULT_TTL_MS = 10 * 60 * 1000;

interface ScopeCacheEntry {
  builtAt: number;
  mtimeMs: number;
  size: number;
  /** 批次 2（R10）：布局感知身份 revision（新布局 manifest revision / 旧布局 -1） */
  revision: number;
  map: Map<string, RelationMapEntry>;
  /** 辅助通道命中反推索引，与 map 同批构建（共用一次分片全量读，不重复 O(N)） */
  aux: AuxRelationIndex;
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
  return resolveCacheEntry(scope, ttlMs)?.map ?? new Map();
}

/**
 * 获取指定 scope 的辅助通道（`ki-relation` / `ki-path`）命中定位索引。
 *
 * 与 `getRelationMap` **共用同一份缓存条目**：两者身份判定（manifest revision / mtime /
 * size 三元组）与全量分片读都只做一次，不会因为多调一个接口而多一次 O(N)。
 *
 * ⚠️ 返回值只读（可能是缓存内实例或共享空索引），调用方不得修改。
 *
 * @param scope 项目隔离标识
 * @param ttlMs 缓存有效期（默认 10 分钟）
 */
export function getRelationAuxIndex(
  scope: string,
  ttlMs: number = DEFAULT_TTL_MS
): AuxRelationIndex {
  return resolveCacheEntry(scope, ttlMs)?.aux ?? EMPTY_AUX_INDEX;
}

/**
 * 用辅助通道向量自带的字段反推父文档定位。
 *
 * 调用前提：`map.get(memoryId)` 未命中（辅助向量的 docId 按设计不入 relations-cache）。
 *
 * 覆盖边界：老版本写入的辅助向量 content 是 `名称 | Group: … | 关键词` 的旧格式，
 * 且可能没有结构化的 `group` 字段 —— 这类命中反推不出来，直接返回 undefined 让调用方
 * 保持原样（安全降级，不会误配到别的文件）。
 *
 * @param aux  `getRelationAuxIndex(scope)` 的结果
 * @param hit  向量命中（只需 tag / group / content 三个字段）
 * @returns 定位条目；`ki-path` 只补 group（返回的 relation 为空串，没有单一文件可指）
 */
export function resolveAuxHit(
  aux: AuxRelationIndex,
  hit: { tag?: string; group?: string; content?: string }
): RelationMapEntry | undefined {
  const content = hit.content ?? '';
  if (!content) return undefined;

  if (hit.tag === AUX_RELATION_TAG) {
    // ki-relation：content = `<文件级 relation>-<chunk 序号>`，按最长前缀回到文件级 relation。
    // 候选按 relation 名长度降序，第一个匹配即最长匹配（避免解析到更短的同名前缀）。
    const candidates = hit.group ? aux.byGroup.get(hit.group) : undefined;
    if (!candidates) return undefined;
    for (const candidate of candidates) {
      if (!content.startsWith(candidate.relation)) continue;
      // 剩余部分必须是 `-<两位以上数字>`：单数字或非数字后缀都不是 chunk 命名
      // （chunk 序号 `String(index).padStart(2,'0')`，超过 99 后为 3 位以上）
      if (!/^-\d{2,}$/.test(content.slice(candidate.relation.length))) continue;
      return candidate;
    }
    return undefined;
  }

  if (hit.tag === AUX_PATH_TAG) {
    // ki-path：content = group 路径以空格分隔，精确反查（不猜空格→斜杠）
    const groupPath = aux.byPathContent.get(content) ?? aux.byPathContent.get(content.trim());
    return groupPath ? { group: groupPath, relation: '' } : undefined;
  }

  return undefined;
}

/** 身份判定 + 懒构建（两个公开接口共用，保证同一身份只构建一次） */
function resolveCacheEntry(scope: string, ttlMs: number): ScopeCacheEntry | null {
  // 批次 2（R10）：布局感知身份（旧实现锚定旧单文件——新布局下恒空 Map，search
  // 反查静默降级）。两布局均无数据：清缓存返回空。
  const identity = getRelationsCacheIdentity(scope);
  if (!identity) {
    cache.delete(scope);
    return null;
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
    return entry;
  }

  // 失效/冷启动：重建
  const built = buildIndexes(scope);
  const next: ScopeCacheEntry = {
    builtAt: Date.now(),
    mtimeMs: identity.mtimeMs,
    size: identity.size,
    revision: identity.revision,
    map: built.map,
    aux: built.aux,
  };
  cache.set(scope, next);
  return next;
}

function buildIndexes(scope: string): { map: Map<string, RelationMapEntry>; aux: AuxRelationIndex } {
  const map = new Map<string, RelationMapEntry>();
  const aux: AuxRelationIndex = { byGroup: new Map(), byPathContent: new Map() };
  {
    // 批次 2（R10）：双轨全量读（新布局分片聚合 / 旧布局旧文件）。
    // 第二轮审查 P1 修复：原实现整体 catch → 返回空 Map 且被身份三元组「认证」缓存
    // 10 分钟，把「分片/manifest 损坏」降级成"该 scope 全部检索结果丢失定位字段"；
    // 与本文件头「数据损坏 → fail-loud」的声明矛盾。此处不再吞异常：
    // 「两布局皆无数据」已在 resolveCacheEntry 前置判定（identity 为 null → 空）。
    for (const [group, gd] of readAllGroupCaches(scope)) {
      const hot = gd?.hot_relations || [];
      // ki-path 反查键与写入侧 buildGroupPathContent 同口径（路径段用空格连接）。
      // 此处不 import 该模块：关系反查层不应反向依赖向量层。
      aux.byPathContent.set(group.split('/').filter(Boolean).join(' '), group);
      const groupEntries: RelationMapEntry[] = [];
      for (const rel of hot) {
        if (!rel) continue;
        const baseEntry: RelationMapEntry = {
          group,
          relation: rel.text,
          ...(rel.sourcePath ? { sourcePath: rel.sourcePath } : {}),
          ...(rel.tags?.length ? { tags: rel.tags } : {}),
        };
        // 只收有名字的 relation 作为反推候选：空名字会让 `content.startsWith('')` 恒真，
        // 把 `-12` 这类畸形 content 误认成某个文件（不影响下面的 id 映射）。
        if (rel.text) groupEntries.push(baseEntry);
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
      if (groupEntries.length > 0) {
        // 长度降序 → resolveAuxHit 逐条比对时第一个命中即最长前缀
        groupEntries.sort((a, b) => b.relation.length - a.relation.length);
        aux.byGroup.set(group, groupEntries);
      }
    }
  }
  return { map, aux };
}

/** 测试辅助：清空全部缓存 */
export function clearRelationMapCache(): void {
  cache.clear();
}
