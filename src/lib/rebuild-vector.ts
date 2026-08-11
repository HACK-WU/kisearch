/**
 * rebuild-vector.ts —— 从已还原的 KB 重建 scope 向量
 *
 * 背景：restore 只还原 KB 文件层（relations-cache.json + Group 树 index.json），
 * 向量层（vectorDir）不随快照还原。本模块从已还原 KB 重建三类向量（与 import 流程对齐）：
 *   - ki-search   内容向量：Group index.json 的 {关系名: 描述文本}
 *   - ki-relation 关系向量：每条 relation 一条（relation名 + Group路径 + 关键词）
 *   - ki-path     路径向量：每个 Group 一条（Group路径 + 关键词）
 *
 * 重建前清空 scope 旧向量（vectorDeleteScope），保证结果与 KB 一致（幂等可重跑）。
 * 内容向量（ki-search）的 docId 回写 relations-cache.json 的 rel.memoryId，
 * 防止 delete-relation 等命令产生悬空引用（与 import 的 writeRelations 语义一致）。
 *
 * 数据源完全来自已还原 KB（自包含，无需 ai-results.json / 外部源目录）。
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, getScopeDataDir } from './config.js';
import { buildGroupPathContent, buildRelationContent } from './path-vectorize.js';
import {
  vectorBulkStore,
  vectorDeleteScope,
  type VectorBulkStoreResult,
} from './vector-client.js';

// 与 import 流程对齐的 tag 常量（VECTORIZE_TAG / ki-relation / ki-path）
const CONTENT_TAG = 'ki-search';
const RELATION_TAG = 'ki-relation';
const PATH_TAG = 'ki-path';

export interface RebuildVectorEntry {
  text: string;
  tags: string;
  /** 内容向量专用：来源 Group 路径（相对 scope 数据目录） */
  groupPath?: string;
  /** 内容向量专用：关系名（index.json 键） */
  relationName?: string;
  /** ki-relation 专用：结构化 Group 字段（不再拼入 content） */
  group?: string;
}

export interface RebuildVectorStats {
  content: number;
  relation: number;
  path: number;
  succeeded: number;
  failed: number;
  updatedMemoryId: number;
}

export interface RebuildVectorResult {
  ok: boolean;
  scope: string;
  stats: RebuildVectorStats;
  errors: { type: string; path: string; error: string }[];
}

/** relations-cache 的 groups 扁平结构（键 = 完整 groupPath） */
interface CacheGroup {
  hot_relations?: { text: string; memoryId?: string | null }[];
  keywords?: string[];
}

// ─── 条目收集（纯函数，可单测） ───

/**
 * 收集内容向量条目：遍历 scope 数据目录下全部 index.json。
 * 排除 version/updatedAt 元数据键；groupPath 为相对 scope 数据目录的 Group 路径。
 *
 * content 纯化契约：text 直接取 index.json 的值（传入什么就是什么，不再拼接
 * `[摘要]/[关键词]/[路径]` 前缀；keywords 机制已删除，REQ-05）。
 *
 * @param scopeDir scope 数据目录
 */
export function collectContentEntries(scopeDir: string): RebuildVectorEntry[] {
  const entries: RebuildVectorEntry[] = [];
  if (!fs.existsSync(scopeDir)) return entries;

  function walk(dir: string, groupPath: string): void {
    let indexFile: string | null = null;
    const subDirs: { name: string; dir: string }[] = [];
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) {
        subDirs.push({ name: f.name, dir: p });
      } else if (f.name === 'index.json') {
        indexFile = p;
      }
    }
    if (indexFile) {
      let content: Record<string, unknown> = {};
      try {
        content = JSON.parse(fs.readFileSync(indexFile, 'utf-8')) as Record<string, unknown>;
      } catch {
        /* 单个 index.json 解析失败跳过 */
      }
      for (const [k, v] of Object.entries(content)) {
        if (k === 'version' || k === 'updatedAt') continue;
        entries.push({
          text: String(v),
          tags: CONTENT_TAG,
          groupPath: groupPath || undefined,
          relationName: k,
        });
      }
    }
    for (const c of subDirs) {
      walk(c.dir, groupPath ? `${groupPath}/${c.name}` : c.name);
    }
  }

  walk(scopeDir, '');
  return entries;
}

/**
 * 收集关系向量 + 路径向量条目（relations-cache.groups 为扁平键结构）。
 * - 每个 group 的每条 relation → ki-relation 向量
 * - 每个 group → 一条 ki-path 向量
 */
export function collectPathRelationEntries(
  groups: Record<string, CacheGroup>
): { relationEntries: RebuildVectorEntry[]; pathEntries: RebuildVectorEntry[] } {
  const relationEntries: RebuildVectorEntry[] = [];
  const pathEntries: RebuildVectorEntry[] = [];

  for (const [groupPath, g] of Object.entries(groups)) {
    for (const rel of g.hot_relations ?? []) {
      relationEntries.push({
        text: buildRelationContent(rel.text, groupPath),
        tags: RELATION_TAG,
        group: groupPath,
      });
    }
    pathEntries.push({
      text: buildGroupPathContent(groupPath),
      tags: PATH_TAG,
    });
  }

  return { relationEntries, pathEntries };
}

/**
 * 收集自定义 tag 内容向量条目（从 relations-cache 的 relation.tags 恢复）。
 * 每个有 tags 字段的 relation，从 local KB（index.json）读取原文，为每个 tag 生成一条内容向量。
 * 用于 rebuild-vector/restore 时自动恢复自定义 tag 向量，使 -t <tag> 可召回。
 */
export function collectTagEntries(
  scope: string,
  groups: Record<string, CacheGroup>
): RebuildVectorEntry[] {
  const entries: RebuildVectorEntry[] = [];
  const config = loadConfig();
  const scopeDir = getScopeDataDir(config, scope);
  // 按 group 缓存 index.json 内容，避免每个 relation 重复读文件（性能优化）
  const localKbCache = new Map<string, Record<string, string> | undefined>();

  for (const [groupPath, g] of Object.entries(groups)) {
    let localKb = localKbCache.get(groupPath);
    if (localKb === undefined && !localKbCache.has(groupPath)) {
      // 首次访问该 group：加载 index.json（读取失败则缓存 undefined 避免重复尝试）
      const localKbPath = path.join(scopeDir, groupPath, 'index.json');
      try {
        if (fs.existsSync(localKbPath)) {
          localKb = JSON.parse(fs.readFileSync(localKbPath, 'utf-8')) as Record<string, string>;
        }
      } catch {
        localKb = undefined;
      }
      localKbCache.set(groupPath, localKb);
    }
    if (!localKb) continue; // 无 local KB 无法恢复 tag 原文
    for (const rel of g.hot_relations ?? []) {
      if (!rel.tags || rel.tags.length === 0) continue;
      const text = localKb[rel.text]; // 从 local KB 读取文件原文（键 = relation 名）
      if (!text) continue; // 无原文无法写 tag 向量
      // 每个 tag 生成一条内容向量（text 相同、tag 不同）
      for (const tag of rel.tags) {
        entries.push({
          text,
          tags: tag,
          group: groupPath,
          relationName: rel.text,
        });
      }
    }
  }
  return entries;
}

/**
 * 回写向量 docId 到 relations-cache 的 rel.memoryId / rel.memoryIds。
 * 匹配键 = groupPath + relationName（index.json 键 ↔ rel.text）。
 * 覆盖内容向量 + 自定义 tag 向量（按 group,relation 聚合 docId），relation/path 向量为检索辅助不关联 cache 条目。
 * @param allEntries 全量 entries（content + relation + path + tag）
 * @param results vectorBulkStore 返回值（index 为全量 entries 索引）
 */
export function updateMemoryIds(
  groups: Record<string, CacheGroup>,
  allEntries: RebuildVectorEntry[],
  results: VectorBulkStoreResult['results']
): number {
  // 按 (groupPath, relationName) 分组收集全部成功条目的 docId（含内容向量 + 自定义 tag 向量）
  const keyToMids = new Map<string, string[]>();
  for (const r of results) {
    if (!r.success) continue;
    const e = allEntries[r.index];
    if (e?.groupPath && e?.relationName) {
      const key = `${e.groupPath}\u0000${e.relationName}`;
      const arr = keyToMids.get(key);
      if (arr) arr.push(r.memoryId);
      else keyToMids.set(key, [r.memoryId]);
    }
  }
  let updated = 0;
  for (const [groupPath, g] of Object.entries(groups)) {
    for (const rel of g.hot_relations ?? []) {
      const mids = keyToMids.get(`${groupPath}\u0000${rel.text}`);
      if (mids && mids.length > 0) {
        // memoryId = 第一个（ki-search 内容向量，向后兼容）；memoryIds = 全部（含 tag docId）
        const changed = rel.memoryId !== mids[0] || (rel.memoryIds ?? []).join(',') !== mids.join(',');
        if (changed) {
          rel.memoryId = mids[0];
          rel.memoryIds = mids;
          updated++;
        }
      }
    }
  }
  return updated;
}

// ─── 主流程 ───

export interface RebuildDeps {
  bulkStore?: typeof vectorBulkStore;
  deleteScope?: typeof vectorDeleteScope;
}

/**
 * 从已还原 KB 重建 scope 的三类向量，并回写 memoryId。
 * @param deps 依赖注入（测试用 mock，缺省用真实实现）
 */
export async function rebuildScopeVectors(
  scope: string,
  deps: RebuildDeps = {}
): Promise<RebuildVectorResult> {
  const bulkStore = deps.bulkStore ?? vectorBulkStore;
  const deleteScope = deps.deleteScope ?? vectorDeleteScope;

  const emptyStats = (): RebuildVectorStats => ({
    content: 0,
    relation: 0,
    path: 0,
    succeeded: 0,
    failed: 0,
    updatedMemoryId: 0,
  });
  const stats = emptyStats();
  const errors: { type: string; path: string; error: string }[] = [];

  const config = loadConfig();
  const scopeDir = getScopeDataDir(config, scope);

  if (!fs.existsSync(scopeDir)) {
    return { ok: false, scope, stats, errors: [{ type: 'scope', path: scopeDir, error: 'scope 数据目录不存在' }] };
  }
  const cachePath = path.join(scopeDir, 'relations-cache.json');
  if (!fs.existsSync(cachePath)) {
    return {
      ok: false,
      scope,
      stats,
      errors: [{ type: 'cache', path: cachePath, error: 'relations-cache.json 不存在' }],
    };
  }

  // 1. 收集四类条目（内容 + relation + path + 自定义 tag）
  const rc = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { groups?: Record<string, CacheGroup> };
  const groups = rc.groups ?? {};
  const contentEntries = collectContentEntries(scopeDir);
  const { relationEntries, pathEntries } = collectPathRelationEntries(groups);
  const tagEntries = collectTagEntries(scope, groups);
  stats.content = contentEntries.length;
  stats.relation = relationEntries.length;
  stats.path = pathEntries.length;
  const allEntries = [...contentEntries, ...relationEntries, ...pathEntries, ...tagEntries];

  // 2. 清空旧向量（保证结果与 KB 一致；失败则中止，避免新旧混杂）
  try {
    await deleteScope({ scope });
  } catch (err) {
    return {
      ok: false,
      scope,
      stats,
      errors: [{ type: 'cleanup', path: scope, error: `清空旧向量失败：${(err as Error).message}` }],
    };
  }

  // 3. 批量向量化
  const res = await bulkStore({ scope, entries: allEntries });
  stats.succeeded = res.succeeded;
  stats.failed = res.failed;
  for (const r of res.results) {
    if (!r.success) {
      const src = allEntries[r.index];
      errors.push({
        type: 'vectorize',
        path: src ? src.text.slice(0, 60) : `index=${r.index}`,
        error: r.error ?? 'unknown',
      });
    }
  }

  // 4. memoryId 回写（内容向量 + 自定义 tag 向量按 (group,relation) 聚合回填；relation/path 向量不关联 cache）
  stats.updatedMemoryId = updateMemoryIds(groups, allEntries, res.results);
  fs.writeFileSync(cachePath, JSON.stringify(rc, null, 2), 'utf-8');

  return { ok: true, scope, stats, errors };
}
