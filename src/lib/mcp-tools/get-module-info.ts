import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeGetModuleInfo } from '../../get-module-info.js';

export function registerGetModuleInfoTool(server: McpServer): void {
  server.tool(
    'ki_get_module_info',
    '读取指定 Group 下某个 Relation 的本地 KB Markdown 内容',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      group: z.string().describe('Group 路径（支持向量语义兜底）'),
      relation: z.string().describe('Relation 名称（精确匹配）'),
    },
    async (args) => {
      try {
        const result = await executeGetModuleInfo({
          scope: args.scope,
          group: args.group,
          relation: args.relation,
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
