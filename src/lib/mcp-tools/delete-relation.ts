import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeDeleteRelation } from '../../delete-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerDeleteRelationTool(server: McpServer): void {
  server.tool(
    'ki_delete_relation',
    '删除 Relation 及其关联数据（relations-cache + 本地KB + wiki文件 + 向量）。当用户要求删除某个记忆片段、清理某个Relation、移除知识条目时使用。向量删除优先按memoryId，无memoryId时用search严格匹配兜底。触发短语：删除这个记忆、移除这个Relation、清理知识条目。',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      group: z.string().describe('Group 路径（支持模糊匹配）'),
      relation: z.string().describe('Relation 名称（精确匹配）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeDeleteRelation({
            scope: args.scope,
            group: args.group,
            relation: args.relation,
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_delete_relation'
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
