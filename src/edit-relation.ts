import { loadConfig, resolveScope } from './lib/config.js';
import { ensureScopeDir } from './lib/store.js';
import {
  applyLineEdits,
  contentRevision,
  createDraft,
  isPublishLeaseActive,
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
      const statusInFlight = draft.status === 'queued' || draft.status === 'running';
      const jobActive = isRelationEditJobActive(draft.editId);
      // 心跳租约未过期 ⇒ 可能有**另一 owner 进程**正在发布临界区内（本进程 activeJobs
      // 看不到它）。此时绝不能按“中断”处理：回滚 KB 会把刚写上的正文打回旧稿，并把草稿
      // 误标 failed 诱使调用方重试、造成双发布。保持原状态返回，等发布方收尾或租约过期
      // （PUBLISH_LEASE_GRACE_MS，≤60s）后自然回到原有恢复逻辑。
      const publishInFlight = statusInFlight && !jobActive && isPublishLeaseActive(draft.scope, draft.editId);
      if (statusInFlight && !jobActive && !publishInFlight) {
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
        // published=true 表示正文已生效（中断恢复或外部入口写入后由 recognize 补登记），
        // 此时 finish 只清理旧索引；requestId 供调用方在超时后原样重试 finish。
        published: Boolean(draft.publishedRevision),
        // publishInFlight：另一 owner 进程正在发布临界区内（心跳租约未过期、本进程无任务）。
        // 调用方应按"发布中"继续轮询，而不是当失败去重试 finish。
        ...(publishInFlight ? { publishInFlight: true } : {}),
        ...(draft.requestId ? { requestId: draft.requestId } : {}),
        ...(draft.wikiSynced !== undefined ? { wikiSynced: draft.wikiSynced } : {}),
        ...(draft.wikiReason ? { wikiReason: draft.wikiReason } : {}),
      };
    }
    if (params.action === 'cancel') {
      if (draft.status === 'failed' && !isRelationEditJobActive(draft.editId)) recognizePublishedDraft(draft);
      if (draft.status === 'queued' || draft.status === 'running') {
        throw new Error('发布已开始，不能直接取消；请 view 查询发布状态，或沿用原 request_id 重试 finish');
      }
      if (draft.status === 'failed' && draft.publishedRevision) {
        // 正文已经发布（上一次发布在写回草稿前中断，由上面的 recognize 补登记）。
        // cancel 的语义是"放弃尚未发布的内容"，此时内容已生效，只能 finish 清理旧索引。
        // 注意该状态下 finish 必须放行（见下方 retryable 判定），否则两个入口互相拒绝，
        // 草稿只能靠手工删除文件才能脱身。
        throw new Error('正文已经发布，不能取消；请沿用原 request_id 重试 finish 清理旧索引');
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
      if (draft.status === 'published') {
        // 幂等返回：附带本次发布记录的 request_id / wiki 结果，便于超时后确认归属与副作用。
        return { ok: true, action: 'finish', scope, editId: draft.editId, status: draft.status,
          ...(draft.requestId ? { requestId: draft.requestId } : {}),
          ...(draft.wikiSynced !== undefined ? { wikiSynced: draft.wikiSynced } : {}),
          ...(draft.wikiReason ? { wikiReason: draft.wikiReason } : {}) };
      }
      if (draft.status === 'cancelled') throw new Error('已取消草稿不能发布');
      if ((draft.status === 'queued' || draft.status === 'running') && isRelationEditJobActive(draft.editId)) {
        return { ok: true, action: 'finish', scope, editId: draft.editId, status: draft.status };
      }
      // 确定性失败（正文/元数据在编辑期间变化、chunk 超限等）重试必然再失败，
      // 直接拒绝并提示重建草稿，避免调用方按「沿用 request_id 重试」空转。
      // 例外：正文已经发布（publishedRevision 已登记）时 finish 只做旧索引清理，
      // 与"重试必然再失败"无关，必须放行——否则该状态下 finish/cancel 双双拒绝。
      if (draft.status === 'failed' && draft.retryable === false && !draft.publishedRevision) {
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

/**
 * daemon RPC 客户端超时（按 action 区分）。
 *
 * 不变量：RPC 超时必须 ≥ MCP 工具层 `withTimeout` 的上界（edit/view/finish 用
 * TOOL_TIMEOUT.WRITE=60s，cancel 用 BULK=300s），否则工具层永远等不到结构化结果、
 * 先收到传输层错误。历史上这里直接用了 callDaemon 的默认 120s：cancel 恰恰要做重活
 * （删除最多 MAX_CHUNKS_PER_FILE 条旧索引），300s 的预算在 daemon 路径上永远拿不到。
 */
export function editRelationRpcTimeoutMs(action: EditRelationParams['action']): number {
  // 取"严格大于"工具层：等值会与工具层超时赛跑，谁先触发不确定（RPC 先触发时调用方
  // 拿到的是传输层错误而非可判定的工具超时）。留 30s 余量让工具层成为唯一出口。
  return action === 'cancel' ? 330_000 : 120_000;
}

export async function executeEditRelation(params: EditRelationParams): Promise<Record<string, unknown>> {
  if (shouldUseDaemonClient()) {
    return callDaemon<Record<string, unknown>>('edit-relation', params, editRelationRpcTimeoutMs(params.action));
  }
  return executeEditRelationLocal(params);
}
