/**
 * `ki_event_edit` —— 事件编辑的**唯一**写工具（2026-11-23 · REQ-20261123-009 · S-02）
 *
 * 合并了原先三个工具（它们已删除，见 git 历史）：
 *   · 关联文档增删 → `action='members'`（add=绑定 / remove=**解绑不删除**）
 *   · 参考文档增删 → `action='references'`（只建引用，不动被引文档的分类与可见性）
 *   · 阶段流转 → `action='stage'`（终态按 `terminalAction` 处理成员文档）
 * 并新增两类：
 *   · `description` 改事件描述（内部取 `revision`，冲突自动重试 1 次）
 *   · `analysis` 上传外部结论（走 `saveExternalAnalysis`，见 S-01）
 *
 * ═══ 为什么单值 action、禁止一次混做 ═══
 * description 写 `{eventId}.json`、analysis 写 `{eventId}.analysis.json`：两个文件、
 * 两把锁、两套乐观锁，**跨文件没有事务**。混做只能"部分成功且不回滚"，AI 拿到半成品
 * 结果后无法判断该重试还是该放弃。所以 schema 上就是单值枚举，字段不匹配即报错。
 *
 * ═══ 三条既有语义一条都不能丢（都是踩过坑的） ═══
 * 1. `members` 的 `remove` 是**解绑**：文档回 wiki、仍可检索，不删除、不进回收站；
 * 2. `references.add` 与「关联文档」冲突时是**整批抛错**，因此逐条调用；
 * 3. `stage` 到终态会按类型设定处理成员文档，`trash` 会把文档移入回收站（不可自动撤销），
 *    且必须回显 `visibility`——否则 AI 会把"搜不到"当成写入失败反复重试。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { bindMembers, unbindMember } from '../events/members.js';
import { addRefs, removeRef } from '../events/refs-service.js';
import { transitionEvent, updateEvent } from '../events/event-service.js';
import { getEventDetail } from '../events/event-detail.js';
import { saveExternalAnalysis } from '../events/analysis-store.js';
import { markExternalConclusionReady } from '../events/analysis-runner.js';
import { scheduleConsume } from '../visibility-queue.js';
import { GovernanceError } from '../governance-errors.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { toolError } from './event-create.js';

const DocRef = z.object({
  group: z.string().describe('Group 路径'),
  name: z.string().describe('文档名（Relation 名）'),
});

const ChainNodeInput = z.object({
  kind: z.enum(['symptom', 'cause', 'root', 'impact', 'fix']).describe('节点类型（数组顺序即阅读顺序）'),
  text: z.string().describe('一句话（≤200 字，不含换行）'),
  ref: z.string().optional().describe('「路径:行号」；必须能在 candidates 内命中，否则点不开'),
  branches: z.array(z.string()).optional().describe('仅 root 可挂：触发条件 / 反例（≤3 条，每条 ≤120 字）'),
});

const CandidateInput = z.object({
  file: z.string().describe('相对分析根目录的路径'),
  line: z.number().int().min(1).describe('起始行号（1 基）'),
  endLine: z.number().int().optional().describe('结束行号（≥ 起始行号）'),
  why: z.string().describe('这处代码为什么是证据（≤200 字）'),
  confidence: z.number().min(0).max(1).optional().describe('0~1；缺省 0.5'),
});

type Action = 'description' | 'analysis' | 'members' | 'references' | 'stage';

/** 每个 action 允许出现的字段（其余字段传了即报错，防"看起来都对但其实没生效"） */
const ALLOWED_FIELDS: Record<Action, readonly string[]> = {
  description: ['description'],
  analysis: ['conclusion', 'chain', 'candidates', 'unconfirmed', 'dataFlow', 'targetDir', 'overwrite', 'skipInvalidCandidates', 'expectedRunId'],
  members: ['docRefs', 'docAction'],
  references: ['docRefs', 'docAction'],
  stage: ['stage', 'note'],
};

const KNOWN_FIELDS = [
  'description', 'conclusion', 'chain', 'candidates', 'unconfirmed', 'dataFlow', 'targetDir',
  'overwrite', 'skipInvalidCandidates', 'expectedRunId', 'docRefs', 'docAction', 'stage', 'note',
] as const;

type EditArgs = {
  scope: string;
  event: string;
  action: Action;
  description?: string;
  conclusion?: string;
  chain?: unknown[];
  candidates?: unknown[];
  unconfirmed?: string[];
  /** 数据链路（多行文本树）：不传 = 这份结论没有链路（覆盖时清空原值） */
  dataFlow?: string;
  targetDir?: string;
  overwrite?: boolean;
  skipInvalidCandidates?: boolean;
  expectedRunId?: string | null;
  docRefs?: Array<{ group: string; name: string }>;
  docAction?: 'add' | 'remove';
  stage?: string;
  note?: string;
};

function ok(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function badArgs(message: string): never {
  throw new Error(message);
}

/**
 * action 与字段的互斥校验。
 *
 * 用普通 `Error`（不是 `GovernanceError`）：这属于**调用方式错误**，不是治理域业务错误，
 * 不该占用错误码号段；`toolError` 会把它转成 `{ok:false, error}` 供 AI 自我纠正。
 */
function assertActionShape(args: EditArgs): void {
  const allowed = ALLOWED_FIELDS[args.action];
  const extra = KNOWN_FIELDS.filter((k) => !allowed.includes(k) && (args as Record<string, unknown>)[k] !== undefined);
  if (extra.length > 0) {
    badArgs(`action=${args.action} 不接受这些字段：${extra.join(', ')}。一次只做一类，请拆成多次调用`);
  }
  switch (args.action) {
    case 'description':
      if (!args.description || !args.description.trim()) badArgs('action=description 需要非空 description');
      return;
    case 'analysis': {
      if (!Array.isArray(args.candidates) || args.candidates.length === 0) {
        badArgs('action=analysis 必须带 candidates（至少 1 条代码位置）：没有位置的结论无法确认');
      }
      if (args.conclusion === undefined && args.chain === undefined) {
        badArgs('action=analysis 至少需要 conclusion 或 chain 之一');
      }
      return;
    }
    case 'members':
    case 'references':
      if (!Array.isArray(args.docRefs) || args.docRefs.length === 0) badArgs(`action=${args.action} 需要 docRefs（1~50 条）`);
      if (!args.docAction) badArgs(`action=${args.action} 需要 docAction（add / remove）`);
      return;
    case 'stage':
      if (!args.stage) badArgs('action=stage 需要 stage（阶段 key 或名称）');
      return;
    default:
      badArgs(`未知 action：${String(args.action)}`);
  }
}

/** 改描述：内部取 revision；冲突时重读一次再试一次（两次都冲突才报错） */
async function handleDescription(args: EditArgs) {
  const write = async (retried: boolean) => {
    const detail = getEventDetail(args.scope, { ref: args.event });
    const rec = await withTimeout(
      updateEvent(args.scope, args.event, { description: args.description!, revision: detail.event.revision }),
      TOOL_TIMEOUT.WRITE,
      'ki_event_edit',
    );
    return { rec, retried };
  };
  let result: { rec: Awaited<ReturnType<typeof updateEvent>>; retried: boolean };
  try {
    result = await write(false);
  } catch (err) {
    if (!(err instanceof GovernanceError) || err.code !== 'REVISION_CONFLICT') throw err;
    result = await write(true);
  }
  return ok({
    ok: true,
    scope: args.scope,
    event: { id: result.rec.id, shortId: `#${result.rec.shortId}` },
    action: 'description',
    revision: result.rec.revision,
    chars: args.description!.trim().length,
    retried: result.retried,
    hint: `描述已更新（${args.description!.trim().length} 字）`,
  });
}

/** 上传外部结论：全部校验/验真/锁在 `saveExternalAnalysis` 里，这里只做转译 */
async function handleAnalysis(args: EditArgs) {
  const detail = getEventDetail(args.scope, { ref: args.event });
  const outcome = await withTimeout(
    /*
     * ★ 必须用**解析后的** `detail.event.id`，不能传 `args.event`。
     * 存储层拿 eventId 当**文件名**（`{eventId}.analysis.json`），而 `args.event` 可能是
     * `#5` 这种引用串 —— 结果写出 `#5.analysis.json`，前端按 `evt_…` 读永远读不到
     * （2026-11-23 真机：#5 连传三次全部落在 `#5.analysis.json`，页面上一条结论都看不到）。
     * 服务层的事件存在性校验能过（`findEventIn` 支持 `#N`），所以这条错误不会被它拦下。
     */
    saveExternalAnalysis(args.scope, detail.event.id, {
      ...(args.conclusion !== undefined ? { conclusion: args.conclusion } : {}),
      ...(args.chain !== undefined ? { chain: args.chain } : {}),
      candidates: args.candidates,
      ...(args.unconfirmed !== undefined ? { unconfirmed: args.unconfirmed } : {}),
      ...(args.dataFlow !== undefined ? { dataFlow: args.dataFlow } : {}),
      ...(args.targetDir !== undefined ? { targetDir: args.targetDir } : {}),
      ...(args.overwrite !== undefined ? { overwrite: args.overwrite } : {}),
      ...(args.skipInvalidCandidates !== undefined ? { skipInvalidCandidates: args.skipInvalidCandidates } : {}),
      ...(args.expectedRunId !== undefined ? { expectedRunId: args.expectedRunId } : {}),
      sourceClient: 'mcp',
    }),
    TOOL_TIMEOUT.WRITE,
    'ki_event_edit',
  );
  const draft = outcome.doc.draft!;
  /*
   * 列表可见性（走查 #2）：外部上传不经过分析器，不补这条标记的话事件列表永远
   * 看不出「有新结论」。写失败不该影响上传结果 —— 它只是列表提示，故单独 try/catch。
   */
  try {
    markExternalConclusionReady(args.scope, detail.event.id, draft.runId, draft.importedAt ?? Date.now());
  } catch {
    // 列表提示失败不影响结论已落盘
  }
  const parts = [
    `结论已上传（${draft.chain.length} 节点）`,
    `${outcome.autoConfirmed} 处代码位置已直接生效（无需人工确认）`,
    `累计已确认位置 ${outcome.doc.confirmed.length} 处`,
  ];
  if (outcome.overwritten) parts.push('已覆盖上一份结论（不可恢复）');
  if (outcome.dropped.length > 0) parts.push(`剔除 ${outcome.dropped.length} 条验真失败的位置`);
  return ok({
    ok: true,
    scope: args.scope,
    /*
     * `detail.event.shortId` 已经是**展示串**（`#5`），再拼一次会得到 `##5`
     * （2026-11-23 真机踩到：回执里出现双井号，AI 会以为编号错了）。
     * 服务层 `EventRecord.shortId` 才是 number，两处不能混用。
     */
    event: {
      id: detail.event.id,
      shortId: String(detail.event.shortId).startsWith('#')
        ? String(detail.event.shortId)
        : `#${detail.event.shortId}`,
    },
    action: 'analysis',
    runId: draft.runId,
    source: 'external',
    importedAt: draft.importedAt,
    overwritten: outcome.overwritten,
    nodes: draft.chain.length,
    autoConfirmed: outcome.autoConfirmed,
    dropped: outcome.dropped,
    unconfirmed: draft.unconfirmed.length,
    confirmedKept: outcome.doc.confirmed.length,
    // 候选已直接生效（autoConfirmed），不再提示「页面确认新候选位置」—— 没有候选可确认了
    hint: parts.join('；'),
  });
}

/** 关联文档：add 走批量（服务层给 skipped/failed 报告），remove 逐条（一条失败不影响其他） */
async function handleMembers(args: EditArgs) {
  const docs = args.docRefs!;
  if (args.docAction === 'add') {
    const result = await withTimeout(
      bindMembers(args.scope, args.event, { docs, by: 'ai' }),
      TOOL_TIMEOUT.WRITE,
      'ki_event_edit',
    );
    if (result.pending.length > 0) void scheduleConsume(args.scope);
    const parts = [`已挂上 ${result.bound.length} 篇`];
    if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 篇（已在本事件或重复提交）`);
    if (result.failed.length > 0) parts.push(`${result.failed.length} 篇被拒：${result.failed[0]!.error}`);
    if (result.visibilityFailed.length > 0) parts.push(`⚠ ${result.visibilityFailed.length} 篇索引未能摘除，仍可能被检索到`);
    if (result.visibility.mode === 'hidden') parts.push('当前阶段不可检索：语义与全文都搜不到，这是阶段设计的预期行为（不是写入失败）');
    else if (result.visibility.mode === 'fts-only') parts.push('当前阶段仅全文可命中：语义检索不会召回，这是预期行为');
    else parts.push('当前阶段语义与全文都可检索');
    return ok({
      ok: true,
      scope: args.scope,
      event: { id: result.event.id, shortId: `#${result.event.shortId}` },
      action: 'members',
      docAction: 'add',
      bound: result.bound,
      skipped: result.skipped,
      failed: result.failed,
      ...(result.visibilityFailed.length > 0 ? { visibilityFailed: result.visibilityFailed } : {}),
      visibility: result.visibility,
      ...(result.pending.length > 0 ? { indexPending: result.pending } : {}),
      hint: parts.join('；'),
    });
  }

  const removed: Array<{ group: string; name: string }> = [];
  const failed: Array<{ group: string; name: string; code: string; error: string }> = [];
  let pending: string[] = [];
  let lastEvent: { id: string; shortId: number } | null = null;
  for (const doc of docs) {
    try {
      const res = await withTimeout(
        unbindMember(args.scope, args.event, doc.group, doc.name),
        TOOL_TIMEOUT.WRITE,
        'ki_event_edit',
      );
      removed.push(res.removed);
      // 逐条累加（只留最后一次会漏报前面的索引补齐项）
      if (res.pending.length > 0) pending = [...new Set([...pending, ...res.pending])];
      lastEvent = { id: res.event.id, shortId: res.event.shortId };
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'UNBIND_FAILED';
      failed.push({ ...doc, code, error: (err as Error).message });
      const parsed = (err as { details?: { event?: { id?: string; shortId?: number } } }).details?.event;
      if (!lastEvent && parsed?.id && typeof parsed.shortId === 'number') {
        lastEvent = { id: parsed.id, shortId: parsed.shortId };
      }
    }
  }
  if (pending.length > 0) void scheduleConsume(args.scope);
  return ok({
    ok: true,
    scope: args.scope,
    event: lastEvent ? { id: lastEvent.id, shortId: `#${lastEvent.shortId}` } : { ref: args.event },
    action: 'members',
    docAction: 'remove',
    removed,
    failed,
    ...(pending.length > 0 ? { indexPending: pending } : {}),
    hint: `已解绑 ${removed.length} 篇（文档回长期保留，仍可被检索）`
      + (failed.length > 0 ? `；${failed.length} 篇失败：${failed[0]!.error}` : '')
      + (pending.length > 0 ? `；索引补齐中，数秒后生效` : ''),
  });
}

/** 参考文档：逐条调用（整批会在一条冲突时带走全部） */
async function handleReferences(args: EditArgs) {
  const docs = args.docRefs!;
  if (args.docAction === 'add') {
    const added: Array<{ group: string; name: string }> = [];
    const skipped: Array<{ group: string; name: string; reason: 'duplicate' | 'already-associated' }> = [];
    const failed: Array<{ group: string; name: string; code: string; error: string }> = [];
    for (const doc of docs) {
      try {
        const res = await withTimeout(
          Promise.resolve().then(() => addRefs(args.scope, args.event, { docs: [doc], addedBy: 'ai' })),
          TOOL_TIMEOUT.WRITE,
          'ki_event_edit',
        );
        if (res.added > 0) added.push(doc);
        for (const _dup of res.skipped) skipped.push({ group: doc.group, name: doc.name, reason: 'duplicate' });
      } catch (err) {
        const code = (err as { code?: string }).code ?? 'REF_ADD_FAILED';
        if (code === 'REF_ALREADY_ADDED') skipped.push({ group: doc.group, name: doc.name, reason: 'duplicate' });
        else if (code === 'REF_ALREADY_ASSOCIATED') skipped.push({ group: doc.group, name: doc.name, reason: 'already-associated' });
        else failed.push({ ...doc, code, error: (err as Error).message });
      }
    }
    return ok({
      ok: true,
      scope: args.scope,
      event: { ref: args.event },
      action: 'references',
      docAction: 'add',
      added: added.length,
      addedList: added,
      skipped,
      failed,
      hint: `已加入 ${added.length} 条参考文档`
        + (skipped.length > 0 ? `；跳过 ${skipped.length} 条（重复或已作为关联文档）` : '')
        + (failed.length > 0 ? `；${failed.length} 条失败：${failed[0]!.error}` : '')
        + '；被引文档的分类与可见性未做任何改动',
    });
  }

  const removed: Array<{ group: string; name: string }> = [];
  const failed: Array<{ group: string; name: string; code: string; error: string }> = [];
  for (const doc of docs) {
    try {
      await withTimeout(
        Promise.resolve().then(() => removeRef(args.scope, args.event, { group: doc.group, name: doc.name })),
        TOOL_TIMEOUT.WRITE,
        'ki_event_edit',
      );
      removed.push(doc);
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'REF_REMOVE_FAILED';
      failed.push({ ...doc, code, error: (err as Error).message });
    }
  }
  return ok({
    ok: true,
    scope: args.scope,
    event: { ref: args.event },
    action: 'references',
    docAction: 'remove',
    removed,
    failed,
    hint: `已移除 ${removed.length} 条参考文档`
      + (failed.length > 0 ? `；${failed.length} 条失败：${failed[0]!.error}` : '')
      + '；被引文档本身未做任何改动',
  });
}

/** 阶段流转：终态按 `terminalAction` 处理成员文档，必须回显 visibility 与去向 */
async function handleStage(args: EditArgs) {
  const outcome = await withTimeout(
    transitionEvent(args.scope, {
      event: args.event,
      stage: args.stage!,
      ...(args.note ? { note: args.note } : {}),
      by: 'ai',
    }),
    TOOL_TIMEOUT.WRITE,
    'ki_event_edit',
  );
  /*
   * `from` / `to` 是 `{key,name,index}`、`affected` 是 `{docs,failed}`（`event-service.ts:476-484`）。
   * 直接插值对象会得到 `[object Object]`（2026-11-23 真机踩到：hint 显示
   * 「已流转：[object Object] → [object Object]」），必须取 `.name` / `.docs`。
   */
  const docsMoved = outcome.affected.docs;
  const parts = [`已流转：${outcome.from.name} → ${outcome.to.name}`];
  if (outcome.closed) {
    parts.push(outcome.terminalAction === 'trash'
      ? `事件已收口：${docsMoved} 篇关联文档已移入回收站（可恢复，但不会自动撤销）`
      : `事件已收口：${docsMoved} 篇关联文档回到长期保留`);
  } else if (docsMoved > 0) {
    parts.push(`可见性已按新阶段调整（${docsMoved} 篇）`);
  }
  if (outcome.visibility.mode === 'hidden') parts.push('当前阶段不可检索：语义与全文都搜不到，这是阶段设计的预期行为（不是写入失败）');
  else if (outcome.visibility.mode === 'fts-only') parts.push('当前阶段仅全文可命中：语义检索不会召回，这是预期行为');
  if (outcome.pending.length > 0) parts.push('索引调整补齐中，数秒后生效');
  return ok({
    ok: true,
    scope: args.scope,
    event: { id: outcome.event.id, shortId: `#${outcome.event.shortId}`, title: outcome.event.title },
    action: 'stage',
    from: outcome.from,
    to: outcome.to,
    closed: outcome.closed,
    ...(outcome.terminalAction ? { terminalAction: outcome.terminalAction } : {}),
    affected: outcome.affected,
    visibility: outcome.visibility,
    ...(outcome.pending.length > 0 ? { indexPending: outcome.pending } : {}),
    ...(outcome.logWarning ? { logWarning: outcome.logWarning } : {}),
    hint: parts.join('；'),
  });
}

export function registerEventEditTool(server: McpServer): void {
  server.tool(
    'ki_event_edit',
    '编辑事件：description=改描述 / analysis=上传结论与数据链路 / members=挂或解绑关联文档 / references=增删参考文档 / stage=流转阶段。'
      + '一次只做一类（单值 action，字段不匹配即报错）；analysis 必须带 candidates。'
      + '注意：members 的 remove 只是解绑（文档仍可检索、不删除）；stage 到终态会按类型设定处理关联文档，trash 类型会把文档移入回收站（不可自动撤销）。',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）或 #shortId（如 #3）'),
      action: z.enum(['description', 'analysis', 'members', 'references', 'stage']).describe(
        '要做的唯一一类操作：description / analysis / members / references / stage',
      ),
      description: z.string().optional().describe('[description] 事件描述，≤4000 字'),
      conclusion: z.string().optional().describe('[analysis] 一句话结论（≤4000 字）'),
      chain: z.array(ChainNodeInput).optional().describe('[analysis] 因果链（≤5 节点，顺序即阅读顺序）'),
      candidates: z.array(CandidateInput).optional().describe('[analysis] 代码位置（必填，≥1；服务端逐条验真）'),
      unconfirmed: z.array(z.string()).optional().describe('[analysis] 未确认点（≤20 条 × ≤300 字）'),
      dataFlow: z.string().optional().describe(
        '[analysis] 数据链路（多行文本树，≤40 行 / ≤3000 字）；不传表示这份结论没有链路',
      ),
      targetDir: z.string().optional().describe('[analysis] 必须等于分析配置根目录'),
      overwrite: z.boolean().optional().describe('[analysis] 覆盖已有 AI 结论必须传 true（不可恢复）'),
      skipInvalidCandidates: z.boolean().optional().describe('[analysis] 剔除验真失败的位置（默认 false=整批失败）'),
      expectedRunId: z.string().nullable().optional().describe('[analysis] 并发闸门：期望的当前 runId；null=期望没有草稿'),
      docRefs: z.array(DocRef).min(1).max(50).optional().describe('[members/references] 文档清单（≤50）'),
      docAction: z.enum(['add', 'remove']).optional().describe('[members/references] add / remove'),
      stage: z.string().optional().describe('[stage] 目标阶段：key（st_3）或名称（如「已定位」）'),
      note: z.string().optional().describe('[stage] 可选备注，落流转日志'),
    },
    async (args) => {
      try {
        assertActionShape(args as EditArgs);
        const a = args as EditArgs;
        switch (a.action) {
          case 'description':
            return await handleDescription(a);
          case 'analysis':
            return await handleAnalysis(a);
          case 'members':
            return await handleMembers(a);
          case 'references':
            return await handleReferences(a);
          case 'stage':
            return await handleStage(a);
          default:
            return badArgs(`未知 action：${String(a.action)}`);
        }
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
