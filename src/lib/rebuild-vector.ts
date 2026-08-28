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
 * 局部重建（--group / --tags）：指定过滤/打标参数时为 partial 模式——
 *   - 不执行全量 deleteScope，仅对匹配子集幂等覆盖（docId 确定性，upsert 幂等），其他向量不受影响；
 *   - --tags 为打标语义：与重建范围内 relation 的已有 rel.tags 合并去重（只增不减），
 *     合并后每个 tag 生成一条内容向量；跨命令累积天然成立（载体即 rel.tags）；
 *   - partial 重建成功后不清导入中断标记（由调用方依据 result.partial 判定）。
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
import { logInfo, logProgress } from './progress.js';
import { parseContentTags } from './constants.js';

/** 向量化分批大小（与 import 链路 bulkVectorize 对齐：批间输出进度，避免单次 upsert 无中间态） */
const VECTORIZE_BATCH_SIZE = 200;

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
  /** 自定义 tag 内容向量条目数（含恢复的 + --tags 新打的） */
  tag: number;
  succeeded: number;
  failed: number;
  updatedMemoryId: number;
  /** --tags 打标：本次实际新增标签的 relation 数（未传 --tags 为 0） */
  taggedRelations: number;
  /** --tags 解析去重后的标签集合（未传为空数组） */
  mergedTags: string[];
}

export interface RebuildVectorResult {
  ok: boolean;
  scope: string;
  /** true = 局部重建（带 --group/--tags）：未清空其他向量、不清中断标记 */
  partial: boolean;
  stats: RebuildVectorStats;
  errors: { type: string; path: string; error: string }[];
}

/** 重建选项（对应 CLI 的 --group / --tags） */
export interface RebuildVectorOptions {
  /** --group 过滤：仅重建该 Group 子树（相对 scope 数据目录的 Group 路径，如 `a/b`） */
  groupFilter?: string;
  /** --tags 打标：逗号分隔；与范围内 relation 已有 rel.tags 合并去重（只增不减） */
  tags?: string;
  /** CLI 层是否显式传入了 --tags（NEG：原始值非空但解析后为空时提示保留标签被过滤） */
  tagsProvided?: boolean;
}

/** relations-cache 的 groups 扁平结构（键 = 完整 groupPath） */
interface CacheGroup {
  hot_relations?: { text: string; memoryId?: string | null; memoryIds?: string[]; tags?: string[] }[];
  keywords?: string[];
}

/** groupPath 是否在过滤子树内（自身或子孙）；未指定过滤时全部命中 */
export function isInGroupScope(groupPath: string, groupFilter?: string): boolean {
  if (!groupFilter) return true;
  return groupPath === groupFilter || groupPath.startsWith(groupFilter + '/');
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
 * @param groupFilter 可选：仅收集该 Group 子树下的 index.json（目录不存在时返回空）
 */
export function collectContentEntries(scopeDir: string, groupFilter?: string): RebuildVectorEntry[] {
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

  if (groupFilter) {
    // 过滤模式：直接从子树目录起遍历（子树不存在时返回空，由调用方先校验）
    const subDir = path.join(scopeDir, ...groupFilter.split('/'));
    if (fs.existsSync(subDir) && fs.statSync(subDir).isDirectory()) {
      walk(subDir, groupFilter);
    }
    return entries;
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
  groups: Record<string, CacheGroup>,
  groupFilter?: string
): { relationEntries: RebuildVectorEntry[]; pathEntries: RebuildVectorEntry[] } {
  const relationEntries: RebuildVectorEntry[] = [];
  const pathEntries: RebuildVectorEntry[] = [];

  for (const [groupPath, g] of Object.entries(groups)) {
    if (!isInGroupScope(groupPath, groupFilter)) continue;
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
  groups: Record<string, CacheGroup>,
  groupFilter?: string
): RebuildVectorEntry[] {
  const entries: RebuildVectorEntry[] = [];
  const config = loadConfig();
  const scopeDir = getScopeDataDir(config, scope);
  // 按 group 缓存 index.json 内容，避免每个 relation 重复读文件（性能优化）
  const localKbCache = new Map<string, Record<string, string> | undefined>();

  for (const [groupPath, g] of Object.entries(groups)) {
    if (!isInGroupScope(groupPath, groupFilter)) continue;
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
          groupPath: groupPath,
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
    if (!r.success || !r.memoryId) continue;
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

// ─── 打标合并（--tags） ───

/**
 * --tags 打标：将 CLI 标签与重建范围内 relation 的已有 rel.tags 合并去重（只增不减）。
 * 跨命令累积天然成立：载体即 rel.tags（restore 打 a → 再次 rebuild 打 b → a∪b）。
 * @param tags 已经 parseContentTags 解析去重的标签；空数组时不操作
 * @returns taggedRelations 本次实际新增标签的 relation 数（无新增不计）
 */
export function mergeRebuildTags(
  groups: Record<string, CacheGroup>,
  tags: string[],
  groupFilter?: string
): { taggedRelations: number } {
  if (tags.length === 0) return { taggedRelations: 0 };
  let taggedRelations = 0;
  for (const [groupPath, g] of Object.entries(groups)) {
    if (!isInGroupScope(groupPath, groupFilter)) continue;
    for (const rel of g.hot_relations ?? []) {
      const existing = rel.tags ?? [];
      const toAdd = tags.filter((t) => !existing.includes(t));
      if (toAdd.length === 0) continue;
      rel.tags = [...existing, ...toAdd];
      taggedRelations++;
    }
  }
  return { taggedRelations };
}

// ─── 主流程 ───

export interface RebuildDeps {
  bulkStore?: typeof vectorBulkStore;
  deleteScope?: typeof vectorDeleteScope;
  /**
   * 进度展示用：全量重建清空前统计旧向量总数（CLI 注入真实实现）。
   * 省略时跳过统计，删除旧向量无进度条（测试注入 mock 时不得触碰真实引擎）。
   */
  countScope?: (params: { scope: string }) => Promise<number>;
}

/**
 * 从已还原 KB 重建 scope 的向量，并回写 memoryId。
 * 不带 opts 时为全量重建（清空+重建，幂等）；带 --group/--tags 时为局部重建（见模块头说明）。
 * @param deps 依赖注入（测试用 mock，缺省用真实实现）
 * @param opts 局部重建选项（--group 过滤 / --tags 打标）
 */
export async function rebuildScopeVectors(
  scope: string,
  deps: RebuildDeps = {},
  opts: RebuildVectorOptions = {}
): Promise<RebuildVectorResult> {
  const startedAt = Date.now();
  const bulkStore = deps.bulkStore ?? vectorBulkStore;
  const deleteScope = deps.deleteScope ?? vectorDeleteScope;
  const countScope = deps.countScope;

  const groupFilter = opts.groupFilter?.trim() || undefined;
  const cliTags = parseContentTags(opts.tags);
  const partial = Boolean(groupFilter) || cliTags.length > 0;

  const emptyStats = (): RebuildVectorStats => ({
    content: 0,
    relation: 0,
    path: 0,
    tag: 0,
    succeeded: 0,
    failed: 0,
    updatedMemoryId: 0,
    taggedRelations: 0,
    mergedTags: cliTags,
  });
  const stats = emptyStats();
  const errors: { type: string; path: string; error: string }[] = [];

  // NEG：显式传入 --tags 但解析后为空（全为保留标签/空白）：
  //   - 无 --group 时拒绝执行（库层与 CLI 层一致，避免程序化调用静默降级为全量清空重建）；
  //   - 有 --group 时仅警告（仍为局部重建，无全量清空风险）。
  if (opts.tagsProvided && cliTags.length === 0) {
    if (!groupFilter) {
      return {
        ok: false,
        scope,
        partial,
        stats,
        errors: [{ type: 'tags', path: opts.tags ?? '', error: '--tags 解析后无有效标签（内部保留标签 ki-search/ki-relation/ki-path 不可用）；为避免误降级为全量清空重建，本次未执行' }],
      };
    }
    process.stderr.write(
      '警告：--tags 解析后无有效标签（内部保留标签 ki-search/ki-relation/ki-path 不可用作自定义标签；已忽略）。\n'
    );
  }

  const config = loadConfig();
  const scopeDir = getScopeDataDir(config, scope);

  if (!fs.existsSync(scopeDir)) {
    return { ok: false, scope, partial, stats, errors: [{ type: 'scope', path: scopeDir, error: 'scope 数据目录不存在' }] };
  }
  const cachePath = path.join(scopeDir, 'relations-cache.json');
  if (!fs.existsSync(cachePath)) {
    return {
      ok: false,
      scope,
      partial,
      stats,
      errors: [{ type: 'cache', path: cachePath, error: 'relations-cache.json 不存在' }],
    };
  }

  // --group 路径安全校验（禁空段与 ./..，防目录穿越与归一化后元数据错位）
  if (groupFilter) {
    const segs = groupFilter.split('/');
    if (segs.some((s) => s === '' || s === '.' || s === '..')) {
      return {
        ok: false,
        scope,
        partial,
        stats,
        errors: [{ type: 'group', path: groupFilter, error: '--group 路径非法（不允许空段或 ..）' }],
      };
    }
  }

  // 1. 读取 relations-cache；--group 需存在（目录或 cache 任一侧命中）
  const rc = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as { groups?: Record<string, CacheGroup> };
  const groups = rc.groups ?? {};
  if (groupFilter) {
    const groupAbs = path.join(scopeDir, ...groupFilter.split('/'));
    const dirExists = fs.existsSync(groupAbs) && fs.statSync(groupAbs).isDirectory();
    const cacheExists = Object.keys(groups).some((k) => isInGroupScope(k, groupFilter));
    if (!dirExists && !cacheExists) {
      return {
        ok: false,
        scope,
        partial,
        stats,
        errors: [{ type: 'group', path: groupFilter, error: `--group 指定的 Group 不存在：${groupFilter}` }],
      };
    }
  }

  // 2. --tags 打标：先合并写 rel.tags，再收集（使本次重建包含新标签的向量）
  const { taggedRelations } = mergeRebuildTags(groups, cliTags, groupFilter);
  stats.taggedRelations = taggedRelations;

  // 3. 收集四类条目（内容 + relation + path + 自定义 tag）
  const contentEntries = collectContentEntries(scopeDir, groupFilter);
  const { relationEntries, pathEntries } = collectPathRelationEntries(groups, groupFilter);
  const tagEntries = collectTagEntries(scope, groups, groupFilter);
  stats.content = contentEntries.length;
  stats.relation = relationEntries.length;
  stats.path = pathEntries.length;
  stats.tag = tagEntries.length;
  const allEntries = [...contentEntries, ...relationEntries, ...pathEntries, ...tagEntries];
  logInfo(
    `收集到 ${allEntries.length} 个条目（内容 ${stats.content} / 关系 ${stats.relation} / 路径 ${stats.path} / 标签 ${stats.tag}）`
  );

  // 4. 清空旧向量：仅全量重建执行（保证结果与 KB 一致）；
  //    局部重建跳过（幂等覆盖匹配子集，其他向量不受影响）。失败则中止，避免新旧混杂。
  //    注入 countScope 时（CLI 路径）先统计旧向量总数，删除过程输出进度条。
  if (!partial) {
    try {
      let existingCount: number | undefined;
      if (countScope) existingCount = await countScope({ scope });
      const del = await deleteScope(
        { scope },
        existingCount !== undefined && existingCount > 0
          ? (deleted) => logProgress(deleted, existingCount!, '删除旧向量')
          : undefined
      );
      if (existingCount !== undefined && existingCount > 0) {
        logInfo(`已删除旧向量 ${del.deleted} 条`);
      }
    } catch (err) {
      return {
        ok: false,
        scope,
        partial,
        stats,
        errors: [{ type: 'cleanup', path: scope, error: `清空旧向量失败：${(err as Error).message}` }],
      };
    }
  }

  // 5. 批量向量化（局部重建时 allEntries 为空则直接完成，仅保留打标回写）
  //    分批提交（200 条/批，与 import 链路 bulkVectorize 对齐）：引擎内部批量 embed 无中间态，
  //    分批后批间可输出进度；docId 由 text+scope+tag 确定性生成，分批不改变幂等语义。
  if (partial && allEntries.length === 0) {
    // NEG：范围内无任何可重建条目 → 显式提示，避免用户误以为重建生效（如 --group 目录下无 index.json 且 cache 无该子树条目）
    process.stderr.write(
      '提示：本次局部重建范围内未收集到任何条目（目标 Group 下可能没有 index.json / relations-cache 条目）；未写入任何向量。\n'
    );
  }
  const aggResults: VectorBulkStoreResult['results'] = [];
  if (allEntries.length > 0) {
    const totalBatches = Math.ceil(allEntries.length / VECTORIZE_BATCH_SIZE);
    if (totalBatches > 1) {
      logInfo(`开始向量化：共 ${allEntries.length} 条，每批 ${VECTORIZE_BATCH_SIZE} 条，共 ${totalBatches} 批`);
    }
    for (let b = 0; b < totalBatches; b++) {
      const offset = b * VECTORIZE_BATCH_SIZE;
      const slice = allEntries.slice(offset, offset + VECTORIZE_BATCH_SIZE);
      const res = await bulkStore({ scope, entries: slice });
      stats.succeeded += res.succeeded;
      stats.failed += res.failed;
      // results[].index 为批内相对索引，聚合时加批偏移还原为全量 entries 索引
      for (const r of res.results) {
        aggResults.push({ ...r, index: r.index + offset });
      }
      if (totalBatches > 1) {
        logProgress(
          Math.min(offset + VECTORIZE_BATCH_SIZE, allEntries.length),
          allEntries.length,
          `向量化批次 ${b + 1}/${totalBatches}`
        );
      }
    }
  }
  for (const r of aggResults) {
    if (!r.success) {
      const src = allEntries[r.index];
      errors.push({
        type: 'vectorize',
        path: src ? src.text.slice(0, 60) : `index=${r.index}`,
        error: r.error ?? 'unknown',
      });
    }
  }

  // 6. memoryId 回写（内容向量 + 自定义 tag 向量按 (group,relation) 聚合回填；relation/path 向量不关联 cache）
  stats.updatedMemoryId = updateMemoryIds(groups, allEntries, aggResults);
  fs.writeFileSync(cachePath, JSON.stringify(rc, null, 2), 'utf-8');
  logInfo(`向量重建完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  return { ok: true, scope, partial, stats, errors };
}
