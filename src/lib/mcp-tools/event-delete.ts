/**
 * `ki_event_delete` —— 删除已收口事件
 *
 * 两条护栏原样保留（不因为换成 MCP 就放宽）：
 *   · **未收口拒绝**（`EVENT_NOT_CLOSED`）：收口前成员文档还挂在事件上，直接删会让它们变成悬空；
 *   · **`doc_action` 必填、无默认**：删事件必然要决定关联文档去向（保留 / 进回收站），
 *     默认 trash 等于让 AI 一次误判就丢文档。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteEvent } from '../events/event-service.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { toolError } from './event-create.js';

export function registerEventDeleteTool(server: McpServer): void {
  server.tool(
    'ki_event_delete',
    '删除已收口的事件；必须指定关联文档去向（wiki=长期保留 / trash=移入回收站）。未收口事件请先用 ki_event_set_stage 走到终态',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）或 #shortId（如 #3）'),
      doc_action: z.enum(['wiki', 'trash']).describe('关联文档去向：wiki=改长期保留（仍可检索）/ trash=移入回收站（7 天内可恢复）'),
    },
    async (args) => {
      try {
        const outcome = await withTimeout(
          deleteEvent(args.scope, { event: args.event, docAction: args.doc_action }),
          TOOL_TIMEOUT.WRITE,
          'ki_event_delete',
        );

        const payload = {
          ok: true,
          scope: args.scope,
          event: {
            id: outcome.event.id,
            shortId: `#${outcome.event.shortId}`,
            title: outcome.event.title,
          },
          docAction: outcome.docAction,
          affected: outcome.affected,
          hint: outcome.docAction === 'trash'
            ? `事件已删除；${outcome.affected.docs} 篇关联文档已移入回收站（7 天内可在回收站页恢复）`
            : `事件已删除；${outcome.affected.docs} 篇关联文档改为长期保留（仍可检索）。参考文档与阶段日志一并清除`,
        };

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return toolError(err);
      }
    },
  );
}
