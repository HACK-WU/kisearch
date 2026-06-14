import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeQueryGroup } from '../../query-group.js';

export function registerQueryGroupTool(server: McpServer): void {
  server.tool(
    'ki_query_group',
    '查询 Group 树 + Relations + 词云，支持向量语义兜底',
    {
      scope: z.string().describe('项目隔离标识'),
      groups: z.string().optional().describe('逗号分隔的 Group 路径列表（支持模糊匹配）'),
      hot_count: z.number().int().positive().optional().default(5).describe('热门展示个数'),
      depth: z.number().int().min(1).max(10).optional().default(4).describe('索引层级深度'),
      mode: z.string().optional().default('hot')
        .describe('展示分区：hot|warm|cold|emerging|full（支持逗号分隔）'),
    },
    async (args) => {
      try {
        const result = executeQueryGroup({
          scope: args.scope,
          groupsParam: args.groups,
          hotCount: args.hot_count ?? 5,
          depth: args.depth ?? 4,
          modes: (args.mode ?? 'hot').split(',').map(m => m.trim()),
        });
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    }
  );
}
