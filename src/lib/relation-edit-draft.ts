import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getKbDir } from './scope.js';
import { readJson, writeJson } from './store.js';
import type { FtsLocator } from './original-locator.js';

export interface RelationLineEdit {
  start_line: number;
  end_line: number;
  new_text: string;
}

export interface RelationEditPreview {
  originalStartLine: number;
  originalEndLine: number;
  resultStartLine: number;
  resultEndLine: number;
  beforeExcerpt: string;
  afterExcerpt: string;
}

export type RelationEditStatus = 'editing' | 'queued' | 'running' | 'failed' | 'published' | 'cancelled';

export interface RelationEditDraft {
  version: number;
  editId: string;
  scope: string;
  group: string;
  relation: string;
  baseRevision: string;
  baseMetadataRevision: string;
  baseContent: string;
  content: string;
  revision: string;
  status: RelationEditStatus;
  requestId?: string;
  error?: string;
  /** 上次失败的发布是否可重试；false 表示确定性失败，重试同一 request_id 必然再次失败。 */
  retryable?: boolean;
  newDenseIds?: string[];
  /** finish 首次写入前已存在的向量；失败取消时不能删除，也不能作为草稿索引隐藏。 */
  preexistingDenseIds?: string[];
  newDenseContentIds?: string[];
  newFtsIds?: string[];
  newFtsLocators?: FtsLocator[];
  oldDenseIds?: string[];
  oldFtsIds?: string[];
  publishedRevision?: string;
  wikiSynced?: boolean;
  wikiReason?: string;
  createdAt: string;
  updatedAt: string;
}

export function contentRevision(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export function metadataRevision(metadata: { tags?: string[]; sourcePath?: string; indexMode: 'dense' | 'fts' }): string {
  return createHash('sha256').update(JSON.stringify({
    tags: metadata.tags ?? [],
    sourcePath: metadata.sourcePath ?? null,
    indexMode: metadata.indexMode,
  })).digest('hex');
}

function draftDir(scope: string): string {
  return path.join(getKbDir(scope), '.relation-edits');
}

function assertEditId(editId: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(editId)) throw new Error('edit_id 格式无效');
}

export function draftPath(scope: string, editId: string): string {
  assertEditId(editId);
  return path.join(draftDir(scope), `${editId}.json`);
}

function archivedDraftPath(scope: string, editId: string): string {
  assertEditId(editId);
  return path.join(draftDir(scope), 'archive', `${editId}.json`);
}

export function createDraft(params: {
  scope: string;
  group: string;
  relation: string;
  baseRevision: string;
  baseMetadataRevision: string;
  baseContent: string;
  content: string;
}): RelationEditDraft {
  const now = new Date().toISOString();
  const draft: RelationEditDraft = {
    version: 1,
    editId: randomUUID(),
    scope: params.scope,
    group: params.group,
    relation: params.relation,
    baseRevision: params.baseRevision,
    baseMetadataRevision: params.baseMetadataRevision,
    baseContent: params.baseContent,
    content: params.content,
    revision: contentRevision(params.content),
    status: 'editing',
    createdAt: now,
    updatedAt: now,
  };
  saveDraft(draft);
  return draft;
}

export function loadDraft(scope: string, editId: string): RelationEditDraft {
  const draft = readJson<RelationEditDraft>(draftPath(scope, editId))
    ?? readJson<RelationEditDraft>(archivedDraftPath(scope, editId));
  if (!draft || draft.editId !== editId || draft.scope !== scope) throw new Error('编辑草稿不存在');
  return draft;
}

export function saveDraft(draft: RelationEditDraft): void {
  const archived = draft.status === 'published' || draft.status === 'cancelled';
  const file = archived ? archivedDraftPath(draft.scope, draft.editId) : draftPath(draft.scope, draft.editId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  draft.updatedAt = new Date().toISOString();
  writeJson(file, draft as unknown as Record<string, unknown>);
  if (archived) {
    try {
      fs.unlinkSync(draftPath(draft.scope, draft.editId));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        // 归档副本已写入，活动路径留下的是**过期状态**。旧实现直接抛错：调用方的失败态
        // 回写会覆盖终态，形成同 editId 双份不一致（archive=published / 活动=failed）。
        // 现改为把同一终态补写到活动路径让两处一致（loadDraft 优先读活动路径），
        // 并显式告警、不抛错——归档副本已可用，不该让收尾动作失败。
        try { writeJson(draftPath(draft.scope, draft.editId), draft as unknown as Record<string, unknown>); }
        catch { /* 活动路径不可写（如被外部替换为目录）：loadDraft 会回落到 archive */ }
        process.stderr.write(
          `提示：编辑草稿 ${draft.editId} 已归档，但未能删除活动目录副本（${(err as Error).message}）；`
          + `已同步终态，可人工清理 ${draftDir(draft.scope)} 下的残留\n`,
        );
      }
    }
    pruneArchivedDrafts(draft.scope);
    endPublishLease(draft.scope, draft.editId); // 终态草稿不再需要发布心跳
  }
}

/** 发布心跳文件路径：kb/{scope}/.relation-edits/{editId}.publish（与草稿同目录，文件名不匹配草稿正则）。 */
export function publishLeasePath(scope: string, editId: string): string {
  assertEditId(editId);
  return path.join(draftDir(scope), `${editId}.publish`);
}

/**
 * 发布心跳有效期。临界区（KB 写 → cache 写）本身只有毫秒级，60s 是"容忍发布方崩溃后
 * 延迟恢复"的上界：租约过期前另一进程的 view 不做中断恢复，过期后按原有逻辑回滚。
 *
 * 只按 mtime 判定、不看 pid：pid 会被系统复用，用 pid 存活性判断会引入"陈旧租约永久生效"
 * 的新失败模式；纯新鲜度判定天然自愈（最长多等一个有效期）。
 */
export const PUBLISH_LEASE_GRACE_MS = 60_000;

/**
 * 置位发布心跳（覆盖写，发布方每个临界区只写一次，**从不阻塞发布**）。
 * 写失败也照常发布：代价是退回"单 owner"假设，而不是让发布失败。
 */
export function beginPublishLease(scope: string, editId: string): void {
  try {
    fs.mkdirSync(draftDir(scope), { recursive: true });
    fs.writeFileSync(publishLeasePath(scope, editId),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
  } catch { /* 心跳写失败不阻断发布；跨进程误判由租约过期兜底 */ }
}

/** 清除发布心跳（幂等）。失败仅留下一个会自然过期的文件，不影响任何判定。 */
export function endPublishLease(scope: string, editId: string): void {
  try { fs.unlinkSync(publishLeasePath(scope, editId)); }
  catch { /* ENOENT 或权限问题：残留由 PUBLISH_LEASE_GRACE_MS 过期兜底 */ }
}

/** 该草稿是否有仍在有效期内的发布心跳（另一进程据此判断"发布者可能活着"）。 */
export function isPublishLeaseActive(scope: string, editId: string): boolean {
  try {
    const stat = fs.statSync(publishLeasePath(scope, editId));
    return Date.now() - stat.mtimeMs < PUBLISH_LEASE_GRACE_MS;
  } catch { return false; }
}

/**
 * 已结束草稿（published/cancelled）的归档保留上限。
 * 每条草稿含 baseContent + content 两份正文副本，不设上限会随编辑次数无界增长；
 * 正文已落 local KB，归档仅作状态审计，故按 updatedAt 保留最新 N 条并显式告警清理。
 */
export const ARCHIVED_DRAFT_RETENTION = 200;

function pruneArchivedDrafts(scope: string): void {
  const dir = path.join(draftDir(scope), 'archive');
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name)); }
  catch { return; }
  if (names.length <= ARCHIVED_DRAFT_RETENTION) return;
  const entries = names.map((name) => {
    const file = path.join(dir, name);
    let updatedAt = 0;
    try { updatedAt = fs.statSync(file).mtimeMs; } catch { /* 并发删除：按最旧处理 */ }
    return { file, updatedAt };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
  let deleted = 0;
  for (const entry of entries.slice(ARCHIVED_DRAFT_RETENTION)) {
    try { fs.unlinkSync(entry.file); deleted += 1; } catch { /* 并发删除/权限问题不阻断归档写入 */ }
  }
  if (deleted > 0) {
    process.stderr.write(`提示：编辑草稿归档超过 ${ARCHIVED_DRAFT_RETENTION} 条，已清理最旧的 ${deleted} 条（正文已落 local KB，归档仅作状态审计）\n`);
  }
}

/** 活动草稿目录 mtime 快照；命中则复用上次结果，避免每次检索重解析全部草稿。 */
const hiddenCache = new Map<string, { stamp: string; ids: Set<string> }>();

/** 目录内活动草稿文件（排除 archive）的名称排序快照；空表示无活动草稿。 */
function activeDraftFiles(dir: string): string[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return names.filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name)).sort();
}

/**
 * 取得尚未发布的新 ID、或已发布但清理失败的旧 ID；供搜索隐藏中间态。
 *
 * 无活动草稿时立即返回空集：这是绝大多数检索的常态，必须零 relations-cache 开销。
 * 有草稿时按「文件清单 + 草稿 mtime + relations-cache 身份」做进程内缓存。
 * cache 身份必须参与：隐藏集会把 cache 已引用的 ID 剔除，只按草稿 mtime 缓存会在
 * import/sync 等入口改写 cache 后长期陈旧（被隐藏 docId 已被合法引用却继续漏召回）。
 */
export function hiddenEditIndexIds(scope: string): Set<string> {
  const dir = draftDir(scope);
  const files = activeDraftFiles(dir);
  if (files.length === 0) {
    hiddenCache.delete(scope);
    return new Set<string>();
  }
  const stamp = `${files.join(',')}@${draftDirMtime(dir, files)}#${relationsCacheIdentity(scope)}`;
  const cached = hiddenCache.get(scope);
  if (cached?.stamp === stamp) return new Set(cached.ids);

  const hidden = new Set<string>();
  for (const name of files) {
    try {
      const draft = readJson<RelationEditDraft>(path.join(dir, name));
      if (!draft || draft.scope !== scope) continue;
      const ids = draft.status === 'published' ? [] : draft.publishedRevision
        ? [...(draft.oldDenseIds ?? []).filter((id) => !draft.newDenseIds?.includes(id)),
          ...(draft.oldFtsIds ?? []).filter((id) => !draft.newFtsIds?.includes(id))]
        : draft.status === 'queued' || draft.status === 'running' || draft.status === 'failed'
          ? [...(draft.newDenseIds ?? []).filter((id) => !draft.preexistingDenseIds?.includes(id)),
            ...(draft.newFtsIds ?? [])]
          : [];
      for (const id of ids) hidden.add(id);
    } catch { /* 损坏草稿由 view/finish fail-loud，搜索不因其整体失败 */ }
  }
  try {
    const cache = readJson<{ groups?: Record<string, { hot_relations?: Array<{ memoryId?: string; memoryIds?: string[]; ftsIds?: string[] }> }> }>(
      path.join(getKbDir(scope), 'relations-cache.json'),
    );
    for (const group of Object.values(cache?.groups ?? {})) {
      for (const relation of group.hot_relations ?? []) {
        for (const id of relation.memoryIds?.length ? relation.memoryIds : relation.memoryId ? [relation.memoryId] : []) hidden.delete(id);
        for (const id of relation.ftsIds ?? []) hidden.delete(id);
      }
    }
  } catch { /* 本地 cache 损坏由正式读链路报告，索引隐藏保持保守状态 */ }
  hiddenCache.set(scope, { stamp, ids: hidden });
  return new Set(hidden);
}

export interface ActiveDraftRef {
  editId: string;
  group: string;
  relation: string;
  status: RelationEditStatus;
}

/**
 * scope 内所有尚未结束的草稿（不含 archive）。
 * 删除类入口在破坏性操作前用它 fail-loud：否则在途草稿会因目标 Relation 消失而永远
 * 无法 finish（只能手工删文件），其登记的索引 ID 也会一直挂在搜索隐藏集里。
 */
export function activeDrafts(scope: string): ActiveDraftRef[] {
  const dir = draftDir(scope);
  const result: ActiveDraftRef[] = [];
  for (const name of activeDraftFiles(dir)) {
    try {
      const draft = readJson<RelationEditDraft>(path.join(dir, name));
      if (!draft || draft.scope !== scope) continue;
      // 终态（published/cancelled）只可能作为活动目录里的残留出现：saveDraft 归档时
      // unlink 失败，或进程在写 archive 前被杀。它们没有在途发布，不能阻断删除类入口
      // ——否则用户会被引导去做已经完成过的 cancel/finish，形成新的死循环。
      // ⚠️ failed/queued/running 仍然必须阻断（在途草稿被删即无法收口）。
      if (draft.status === 'published' || draft.status === 'cancelled') continue;
      result.push({ editId: draft.editId, group: draft.group, relation: draft.relation, status: draft.status });
    } catch { /* 损坏草稿由 view/finish fail-loud，删除入口不因其整体失败 */ }
  }
  return result;
}

/** relations-cache 的轻量身份（mtime + size）；缺失时返回 none，仍按草稿变化失效。 */
function relationsCacheIdentity(scope: string): string {
  try {
    const stat = fs.statSync(path.join(getKbDir(scope), 'relations-cache.json'));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch { return 'none'; }
}

/** 活动草稿文件的最大 mtime；作为缓存失效依据（内容变更即变，删除由文件清单覆盖）。 */
function draftDirMtime(dir: string, files: string[]): number {
  let latest = 0;
  for (const name of files) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch { /* 并发删除：清单已变化，下次调用重算 */ }
  }
  return latest;
}

interface LinePosition { start: number; end: number }

function linePositions(content: string): LinePosition[] {
  const positions: LinePosition[] = [];
  const newline = /\r?\n/g;
  let start = 0;
  for (const match of content.matchAll(newline)) {
    const end = match.index;
    positions.push({ start, end });
    start = end + match[0].length;
  }
  positions.push({ start, end: content.length });
  return positions;
}

/** 所有区域以调用开始时的同一正文快照定位；任一无效则不返回新正文。 */
export function applyLineEdits(content: string, edits: RelationLineEdit[]): {
  content: string;
  totalLines: number;
  previews: RelationEditPreview[];
} {
  if (!Array.isArray(edits) || edits.length === 0) throw new Error('edits 至少需要一个修改区域');
  const lines = linePositions(content);
  const sorted = [...edits].sort((a, b) => a.start_line - b.start_line || a.end_line - b.end_line);
  for (let i = 0; i < sorted.length; i++) {
    const edit = sorted[i];
    if (!Number.isInteger(edit.start_line) || !Number.isInteger(edit.end_line)
      || edit.start_line < 1 || edit.end_line < edit.start_line || edit.end_line > lines.length) {
      throw new Error(`编辑区域 ${i + 1} 行号越界（正文共 ${lines.length} 行）`);
    }
    if (typeof edit.new_text !== 'string') throw new Error(`编辑区域 ${i + 1} 缺少 new_text`);
    if (i > 0 && edit.start_line <= sorted[i - 1].end_line) {
      throw new Error(`编辑区域 ${i + 1} 与前一区域重叠`);
    }
  }
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const previews: RelationEditPreview[] = [];
  let lineDelta = 0;
  for (const edit of sorted) {
    const before = content.slice(lines[edit.start_line - 1].start, lines[edit.end_line - 1].end);
    const after = edit.new_text.replace(/\r?\n/g, eol);
    const addedLines = after ? after.split(/\r?\n/).length : 0;
    const resultStartLine = edit.start_line + lineDelta;
    previews.push({ originalStartLine: edit.start_line, originalEndLine: edit.end_line,
      resultStartLine, resultEndLine: resultStartLine + addedLines - 1,
      beforeExcerpt: before.slice(0, 400), afterExcerpt: after.slice(0, 400) });
    lineDelta += addedLines - (edit.end_line - edit.start_line + 1);
  }
  let next = content;
  // 倒序应用防止行号漂移；用副本反转，保持 sorted 的升序语义不被外部观察者打乱。
  for (const edit of [...sorted].reverse()) {
    const first = lines[edit.start_line - 1];
    const last = lines[edit.end_line - 1];
    const replacement = edit.new_text.replace(/\r?\n/g, eol);
    const deletesToEnd = replacement.length === 0 && edit.end_line === lines.length;
    if (deletesToEnd && edit.start_line > 1) {
      // 删到文末：截断到上一行行尾，并保留单个结尾换行，避免多轮删尾累积悬挂空行。
      next = next.slice(0, lines[edit.start_line - 2].end) + eol;
    } else if (deletesToEnd) {
      // 删除整个文档的行（后续由非空校验拒绝，这里保持确定结果以免抛错前状态含糊）。
      next = '';
    } else if (replacement.length === 0) {
      // 删除文中间的 [start, end] 行：保留上一行的换行，让 end+1 行顶上来。
      next = next.slice(0, first.start) + next.slice(lines[edit.end_line].start);
    } else {
      next = next.slice(0, first.start) + replacement + next.slice(last.end);
    }
  }
  if (!next.trim()) throw new Error('修改后正文不能为空；删除整个 Relation 请使用 ki_delete_relation');
  return { content: next, totalLines: linePositions(next).length, previews };
}
