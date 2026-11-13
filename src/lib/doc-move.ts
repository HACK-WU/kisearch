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
  const content = readJson<Record<string, string>>(getLocalKbDir(scope, group))?.[relation];
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
    rollbackSource();
    reject(500, 'MOVE_PARTIAL',
      `目标 Group 已写入，但旧位置清理失败：${removed.error}；`
      + (undo.ok
        ? '已回滚（目标位置的新副本已删除、源文件已搬回），可稍后重试'
        : `自动回滚不完整：请在「${targetGroup}」手工删除「${targetRelation}」后再重试`),
      { retryable: true, source: source.moved ? 'moved' : 'unchanged' });
  }

  return {
    ok: true,
    from: { scope, group, relation },
    to: { scope, group: targetGroup, relation: targetRelation },
    source,
    indexMode,
    warnings,
  };
}
