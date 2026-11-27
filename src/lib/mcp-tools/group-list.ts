import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { queryGroupByScope, VIEW_TOTAL_TIMEOUT } from '../group-list-view.js';
import { TOOL_TIMEOUT } from './util.js';

export function registerGroupListTool(server: McpServer): void {
  server.tool(
    'ki_group_list',
    '列出 Group 树 + Relations，支持 hot/warm/cold/emerging/full 分区与向量语义兜底',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（视图会自动展开为成员库并按库分桶；省略则用 default；strict 模式下必须传且须在白名单内）'),
      groups: z.string().optional().describe('逗号分隔的 Group 路径列表（支持模糊匹配），展示各 Group 的 Relations（与 subtree 互斥）'),
      group: z.string().optional().describe('groups 的单数别名（两者同时传时以 groups 为准）'),
      subtree: z.string().optional().describe('以指定 Group 路径为根输出子树结构（结构导航视角，支持模糊匹配；与 groups 互斥）'),
      hot_count: z.number().int().positive().optional().default(5).describe('热门展示个数'),
      depth: z.number().int().min(1).max(10).optional().default(4).describe('索引层级深度'),
      mode: z.string().optional().default('hot')
        .describe('展示分区：hot|warm|cold|emerging|full（支持逗号分隔）'),
      auto_fallback: z.boolean().optional().default(true)
        .describe('是否启用语义兜底（默认开启）'),
    },
    async (args) => {
      try {
        /**
         * 视图展开统一交给 `queryGroupByScope`（CLI / 对话侧共用同一实现）：
         * 两个库都有 `projects` 时各自一棵树 —— 合并后 Agent 无法判断文档属于哪个库。
         */
        const outcome = await queryGroupByScope(args.scope, {
          groupsParam: args.groups ?? args.group,
          subtreeParam: args.subtree,
          hotCount: args.hot_count ?? 5,
          depth: args.depth ?? 4,
          modes: (args.mode ?? 'hot').split(',').map(m => m.trim()),
          autoFallback: args.auto_fallback,
          // 单成员 30s + 整体 50s：MCP 客户端 tools/call 硬超时 60s，超过后客户端先失败
          timeout: { ms: TOOL_TIMEOUT.READ, label: 'ki_group_list', totalMs: VIEW_TOTAL_TIMEOUT.MCP },
        });

        if (outcome.kind === 'single') {
          if (outcome.result.ok) {
            return {
              content: [{ type: 'text', text: outcome.result.output }],
            };
          }
          return {
            isError: true,
            content: [{ type: 'text', text: outcome.result.error }],
          };
        }

        if (outcome.kind === 'view-empty') {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                view: outcome.view,
                error: `视图 ${outcome.view} 没有可用的成员库`,
                skipped: outcome.skipped,
              }, null, 2),
            }],
          };
        }

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              ok: true,
              view: outcome.view,
              members: outcome.members,
              memberTotal: outcome.memberTotal,
              buckets: outcome.buckets,
              ...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    },
  );
}
