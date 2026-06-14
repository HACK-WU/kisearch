import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeSearch } from '../../search.js';

export function registerSearchTool(server: McpServer): void {
  server.tool(
    'ki_search',
    '语义检索知识库内容',
    {
      scope: z.string().describe('项目隔离标识'),
      query: z.string().describe('自然语言查询文本'),
      limit: z.number().int().positive().optional().default(10).describe('返回条数上限'),
      threshold: z.number().min(0).max(1).optional().describe('相似度阈值（0-1）'),
      tags: z.string().optional().default('ki-search').describe('过滤标签（默认 ki-search）'),
    },
    async (args) => {
      try {
        const result = executeSearch({
          scope: args.scope,
          query: args.query,
          limit: args.limit,
          threshold: args.threshold,
          tags: args.tags,
        });
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
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
