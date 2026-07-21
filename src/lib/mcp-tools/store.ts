import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeStore } from '../../store.js';

export function registerStoreTool(server: McpServer): void {
  server.tool(
    'ki_store',
    '存储文本到向量索引',
    {
      scope: z.string().describe('项目隔离标识'),
      text: z.string().describe('待向量化文本'),
      tags: z.string().optional().default('ki-search').describe('逗号分隔 tags'),
    },
    async (args) => {
      try {
        const result = await executeStore({
          scope: args.scope,
          text: args.text,
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
