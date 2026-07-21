import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeBulkStore } from '../../bulk-store.js';

export function registerBulkStoreTool(server: McpServer): void {
  server.tool(
    'ki_bulk_store',
    '批量存储文本到向量索引',
    {
      scope: z.string().describe('项目隔离标识'),
      input: z.string().describe('批量数据 JSON 文件路径'),
    },
    async (args) => {
      try {
        const result = await executeBulkStore({
          scope: args.scope,
          inputFile: args.input,
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
