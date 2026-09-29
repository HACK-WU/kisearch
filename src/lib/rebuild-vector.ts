/**
 * rebuild-vector.ts —— 从已还原的 KB 重建 scope 向量
 *
 * 背景：restore 只还原 KB 文件层（relations-cache.json + Group 树 index.json），
 * 向量层（vectorDir）不随快照还原。本模块从已还原 KB 重建三类向量（与 import 流程对齐）：
 *   - ki-search   内容向量：Group index.json 的 {关系名: 描述文本}
 *   - ki-relation 关系向量：每条 relation 一条（relation名 + Group路径 + 关键词）
 *   - ki-path     路径向量：每个 Group 一条（Group路径 + 关键词）
 *
 * 同维度重建前清空 scope 旧向量（vectorDeleteScope）；跨维度时写入暂存 Collection，
 * 完整写入并校验后才切换目录，旧 Collection 留在 migration-backups 供恢复。
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
import { randomUUID } from 'node:crypto';
import { loadConfig, getScopeDataDir, getScopeCleanConfig, runWithConfigSnapshot } from './config.js';
import { getVectorMigrationMarkerPath, getVectorMigrationPaths } from './scope-collection.js';
import { buildGroupPathContent, buildRelationContent } from './path-vectorize.js';
import { buildChunkEntries } from './chunk-entries.js';
import { cleanMarkdownText, runCleanHooks, type CleanRules } from './clean.js';
import { getSource } from './scope.js';
import {
  vectorBulkStore,
  vectorCollectionDimension,
  vectorDeleteScope,
  closeEngine,
  getEngine,
  type VectorBulkStoreResult,
} from './vector-client.js';
import { logInfo, logProgress, logWarn } from './progress.js';
import { parseContentTags } from './constants.js';
import { ftsDeleteByIds } from './fts-client.js';

/** 向量化分批大小（与 import 链路 bulkVectorize 对齐：批间输出进度，避免单次 upsert 无中间态） */
const VECTORIZE_BATCH_SIZE = 200;

/** 切分参数默认值（与 import 的 --chunk-size / --chunk-overlap 默认对齐；source 块缺失时回退） */
const DEFAULT_CHUNK_SIZE = 1000;
const DEFAULT_CHUNK_OVERLAP = 150;

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
  /** content 向量专用：chunk relation 名（如 foo-01）；ki-relation 向量以它作为文本 */
  chunkRelation?: string;
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
  /** 跨维度迁移成功后保留的旧 Collection 目录，供人工回退。 */
  migrationBackup?: string;
  /** 与旧 Collection 配套的 relations-cache 备份。 */
  migrationCacheBackup?: string;
}

/** 重建选项（对应 CLI 的 --group / --tags） */
export interface RebuildVectorOptions {
  /** --group 过滤：仅重建该 Group 子树（相对 scope 数据目录的 Group 路径，如 `a/b`） */
  groupFilter?: string;
  /** --tags 打标：逗号分隔；与范围内 relation 已有 rel.tags 合并去重（只增不减） */
  tags?: string;
  /** CLI 层是否显式传入了 --tags（NEG：原始值非空但解析后为空时提示保留标签被过滤） */
  tagsProvided?: boolean;
  /** 跨维度全量重建会替换旧 Collection，必须显式确认。 */
  yes?: boolean;
  /** 仅在批次边界检查；不强行打断正在进行的 embedding/zvec 批次。 */
  abortSignal?: AbortSignal;
  /** 切分参数覆盖；缺省读 group-index.source（导入时持久化），再缺省 1000/150 */
  chunkSize?: number;
  chunkOverlap?: number;
  onProgress?: (progress: {
    phase: 'rebuild';
    done: number;
    total: number;
    persisted?: number;
    metadataPending?: number;
    failed?: number;
    cancelled?: number;
  }) => void;
}

/** relations-cache 的 groups 扁平结构（键 = 完整 groupPath） */
interface CacheGroup {
  hot_relations?: { text: string; memoryId?: string | null; memoryIds?: string[]; tags?: string[];
    ftsIds?: string[]; ftsLocators?: Array<{ ftsId: string; lineStart: number; lineEnd: number; sourcePath?: string; chunkIndex?: number }>; ftsIndexComplete?: boolean }[];
  keywords?: string[];
}

/**
 * 集合与缓存的切换跨多次 rename，中途崩溃会留下"半切换"现场。
 * 下次显式重建时先按事务标记恢复旧集合与配套缓存，再按当前配置重试。
 * 标记属不可信的本地状态：其中记录的每条路径都必须与"当前配置 + 已校验 scope +
 * migrationId"派生出的路径一致，否则宁可拒绝自动回退。
 */
async function rollbackPendingVectorMigration(
  scope: string,
  config: ReturnType<typeof loadConfig>,
  scopeDir: string,
): Promise<boolean> {
  const markerProbePath = getVectorMigrationMarkerPath(config, scope);
  if (!fs.existsSync(markerProbePath)) return false;

  let marker: Record<string, unknown>;
  try {
    marker = JSON.parse(fs.readFileSync(markerProbePath, 'utf-8')) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`事务标记损坏，无法自动回退：${markerProbePath}；${(error as Error).message}`);
  }
  const migrationId = marker.migrationId;
  if (marker.scope !== scope || typeof migrationId !== 'string') {
    throw new Error(`事务标记 scope 或 migrationId 无效，拒绝自动回退：${markerProbePath}`);
  }

  // 与写入侧同一派生函数：vectorDir 若已变更，这里算出的路径与标记不符 → 拒绝自动回退，
  // 避免把旧 vectorDir 的集合改名到新位置（那才是真正的数据错位）。
  const paths = getVectorMigrationPaths(config, scope, migrationId);
  const { stageRoot, stageCollectionPath, liveCollectionPath, backupPath, cacheBackupPath, markerPath } = paths;
  const stageConfig = { ...config, vectorDir: stageRoot };
  const cachePath = path.join(scopeDir, 'relations-cache.json');
  const expectedPaths: Record<string, string> = {
    backupPath,
    cacheBackupPath,
    cachePath,
    liveCollectionPath,
    stageCollectionPath,
  };
  for (const [key, expected] of Object.entries(expectedPaths)) {
    if (path.resolve(String(marker[key] ?? '')) !== path.resolve(expected)) {
      throw new Error(`事务标记路径 ${key} 与当前配置不符，拒绝自动回退：${markerPath}`);
    }
  }

  await closeEngine(scope);
  const hasOldCollectionBackup = fs.existsSync(backupPath);
  if (hasOldCollectionBackup) {
    if (!fs.existsSync(cacheBackupPath)) {
      throw new Error(`旧 Collection 备份存在但 relations-cache 备份缺失，拒绝自动回退：${backupPath}`);
    }
    if (fs.existsSync(liveCollectionPath)) {
      if (fs.existsSync(stageCollectionPath)) {
        throw new Error(`迁移目录状态不明确（live 与 stage 同时存在），拒绝自动回退：${markerPath}`);
      }
      fs.mkdirSync(path.dirname(stageCollectionPath), { recursive: true, mode: 0o700 });
      fs.renameSync(liveCollectionPath, stageCollectionPath);
    }
    fs.renameSync(backupPath, liveCollectionPath);
  } else if (!fs.existsSync(liveCollectionPath)) {
    throw new Error(`旧 Collection 与旧集合备份均不存在，拒绝自动回退：${markerPath}`);
  }

  if (fs.existsSync(cacheBackupPath)) {
    const cacheRestoreTemp = path.join(scopeDir, `.relations-cache-recovery-${migrationId}.tmp`);
    fs.copyFileSync(cacheBackupPath, cacheRestoreTemp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(cacheRestoreTemp, 0o600);
    fs.renameSync(cacheRestoreTemp, cachePath);
  } else if (hasOldCollectionBackup) {
    // 上面已拦住这种组合；此处保留显式判断，防止将来调整顺序时丢掉这条不变量。
    throw new Error(`relations-cache 备份缺失，拒绝自动回退：${cacheBackupPath}`);
  }

  fs.rmSync(markerPath);
  try {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  } catch (error) {
    logWarn(`旧迁移暂存目录清理失败（可稍后手动清理）：${stageRoot}；${(error as Error).message}`);
  }
  logWarn(`检测到未完成的向量迁移，已自动恢复旧 Collection 与 relations-cache；现将按当前配置重新执行：${scope}`);
  return true;
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
export function collectContentEntries(scopeDir: string, groupFilter?: string, strict = false): RebuildVectorEntry[] {
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
        if (!content || typeof content !== 'object' || Array.isArray(content)) {
          throw new Error('顶层必须是对象');
        }
      } catch (error) {
        if (strict) throw new Error(`读取 ${indexFile} 失败：${(error as Error).message}`);
        /* 单个 index.json 解析失败跳过 */
      }
      for (const [k, v] of Object.entries(content)) {
        if (k === 'version' || k === 'updatedAt') continue;
        if (strict && typeof v !== 'string') {
          throw new Error(`迁移来源 ${indexFile} 的关系 "${k}" 不是文本`);
        }
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
 * 从 chunk 级 content 条目派生 ki-relation 向量条目。
 *
 * 与 import 对齐：**每个 chunk 一条**（文本 = chunk relation 名，如 `foo-01`）。
 * 旧实现从 relations-cache 的 hot_relations 收集（文件级 relation 一条），
 * 导致 rebuild 的 ki-relation 向量数量与 import 不一致。
 */
export function collectRelationEntries(contentEntries: RebuildVectorEntry[]): RebuildVectorEntry[] {
  return contentEntries
    .filter((e) => e.chunkRelation)
    .map((e) => ({
      text: buildRelationContent(e.chunkRelation!, e.groupPath),
      tags: RELATION_TAG,
      group: e.groupPath,
    }));
}

/**
 * 收集 ki-path 向量条目（每个出现过 content chunk 的 group 一条）。
 * 与 import 的 groupSet 语义一致：只对实际有向量条目的 group 建 path 向量。
 */
export function collectPathEntries(contentEntries: RebuildVectorEntry[]): RebuildVectorEntry[] {
  const groupSet = new Set<string>();
  for (const e of contentEntries) {
    if (e.groupPath) groupSet.add(e.groupPath);
  }
  return [...groupSet].map((groupPath) => ({
    text: buildGroupPathContent(groupPath),
    tags: PATH_TAG,
  }));
}

/**
 * 把文件级原文条目（local KB 的值）清洗 + 切分为 chunk 级 content 条目。
 *
 * 必要性：local KB 存的是**文件级原文**（方案 D），而 import 的向量化输入是
 * **清洗后的 chunk**。旧 rebuild 直接拿 KB 原文做向量，造成粒度（文件级 vs chunk 级）
 * 与文本（原文 vs 清洗后）双重不一致，docId/memoryId 语义随之漂移。
 * 本函数复用 import 的清洗与 chunk 实现，保证两条链路产出相同的 chunkRelation / docId。
 */
async function buildContentChunkEntries(
  rawEntries: RebuildVectorEntry[],
  opts: {
    cleanEnabled: boolean;
    cleanRules?: CleanRules;
    cleanHooks: string[];
    chunkSize: number;
    chunkOverlap: number;
    abortSignal?: AbortSignal;
  },
): Promise<RebuildVectorEntry[]> {
  const out: RebuildVectorEntry[] = [];
  for (const raw of rawEntries) {
    // 切分 + 清洗是逐文件的 CPU 工作，取消不应等到向量化阶段才生效
    if (opts.abortSignal?.aborted) {
      throw Object.assign(new Error('向量重建已取消（切分阶段）'), { code: 'REBUILD_CANCELLED' });
    }
    const relationName = raw.relationName ?? '<unknown>';
    let text = opts.cleanEnabled ? cleanMarkdownText(raw.text, opts.cleanRules) : raw.text;
    if (opts.cleanEnabled && opts.cleanHooks.length > 0) {
      const hookResult = await runCleanHooks(text, opts.cleanHooks);
      if (!hookResult.ok) {
        // 与 import 的 P-7 语义一致：hooks 全部失败 → 不写该文件的向量
        logWarn(`清洗 hook 失败已跳过（${relationName}）：${hookResult.failedHooks.join(', ')}`);
        continue;
      }
      text = hookResult.text;
    }
    // chunk 命名以 local KB 键（= 导入时的 deriveRelationText(rel)）为前缀，与 import 产物同构
    const { entries } = buildChunkEntries({
      fileKey: relationName,
      groupPath: raw.groupPath ?? '',
      text,
      chunkSize: opts.chunkSize,
      chunkOverlap: opts.chunkOverlap,
    });
    for (const e of entries) {
      out.push({
        text: e.text,
        tags: CONTENT_TAG,
        groupPath: raw.groupPath,
        relationName: raw.relationName,
        chunkRelation: e.chunkRelation,
      });
    }
  }
  return out;
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
  /** 读取旧 Collection 维度，确保重建修改数据前发现配置不兼容。 */
  collectionDimension?: (scope: string) => Promise<number | undefined>;
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
  const checkCancelled = (done = 0, total = 1): void => {
    opts.onProgress?.({ phase: 'rebuild', done, total });
    if (opts.abortSignal?.aborted) {
      throw Object.assign(new Error(`向量重建已取消（当前批次完成，已处理 ${done}/${total} 条）`), { code: 'REBUILD_CANCELLED' });
    }
  };
  checkCancelled();
  const startedAt = Date.now();
  const bulkStore = deps.bulkStore ?? vectorBulkStore;
  const deleteScope = deps.deleteScope ?? vectorDeleteScope;
  const collectionDimension = deps.collectionDimension ?? vectorCollectionDimension;
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
  let cumulativePersisted = 0;
  let cumulativeMetadataPending = 0;
  let cumulativeFailed = 0;
  let cumulativeCancelled = 0;

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

  try {
    await rollbackPendingVectorMigration(scope, config, scopeDir);
  } catch (error) {
    return {
      ok: false,
      scope,
      partial,
      stats,
      errors: [{ type: 'migration-recovery', path: scope, error: `检测到未完成的向量迁移，自动回退未完成；所有 scope 读写仍受保护。请检查迁移事务标记及其记录的备份路径：${(error as Error).message}` }],
    };
  }

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

  // 在清理或打标前确认维度。跨维度只能通过显式确认的全量重建迁移 schema。
  let persistedDimension: number | undefined;
  try {
    persistedDimension = await collectionDimension(scope);
  } catch (err) {
    return {
      ok: false,
      scope,
      partial,
      stats,
      errors: [{
        type: 'dimension',
        path: scope,
        error: `读取旧 Collection 维度失败，未执行重建：${(err as Error).message}`,
      }],
    };
  }
  const embeddingDimension = config.embedding.dimension;
  const needsMigration = persistedDimension !== undefined && embeddingDimension !== persistedDimension;
  if (needsMigration && (partial || opts.yes !== true)) {
    return {
      ok: false,
      scope,
      partial,
      stats,
      errors: [{
        type: 'dimension',
        path: scope,
        error: `embedding.dimension (${embeddingDimension}) !== persisted dimension (${persistedDimension})；旧向量及 relations-cache 均未更改。${partial ? '跨维度迁移仅支持全量重建，请去掉 --group/--tags 后添加 --yes' : `确认替换旧向量集合后，请执行 ki restore ${scope} --rebuild-vector --yes`}`,
      }],
    };
  }

  // 2. --tags 打标：先合并写 rel.tags，再收集（使本次重建包含新标签的向量）
  const { taggedRelations } = mergeRebuildTags(groups, cliTags, groupFilter);
  stats.taggedRelations = taggedRelations;

  // 3. 收集条目：content 与 import 对齐 —— 清洗 → 按 source 块记录的参数切分 → chunk 级条目。
  //    必要性：local KB 存的是文件级原文（方案 D），直接向量化会与 import 的
  //    清洗后 chunk 产物在粒度与文本上双重不一致（docId/memoryId 随之漂移）。
  const source = getSource(scope);
  const chunkSize = opts.chunkSize ?? source?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const chunkOverlap = opts.chunkOverlap ?? source?.chunkOverlap ?? DEFAULT_CHUNK_OVERLAP;
  const cleanCfg = getScopeCleanConfig(config, scope);
  const cleanEnabled = cleanCfg?.enabled !== false;
  const cleanHooks = cleanCfg?.hooks ?? [];

  let rawContentEntries: RebuildVectorEntry[];
  try {
    rawContentEntries = collectContentEntries(scopeDir, groupFilter, needsMigration);
  } catch (error) {
    return { ok: false, scope, partial, stats, errors: [{ type: 'migration-source', path: scopeDir, error: `迁移前读取 KB 失败，旧集合未更改：${(error as Error).message}` }] };
  }
  const contentEntries = await buildContentChunkEntries(rawContentEntries, {
    cleanEnabled,
    cleanRules: cleanCfg?.rules,
    cleanHooks,
    chunkSize,
    chunkOverlap,
    abortSignal: opts.abortSignal,
  });
  if (needsMigration) {
    const rebuiltRelations = new Set(contentEntries.map((entry) => `${entry.groupPath ?? ''}\u0000${entry.relationName ?? ''}`));
    for (const [groupPath, group] of Object.entries(groups)) {
      for (const rel of group.hot_relations ?? []) {
        if (!rel.memoryId && (rel.memoryIds?.length ?? 0) === 0) continue;
        if (rebuiltRelations.has(`${groupPath}\u0000${rel.text}`)) continue;
        return { ok: false, scope, partial, stats, errors: [{ type: 'migration-source', path: `${groupPath}/${rel.text}`, error: '旧缓存引用了向量，但 KB 原文无法生成对应内容向量；已保留旧集合和缓存，请先修复 index.json/清洗配置' }] };
      }
    }
  }
  const relationEntries = collectRelationEntries(contentEntries);
  const pathEntries = collectPathEntries(contentEntries);
  const tagEntries = collectTagEntries(scope, groups, groupFilter);
  stats.content = contentEntries.length;
  stats.relation = relationEntries.length;
  stats.path = pathEntries.length;
  stats.tag = tagEntries.length;
  const allEntries = [...contentEntries, ...relationEntries, ...pathEntries, ...tagEntries];
  logInfo(
    `切分完成：${rawContentEntries.length} 个 KB 条目 → ${contentEntries.length} 个 chunk`
      + `（chunkSize=${chunkSize}, overlap=${chunkOverlap}, clean=${cleanEnabled ? 'on' : 'off'}）`
  );
  logInfo(
    `收集到 ${allEntries.length} 个条目（内容 ${stats.content} / 关系 ${stats.relation} / 路径 ${stats.path} / 标签 ${stats.tag}）`
  );

  const migrationId = needsMigration ? randomUUID() : '';
  const migrationPaths = needsMigration ? getVectorMigrationPaths(config, scope, migrationId) : null;
  const stageRoot = migrationPaths?.stageRoot ?? '';
  const stageConfig = migrationPaths ? { ...config, vectorDir: migrationPaths.stageRoot } : config;
  const stageCollectionPath = migrationPaths?.stageCollectionPath ?? '';
  const liveCollectionPath = migrationPaths?.liveCollectionPath ?? '';
  const backupPath = migrationPaths?.backupPath ?? '';
  const cacheBackupPath = migrationPaths?.cacheBackupPath ?? '';
  const pendingPath = migrationPaths?.markerPath ?? '';
  const cacheTempPath = needsMigration ? path.join(scopeDir, `.relations-cache-${migrationId}.tmp`) : '';
  let migrationCommitted = false;
  let markerCreated = false;
  let cacheSwitched = false;
  let preserveStage = false;

  try {
    if (needsMigration) {
      // 旧 Collection 保持原位；新维度写入独立目录。scope/标签/docId 仍使用原始值。
      await closeEngine(scope);
      await runWithConfigSnapshot(stageConfig, () => getEngine(scope));
    }

  // 4. 清空旧向量：仅全量重建执行（保证结果与 KB 一致）；
  //    局部重建跳过（幂等覆盖匹配子集，其他向量不受影响）。失败则中止，避免新旧混杂。
  //    注入 countScope 时（CLI 路径）先统计旧向量总数，删除过程输出进度条。
  if (!partial && !needsMigration) {
    try {
      checkCancelled();
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
    checkCancelled(0, allEntries.length);
    if (totalBatches > 1) {
      logInfo(`开始向量化：共 ${allEntries.length} 条，每批 ${VECTORIZE_BATCH_SIZE} 条，共 ${totalBatches} 批`);
    }
    for (let b = 0; b < totalBatches; b++) {
      checkCancelled(Math.min(b * VECTORIZE_BATCH_SIZE, allEntries.length), allEntries.length);
      const offset = b * VECTORIZE_BATCH_SIZE;
      const slice = allEntries.slice(offset, offset + VECTORIZE_BATCH_SIZE);
      const storeBatch = () => bulkStore({ scope, entries: slice }, {
        abortSignal: opts.abortSignal,
        onProgress: (progress) => opts.onProgress?.({
          phase: 'rebuild',
          done: Math.min(allEntries.length, offset + (progress.done ?? 0)),
          total: allEntries.length,
          persisted: cumulativePersisted + (progress.persisted ?? 0),
          metadataPending: cumulativeMetadataPending + (progress.metadataPending ?? 0),
          failed: cumulativeFailed + (progress.failed ?? 0),
          cancelled: cumulativeCancelled + (progress.cancelled ?? 0),
        }),
      });
      const res = needsMigration
        ? await runWithConfigSnapshot(stageConfig, storeBatch)
        : await storeBatch();
      stats.succeeded += res.succeeded;
      stats.failed += res.failed;
      cumulativePersisted += res.succeeded;
      cumulativeMetadataPending += res.metadataPending ?? 0;
      cumulativeFailed += res.failed;
      cumulativeCancelled += res.cancelled ?? 0;
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
      opts.onProgress?.({
        phase: 'rebuild',
        done: Math.min(offset + slice.length, allEntries.length),
        total: allEntries.length,
        persisted: cumulativePersisted,
        metadataPending: cumulativeMetadataPending,
        failed: cumulativeFailed,
        cancelled: cumulativeCancelled,
      });
      checkCancelled(Math.min(offset + VECTORIZE_BATCH_SIZE, allEntries.length), allEntries.length);
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
  if (needsMigration) {
    // 有任一条失败/取消时不切换；当前运行中的旧集合与缓存仍完整。
    if (errors.length > 0 || stats.failed > 0 || cumulativeMetadataPending > 0 || cumulativeCancelled > 0) {
      return {
        ok: false, scope, partial, stats,
        errors: [{ type: 'migration', path: scope, error: '新维度向量未全部写入，已保留旧 Collection 和 relations-cache；请修复 embedding 后重试' }, ...errors],
      };
    }
    checkCancelled(allEntries.length, Math.max(allEntries.length, 1));
    const stagedDimension = await runWithConfigSnapshot(stageConfig, () => vectorCollectionDimension(scope));
    if (stagedDimension !== embeddingDimension) {
      return { ok: false, scope, partial, stats, errors: [{ type: 'migration', path: scope, error: `新 Collection 维度校验失败：期望 ${embeddingDimension}，实际 ${stagedDimension}` }] };
    }
    // 先写好缓存临时文件；切换目录后只需原子 rename，失败时可恢复旧集合。
    fs.writeFileSync(cacheTempPath, JSON.stringify(rc, null, 2), { encoding: 'utf-8', mode: 0o600 });
    await closeEngine(scope);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(backupPath), 0o700);
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.dirname(pendingPath), 0o700);
    try {
      fs.writeFileSync(pendingPath, JSON.stringify({ scope, migrationId, backupPath, cacheBackupPath, cachePath, liveCollectionPath, stageCollectionPath }), { flag: 'wx', mode: 0o600 });
      markerCreated = true;
      fs.copyFileSync(cachePath, cacheBackupPath, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(cacheBackupPath, 0o600);
      fs.renameSync(liveCollectionPath, backupPath);
      fs.renameSync(stageCollectionPath, liveCollectionPath);
      fs.renameSync(cacheTempPath, cachePath);
      cacheSwitched = true;
      migrationCommitted = true;
      // 到这里新维度集合与配套缓存已提交。FTS-only 清理属派生索引维护，
      // 放到标记清除之后执行：中断时同维度重建可安全重试。
      fs.rmSync(pendingPath);
    } catch (error) {
      if (migrationCommitted) throw error;
      try {
        if (fs.existsSync(backupPath)) {
          if (fs.existsSync(liveCollectionPath)) fs.renameSync(liveCollectionPath, stageCollectionPath);
          fs.renameSync(backupPath, liveCollectionPath);
        }
        if (cacheSwitched) {
          fs.copyFileSync(cacheBackupPath, cacheTempPath);
          fs.renameSync(cacheTempPath, cachePath);
        }
        if (markerCreated) fs.rmSync(pendingPath);
      } catch (rollbackError) {
        preserveStage = true;
        return { ok: false, scope, partial, stats, errors: [{ type: 'migration', path: scope, error: `切换新 Collection 失败且自动回退失败：${(error as Error).message}；${(rollbackError as Error).message}。旧集合备份：${backupPath}；事务标记：${pendingPath}` }] };
      }
      return { ok: false, scope, partial, stats, errors: [{ type: 'migration', path: scope, error: `切换新 Collection 失败，已恢复旧集合：${(error as Error).message}` }] };
    }
  }
  // FTS-only 文档若本次成功重建出 dense，清理旧全文索引并移除独立 ID，避免
  // 同一 relation 同时出现在两套索引中。跨维度迁移已先提交 dense/cache 并清除事务标记；
  // 清理中断时旧 FTS 数据仍是可重试的冗余索引，不会破坏新旧 Collection/cache 配对。
  for (const [groupPath, group] of Object.entries(groups)) {
    if (!isInGroupScope(groupPath, groupFilter)) continue;
    for (const rel of group.hot_relations ?? []) {
      const denseWritten = (rel.memoryIds?.length ?? 0) > 0 || !!rel.memoryId;
      if (!denseWritten || !rel.ftsIds || rel.ftsIds.length === 0) continue;
      try {
        const deleted = await ftsDeleteByIds({ scope, ids: rel.ftsIds });
        if (deleted.failed === 0) {
          delete rel.ftsIds;
          delete rel.ftsLocators;
          delete rel.ftsIndexComplete;
        } else {
          const remainingIds = new Set(deleted.failedIds);
          rel.ftsIds = rel.ftsIds.filter((id) => remainingIds.has(id));
          rel.ftsLocators = (rel.ftsLocators ?? []).filter((locator) => remainingIds.has(locator.ftsId));
          if (rel.ftsIds.length === 0) {
            delete rel.ftsIds;
            delete rel.ftsLocators;
            delete rel.ftsIndexComplete;
          }
          errors.push({ type: 'fts-cleanup', path: `${groupPath}/${rel.text}`, error: `旧 FTS-only 索引清理失败 ${deleted.failed} 条` });
        }
      } catch (err) {
        errors.push({ type: 'fts-cleanup', path: `${groupPath}/${rel.text}`, error: (err as Error).message });
      }
    }
  }
  // 迁移时上方已原子提交 memoryIds；FTS-only 清理后再更新缓存。
  if (needsMigration) {
    fs.writeFileSync(cacheTempPath, JSON.stringify(rc, null, 2), { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(cacheTempPath, cachePath);
  } else {
    fs.writeFileSync(cachePath, JSON.stringify(rc, null, 2), 'utf-8');
  }
  opts.onProgress?.({ phase: 'rebuild', done: allEntries.length, total: Math.max(allEntries.length, 1) });
  logInfo(`向量重建完成，耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

  return { ok: true, scope, partial, stats, errors, ...(needsMigration ? { migrationBackup: backupPath, migrationCacheBackup: cacheBackupPath } : {}) };
  } catch (error) {
    if (!needsMigration) throw error;
    if (migrationCommitted) {
      const pending = fs.existsSync(pendingPath);
      return { ok: false, scope, partial, stats, migrationBackup: backupPath, migrationCacheBackup: cacheBackupPath, errors: [{ type: 'migration-post-commit', path: scope, error: pending
        ? `新 Collection 已切换，但事务标记未能清除：${(error as Error).message}；请再次执行 ki restore ${scope} --rebuild-vector --yes，命令会先自动恢复旧集合再重试。旧集合备份：${backupPath}；缓存备份：${cacheBackupPath}`
        : `新 Collection 与 relations-cache 已切换；后续 FTS 清理或缓存整理失败：${(error as Error).message}。请执行 ki restore ${scope} --rebuild-vector 重试清理，旧集合与缓存备份保留在 ${backupPath} 和 ${cacheBackupPath}` }] };
    }
    return { ok: false, scope, partial, stats, errors: [{ type: 'migration', path: scope, error: `新维度重建失败，旧 Collection 和 relations-cache 未更改：${(error as Error).message}` }] };
  } finally {
    if (needsMigration) {
      await closeEngine(scope);
      if (fs.existsSync(cacheTempPath)) fs.rmSync(cacheTempPath, { force: true });
      if (!preserveStage && fs.existsSync(stageRoot)) fs.rmSync(stageRoot, { recursive: true, force: true });
    }
  }
}
