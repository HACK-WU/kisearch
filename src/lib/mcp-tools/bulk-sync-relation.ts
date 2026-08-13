import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeBulkSyncRelation } from '../../sync-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerBulkSyncRelationTool(server: McpServer): void {
  server.tool(
    'ki_bulk_sync_relation',
    '批量写入/更新 Relation + 本地 KB + 向量层（一次 embedding + 一次向量写入，比多次并发调用 ki_sync_relation 快 N 倍）。自动补建 Group 树。当需要同时写入多条 Relation 时优先使用此工具。',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      items: z.array(z.object({
        group: z.string().describe('Group 路径（支持 / 层级嵌套）'),
        relation: z.string().describe('Relation 名称'),
        module_info: z.string().describe('本地 KB Markdown 内容'),
        tags: z.string().optional().describe('文档内容自定义标签（逗号分隔多个，叠加在默认 ki-search 之上，如 "api,auth"）'),
      })).min(1).max(50).describe('批量写入条目（单次最多 50 条；超出请分批调用，避免触发工具超时）'),
      vector: z.boolean().optional().default(true).describe('是否写入向量层（ki-search/ki-relation）。false=非向量化：仅写 KB 层（不产生 memoryId，无法被 ki search 召回）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeBulkSyncRelation({
            scope: args.scope,
            items: args.items,
            vector: args.vector,
          }),
          TOOL_TIMEOUT.BULK,
          'ki_bulk_sync_relation'
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
