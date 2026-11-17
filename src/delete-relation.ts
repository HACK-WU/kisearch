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
import { buildGroupPathContent, deletePathVector } from './lib/path-vectorize.js';
import { removeRelationPathVectors } from './lib/relation-path-vector.js';
import {
  recomputeContentVectorIds,
  pickContentVectorHits,
  contentVectorTags,
  extractKbBody,
  CONTENT_FALLBACK_SEARCH_LIMIT,
} from './lib/content-vector-match.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';
// S-04（REQ-20261009-003）：元数据删除需与同进程读任务互斥（提交窗口）
import { getSharedOperationCoordinator } from './lib/operation-coordinator.js';
import { loadConfig, resolveScope } from './lib/config.js';
import { withScopeWriteLock } from './lib/scope-write-lock.js';
import { resolveWikiRootDir } from './lib/wiki-sync.js';
import { ftsDeleteByIds } from './lib/fts-client.js';
import { activeDrafts } from './lib/relation-edit-draft.js';
import { moveToTrash, purgeExpired } from './lib/trash-service.js';
import type { TrashReason } from './lib/trash-store.js';
import type { Relation } from './lib/scoring.js';

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
    /** 文档级自定义标签：内容向量除 `ki-search` 外每个 tag 各一条，删前重算 docId 时要用 */
    tags?: string[];
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
  /**
   * 组级路径向量（tag=ki-path）是否已清理。
   * 仅「组内最后一篇文档被删」时为 true；组里还有文档时字段不出现（path 属于整组）。
   */
  groupPathVectorRemoved?: boolean;
  /** 组路径向量清理失败原因（未清理到/引擎报错） */
  groupPathVectorReason?: string;
  /** 回收站回执（S-04）：进站成功才有；`_disabled` 时说明本次未进站 */
  trash?: {
    dirName: string;
    reason: TrashReason;
    expiresAt: number;
    ttlDays: number;
  };
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
  /**
   * 跳过「内容向量」删除。**移动文档专用**。
   *
   * 内容向量的 docId = `sha256(text + scope + tag)` —— **不含 group 与 relation**
   * （`vector-client.ts:594`）。移动一篇文档时内容一个字都没改，新位置写入的是**同一批 docId**；
   * 若这里照常按旧记录的 `memoryIds` 删除，就会把刚写好的向量删掉 ——
   * 而 cache 仍宣称「已向量化」，语义检索静默搜不到（比报错更难发现）。
   *
   * 同时要跳过 `deleteBySearch` 兜底：那条兜底按 relation 名前缀匹配内容，同样会误删。
   */
  skipDenseDelete?: boolean;
  /**
   * 回收站入站原因（S-04）。缺省 manual；事件收口传 event-closed、过期扫描传 temp-expired。
   * `trashEnabled=false` 时忽略本字段。
   */
  trashReason?: TrashReason;
  /**
   * 是否进回收站（默认 true）。仅用于观测期应急回滚：
   * 置 false 走旧行为（硬删，不可恢复）。**不要**长期关掉——那等于放弃「删除可逆」。
   */
  trashEnabled?: boolean;
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

    /**
     * 0. 回收站快照（REQ-20261113-004 · S-04 §3.1）
     *
     * **必须在删除任何数据之前成功**：快照失败即中止删除 —— 「删了但没备份」的窗口
     * 比「删不掉」严重得多（后者用户可重试，前者不可逆）。
     * 应急开关：KI_TRASH_DISABLED=1 时走旧行为（硬删），仅用于观测期回滚。
     */
    /**
     * 什么时候**不**进站（两个极易漏的调用方，漏了就是垃圾条目）：
     *   ① 移动文档（`skipDenseDelete=true`）：文档没消失，只是换了位置。进站会留下
     *      「移动即备份」的垃圾条目，且恢复时与移动后的文档同名冲突；
     *   ② 数据源 prune（`wikiDelete=false`）：删的是「源文件已不存在的副本」，
     *      进站只会堆垃圾，且恢复后下一轮同步又会删掉。
     */
    const trashEnabled = params.trashEnabled !== false
      && process.env.KI_TRASH_DISABLED !== '1'
      && params.skipDenseDelete !== true
      && params.wikiDelete !== false;
    if (trashEnabled) {
      const trashed = moveToTrash({
        scope,
        group: resolvedGroup,
        relation,
        reason: params.trashReason ?? 'manual',
        relationSnapshot: rel as unknown as Relation | undefined,
      });
      if (!trashed.ok) {
        return { ok: false, error: `${trashed.code}: ${trashed.error}（未删除任何数据）` };
      }
      result.trash = {
        dirName: trashed.item.dirName,
        reason: trashed.item.reason,
        expiresAt: trashed.item.expiresAt,
        ttlDays: trashed.item.ttlDays,
      };
    }

    /**
     * 0.5 删除前留一份正文 —— 内容向量的唯一可重算来源。
     *
     * 内容向量 docId = `sha256(正文 + scope + tag)`（见 vector-client::generateDocId），
     * **与 group / relation 无关** ⇒ 正文在手就能精确算回它的全部 docId，不必依赖
     * `cache.memoryIds`（可能因补写失败、tag 变更或形态切换而过期）也不必依赖语义检索
     * （检索兜底的判据天然不可能完整）。
     *
     * 必须在第 2 步删 local KB **之前**读：删完就再也取不回来，只能退回脆弱兜底。
     * 正文缺失（KB 已无该条，例如只剩 cache 残壳）时为 null。
     *
     * 同时把**同组其他文档的正文**一并读出来：检索兜底按「正文包含候选内容」判断归属时，
     * 公共段落（模板头 / 目录 / 引用整段他人原文）会同时被多篇包含 —— 那种命中无法唯一
     * 归属，必须放弃（误删他人向量不可逆，要重建索引）。一次读盘即可，不额外开销。
     */
    const groupKb = (() => {
      try {
        return readJson<Record<string, unknown>>(getLocalKbDir(scope, resolvedGroup)) ?? {};
      } catch {
        return {} as Record<string, unknown>;
      }
    })();
    const kbContent = extractKbBody(groupKb[relation]);
    const siblingBodies = Object.entries(groupKb)
      .filter(([key]) => key !== relation)
      .map(([, raw]) => extractKbBody(raw))
      .filter((body): body is string => Boolean(body));

    /** 元数据提交窗口是否失败：失败时磁盘上文档仍在，索引清理必须停手 */
    let metadataFailed = false;

    // 1. 从 relations-cache.json 删除（内存）
    if (relIdx >= 0 && groupData) {
      groupData.hot_relations.splice(relIdx, 1);
      result.cacheRemoved = true;
    }

    // 2. 元数据删除（S-04 I1/I2，REQ-20261009-003）：**分片先落（列表先消失）→ 紧邻删 KB（详情后消失）**，
    //    ★ 失败标记：元数据没落盘意味着磁盘上文档还在，后面任何索引清理都必须停手（4.6 会读这个标记）。
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
      metadataFailed = true;
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
      // 删除目标**恒为命名约定路径** `<wiki>/<group>/<relation>.md`（writeBackToWiki 的镜像位置）：
      // 2026-11-12 起 source 块退出写回定位，sourcePath 相对的是「导入时的源树」，
      // 直接拿来拼 wiki 根会命中同名的别的文件（曾有手动 wiki 文档被误删的风险）。
      //
      // sourcePath 只用于**归属校验**：它与约定路径必须 realpath 相同；不一致、
      // 或 sourcePath 文件不存在而约定文件在（归属存疑）→ 一律拒绝删除。
      // 原则：硬删无回收站，宁可删不掉，也不误删同名文件。
      const sourcePathFile = sourceDir && rel?.sourcePath
        ? path.resolve(sourceDir, rel.sourcePath)
        : null;
      const wikiFile = findWikiFile(scope, resolvedGroup, relation);
      if (wikiDeleteDisabled) {
        result.wikiSkipReason = 'wiki-delete-disabled';
      } else if (!sourceDir) {
        result.wikiSkipReason = 'not-configured';
      } else if (!wikiFile || !fs.existsSync(wikiFile)) {
        result.wikiSkipReason = 'file-not-found';
      } else {
        let mismatched = false;
        if (sourcePathFile) {
          let srcReal: string | null = null;
          try { srcReal = fs.realpathSync(sourcePathFile); } catch { srcReal = null; }
          try {
            mismatched = srcReal === null || srcReal !== fs.realpathSync(wikiFile);
          } catch {
            mismatched = true;
          }
        }
        if (mismatched) {
          result.wikiSkipReason = 'source-mismatch';
          result.reason = `${result.reason || ''} sourcePath 与命名约定路径不是同一个文件，拒绝删除: ${wikiFile}`.trim();
        } else {
          result.wikiMatch = sourcePathFile ? 'sourcePath' : 'legacy-name';
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
    //    未命中再用「正文重算 docId」精确补删，最后才走 search 兜底）
    // 移动文档：内容向量 docId 不含 group/relation，新位置写的就是同一批 id —— 不能删
    // 元数据没落盘 ⇒ 磁盘上文档仍在（列表还能看到），此时摘索引会把用户带进
    // 「列表里有、点开 404 / 搜不到」的状态。索引清理必须整体停手，与 4.6 同一口径。
    const memOutcome = metadataFailed
      ? { removed: false, method: 'skip' as const, reason: '元数据删除失败：文档仍在，索引已保留' }
      : params.skipDenseDelete === true
        ? { removed: false, method: 'skip' as const, reason: '内容向量 docId 不含 group：同一篇文档移动后 id 不变，已保留（由新位置接续）' }
        : await deleteMemMemory(
          scope,
          relation,
          rel?.memoryIds ?? (rel?.memoryId ? [rel.memoryId] : undefined),
          { content: kbContent, tags: rel?.tags, siblingBodies },
        );
    result.memRemoved = memOutcome.removed;
    result.memMethod = memOutcome.method;
    if (memOutcome.memoryId) result.memMemoryId = memOutcome.memoryId;
    if (memOutcome.reason) {
      result.reason = `${result.reason || ''} ${memOutcome.reason}`.trim();
    }
    const ftsIds = rel?.ftsIds ?? [];
    if (metadataFailed) {
      // 同 4 的理由：文档还在，FTS 索引不能摘（否则全文检索直接搜不到一份仍然存在的文档）
      result.fullTextRemoved = true;
      result.reason = `${result.reason || ''} 元数据删除失败：FTS 索引已保留`.trim();
    } else {
      const ftsOutcome = await ftsDeleteByIds({ scope, ids: ftsIds });
      result.fullTextRemoved = ftsOutcome.failed === 0;
      if (ftsOutcome.failed > 0) {
        result.reason = `${result.reason || ''} FTS-only 索引删除失败：${ftsOutcome.failed} 条`.trim();
      }
    }

    // 4.5 清理路径向量（tag=ki-relation，REQ-20261021-002）：
    //    写入侧刻意不回写它的 docId（cache 只记内容向量），只按 memoryIds 删会留下孤儿。
    //    ★ docId 只由 relation 名 + scope + tag 决定 ⇒ **跨组共享**：同名 relation 还活在
    //    别的组时必须保留，否则会把兄弟组的路径向量一起删掉（与 group-delete 的共享保护同源）。
    const otherHolders = Object.entries(cache.groups)
      .filter(([groupPath]) => groupPath !== resolvedGroup)
      .filter(([, data]) => (data?.hot_relations ?? []).some((item) => item.text === relation))
      .map(([groupPath]) => groupPath);
    if (metadataFailed) {
      result.relationVectorRemoved = false;
      result.relationVectorReason = '元数据删除失败：文档仍在，路径向量已保留';
    } else if (params.skipDenseDelete === true) {
      // 移动文档：路径向量的 docId 同样只由 relation 名决定（buildRelationContent 忽略 group），
      // 新位置写入的就是同一个 docId —— 这里照删会把刚写好的索引抹掉，而 cache 仍宣称已向量化。
      // 旧逻辑只靠「另一侧 cache 仍持有同名 relation」侥幸保护，回滚/写入失败等分支站不住。
      result.relationVectorRemoved = false;
      result.relationVectorReason = '移动文档：路径向量 docId 与位置无关，已保留（由新位置接续）';
    } else if (otherHolders.length > 0) {
      result.relationVectorRemoved = false;
      result.relationVectorReason = `同名 relation 仍存在于其他组（${otherHolders.join('、')}），路径向量为跨组共享，已保留`;
    } else {
      const relVec = await deleteRelationVector(scope, relation, resolvedGroup, {
        contentVectorCount: contentVectorCount(rel),
        siblingNames: new Set((cache.groups[resolvedGroup]?.hot_relations ?? []).map((item) => item.text)),
      });
      result.relationVectorRemoved = relVec.removed;
      if (relVec.deleted !== undefined) result.relationVectorDeleted = relVec.deleted;
      if (relVec.reason) {
        result.relationVectorReason = relVec.reason;
        result.reason = `${result.reason || ''} ${relVec.reason}`.trim();
      }
    }

    /**
     * 4.6 组级路径向量（tag=ki-path）：
     *
     * 文档级删除过去完全不处理它 —— 组内最后一篇被删掉后 path 向量就成了孤儿，
     * 语义检索仍能按组路径召回一个已经没有文档的组（用户视角是「文档删了还搜得到」）。
     *
     * 判定口径比 `visibility-index::groupHasVisibleDocsIn` **更保守**（那边把 hidden 文档视为
     * 不占位，这里一律算占位）：只有组内一条 relation 都不剩才清。三条前置条件缺一不可 ——
     * 组有分片、分片里确实没有文档了、元数据已成功落盘（没落盘说明文档还在磁盘上）。
     *
     * 回收站还原不受影响：`trash-service::enqueueRebuild` 会把 path 放进待重建类别。
     */
    const remainingInGroup = groupData?.hot_relations?.length ?? 0;
    if (groupData && remainingInGroup === 0 && !result.cacheRemoved) {
      // cache 里本来就没有这条（例如上次删除半途退出）：无法确认组内是否真的空了，
      // 不能清组路径向量，但也不能静默 —— 否则「组路径还能召回一个空组」时没人知道为什么。
      result.groupPathVectorReason = 'cache 中已无该 relation（可能是上次删除半途），无法确认组内是否为空，已跳过组路径向量清理';
    } else if (groupData && remainingInGroup === 0 && metadataFailed) {
      result.groupPathVectorReason = '元数据删除失败：文档仍在，组路径向量已保留';
    } else if (groupData && remainingInGroup === 0) {
      try {
        // 主路：docId 由组路径文本决定，可直接重算 ⇒ 一次 id 删除即可，不付 embedding。
        // `deletePathVector` 走「语义检索 top-5 + 精确匹配」，前缀相近的组多时可能检索不到
        // 真身却返回 ok:true（谎报已清理），只适合当历史文本形态的兜底。
        const groupPathText = buildGroupPathContent(resolvedGroup);
        const pathId = generateDocId(groupPathText, scope, 'ki-path');
        const res = await vectorDelete({ scope, ids: [pathId] });
        if (res.errors.length > 0) throw new Error(res.errors[0].reason);
        if (res.deleted === 0) {
          const pathOutcome = await deletePathVector(groupPathText, 'ki-path', scope);
          if (!pathOutcome.ok) throw new Error(pathOutcome.error ?? 'unknown');
        }
        result.groupPathVectorRemoved = true;
      } catch (err) {
        const message = (err as Error).message;
        result.groupPathVectorRemoved = false;
        result.groupPathVectorReason = `组路径向量未清理: ${message}`;
        result.reason = `${result.reason || ''} 组路径向量（ki-path）未清理: ${message}`.trim();
      }
    }

    // 注：cache 分片落盘已上移到第 2 步的「元数据提交窗口」内（S-04 I1/I2：分片先落 → KB 后删）。
    result.deleted = result.cacheRemoved;
    // 惰性清理（S-04 §3.5）：删除是最自然的时机，不引入定时器
    try {
      purgeExpired({ scope });
    } catch (err) {
      console.warn(`[trash] 到期清理失败（不影响删除结果）：${(err as Error).message}`);
    }

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


// ─── 向量删除（memoryIds → 正文重算 → search 兜底） ───

interface ContentVectorHint {
  /** 删除前读到的 KB 正文（`null` = 取不到，只能用 memoryIds 与检索） */
  content?: string | null;
  /** 文档级自定义 tag（每个 tag 各一条内容向量） */
  tags?: string[];
  /** 同组其他文档正文：排除「公共段落」造成的归属误判 */
  siblingBodies?: string[];
}

async function deleteMemMemory(
  scope: string,
  relation: string,
  memoryIds?: string[],
  hint: ContentVectorHint = {},
): Promise<{ removed: boolean; method: 'memoryId' | 'search' | 'skip' | 'none'; memoryId?: string; reason?: string }> {
  const avail = await ensureVectorAvailable();
  if (!avail.available) {
    return { removed: false, method: 'skip', reason: `向量服务不可用: ${avail.reason}` };
  }

  const ids = (memoryIds ?? []).filter(Boolean);
  const notes: string[] = [];
  let deleted = 0;
  let deletedId: string | undefined;

  // 第一层：按 memoryIds(docId) 批量删除（多 tag 内容向量全部清理）。正常路径零额外成本。
  if (ids.length > 0) {
    try {
      const res = await vectorDelete({ scope, ids });
      deleted += res.deleted;
      deletedId = ids[0];
      // ★ 只有「应删的都删到了且没有失败项」才算完全成功：
      //   `deleted > 0` 也可能是部分命中（剩下的漂移 docId 成为孤儿）；
      //   `errors` 已过滤 NOT_FOUND，非空即真失败 —— 两者都不能当成功放行。
      if (res.deleted >= ids.length && res.errors.length === 0) {
        return { removed: true, method: 'memoryId', memoryId: ids[0] };
      }
      if (res.errors.length > 0) {
        notes.push(`memoryIds 有 ${res.errors.length} 条删除失败（${res.errors[0].reason}）`);
      }
      if (res.deleted < ids.length) {
        notes.push(res.deleted > 0
          ? `memoryIds 部分命中（${res.deleted}/${ids.length}）`
          : `memoryIds(${ids.join(',')}) 未命中`);
      }
    } catch (err) {
      notes.push(`memoryIds(${ids.join(',')}) 删除失败: ${(err as Error).message}`);
    }
  }

  // 第二层：用正文重算 docId 补删（精确、无 embedding）。覆盖「ids 过期但仍能算回真实 docId」。
  // 口径必须与第一层一致：`extra` 全部删到且无失败项才算完成，否则把缺口带进 notes 往下走。
  if (hint.content) {
    const extra = recomputeContentVectorIds(scope, hint.content, hint.tags).filter((id) => !ids.includes(id));
    if (extra.length > 0) {
      try {
        const res = await vectorDelete({ scope, ids: extra });
        deleted += res.deleted;
        if (res.deleted >= extra.length && res.errors.length === 0) {
          return { removed: true, method: 'memoryId', memoryId: extra[0] };
        }
        if (res.errors.length > 0) {
          notes.push(`正文重算 docId 有 ${res.errors.length} 条删除失败（${res.errors[0].reason}）`);
        }
        if (res.deleted < extra.length) {
          notes.push(res.deleted > 0
            ? `正文重算 docId 部分命中（${res.deleted}/${extra.length}）`
            : `正文重算 docId(${extra.join(',')}) 未命中`);
        }
      } catch (err) {
        notes.push(`正文重算 docId 删除失败: ${(err as Error).message}`);
      }
    }
  }

  /**
   * 第三层：语义检索兜底（判据见 deleteBySearch，会调用一次 embedding）。
   *
   * 只在「一条都没删到」时执行：这是 cache 全过期的实锤。部分命中时剩余的多是不存在的
   * 陈旧 id，为它付 embedding 会让每次删除都变慢；改成在 reason 里显式报缺口（fail-loud），
   * 既不让用户以为删干净了，也不把成本摊到常规路径。
   */
  if (deleted === 0) {
    const searchResult = await deleteBySearch(scope, relation, hint);
    return {
      ...searchResult,
      reason: notes.length > 0
        ? `${notes.join('；')}，已尝试 search 兜底。${searchResult.reason || ''}`.trim()
        : searchResult.reason,
    };
  }

  return {
    removed: true,
    method: 'memoryId',
    memoryId: deletedId,
    reason: notes.length > 0 ? `已删除部分内容向量，仍有缺口：${notes.join('；')}` : undefined,
  };
}

/**
 * search 兜底删除：用 relation 名称做向量检索，确认归属后删除。
 *
 * 归属判据（两条，任一命中即认为属于待删文档；`ki-relation` / `ki-path` 一律排除，
 * 它们由各自专职函数清理）：
 *   ① **正文比对**（有正文时最可靠）：内容向量存的就是整篇正文，或它按 chunkSize
 *      切出来的片段 —— 因此 `content === 正文` 或 `正文包含 content` 即归属。
 *      同组其他文档的正文不会被本篇正文包含，不会误删。
 *   ② **标题前缀**（历史判据，无正文时的退路）：relation 名称以 `# ` / `### ` /
 *      行首形式出现。正文标题与 relation 名不一致时必然匹配不上，这正是
 *      「删除后仍能搜到」的直接原因，故降级为退路而不再是唯一判据。
 * 注：不用 \b（单词边界），因为 \b 对中文字符不生效
 */
async function deleteBySearch(
  scope: string,
  relation: string,
  hint: ContentVectorHint = {},
): Promise<{ removed: boolean; method: 'search'; memoryId?: string; reason?: string }> {
  try {
    // tag 白名单：只查内容向量（ki-search + 文档自定义 tag）。
    // 不限定 tag 时，历史记录的 tag 字段一旦缺失，`ki-relation`（content 恰好就是 relation
    // 名）会被标题判据整体命中 ⇒ 绕过 `deleteRelationVector` 的跨组共享保护，删掉兄弟组的关系向量。
    const results = await vectorSearch({
      scope,
      query: relation,
      tags: contentVectorTags(hint.tags),
      limit: CONTENT_FALLBACK_SEARCH_LIMIT,
    });

    if (results.length === 0) {
      return { removed: false, method: 'search', reason: `search 无结果，mem 中可能无此记忆` };
    }

    const body = (hint.content ?? '').trim();
    // 判据与 visibility-index 同源（content-vector-match.ts）：正文比对优先，标题前缀退路
    const { hits: matched, bodyMatched, ambiguous } = pickContentVectorHits(results, {
      relation,
      body,
      siblingBodies: hint.siblingBodies,
    });

    if (matched.length === 0) {
      return {
        removed: false,
        method: 'search',
        reason: `search 返回 ${results.length} 条但无匹配（${body
          ? '正文与候选内容不一致，且 relation 名称未作为标题前缀出现'
          : 'relation 名称未作为标题前缀出现'}${ambiguous > 0 ? `；另有 ${ambiguous} 条同时命中其他文档正文，无法唯一归属已放弃` : ''}）`,
      };
    }

    // 删除所有匹配的内容 doc（多 tag 内容各有独立 doc，须全部清理，#M1）
    const ids = matched.map((r) => r.memoryId).filter(Boolean) as string[];
    const res = await vectorDelete({ scope, ids });
    if (res.deleted === 0) {
      return { removed: false, method: 'search', reason: `vectorDelete 未删除任何条目（ids=${ids.join(',')}）` };
    }
    if (res.deleted < ids.length) {
      return {
        removed: true,
        method: 'search',
        memoryId: ids[0],
        reason: `search 兜底部分命中（${res.deleted}/${ids.length}${bodyMatched > 0 ? '，正文比对命中' : ''}）`,
      };
    }
    return { removed: true, method: 'search', memoryId: ids[0] };
  } catch (err) {
    return { removed: false, method: 'search', reason: `search 兜底失败: ${(err as Error).message}` };
  }
}

/** cache 记录的内容向量条数（= memoryIds 去掉自定义 tag 后的数量，与 import.ts 同口径） */
function contentVectorCount(rel?: { memoryIds?: string[]; memoryId?: string; tags?: string[] }): number {
  const all = rel?.memoryIds?.length ? rel.memoryIds : rel?.memoryId ? [rel.memoryId] : [];
  return Math.max(0, all.length - (rel?.tags?.length ?? 0));
}

/**
 * 删除 tag=ki-relation 的**路径向量**（REQ-20261021-002）。
 *
 * 为什么单列一个函数：路径向量的 docId **没有回写到 cache**（见 sync-relation.ts
 * 「relation 路径向量（ki-relation），不回写到 cache（cache 只记内容向量 docId）」），
 * 而 delete-relation 只按 memoryIds 删内容向量 ⇒ 删完 `ki doc list` 仍剩一条孤儿。
 *
 * 好在 docId 可**重算**：`sha256(文本 + scope + tag)`，文本形态有三种——
 *   单条写入：`buildRelationContent()` 只返回 relation 名；
 *   **分块导入**：chunkRelation 形如 `relation-01` / `relation-02`（chunk-entries.ts::deriveChunkRelation
 *     恒带两位后缀，见 import.ts 按 `e.chunkRelation` 写路径向量）——过去只算纯名，
 *     这类文档删完必留 `relation-01` 孤儿且不报原因；
 *   历史（12d14c4 之前）：`${relation} | Group: ${group 空格化}`（keywords 机制已废弃）。
 * 三种都算一遍直接删；仍未命中再按 tag 精确检索兜底（更早形态无法穷举）。
 *
 * ⚠️ docId 跨组共享（只由 relation 名决定），调用方必须先确认没有其他组持有同名 relation。
 */
async function deleteRelationVector(
  scope: string,
  relation: string,
  group: string,
  opts: { contentVectorCount?: number; siblingNames?: Set<string> } = {},
): Promise<{ removed: boolean; deleted?: number; reason?: string }> {
  const avail = await ensureVectorAvailable();
  if (!avail.available) {
    return { removed: false, reason: `路径向量未清理（向量服务不可用：${avail.reason || 'unknown'}）` };
  }
  // 候选重算与检索兜底由 relation-path-vector 单点实现：hidden 摘除走同一函数，
  // 避免「删除删得掉、hidden 摘不掉」的分叉。
  return removeRelationPathVectors({ scope, relation, group, ...opts });
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
