import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeBulkStore } from '../../bulk-store.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerBulkStoreTool(server: McpServer): void {
  server.tool(
    'ki_bulk_store',
    '批量存储文本到向量索引',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      input: z.string().describe('批量数据 JSON 文件路径'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeBulkStore({
            scope: args.scope,
            inputFile: args.input,
          }),
          TOOL_TIMEOUT.BULK,
          'ki_bulk_store'
        );
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
