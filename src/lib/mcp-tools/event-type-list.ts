/**
 * `ki_event_type_list` —— 事件类型枚举（只读）
 *
 * AI 需要它回答两个问题：
 *   ① 「这个事件能流转到哪些阶段」—— `stages` 带 `key` / `name` / `visibility` / `disabled`；
 *   ② 「收口后文档会怎样」—— 类型级 `terminalAction`（keep / trash）。
 *
 * 不返回 `revision` 之外的可变字段：`revision` 仍要给，AI 若后续要改类型（页面侧）可知并发状态。
 * 但**本工具不提供任何写能力**（类型只能由人在页面维护）。
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { listTypes } from '../events/type-service.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerEventTypeListTool(server: McpServer): void {
  server.tool(
    'ki_event_type_list',
    '列出事件类型及其阶段链（每阶段可见性）与收口动作；只读，不能创建或修改类型',
    {
      scope: z.string().optional().default('default').describe('知识库名'),
    },
    async (args) => {
      try {
        const types = await withTimeout(
          Promise.resolve().then(() => listTypes(args.scope)),
          TOOL_TIMEOUT.READ,
          'ki_event_type_list',
        );

        const payload = {
          ok: true,
          scope: args.scope,
          count: types.length,
          types: types.map((type) => ({
            id: type.id,
            name: type.name,
            // 有描述才输出：省略比 "description": undefined 更省 token，也便于 AI 判断「未描述」
            ...(type.description ? { description: type.description } : {}),
            builtin: type.builtin,
            terminalAction: type.terminalAction,
            fallbackDays: type.fallbackDays,
            revision: type.revision,
            stages: type.stages.map((stage, index) => ({
              key: stage.key,
              name: stage.name,
              index,
              visibility: stage.visibility,
              disabled: stage.disabled === true,
              ...(stage.originalName ? { originalName: stage.originalName } : {}),
            })),
          })),
          visibilityLegend: {
            full: '语义 + 全文都可检索',
            'fts-only': '仅全文可命中（语义检索不召回）',
            hidden: '都不可检索，只能按名读取',
          },
          /**
           * `fallbackDays` 是预留字段（事件 #76），刻意单列一句：不写这句，AI 会把
           * 「90 天」当保障转述给用户（"到期会自动收口"是假的，全仓没有清理任务）。
           */
          fallbackDaysNote: '预留字段：当前没有到期清理任务，fallbackDays 配了也不会自动收口',
          hint: '选类型时优先依据 description（说明这类事件装什么），不要只看 name；流转用 ki_event_edit stage（stage 可传阶段 key 或名称）；创建事件用 ki_event_create（type 可传 id 或名称）；类型本身只能在页面增删改',
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
