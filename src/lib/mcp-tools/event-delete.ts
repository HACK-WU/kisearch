/**
 * `ki_event_delete` —— 删除事件
 *
 * 两条护栏原样保留（不因为换成 MCP 就放宽）：
 *   · **未收口默认拒绝**（`EVENT_NOT_CLOSED`）：收口前成员文档还挂在事件上，直接删会让它们变成悬空；
 *   · **`doc_action` 必填、无默认**：删事件必然要决定关联文档去向（保留 / 进回收站），
 *     默认 trash 等于让 AI 一次误判就丢文档。
 *
 * 2026-11-18 增补 `force` + `confirm_title`（清理测试 / 废弃事件用）：
 *   · `force` 只开放给**无关联文档**的事件——有成员时必须先收口（`applyTerminalAction`
 *     会把文档与索引一起处理）或先 `ki_event_docs remove` 解绑；
 *   · `confirm_title` 必须与标题逐字一致：逼调用方先把标题读出来，避免按错的 id 删掉别的事件
 *     （与回收站 `PURGE_CONFIRM_MISMATCH` 同一手感）。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { deleteEvent } from '../events/event-service.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { toolError } from './event-create.js';

export function registerEventDeleteTool(server: McpServer): void {
  server.tool(
    'ki_event_delete',
    '删除事件；必须指定关联文档去向（wiki=长期保留 / trash=移入回收站）。未收口事件默认拒绝（先用 ki_event_set_stage 走到终态）；'
      + '清理测试/废弃的**空事件**可传 force + confirm_title（标题逐字一致）',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      event: z.string().describe('事件 id（evt_…）或 #shortId（如 #3）'),
      doc_action: z.enum(['wiki', 'trash']).describe('关联文档去向：wiki=改长期保留（仍可检索）/ trash=移入回收站（7 天内可恢复）'),
      force: z.boolean().optional().describe('强制删除未收口事件（仅清理测试/废弃事件；只对无关联文档的事件生效）'),
      confirm_title: z.string().optional().describe('force 时必填：须与事件标题完全一致（防止删错事件）'),
    },
    async (args) => {
      try {
        const outcome = await withTimeout(
          deleteEvent(args.scope, {
            event: args.event,
            docAction: args.doc_action,
            ...(args.force ? { force: true } : {}),
            ...(args.confirm_title ? { confirmTitle: args.confirm_title } : {}),
          }),
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
          forced: outcome.forced,
          affected: outcome.affected,
          hint: outcome.forced
            ? `未收口事件已强制删除；该事件无关联文档，未改动任何文档与索引（阶段日志、参考文档、AI 分析草稿随事件一并清除）`
            : outcome.docAction === 'trash'
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
