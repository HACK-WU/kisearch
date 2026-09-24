import { loadConfig, resolveScope } from './lib/config.js';
import { ensureScopeDir } from './lib/store.js';
import {
  applyLineEdits,
  contentRevision,
  createDraft,
  loadDraft,
  saveDraft,
  type RelationLineEdit,
  type RelationEditDraft,
} from './lib/relation-edit-draft.js';
import { readLiveRelation } from './lib/relation-edit-live.js';
import { queueRelationEditFinish, isRelationEditJobActive, recoverInterruptedPublication,
  recognizePublishedDraft, discardUnpublishedIndex } from './lib/relation-edit-publish.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';

export interface EditRelationParams {
  action: 'edit' | 'view' | 'finish' | 'cancel';
  scope?: string;
  group?: string;
  relation?: string;
  editId?: string;
  expectedRevision?: string;
  edits?: RelationLineEdit[];
  requestId?: string;
  startLine?: number;
  endLine?: number;
}

function sameTarget(draft: RelationEditDraft, group?: string, relation?: string): void {
  if (group !== undefined && group !== draft.group) throw new Error('group 与 edit_id 对应的草稿不一致');
  if (relation !== undefined && relation !== draft.relation) throw new Error('relation 与 edit_id 对应的草稿不一致');
}

export async function executeEditRelationLocal(params: EditRelationParams): Promise<Record<string, unknown>> {
  try {
    const scope = resolveScope(loadConfig(), params.scope);
    ensureScopeDir(scope);
    if (params.action === 'edit') {
      if (!params.expectedRevision) throw new Error('edit 需要 expected_revision');
      if (!params.edits?.length) throw new Error('edit 需要非空 edits 数组');
      if (params.editId) {
        const draft = loadDraft(scope, params.editId);
        sameTarget(draft, params.group, params.relation);
        if (draft.status !== 'editing') throw new Error(`草稿状态 ${draft.status} 不允许编辑；失败的发布请重试 finish`);
        if (draft.revision !== params.expectedRevision) throw new Error('草稿版本冲突：请 view 最新草稿后重试');
        const edited = applyLineEdits(draft.content, params.edits);
        draft.content = edited.content;
        draft.revision = contentRevision(edited.content);
        draft.status = 'editing';
        delete draft.error;
        saveDraft(draft);
        return { ok: true, action: 'edit', scope, editId: draft.editId, status: draft.status,
          revision: draft.revision, totalLines: edited.totalLines, editsApplied: params.edits.length,
          previews: edited.previews };
      }
      if (!params.group || !params.relation) throw new Error('首次 edit 需要 group 和 relation');
      const live = readLiveRelation(scope, params.group, params.relation);
      if (live.revision !== params.expectedRevision) throw new Error('正式正文版本冲突：请重新读取 Relation');
      const edited = applyLineEdits(live.content, params.edits);
      const draft = createDraft({ scope, group: params.group, relation: params.relation,
        baseRevision: live.revision, baseMetadataRevision: live.metadataRevision,
        baseContent: live.content, content: edited.content });
      return { ok: true, action: 'edit', scope, editId: draft.editId, status: draft.status,
        revision: draft.revision, totalLines: edited.totalLines, editsApplied: params.edits.length,
        previews: edited.previews };
    }
    if (!params.editId) throw new Error(`${params.action} 需要 edit_id`);
    const draft = loadDraft(scope, params.editId);
    sameTarget(draft, params.group, params.relation);
    if (params.action === 'view') {
      if ((draft.status === 'queued' || draft.status === 'running') && !isRelationEditJobActive(draft.editId)) {
        recoverInterruptedPublication(draft);
        recognizePublishedDraft(draft);
        draft.status = 'failed';
        draft.error = '发布任务已中断；请沿用 request_id 重试 finish';
        saveDraft(draft);
      }
      const lines = draft.content.split(/\r?\n/);
      const first = params.startLine ?? 1;
      const last = params.endLine ?? lines.length;
      if (!Number.isInteger(first) || !Number.isInteger(last) || first < 1 || last < first || last > lines.length) {
        throw new Error(`view 行号越界（草稿共 ${lines.length} 行）`);
      }
      return { ok: true, action: 'view', scope, editId: draft.editId, group: draft.group,
        relation: draft.relation, status: draft.status, revision: draft.revision,
        baseRevision: draft.baseRevision, totalLines: lines.length, lineStart: first, lineEnd: last,
        content: lines.slice(first - 1, last).join('\n'), ...(draft.error ? { error: draft.error } : {}),
        ...(draft.retryable !== undefined ? { retryable: draft.retryable } : {}),
        ...(draft.wikiSynced !== undefined ? { wikiSynced: draft.wikiSynced } : {}),
        ...(draft.wikiReason ? { wikiReason: draft.wikiReason } : {}),
      };
    }
    if (params.action === 'cancel') {
      if (draft.status === 'failed' && !isRelationEditJobActive(draft.editId)) recognizePublishedDraft(draft);
      if (draft.status === 'queued' || draft.status === 'running' || (draft.status === 'failed' && draft.publishedRevision)) {
        throw new Error('发布已开始，不能直接取消；请 view 查询并重试 finish 清理索引');
      }
      if (draft.status === 'published') throw new Error('Relation 已发布，不能取消');
      if (draft.status === 'failed') await discardUnpublishedIndex(draft);
      draft.status = 'cancelled';
      saveDraft(draft);
      return { ok: true, action: 'cancel', scope, editId: draft.editId, status: draft.status };
    }
    if (params.action === 'finish') {
      if (!params.expectedRevision || draft.revision !== params.expectedRevision) throw new Error('草稿版本冲突：请 view 最新草稿后重试');
      if (!params.requestId) throw new Error('finish 需要 request_id，以支持超时后幂等查询与重试');
      if (draft.status === 'published') return { ok: true, action: 'finish', scope, editId: draft.editId, status: draft.status };
      if (draft.status === 'cancelled') throw new Error('已取消草稿不能发布');
      if ((draft.status === 'queued' || draft.status === 'running') && isRelationEditJobActive(draft.editId)) {
        return { ok: true, action: 'finish', scope, editId: draft.editId, status: draft.status };
      }
      // 确定性失败（正文/元数据在编辑期间变化、chunk 超限等）重试必然再失败，
      // 直接拒绝并提示重建草稿，避免调用方按「沿用 request_id 重试」空转。
      if (draft.status === 'failed' && draft.retryable === false) {
        throw new Error(`上次发布为不可重试失败（${draft.error ?? '未知原因'}）；请重新创建草稿`);
      }
      if (draft.requestId && draft.requestId !== params.requestId && draft.status !== 'editing') {
        throw new Error('已有不同 request_id 的提交；请沿用原 request_id 查询或重试');
      }
      draft.requestId = params.requestId;
      draft.status = 'queued';
      delete draft.error;
      delete draft.retryable;
      saveDraft(draft);
      queueRelationEditFinish(draft);
      return { ok: true, action: 'finish', scope, editId: draft.editId, status: 'queued', requestId: draft.requestId };
    }
    throw new Error('不支持的 action');
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

export async function executeEditRelation(params: EditRelationParams): Promise<Record<string, unknown>> {
  if (shouldUseDaemonClient()) return callDaemon<Record<string, unknown>>('edit-relation', params);
  return executeEditRelationLocal(params);
}
