/**
 * `ki_event_list` —— 事件枚举（只读）
 *
 * 分页与限额是硬要求（R42）：事件可能上百，每条的关联文档可能几十篇。
 * 不限的话一次返回几百 KB，AI 上下文直接被吃掉，而它通常只需要"最近 3 个未收口事件"。
 *
 *   - `limit` 默认 20 / 上限 100，配 `offset`，返回 `total` 与 `hasMore`；
 *   - 每个事件的 `docsPreview` 默认 3 条 / 上限 10（`docsPreviewLimit`），
 *     配 `memberTotal` 让 AI 知道"还有多少没显示"。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listEvents } from '../events/event-service.js';
import { readAnalysisDocRaw } from '../events/analysis-store.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerEventListTool(server: McpServer): void {
  server.tool(
    'ki_event_list',
    '列出事件（分页）：id / #shortId / 标题 / 类型 / 当前阶段 / 可见性 / 关联文档预览 / 已确认代码位置预览；只读，创建事件用 ki_event_create',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
      status: z.enum(['open', 'closed', 'all']).optional().default('open').describe('筛选：未收口（默认）/ 已收口 / 全部'),
      type: z.string().optional().describe('按事件类型 id 筛选（如 et_1）；可先调 ki_event_type_list 获取'),
      q: z.string().optional().describe('按标题或 #shortId 模糊匹配'),
      limit: z.number().int().min(1).max(100).optional().default(20).describe('每页条数，默认 20，上限 100'),
      offset: z.number().int().min(0).optional().default(0).describe('偏移量'),
      docs_preview_limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(3)
        .describe('每个事件返回的关联文档名条数，默认 3，上限 10'),
      locations_preview_limit: z
        .number()
        .int()
        .min(1)
        .max(10)
        .optional()
        .default(5)
        .describe('每个事件返回的已确认代码位置条数，默认 5，上限 10'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          Promise.resolve().then(() => listEvents(args.scope, {
            status: args.status,
            ...(args.type ? { typeId: args.type } : {}),
            ...(args.q ? { q: args.q } : {}),
            limit: args.limit,
            offset: args.offset,
            docsPreviewLimit: args.docs_preview_limit,
          })),
          TOOL_TIMEOUT.READ,
          'ki_event_list',
        );

        const locLimit = args.locations_preview_limit;
        const payload = {
          ok: true,
          scope: args.scope,
          total: result.total,
          hasMore: result.hasMore,
          count: result.items.length,
          events: result.items.map((item) => {
            const analysis = readAnalysisDocRaw(args.scope, item.event.id);
            const confirmed = analysis.confirmed;
            return {
              id: item.event.id,
              shortId: `#${item.event.shortId}`,
              title: item.event.title,
              ...(item.event.description ? { description: item.event.description } : {}),
              type: item.type ? { id: item.type.id, name: item.type.name } : null,
              stage: { key: item.stage.key, name: item.stage.name, index: item.stage.index },
              visibility: item.stage.visibility,
              closed: item.event.closedAt !== null,
              ...(item.event.closedAt ? { closedAt: item.event.closedAt } : {}),
              memberTotal: item.memberTotal,
              docsPreview: item.members.map((m) => ({ group: m.group, name: m.name })),
              ...(item.memberTotal > item.members.length
                ? { docsPreviewNote: `仅显示前 ${item.members.length} 篇，共 ${item.memberTotal} 篇` }
                : {}),
              ...(analysis.draft?.conclusion
          ? {
            conclusionPreview: analysis.draft.conclusion.length > 120
              ? `${analysis.draft.conclusion.slice(0, 120)}…`
              : analysis.draft.conclusion,
          }
          : {}),
        codeLocationTotal: confirmed.length,
              codeLocationsPreview: confirmed.slice(0, locLimit).map((c) => ({
                file: c.file,
                line: c.line,
                ...(c.endLine !== undefined ? { endLine: c.endLine } : {}),
                why: c.why.length > 160 ? `${c.why.slice(0, 160)}…` : c.why,
                commit: c.commit,
              })),
            };
          }),
          hint: '绑定文档用 ki_sync_relation 的 event 参数（传 id 或 #shortId）；绑定已收口事件会被拒绝',
        };

        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ ok: false, error: (err as Error).message }, null, 2) }],
        };
      }
    },
  );
}
