import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeDeleteRelation } from '../../delete-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerDeleteRelationTool(server: McpServer): void {
  server.tool(
    'ki_delete_relation',
    '删除 Relation 及其关联数据（relations-cache + 本地KB + wiki文件 + 向量）。当用户要求删除某个记忆片段、清理某个Relation、移除知识条目时使用。向量删除优先按memoryId，无memoryId时用search严格匹配兜底。若有未结束的 ki_edit_relation 草稿，会拒绝删除并提示先 cancel/finish 收口。触发短语：删除这个记忆、移除这个Relation、清理知识条目。'
    + '删除前会先把正文与元数据移入**回收站**（返回体的 trash 字段给出 dirName / expiresAt / ttlDays），'
    + '所以删除是可恢复的——用户问起时请告知"可以到 Web 的回收站页恢复，保留期由该库设置决定"，'
    + '不要说成删了就没了。索引（语义/全文/路径/关系）在恢复时重建，需要数秒。'
    + '注意：删除后不返回文档链接（文档已不存在，给了也是死链）。',
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
        // 刻意**不**附加文档链接（REQ-20261123-003 U5）：文档已删除，链接必然 404，
        // 死链比没有链接更糟，还会诱导模型说「已删除，可以去看看」。后人请勿"顺手补齐"。
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
