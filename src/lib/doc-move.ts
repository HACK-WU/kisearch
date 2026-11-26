/**
 * doc-move.ts —— 文档移动（改 Group / 同时改名称）
 *
 * 为什么单独成模块而不是拼一次「读 → 写新组 → 删旧组」：文档在 ki 里有 5 处落点
 * （本地 KB 正文、元数据分片、Group 树、向量 + FTS 索引、wiki 回写文件），
 * 漏一处就是「看起来移动成功、实际数据分叉」。本模块只负责**预检 + 编排 + 回滚**，
 * 真正的写入与清除分别复用已测链路：
 *
 *   ├─ 落新位置：`executeSyncRelation`（组树补建 / KB / 分片 / 向量 / FTS 一次做完）
 *   └─ 清旧位置：`executeDeleteRelation`（wikiDelete:false —— 文件由本模块自己搬）
 *
 * ★ 为什么源文件先搬：它是唯一的**仓库外副作用**，放最前面失败时 ki 侧零改动、
 *   无需回滚；而写库失败时把它搬回去即可。
 * ★ 为什么要 `skipWikiWriteback`：`writeBackToWiki` 会用 `generateMarkdown` 重新生成
 *   内容（补 front-matter / 标题），与「文件原样搬家」的语义不符。
 */
import fs from 'node:fs';
import path from 'node:path';

import { getLocalKbDir } from './scope.js';
import { extractKbBody } from './content-vector-match.js';
// 附件搬运（#102）：跨 group 移动时，图片必须跟着正文一起走
import { collectGroupAssetRefs, copyAssetFiles, deleteOrphans, listDocAssetFiles } from './asset-orphan.js';
import { loadGroupCache } from './group-cache.js';
import { readJson } from './store.js';
import { activeDrafts, contentRevision } from './relation-edit-draft.js';
import { relationIndexMode } from './relation-edit-live.js';
import type { Relation } from './scoring.js';
import { resolveWikiRootDir } from './wiki-sync.js';
import { groupToRelDir, isRootGroup } from './import-path.js';
import { datasourceManagedFile, normalizeGroup, normalizeRelation, reject } from './doc-identity.js';
import { executeSyncRelation } from '../sync-relation.js';
import { executeDeleteRelation } from '../delete-relation.js';

export interface MoveDocumentInput {
  scope: string;
  /** 当前位置 */
  group: string;
  relation: string;
  /** 目标位置：Group 必填，名称缺省沿用原名（Q2：同名冲突时由用户改成新名称） */
  targetGroup: string;
  targetRelation?: string;
  /** 可选乐观锁：来自 `GET /api/doc/edit` 的 revision */
  expectedRevision?: string;
}

export interface SourceMovePlan {
  /** 是否配置了 wiki 回写目录（未配置 = 只搬 KB，一个文件都不碰） */
  configured: boolean;
  moved: boolean;
  from?: string;
  to?: string;
  /** 未搬文件的原因（已搬时不出现） */
  reason?: string;
}

export interface MoveDocumentResult {
  ok: true;
  from: { scope: string; group: string; relation: string };
  to: { scope: string; group: string; relation: string };
  source: SourceMovePlan;
  indexMode: 'dense' | 'fts';
  /**
   * 附件搬运结果（#102）：只有**跨 Group** 移动时出现。
   *
   * 同组改名不动附件（相对引用不变），所以那种情况不返回本字段。
   */
  assets?: {
    /** 复制到目标 Group 的文件数 */
    copied: number;
    copiedBytes: number;
    /** 目标已有内容相同的同名文件（本来就共用同一张图） */
    shared: number;
    /** 从原 Group 清掉的图（原组已无其它文档引用它们） */
    removedFromSource: number;
  };
  warnings: string[];
}

/** 解析并校验「源文件 → 目标路径」；只读，任何一条不满足都降级为「不搬文件」而不是抛错 */
function planSourceMove(
  scope: string,
  record: { sourcePath?: string },
  targetGroup: string,
  targetRelation: string,
): SourceMovePlan {
  const root = resolveWikiRootDir(scope).dir;
  if (!root) return { configured: false, moved: false, reason: '未配置 wikiSync.sourceDir：只更新 KB，不写任何文件' };
  const rel = String(record.sourcePath ?? '').replace(/\\/g, '/');
  if (!rel || path.posix.isAbsolute(rel) || rel.split('/').some((part) => !part || part === '.' || part === '..')) {
    return { configured: true, moved: false, reason: '文档缺少可唯一定位的 wiki 回写目标路径：只更新 KB，不搬文件' };
  }
  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(root);
    if (!rootStat.isFile()) fs.realpathSync(root);
  } catch (error) {
    return { configured: true, moved: false, reason: `wiki 回写目录不可用（${(error as Error).message}）：只更新 KB，不搬文件` };
  }
  if (rootStat.isFile()) {
    // 单文件导入：sourceDir 指向一个文件，没有可搬的目录结构
    return { configured: true, moved: false, reason: '单文件导入的 wiki 目标不参与移动：只更新 KB，不搬文件' };
  }
  const from = path.resolve(root, rel);
  if (!from.startsWith(`${path.resolve(root)}${path.sep}`)) {
    return { configured: true, moved: false, reason: 'wiki 回写目标越出配置目录：只更新 KB，不搬文件' };
  }
  if (!fs.existsSync(from)) {
    return { configured: true, moved: false, reason: 'wiki 源文件已不存在：只更新 KB，不搬文件' };
  }
  const relDir = groupToRelDir(targetGroup);
  const to = relDir ? path.join(root, relDir, `${targetRelation}.md`) : path.join(root, `${targetRelation}.md`);
  if (!to.startsWith(`${path.resolve(root)}${path.sep}`)) {
    return { configured: true, moved: false, reason: '目标路径越出配置目录：只更新 KB，不搬文件' };
  }
  if (fs.existsSync(to) && path.resolve(to) !== path.resolve(from)) {
    // 目标文件已存在：绝不覆盖用户文件
    reject(409, 'SOURCE_EXISTS', `目标位置已存在同名文件：${to}；请先处理该文件或换一个名称`, { target: to });
  }
  return { configured: true, moved: false, from, to };
}

/** 跨设备（EXDEV）退化：copy + unlink；同盘走 rename（原子） */
function moveFile(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

/** 把已搬走的文件搬回原位（回滚用）；失败只记入 warnings，不掩盖原始错误 */
function rollbackFile(from: string, to: string, warnings: string[]): void {
  try {
    if (fs.existsSync(to) && !fs.existsSync(from)) moveFile(to, from);
  } catch (error) {
    warnings.push(`源文件回滚失败：${(error as Error).message}（文件仍在 ${to}）`);
  }
}

/**
 * 移动一篇文档。调用方负责持有 scope 写锁（HTTP 层传入 `doc-move-write`）。
 *
 * 顺序：预检（全只读） → 搬源文件 → 落新位置 → 清旧位置；任一步失败按逆序回滚。
 */
export async function moveDocument(input: MoveDocumentInput): Promise<MoveDocumentResult> {
  const scope = String(input.scope ?? '').trim();
  if (!scope) reject(400, 'DOC_ID_INVALID', '缺少 scope');
  const group = normalizeGroup(input.group, '原 Group');
  const relation = normalizeRelation(input.relation, '文档名称');
  // 目标侧放行根保留键：选择器里点「根目录」就是显式选择，不是缺省兜底
  const targetGroup = normalizeGroup(input.targetGroup, '目标 Group', true);
  const targetRelation = normalizeRelation(input.targetRelation ?? relation, '文档名称');

  // ─── 预检①：源文档存在（分片 + 正文两层，缺一即 404，两者口径与编辑器一致）───
  const record = loadGroupCache(scope, group)?.hot_relations.find((item) => item.text === relation);
  if (!record) reject(404, 'DOC_NOT_FOUND', `文档不存在：${group} / ${relation}`);
  // 整组读一次：正文用 extractKbBody（条目值可能是 string，也可能是 {moduleInfo|content}），
  // 附件引用统计复用同一份
  const kbRaw = readJson<Record<string, unknown>>(getLocalKbDir(scope, group));
  const content = extractKbBody(kbRaw?.[relation]);
  if (typeof content !== 'string') reject(404, 'DOC_NOT_FOUND', '文档原文不存在');
  if (group === targetGroup && relation === targetRelation) {
    reject(400, 'SAME_TARGET', '目标 Group 与文档名称都未变化');
  }

  // ─── 预检②：目标重名（Q2：不覆盖、不加后缀，让用户自己改名）───
  const existing = loadGroupCache(scope, targetGroup)?.hot_relations.find((item) => item.text === targetRelation);
  if (existing) {
    reject(409, 'TARGET_EXISTS',
      `目标 Group「${targetGroup}」已有同名文档「${targetRelation}」，请换一个名称后再移动`,
      { targetGroup, targetRelation });
  }

  // ─── 预检③：乐观锁 / 在途草稿 / 数据源管辖 / 源文件落点 ───
  if (input.expectedRevision && contentRevision(content) !== input.expectedRevision) {
    reject(409, 'REVISION_CONFLICT', '正文已变化，请重新加载文档后再移动');
  }
  const drafts = activeDrafts(scope).filter((draft) => draft.group === group && draft.relation === relation);
  if (drafts.length > 0) {
    reject(409, 'DOC_EDIT_IN_PROGRESS',
      `该文档有 ${drafts.length} 条未结束的编辑草稿（${drafts.map((draft) => `${draft.editId}:${draft.status}`).join(', ')}），`
      + '请先用 ki_edit_relation 的 cancel / finish 收口后再移动');
  }
  const managed = datasourceManagedFile(scope, (record as { sourcePath?: string }).sourcePath);
  if (managed) {
    reject(409, 'DATASOURCE_BLOCKED',
      `该文档由数据源同步维护（${managed}）：移动后下次同步会在原 Group 重新导入一份，形成两份副本。`
      + '请到「数据源」页调整目录结构后重新同步，或改为手动写入一份后删除这条导入来源。',
      { sourcePath: managed });
  }

  const warnings: string[] = [];
  const planned = planSourceMove(scope, record as { sourcePath?: string }, targetGroup, targetRelation);
  const source: SourceMovePlan = { ...planned };

  // ─── 第 1 步：搬源文件（唯一的仓库外副作用，最先做）───
  if (source.from && source.to) {
    try {
      moveFile(source.from, source.to);
      source.moved = true;
      delete source.reason;
    } catch (error) {
      reject(500, 'SOURCE_MOVE_FAILED', `源文件移动失败：${(error as Error).message}`, { from: source.from, to: source.to });
    }
  } else if (source.reason) {
    warnings.push(source.reason);
  }

  const rollbackSource = (): void => {
    if (source.moved && source.from && source.to) {
      rollbackFile(source.from, source.to, warnings);
      source.moved = false;
    }
  };

  /**
   * ─── 第 1.5 步：把这篇引用的图复制到目标 Group（仅跨 Group）───
   *
   * 为什么复制而不是改正文引用：正文里是 `./images/x.svg` 这种**相对引用**，只要图片
   * 在目标 group 的 assets 下保持同样相对路径就不用动正文（改正文会牵动向量与 revision）。
   *
   * 源 group 的图**先不删**：第 3 步清旧位置失败时要能整体回滚。删除放在最后一步。
   */
  const crossGroup = group !== targetGroup;
  const docAssets = crossGroup ? listDocAssetFiles(scope, group, relation, kbRaw) : [];
  const assetMove = crossGroup
    ? copyAssetFiles(scope, group, targetGroup, docAssets.map((file) => file.rel))
    : { created: [] as string[], skipped: [] as string[], conflicts: [] as string[], failed: [] as string[], bytes: 0 };
  if (assetMove.created.length > 0) {
    warnings.push(`已复制 ${assetMove.created.length} 个附件到「${targetGroup}」（${assetMove.bytes} 字节）`);
  }
  if (assetMove.conflicts.length > 0) {
    // 保留目标组那份：静默覆盖会换掉目标组其它文档正在用的图，比"新文档显示错图"更糟
    warnings.push(
      `目标 Group 已有同名但内容不同的附件，已保留目标那份（本文档会引用它）：${assetMove.conflicts.slice(0, 5).join(', ')}`
      + (assetMove.conflicts.length > 5 ? ` 等 ${assetMove.conflicts.length} 个` : ''),
    );
  }
  if (assetMove.failed.length > 0) {
    // 复制失败与「同名冲突」是两件事：这里是真没能搬过去，目标组里这些图会 404
    warnings.push(
      `有 ${assetMove.failed.length} 个附件未能复制到「${targetGroup}」（${assetMove.failed.slice(0, 5).join(', ')}`
      + `${assetMove.failed.length > 5 ? ' …' : ''}）：目标组里这些图会取不到，请手工补上`,
    );
  }
  const rollbackAssets = (): void => {
    if (assetMove.created.length === 0) return;
    const undone = deleteOrphans(scope, assetMove.created.map((rel) => ({ group: targetGroup, rel })));
    if (undone.errors.length > 0) {
      warnings.push(`附件回滚不完整：${undone.errors.slice(0, 3).join('; ')}`);
    }
    assetMove.created = [];
  };

  // ─── 第 2 步：落到目标位置（组树 / KB / 分片 / 向量 / FTS 一次做完）───
  const indexMode = relationIndexMode(record as Relation);
  const tags = Array.isArray((record as { tags?: string[] }).tags) ? ((record as { tags?: string[] }).tags as string[]) : [];
  const sourcePath = source.moved && source.to
    ? path.relative(resolveWikiRootDir(scope).dir as string, source.to).split(path.sep).join('/')
    : undefined;
  const writeResult = await executeSyncRelation({
    scope,
    group: targetGroup,
    relation: targetRelation,
    moduleInfo: content,
    vector: indexMode === 'dense',
    ...(tags.length > 0 ? { tags: tags.join(',') } : {}),
    ...(sourcePath ? { sourcePath } : {}),
    // 文件已由上面 rename 到位；这里不能再让 generateMarkdown 重写一遍
    skipWikiWriteback: true,
    // 目标是根目录时显式传了保留键，需放行（且不打 groupSource 兜底标记）
    ...(isRootGroup(targetGroup) ? { allowRootGroup: true } : {}),
  });
  if (!writeResult.ok) {
    // 写入是「KB → 分片 → 向量 → FTS」多步，失败可能已经留下半成品条目：
    // 先尽力清掉目标位置那一份，再回滚源文件，最后**按事实**告知还剩什么（不猜）。
    await executeDeleteRelation({ scope, group: targetGroup, relation: targetRelation, wikiDelete: false, skipDenseDelete: true });
    const leftover = loadGroupCache(scope, targetGroup)?.hot_relations.some((item) => item.text === targetRelation) ?? false;
    rollbackAssets();
    rollbackSource();
    reject(500, 'MOVE_INDEX_FAILED',
      `写入目标 Group 失败：${writeResult.error}；`
      + (leftover
        ? `目标位置可能留有半成品「${targetGroup} / ${targetRelation}」，请手工清理后再重试`
        : '已回滚（目标位置未留下副本、源文件已搬回）'),
      { retryable: true, source: source.moved ? 'moved' : 'unchanged' });
  }

  // ─── 第 3 步：清掉旧位置（不碰文件：wikiDelete=false；不删内容向量：同一篇文档 id 不变）───
  const removed = await executeDeleteRelation({ scope, group, relation, wikiDelete: false, skipDenseDelete: true });
  if (!removed.ok) {
    // 回滚：新位置刚写的那份删掉（同样不碰文件），再把文件搬回去 —— 不留"两边都在"
    const undo = await executeDeleteRelation({
      scope, group: targetGroup, relation: targetRelation, wikiDelete: false, skipDenseDelete: true,
    });
    rollbackAssets();
    rollbackSource();
    reject(500, 'MOVE_PARTIAL',
      `目标 Group 已写入，但旧位置清理失败：${removed.error}；`
      + (undo.ok
        ? '已回滚（目标位置的新副本已删除、源文件已搬回），可稍后重试'
        : `自动回滚不完整：请在「${targetGroup}」手工删除「${targetRelation}」后再重试`),
      { retryable: true, source: source.moved ? 'moved' : 'unchanged' });
  }

  /**
   * ─── 第 4 步：清理原 Group 里已无引用的图 ───
   *
   * 判据必须放在「清掉旧位置之后」：此时原 group 的 KB 里已经没有这篇文档，
   * 差集天然等于「原组不再有人引用」。共享图会留在原组（其它文档还在用）。
   *
   * 失败只记 warning：文档已经移动成功，附件清理是收尾工作，不能倒过来判定移动失败
   * （那会让用户重复执行一次已经完成的移动）。
   */
  let removedFromSource = 0;
  if (crossGroup && docAssets.length > 0) {
    const kbAfter = readJson<Record<string, unknown>>(getLocalKbDir(scope, group));
    const stillReferenced = collectGroupAssetRefs(kbAfter);
    const removable = docAssets
      .filter((file) => !stillReferenced.has(file.rel))
      .map((file) => ({ group, rel: file.rel }));
    if (removable.length > 0) {
      const cleaned = deleteOrphans(scope, removable);
      removedFromSource = cleaned.deleted;
      if (cleaned.errors.length > 0) {
        warnings.push(`原 Group 附件清理未完成：${cleaned.errors.slice(0, 3).join('; ')}`);
      }
    }
  }

  return {
    ok: true,
    from: { scope, group, relation },
    to: { scope, group: targetGroup, relation: targetRelation },
    source,
    indexMode,
    ...(crossGroup
      ? {
        assets: {
          copied: assetMove.created.length,
          copiedBytes: assetMove.bytes,
          shared: assetMove.skipped.length,
          removedFromSource,
        },
      }
      : {}),
    warnings,
  };
}
