#!/usr/bin/env node
/**
 * delete-relation.ts - 删除 Relation 及其关联数据
 *
 * 删除范围：
 *   1. relations-cache.json 中 groups[g].hot_relations[] 的对应条目
 *   2. 本地 KB index.json 中的对应 key
 *   3. wiki 目录下的 .md 文件
 *   4. 向量记忆（按 docId 删除，无 memoryId 时 vectorSearch 兜底严格匹配）
 *
 * 注意：不删除 group-index.json 的 Group 节点（Group 可能含其他 Relation）
 *
 * 用法:
 *   单条: npx jiti delete-relation.ts --scope <scope> --group <group> --relation <text>
 *   批量: npx jiti delete-relation.ts --scope <scope> --input <jsonFile>
 */

import { Command } from 'commander';
import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from './lib/store.js';
import {
  getRelationsCachePath,
  getGroupIndexPath,
  getKbDir,
  getLocalKbDir,
  validateScope,
} from './lib/scope.js';
import { resolveGroupPath } from './lib/group-resolve.js';
import { loadCacheShape, persistCacheShape, migrateLegacyRelationsCache, hasShardedLayout, hasNoRelationsData, listGroupPaths, loadGroupCache, deleteGroupCache, buildGroupMatchContext, isRelationsRootPath, type LegacyRelationsCacheShape } from './lib/group-cache.js';
import { assertNoPendingVectorMigration, vectorSearch, vectorDelete, ensureVectorAvailable, closeEngine, generateDocId } from './lib/vector-client.js';
import { buildRelationContent } from './lib/path-vectorize.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';
// S-04（REQ-20261009-003）：元数据删除需与同进程读任务互斥（提交窗口）
import { getSharedOperationCoordinator } from './lib/operation-coordinator.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { withScopeWriteLock } from './lib/scope-write-lock.js';
import { resolveWikiRootDir } from './lib/wiki-sync.js';
import { ftsDeleteByIds } from './lib/fts-client.js';
import { activeDrafts } from './lib/relation-edit-draft.js';

// ─── 类型 ───

interface GroupData {
  hot_relations: Array<{
    id: string;
    text: string;
    score: number;
    useCount: number;
    lastUsedTime: number | null;
    isImported: boolean;
    memoryId?: string;
    /** 多值：文档内容向量（多 tag 各一）的全部 docId，供 delete 精确清理（与 scoring.ts Relation.memoryIds 一致） */
    memoryIds?: string[];
    ftsIds?: string[];
    /** 原始文件相对 sourceDir 的 posix 路径（用于硬删前的归属校验） */
    sourcePath?: string;
  }>;
  keywords: string[];
}

interface RelationsCache {
  version: number;
  scope: string;
  partition_config: Record<string, unknown>;
  groups: Record<string, GroupData>;
  updatedAt: string | null;
}

export interface DeleteResult {
  relation: string;
  group: string;
  deleted: boolean;
  cacheRemoved: boolean;
  kbRemoved: boolean;
  wikiRemoved: boolean;
  wikiSkipReason?: 'not-configured' | 'file-not-found' | 'outside-source-dir' | 'source-mismatch' | 'wiki-delete-disabled';
  wikiMatch?: 'sourcePath' | 'legacy-name';
  wikiError?: string;
  memRemoved: boolean;
  memMethod: 'memoryId' | 'search' | 'skip' | 'none';
  memMemoryId?: string;
  fullTextRemoved: boolean;
  /**
   * 路径向量（tag=ki-relation）是否已清理（REQ-20261021-002）。
   * 写入侧刻意不回写它的 docId（只记内容向量），故删除侧必须按可重算 docId 补删；
   * 同名 relation 仍被其他组引用时**保留**（docId 跨组共享，删了会误伤）。
   */
  relationVectorRemoved: boolean;
  /** 本次删掉的路径向量条数（0 = 未命中或按共享保护跳过） */
  relationVectorDeleted?: number;
  /** 路径向量保留 / 失败的原因（成功命中时不下发） */
  relationVectorReason?: string;
  reason?: string;
}

// ─── 核心删除逻辑 ───

export interface DeleteRelationParams {
  scope?: string;
  group: string;
  relation: string;
  /**
   * 是否硬删源 `.md`（默认 true，既有 CLI/HTTP 行为不变）。
   * 数据源 prune 传 `false`（设计 S-03 D6）：候选的存在性判定不可靠时，
   * 删源文件是不可逆的数据丢失面，必须由用户显式确认才做——数据源路径暂不提供。
   */
  wikiDelete?: boolean;
}

export type DeleteRelationOutcome =
  | { ok: true; scope: string; result: DeleteResult }
  | { ok: false; error: string };

async function executeDeleteRelationLocal(params: DeleteRelationParams): Promise<DeleteRelationOutcome> {
  try {
    const { group, relation } = params;
    // scope 护栏：default 模式下缺省回退 default，strict 模式下强制显式且须注册
    const scope = resolveScope(loadConfig(), params.scope);
    validateScope(scope);
    assertNoPendingVectorMigration(scope);

    // 批次 2（W3）：双轨读（loadCacheShape；resolveGroupPath 需完整键上下文，删除低频全量可接受）
    const cachePath = getRelationsCachePath(scope);
    let cache: RelationsCache;
    try {
      cache = loadCacheShape(scope) as unknown as RelationsCache;
    } catch (err) {
      // 第二轮审查 P2：只把「两布局皆无数据」报成未初始化；损坏必须原样透出
      return { ok: false, error: hasNoRelationsData(scope) ? 'relations-cache.json 不存在' : (err as Error).message };
    }

    // 解析 Group 路径（支持模糊补全）
    const groupIndex = readJson<Record<string, unknown>>(getGroupIndexPath(scope));
    const resolved = await resolveGroupPath(group, groupIndex as any, cache.groups, scope);
    if (!resolved.matched) {
      return { ok: false, error: `Group "${group}" 未匹配到任何节点` };
    }
    const resolvedGroup = resolved.resolvedPath;

    const groupData = cache.groups[resolvedGroup];
    // groupData 可能为空（cache 已清但 wiki/mem 残留），继续清理 wiki + mem

    // 查找 Relation（cache 中可能已被清空，但 wiki/mem 残留需清理）
    const relIdx = groupData ? groupData.hot_relations.findIndex(r => r.text === relation) : -1;
    const rel = relIdx >= 0 ? groupData.hot_relations[relIdx] : undefined;

    const result: DeleteResult = {
      relation,
      group: resolvedGroup,
      deleted: false,
      cacheRemoved: false,
      kbRemoved: false,
      wikiRemoved: false,
      memRemoved: false,
      memMethod: 'none',
      fullTextRemoved: true,
      relationVectorRemoved: false,
    };

    // 在途编辑草稿卫兵（fail-loud）：草稿的 baseRevision 绑定当前正文，Relation 一旦被删，
    // 草稿永远无法 finish（只能手工删文件），其登记的索引 ID 也会一直挂在搜索隐藏集里。
    const pendingDrafts = activeDrafts(scope)
      .filter((draft) => draft.group === resolvedGroup && draft.relation === relation);
    if (pendingDrafts.length > 0) {
      return { ok: false, error: `Relation 有 ${pendingDrafts.length} 条未结束的编辑草稿`
        + `（${pendingDrafts.map((draft) => `${draft.editId}:${draft.status}`).join(', ')}）`
        + '；请先用 ki_edit_relation 的 cancel 或 finish 收口后再删除' };
    }

    // 1. 从 relations-cache.json 删除（内存）
    if (relIdx >= 0 && groupData) {
      groupData.hot_relations.splice(relIdx, 1);
      result.cacheRemoved = true;
    }

    // 2. 元数据删除（S-04 I1/I2，REQ-20261009-003）：**分片先落（列表先消失）→ 紧邻删 KB（详情后消失）**，
    //    两次写整段在「元数据提交窗口」内，**中间不夹引擎 I/O**（wiki 移动 / 向量删除 / FTS 删除全部移到窗后）。
    //    反序（KB 先删、分片后落）会让并发读稳定看到"列表里在、点开 404"——已用隔离 scope 实测复现
    //    （temp/verify-h2-delete-window.ts，见 design/design-review.md）。
    try {
      getSharedOperationCoordinator().withMetadataCommitSync(scope, () => {
        if (result.cacheRemoved) {
          migrateLegacyRelationsCache(scope);
          persistCacheShape(scope, cache as unknown as LegacyRelationsCacheShape, new Set([resolvedGroup]));
        }
        const localKbPath = getLocalKbDir(scope, resolvedGroup);
        if (fs.existsSync(localKbPath)) {
          const localKb = readJson<Record<string, string>>(localKbPath);
          if (localKb && relation in localKb) {
            delete localKb[relation];
            writeJson(localKbPath, localKb);
            result.kbRemoved = true;
          }
        }
      });
    } catch (err) {
      result.reason = `元数据删除失败: ${(err as Error).message}`;
    }

    // 3. 硬删源 .md（D7）：归属校验 + realpath containment，不进回收站
    try {
      const wikiDeleteDisabled = params.wikiDelete === false;
      const root = wikiDeleteDisabled ? null : resolveWikiRootDir(scope);
      const sourceDir = root?.dir ?? null;
      // sourcePath 是导入时的真实相对路径（可能平铺在 sourceDir 根下），优先用它定位；
      // 仅历史数据无 sourcePath 时才回退到 <sourceDir>/<group>/<relation>.md 约定。
      //
      // ★ 只有根目录确实来自**该次导入的 source 块**时才敢用 sourcePath：根目录退化为
      //   wikiSync.sourceDir 时（单文件导入的 scope 属这一类），sourcePath 相对的是导入源
      //   那棵树，套到 wiki 根上会命中同名的 wiki 文件并硬删（无回收站）。这种场景只认
      //   命名约定 <wiki>/<group>/<relation>.md —— 那正是 writeBackToWiki 写出的镜像文件。
      const sourcePathFile = sourceDir && root?.from === 'source' && rel?.sourcePath
        ? path.resolve(sourceDir, rel.sourcePath)
        : null;
      const fallbackFile = findWikiFile(scope, resolvedGroup, relation);
      const expectedExists = !!sourcePathFile && fs.existsSync(sourcePathFile);
      const wikiFile = expectedExists ? sourcePathFile : fallbackFile;
      if (wikiDeleteDisabled) {
        result.wikiSkipReason = 'wiki-delete-disabled';
      } else if (!sourceDir) {
        result.wikiSkipReason = 'not-configured';
      } else if (sourcePathFile && !expectedExists && fallbackFile && fs.existsSync(fallbackFile)) {
        // sourcePath 声明的文件不存在，但按命名约定存在另一份：视为归属不符，拒绝删除
        result.wikiSkipReason = 'source-mismatch';
        result.reason = `${result.reason || ''} sourcePath 文件不存在但命名约定文件存在，拒绝删除: ${fallbackFile}`.trim();
      } else if (!wikiFile || !fs.existsSync(wikiFile)) {
        result.wikiSkipReason = 'file-not-found';
      } else {
        const expected = sourcePathFile;
        let mismatched = false;
        if (expected) {
          try {
            mismatched = fs.realpathSync(expected) !== fs.realpathSync(wikiFile);
          } catch {
            mismatched = true;
          }
        }
        if (mismatched) {
          result.wikiSkipReason = 'source-mismatch';
          result.reason = `${result.reason || ''} 源文件与 sourcePath 不符，拒绝删除: ${wikiFile}`.trim();
        } else {
          result.wikiMatch = expected ? 'sourcePath' : 'legacy-name';
          const outcome = unlinkWithinSourceDir(sourceDir, wikiFile);
          if (outcome.status === 'deleted') {
            result.wikiRemoved = true;
            if (result.wikiMatch === 'legacy-name') {
              result.reason = `${result.reason || ''} 历史 relation 无 sourcePath，按文件名删除`.trim();
            }
          } else if (outcome.status === 'io-error') {
            result.wikiError = outcome.error;
          } else {
            result.wikiSkipReason = outcome.status;
          }
        }
      }
    } catch (err) {
      result.wikiError = (err as Error).message;
    }

    // 4. 删除向量记忆（rel 可能为 undefined；优先按 memoryIds 多值删多 tag 内容向量，
    //    退化为单 memoryId，无则走 search 兜底）
    const memOutcome = await deleteMemMemory(scope, relation, rel?.memoryIds ?? (rel?.memoryId ? [rel.memoryId] : undefined));
    result.memRemoved = memOutcome.removed;
    result.memMethod = memOutcome.method;
    if (memOutcome.memoryId) result.memMemoryId = memOutcome.memoryId;
    if (memOutcome.reason) {
      result.reason = `${result.reason || ''} ${memOutcome.reason}`.trim();
    }
    const ftsIds = rel?.ftsIds ?? [];
    const ftsOutcome = await ftsDeleteByIds({ scope, ids: ftsIds });
    result.fullTextRemoved = ftsOutcome.failed === 0;
    if (ftsOutcome.failed > 0) {
      result.reason = `${result.reason || ''} FTS-only 索引删除失败：${ftsOutcome.failed} 条`.trim();
    }

    // 4.5 清理路径向量（tag=ki-relation，REQ-20261021-002）：
    //    写入侧刻意不回写它的 docId（cache 只记内容向量），只按 memoryIds 删会留下孤儿。
    //    ★ docId 只由 relation 名 + scope + tag 决定 ⇒ **跨组共享**：同名 relation 还活在
    //    别的组时必须保留，否则会把兄弟组的路径向量一起删掉（与 group-delete 的共享保护同源）。
    const otherHolders = Object.entries(cache.groups)
      .filter(([groupPath]) => groupPath !== resolvedGroup)
      .filter(([, data]) => (data?.hot_relations ?? []).some((item) => item.text === relation))
      .map(([groupPath]) => groupPath);
    if (otherHolders.length > 0) {
      result.relationVectorRemoved = false;
      result.relationVectorReason = `同名 relation 仍存在于其他组（${otherHolders.join('、')}），路径向量为跨组共享，已保留`;
    } else {
      const relVec = await deleteRelationVector(scope, relation, resolvedGroup);
      result.relationVectorRemoved = relVec.removed;
      if (relVec.deleted !== undefined) result.relationVectorDeleted = relVec.deleted;
      if (relVec.reason) {
        result.relationVectorReason = relVec.reason;
        result.reason = `${result.reason || ''} ${relVec.reason}`.trim();
      }
    }

    // 注：cache 分片落盘已上移到第 2 步的「元数据提交窗口」内（S-04 I1/I2：分片先落 → KB 后删）。
    result.deleted = result.cacheRemoved;
    return { ok: true, scope, result };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeDeleteRelation(params: DeleteRelationParams): Promise<DeleteRelationOutcome> {
  if (shouldUseDaemonClient()) return callDaemon<DeleteRelationOutcome>('delete-relation', params);
  try {
    return await withScopeWriteLock(resolveScope(loadConfig(), params.scope), 'delete-relation', () => executeDeleteRelationLocal(params));
  } catch (error) { return { ok: false, error: (error as Error).message }; }
}


// ─── 向量删除（先 memoryId 后 search 兜底） ───

async function deleteMemMemory(
  scope: string,
  relation: string,
  memoryIds?: string[]
): Promise<{ removed: boolean; method: 'memoryId' | 'search' | 'skip' | 'none'; memoryId?: string; reason?: string }> {
  const avail = await ensureVectorAvailable();
  if (!avail.available) {
    return { removed: false, method: 'skip', reason: `向量服务不可用: ${avail.reason}` };
  }

  const ids = (memoryIds ?? []).filter(Boolean);

  // 优先按 memoryIds(docId) 批量删除（多 tag 内容向量全部清理）
  if (ids.length > 0) {
    try {
      const res = await vectorDelete({ scope, ids });
      if (res.deleted > 0) {
        const primary = ids[0];
        return { removed: true, method: 'memoryId', memoryId: primary };
      }
      // 全部未命中（id 不存在，可能 text 变更导致 docId 漂移），继续 search 兜底
      const searchResult = await deleteBySearch(scope, relation);
      return {
        ...searchResult,
        reason: `memoryIds(${ids.join(',')}) 未命中，已尝试 search 兜底。${searchResult.reason || ''}`.trim(),
      };
    } catch (err) {
      // memoryIds 删除失败，继续 search 兜底
      const e = err as Error;
      const searchResult = await deleteBySearch(scope, relation);
      return {
        ...searchResult,
        reason: `memoryIds(${ids.join(',')}) 删除失败: ${e.message}，已尝试 search 兜底。${searchResult.reason || ''}`.trim(),
      };
    }
  }

  // 无 memoryId，直接 search 兜底
  return deleteBySearch(scope, relation);
}

/**
 * search 兜底删除：用 relation 名称向量检索，严格匹配确认后删除
 *
 * 严格匹配规则：返回的 content 剥离 【标签:xxx】 前缀后，
 * relation 名称必须作为标题行的前缀出现（# 或 ### 开头，或独立行）
 * 注：不用 \b（单词边界），因为 \b 对中文字符不生效
 */
async function deleteBySearch(scope: string, relation: string): Promise<{ removed: boolean; method: 'search'; memoryId?: string; reason?: string }> {
  try {
    // 用 relation 名称做查询（不限 tag，覆盖多 tag 内容向量——兜底时须清理全部 tag 的该内容 doc，#M1）
    const results = await vectorSearch({
      scope,
      query: relation,
      limit: 20,
    });

    if (results.length === 0) {
      return { removed: false, method: 'search', reason: `search 无结果，mem 中可能无此记忆` };
    }

    // 严格匹配：content 剥离标签前缀后，relation 名称作为标题前缀出现
    // 边界规则：relation 后必须是非字母数字字符（中英文均排除）或行尾，
    // 避免 "加密" 误匹配 "### 加密工具"（\b 对中文无效，用自定义边界）
    const boundary = '(?=[^a-zA-Z0-9\\u4e00-\\u9fa5]|$)';
    const matched = results.filter(r => {
      // 路径向量（tag=ki-relation）由 deleteRelationVector 专职清理：
      // 它的 content 就是 relation 名，必然命中下面的"标题前缀"规则 ⇒ 会在这里被顺手删掉，
      // 既造成职责重叠，也让 deleteRelationVector 事后命中不到、把结果误报成"未删除"。
      if (r.tag === 'ki-relation') return false;
      const content = r.content || '';
      const cleanContent = content.replace(/^【标签:[^】]*】\s*/, '');
      const titlePatterns = [
        new RegExp(`^#\\s*${escapeRegExp(relation)}${boundary}`, 'mu'),
        new RegExp(`^###\\s*${escapeRegExp(relation)}${boundary}`, 'mu'),
        new RegExp(`^${escapeRegExp(relation)}${boundary}`, 'mu'),
      ];
      return titlePatterns.some(p => p.test(cleanContent));
    });

    if (matched.length === 0) {
      return { removed: false, method: 'search', reason: `search 返回 ${results.length} 条但无严格匹配（relation 名称未作为标题前缀出现）` };
    }

    // 删除所有严格匹配的内容 doc（多 tag 内容各有独立 doc，须全部清理，#M1）
    const ids = matched.map((r) => r.memoryId).filter(Boolean) as string[];
    const res = await vectorDelete({ scope, ids });
    if (res.deleted === 0) {
      return { removed: false, method: 'search', reason: `vectorDelete 未删除任何条目（ids=${ids.join(',')}）` };
    }
    return { removed: true, method: 'search', memoryId: ids[0] };
  } catch (err) {
    return { removed: false, method: 'search', reason: `search 兜底失败: ${(err as Error).message}` };
  }
}

/**
 * 删除 tag=ki-relation 的**路径向量**（REQ-20261021-002）。
 *
 * 为什么单列一个函数：路径向量的 docId **没有回写到 cache**（见 sync-relation.ts
 * 「relation 路径向量（ki-relation），不回写到 cache（cache 只记内容向量 docId）」），
 * 而 delete-relation 只按 memoryIds 删内容向量 ⇒ 删完 `ki doc list` 仍剩一条孤儿。
 *
 * 好在 docId 可**重算**：`sha256(文本 + scope + tag)`，文本形态有两种——
 *   现状：`buildRelationContent()` 只返回 relation 名；
 *   历史（12d14c4 之前）：`${relation} | Group: ${group 空格化}`（keywords 机制已废弃）。
 * 两种都算一遍直接删；仍未命中再按 tag 精确检索兜底（更早形态无法穷举）。
 *
 * ⚠️ docId 跨组共享（只由 relation 名决定），调用方必须先确认没有其他组持有同名 relation。
 */
async function deleteRelationVector(
  scope: string,
  relation: string,
  group: string,
): Promise<{ removed: boolean; deleted?: number; reason?: string }> {
  const avail = await ensureVectorAvailable();
  if (!avail.available) {
    return { removed: false, reason: `路径向量未清理（向量服务不可用：${avail.reason || 'unknown'}）` };
  }
  const RELATION_TAG = 'ki-relation';
  const legacyGroupPart = group.split('/').filter(Boolean).join(' ');
  const candidateIds = [...new Set([
    generateDocId(buildRelationContent(relation, group), scope, RELATION_TAG),
    generateDocId(`${relation} | Group: ${legacyGroupPart}`, scope, RELATION_TAG),
  ])];

  let deleted = 0;
  try {
    const res = await vectorDelete({ scope, ids: candidateIds });
    deleted += res.deleted;
  } catch (err) {
    return { removed: false, deleted: 0, reason: `路径向量删除失败: ${(err as Error).message}` };
  }
  if (deleted > 0) return { removed: true, deleted };

  // docId 未命中 → 按 tag 精确检索兜底；只认「以 relation 名开头」的命中，避免误删仅语义相近的条目
  try {
    const hits = await vectorSearch({ scope, query: relation, tags: [RELATION_TAG], limit: 20 });
    const ids = hits
      .filter((hit) => {
        const content = (hit.content || '').trim();
        return content === relation
          || content.startsWith(`${relation} |`)
          || content.startsWith(`${relation} `);
      })
      .map((hit) => hit.memoryId)
      .filter(Boolean) as string[];
    // 未命中视为「本就不存在路径向量」（纯 FTS-only / 历史无路径向量的数据），不报错误
    if (ids.length === 0) return { removed: false, deleted: 0 };
    const res = await vectorDelete({ scope, ids });
    return res.deleted > 0
      ? { removed: true, deleted: res.deleted }
      : { removed: false, deleted: 0, reason: `路径向量兜底删除未生效（ids=${ids.join(',')}）` };
  } catch (err) {
    return { removed: false, deleted: 0, reason: `路径向量 search 兜底失败: ${(err as Error).message}` };
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── wiki 文件定位 ───

// wiki 源目录统一由 wiki-sync.ts::resolveWikiRootDir 解析（source 块须是目录才算数）：
// 单文件导入时 source.dir 是文件路径，当目录用只会定位到 `file/<sourcePath>` 这种
// 必然不存在的路径（静默不删 wiki 文件）。

/**
 * 在 sourceDir 内删除文件：realpath containment 校验，拒绝符号链接逃逸。
 * 仅用于 D7 的硬删路径；不创建回收站。
 */
function unlinkWithinSourceDir(
  sourceDir: string,
  filePath: string,
): { status: 'deleted' } | { status: 'file-not-found' | 'outside-source-dir' } | { status: 'io-error'; error: string } {
  try {
    const sourceReal = fs.realpathSync(sourceDir);
    const fileReal = fs.realpathSync(filePath);
    if (fileReal !== sourceReal && !fileReal.startsWith(`${sourceReal}${path.sep}`)) {
      return { status: 'outside-source-dir' };
    }
    fs.unlinkSync(fileReal);
    return { status: 'deleted' };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'file-not-found' };
    return { status: 'io-error', error: (err as Error).message };
  }
}

/**
 * 根据 config.json 的 wikiSync 配置定位 wiki 文件路径
 * 优先级与 wiki-sync.ts 的 resolveWikiRootDir 一致（rootName 概念已移除）：
 *   1. group-index.json 的 source 块（source.dir，须为目录）
 *   2. config.json 中 scope 级 wikiSync.sourceDir
 */
function findWikiFile(scope: string, group: string, relation: string): string | null {
  const sourceDir = resolveWikiRootDir(scope).dir;
  if (!sourceDir) return null;

  // 计算文件路径（group 即完整相对路径，不做前缀剥离）
  const filePath = group
    ? path.join(sourceDir, group, `${relation}.md`)
    : path.join(sourceDir, `${relation}.md`);

  return fs.existsSync(filePath) ? filePath : null;
}


// ─── 批量删除 ───

export interface BatchDeleteItem {
  group: string;
  relation: string;
}

export type BatchDeleteResult = {
  ok: boolean;
  scope?: string;
  results: DeleteResult[];
  total: number;
  failed: number;
};

async function executeBatchDeleteLocal(
  scope: string | undefined,
  items: BatchDeleteItem[],
  opts?: { wikiDelete?: boolean },
): Promise<BatchDeleteResult> {
  const results: DeleteResult[] = [];
  let failed = 0;

  for (const item of items) {
    const outcome = await executeDeleteRelation({
      scope,
      group: item.group,
      relation: item.relation,
      ...(opts?.wikiDelete !== undefined ? { wikiDelete: opts.wikiDelete } : {}),
    });
    if (outcome.ok) {
      results.push(outcome.result);
      if (!outcome.result.deleted) failed++;
    } else {
      results.push({
        relation: item.relation,
        group: item.group,
        deleted: false,
        cacheRemoved: false,
        kbRemoved: false,
        wikiRemoved: false,
        fullTextRemoved: false,
        memRemoved: false,
        memMethod: 'none',
        relationVectorRemoved: false,
        reason: outcome.error,
      });
      failed++;
    }
  }

  return { ok: true, scope, results, total: items.length, failed };
}

export async function executeBatchDelete(
  scope: string | undefined,
  items: BatchDeleteItem[],
  opts?: { wikiDelete?: boolean },
): Promise<BatchDeleteResult> {
  if (shouldUseDaemonClient()) {
    return callDaemon<BatchDeleteResult>('batch-delete', {
      scope,
      items,
      ...(opts?.wikiDelete !== undefined ? { wikiDelete: opts.wikiDelete } : {}),
    });
  }
  try {
    return await withScopeWriteLock(resolveScope(loadConfig(), scope), 'batch-delete', () => executeBatchDeleteLocal(scope, items, opts));
  } catch (error) {
    // BatchDeleteResult 无 error 字段（既有类型约束）：整体失败时按逐条失败落形，
    // 错误信息进每条 DeleteResult.reason —— 与上方单条失败分支同款形状
    const message = (error as Error).message;
    return {
      ok: false,
      results: items.map((item) => ({
        relation: item.relation,
        group: item.group,
        deleted: false,
        cacheRemoved: false,
        kbRemoved: false,
        wikiRemoved: false,
        fullTextRemoved: false,
        memRemoved: false,
        memMethod: 'none' as const,
        relationVectorRemoved: false,
        reason: message,
      })),
      total: items.length,
      failed: items.length,
    };
  }
}

// ─── CLI ───

const program = new Command();

program
  .name('delete-relation')
  .showHelpAfterError()
  .description('删除单个 Relation 及其关联数据（cache + KB + 源 .md + 向量/FTS）。删组请用 ki group delete')
  .option('-s, --scope <scope>', '项目隔离标识（default 模式可省略，默认 default；strict 模式必填）')
  .option('-g, --group <group>', 'Group 路径')
  .option('-r, --relation <relation>', 'Relation 名称（必填；删组请用 ki group delete）')
  .option('-i, --input <input>', 'JSON 输入文件路径（批量模式，格式 {"items":[{"group","relation"}]}）')
  .action(async (opts) => {
    try {
      if (opts.input) {
        const inputData = JSON.parse(fs.readFileSync(opts.input, 'utf-8'));
        const items: BatchDeleteItem[] = inputData.items;
        if (!Array.isArray(items)) {
          console.log(JSON.stringify({ ok: false, error: '输入文件格式错误：缺少 items 数组' }, null, 2));
          await closeEngine();
          process.exit(1);
        }
        const result = await executeBatchDelete(opts.scope, items);
        console.log(JSON.stringify(result, null, 2));
        await closeEngine();
        return;
      }

      if (!opts.group) {
        console.log(JSON.stringify({ ok: false, error: '需提供 --group（文档级删除需 --group + --relation）' }, null, 2));
        await closeEngine();
        process.exit(1);
      }

      // 只删 relation；删组一律走 ki group delete（D2）
      if (!opts.relation) {
        console.log(JSON.stringify({
          ok: false,
          error: 'delete-relation 只删除单个 Relation，需要 --relation',
          hint: `删组请用: ki group delete "${opts.group}" --yes`,
        }, null, 2));
        await closeEngine();
        process.exit(1);
      }

      const result = await executeDeleteRelation({
        scope: opts.scope,
        group: opts.group,
        relation: opts.relation,
      });
      console.log(JSON.stringify(result, null, 2));
      await closeEngine();
      if (!result.ok) process.exit(1);
    } catch (err) {
      console.log(JSON.stringify({ ok: false, error: (err as Error).message }, null, 2));
      await closeEngine();
      process.exit(1);
    }
  });

const _isMain = (() => {
  try {
    const entry = process.argv[1];
    if (!entry || !import.meta.url) return false;
    return import.meta.url.endsWith(entry.replace(/\\/g, '/'));
  } catch { return false; }
})();
if (_isMain) program.parse();
