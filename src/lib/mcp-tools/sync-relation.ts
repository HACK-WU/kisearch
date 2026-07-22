import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeSyncRelation } from '../../sync-relation.js';

export function registerSyncRelationTool(server: McpServer): void {
  server.tool(
    'ki_sync_relation',
    '写入/更新 Relation + 关键词 + 本地 KB（自动补建 Group 树）',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      group: z.string().describe('Group 路径（支持 / 层级嵌套）'),
      relation: z.string().describe('Relation 名称'),
      module_info: z.string().describe('本地 KB Markdown 内容'),
      keywords: z.array(z.string()).describe('关键词列表'),
    },
    async (args) => {
      try {
        const result = await executeSyncRelation({
          scope: args.scope,
          group: args.group,
          relation: args.relation,
          moduleInfo: args.module_info,
          keywords: args.keywords,
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
