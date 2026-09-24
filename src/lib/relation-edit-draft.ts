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
    try { fs.unlinkSync(draftPath(draft.scope, draft.editId)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
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
 * 有草稿时按「目录名 + mtime + 文件清单」做进程内缓存，草稿未变则复用上次结果。
 */
export function hiddenEditIndexIds(scope: string): Set<string> {
  const dir = draftDir(scope);
  const files = activeDraftFiles(dir);
  if (files.length === 0) {
    hiddenCache.delete(scope);
    return new Set<string>();
  }
  const stamp = `${files.join(',')}@${draftDirMtime(dir, files)}`;
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
