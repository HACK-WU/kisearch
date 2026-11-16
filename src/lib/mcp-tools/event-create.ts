/**
 * `ki_event_create` —— 创建事件（可同时挂关联文档与参考文档）
 *
 * 为什么把 docs / refs 放进创建入参而不是让 AI 建完再调两次：
 * 一次事务能给出完整绑定报告（哪些挂上、哪些被拒为什么），也避免"事件建成、文档没挂上"
 * 的半成品状态需要第二次调用才发现。
 *
 * `type` / `stage` 同时接受 id/key 与名称：AI 直接说「bug 排查 / 排查中」即可，
 * 少一次 `ki_event_type_list` 往返，也避免它抄错 key；歧义时不猜，返回可选清单。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createEventWithBinding } from '../events/event-service.js';
import { listTypes } from '../events/type-service.js';
import { GovernanceError } from '../governance-errors.js';
import { scheduleConsume } from '../visibility-queue.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

const DocRef = z.object({
  group: z.string().describe('Group 路径（如 wiki/登录）'),
  name: z.string().describe('文档名（Relation 名）'),
});

export function registerEventCreateTool(server: McpServer): void {
  server.tool(
    'ki_event_create',
    '创建事件；可同时挂关联文档（docs，分类变 event、可见性随阶段）与参考文档（refs，只建引用）',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      title: z.string().describe('事件标题（如「登录页白屏」）'),
      description: z.string().optional().describe('事件描述（可选，会注入 AI 分析上下文，≤4000 字）'),
      type: z.string().describe('事件类型：id（et_1）或名称（如「bug 排查」）；可先调 ki_event_type_list'),
      stage: z.string().optional().describe('起始阶段：key（st_1）或名称（如「排查中」）；缺省首阶段'),
      docs: z.array(DocRef).max(50).optional().describe('初始关联文档（≤50 篇）'),
      refs: z.array(DocRef).max(50).optional().describe('初始参考文档（≤50 条）'),
    },
    async (args) => {
      try {
        const types = listTypes(args.scope);
        const wanted = args.type.trim();
        const byId = types.filter((t) => t.id === wanted);
        // 名称匹配允许多条命中（自定义类型可与内置同名）：此时**不猜**，报错让 AI 改传 id
        const byName = byId.length > 0 ? [] : types.filter((t) => t.name === wanted);
        if (byName.length > 1) {
          throw new GovernanceError('TYPE_NOT_FOUND', `类型名「${wanted}」对应 ${byName.length} 个类型，请改传 id`, {
            available: byName.map((t) => ({ id: t.id, name: t.name, builtin: t.builtin })),
          });
        }
        const type = byId[0] ?? byName[0];
        if (!type) {
          throw new GovernanceError('TYPE_NOT_FOUND', `事件类型「${args.type}」不存在`, {
            available: types.map((t) => ({ id: t.id, name: t.name, builtin: t.builtin })),
          });
        }

        const outcome = await withTimeout(
          createEventWithBinding(args.scope, {
            title: args.title,
            ...(args.description !== undefined ? { description: args.description } : {}),
            typeId: type.id,
            ...(args.stage ? { stageKey: args.stage } : {}),
            ...(args.docs ? { docs: args.docs } : {}),
            ...(args.refs ? { refs: args.refs } : {}),
            by: 'ai',
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_event_create',
        );
        if (outcome.pending.length > 0) void scheduleConsume(args.scope);

        const payload = {
          ok: true,
          scope: args.scope,
          event: {
            id: outcome.event.id,
            shortId: `#${outcome.event.shortId}`,
            title: outcome.event.title,
            type: { id: type.id, name: type.name },
            stage: {
              key: outcome.event.stageKey,
              name: type.stages.find((s) => s.key === outcome.event.stageKey)?.name ?? outcome.event.stageKey,
            },
            closed: false,
          },
          binding: outcome.binding,
          visibility: outcome.visibility,
          ...(outcome.pending.length > 0 ? { indexPending: outcome.pending } : {}),
          hint: buildHint(outcome.visibility, outcome.binding, outcome.pending),
        };

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}

function buildHint(
  visibility: { mode: string },
  binding: {
    docs: { bound: unknown[]; failed: Array<{ error: string }>; visibilityFailed: unknown[] };
    refs: { added: number; failed: unknown[] };
  },
  pending: string[],
): string {
  const parts: string[] = [];
  parts.push(`关联 ${binding.docs.bound.length} 篇、参考 ${binding.refs.added} 篇`);
  if (binding.docs.failed.length > 0) {
    parts.push(`${binding.docs.failed.length} 篇关联文档被拒：${binding.docs.failed[0].error}`);
  }
  if (binding.refs.failed.length > 0) parts.push(`${binding.refs.failed.length} 条参考文档失败`);
  if (binding.docs.visibilityFailed.length > 0) {
    parts.push(`⚠ ${binding.docs.visibilityFailed.length} 篇索引未能摘除，仍可能被检索到`);
  }
  if (visibility.mode === 'hidden') {
    parts.push('当前阶段不可检索：语义与全文都搜不到，这是阶段设计的预期行为；推进阶段用 ki_event_set_stage');
  } else if (visibility.mode === 'fts-only') {
    parts.push('当前阶段仅全文可命中：语义检索不会召回，这是预期行为');
  } else {
    parts.push('当前阶段语义与全文都可检索');
  }
  if (pending.length > 0) parts.push(`索引补齐中（${pending.join(' / ')}），数秒后生效`);
  return parts.join('；');
}

export function toolError(err: unknown): { isError: true; content: Array<{ type: 'text'; text: string }> } {
  if (err instanceof GovernanceError) {
    return {
      isError: true,
      content: [{
        type: 'text',
        text: JSON.stringify({
          ok: false,
          code: err.code,
          error: err.message,
          ...(err.details ? { details: err.details } : {}),
        }, null, 2),
      }],
    };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (err as Error).message }, null, 2) }],
  };
}
