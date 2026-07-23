import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeTagList } from '../../tag.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerTagListTool(server: McpServer): void {
  server.tool(
    'ki_tag_list',
    '列出指定 scope 下用过的 tag（含文档数，按数量降序，只读）；用于在 ki_search / doc 过滤前发现可用 tag',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeTagList({ scope: args.scope }),
          TOOL_TIMEOUT.READ,
          'ki_tag_list'
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
