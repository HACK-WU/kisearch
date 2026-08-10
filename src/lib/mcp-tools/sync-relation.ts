import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeSyncRelation } from '../../sync-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerSyncRelationTool(server: McpServer): void {
  server.tool(
    'ki_sync_relation',
    '写入/更新 Relation + 本地 KB（自动补建 Group 树）',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      group: z.string().describe('Group 路径（支持 / 层级嵌套）'),
      relation: z.string().describe('Relation 名称'),
      module_info: z.string().describe('本地 KB Markdown 内容'),
      vector: z.boolean().optional().default(true).describe('是否写入向量层（ki-search/ki-relation）。false=非向量化：仅写 KB 层（不产生 memoryId，无法被 ki search 召回）'),
      tags: z.string().optional().describe('文档内容自定义标签（逗号分隔多个，叠加在默认 ki-search 之上，如 "api,auth"）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeSyncRelation({
            scope: args.scope,
            group: args.group,
            relation: args.relation,
            moduleInfo: args.module_info,
            vector: args.vector,
            tags: args.tags,
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_sync_relation'
        );
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
