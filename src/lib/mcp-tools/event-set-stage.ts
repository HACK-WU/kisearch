/**
 * `ki_event_set_stage` —— 事件流转（阶段推进）
 *
 * 创建 / 删除事件与两类文档增删见 `ki_event_create` / `ki_event_delete` /
 * `ki_event_docs` / `ki_event_refs`（REQ-20261116-004 起开放）；**事件类型本身**
 * （阶段链、可见性、收口动作）仍只能在页面增删改 —— 那是元配置，改错会连带所有事件。
 *
 * 三条硬约束（都在服务层兜住，这里只负责转译成 MCP 错误）：
 *   - 目标阶段不存在 / 已停用 / 与当前相同 → 400 语义（`STAGE_NOT_FOUND` / `STAGE_DISABLED` / `STAGE_UNCHANGED`）；
 *   - 事件已收口 → `EVENT_CLOSED`（收口时成员已按终态动作处理，再流转会"文档已不在、事件又活过来"）；
 *   - 到达终态 → 按类型级 `terminalAction` 处理成员文档（keep 回 wiki / trash 进回收站）。
 *
 * 返回值必须回显 `visibility`：AI 若看到 `fts-only` 就应知道"语义检索搜不到是预期行为"，
 * 否则它会把正常行为当成写入失败并反复重试。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { transitionEvent } from '../events/event-service.js';
import { GovernanceError } from '../governance-errors.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerEventSetStageTool(server: McpServer): void {
  server.tool(
    'ki_event_set_stage',
    '把事件流转到指定阶段（唯一的状态写工具）；到终态阶段会按类型设定的收口动作处理关联文档',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）或 #shortId（如 #3）'),
      stage: z.string().describe('目标阶段：阶段 key（st_3）或阶段名（如「已定位」）'),
      note: z.string().optional().describe('可选备注，落流转日志'),
    },
    async (args) => {
      try {
        const outcome = await withTimeout(
          transitionEvent(args.scope, {
            event: args.event,
            stage: args.stage,
            ...(args.note ? { note: args.note } : {}),
            by: 'ai',
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_event_set_stage',
        );

        const payload = {
          ok: true,
          scope: args.scope,
          event: {
            id: outcome.event.id,
            shortId: `#${outcome.event.shortId}`,
            title: outcome.event.title,
          },
          from: outcome.from,
          to: outcome.to,
          closed: outcome.closed,
          ...(outcome.terminalAction ? { terminalAction: outcome.terminalAction } : {}),
          affected: outcome.affected,
          visibility: outcome.visibility,
          ...(outcome.pending.length > 0 ? { indexPending: outcome.pending } : {}),
          ...(outcome.logWarning ? { logWarning: outcome.logWarning } : {}),
          hint: buildHint(outcome),
        };

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
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
    },
  );
}

/** 按目标档位给出「为什么搜不到 / 为什么能搜到」的可读解释 */
function buildHint(outcome: Awaited<ReturnType<typeof transitionEvent>>): string {
  const parts: string[] = [];
  if (outcome.visibility.mode === 'hidden') {
    parts.push('当前阶段不可检索：语义与全文都查不到这批判文档，这是阶段设计的预期行为，不是写入失败；按名读取用 ki_get_module_info');
  } else if (outcome.visibility.mode === 'fts-only') {
    parts.push('当前阶段仅全文可命中：语义检索不会召回，关键词检索用 ki_search(mode=fulltext)，按名读取用 ki_get_module_info');
  } else {
    parts.push('当前阶段语义与全文都可检索');
  }
  if (outcome.closed) {
    parts.push(
      outcome.terminalAction === 'trash'
        ? `事件已收口，${outcome.affected.docs} 篇关联文档已移入回收站（可在页面恢复）`
        : `事件已收口，${outcome.affected.docs} 篇关联文档已改为长期保留并解除绑定`,
    );
  }
  if (outcome.affected.failed > 0) {
    parts.push(`有 ${outcome.affected.failed} 篇文档处理失败，需在页面重试`);
  }
  if (outcome.pending.length > 0) {
    parts.push(`索引重建中（${outcome.pending.join(' / ')}），数秒后生效`);
  }
  return parts.join('；');
}
