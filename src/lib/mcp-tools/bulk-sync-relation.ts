import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeBulkSyncRelation } from '../../sync-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { docUrl, withUrl } from './doc-link.js';

export function registerBulkSyncRelationTool(server: McpServer): void {
  server.tool(
    'ki_bulk_sync_relation',
    '批量写入/更新 Relation + 本地 KB + 向量层（一次 embedding + 一次向量写入，比多次并发调用 ki_sync_relation 快 N 倍）。自动补建 Group 树。当需要同时写入多条 Relation 时优先使用此工具。'
    + '成功时**每条成功结果**各带 url（该文档在 Web 端的地址）；请把它们原样告知用户。',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      items: z.array(z.object({
        group: z.string().describe('Group 路径（支持 / 层级嵌套）；留空（""）则写入「根」目录（对齐 ki import 的根目录口径）'),
        relation: z.string().describe('Relation 名称'),
        module_info: z.string().describe('本地 KB Markdown 内容'),
        tags: z.string().optional().describe('文档内容自定义标签（逗号分隔多个，叠加在默认 ki-search 之上，如 "api,auth"）'),
        lifecycle: z.enum(['wiki', 'temp', 'event']).optional().describe('该条文档的分类；缺省=wiki（覆盖时保持原值）'),
        ttl_days: z.number().int().min(1).max(365).optional().describe('仅 lifecycle=temp：期限天数'),
        event: z.string().optional().describe('仅 lifecycle=event：事件 id 或 #3（事件需先在页面创建）'),
      })).min(1).max(50).describe('批量写入条目（单次最多 50 条；超出请分批调用，避免触发工具超时）'),
      vector: z.boolean().optional().default(true).describe('是否写入 dense 向量层。false=FTS-only：不调用 embedding，写入独立全文 Collection'),
    },
    async (args, extra) => {
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
        // 逐条附链接（REQ-20261123-003）：只给**真正写入成功**的条目；
        // skipped / 有 skipReason 的条目与失败条目一律不带（用户点了也是空的）。
        const payload = result.ok
          ? {
              ...result,
              results: result.results.map((item) => (
                item.skipped === true || item.skipReason
                  ? item
                  : withUrl(item, docUrl(
                      { scope: result.scope, group: item.group, relation: item.relation },
                      extra,
                    ))
              )),
            }
          : result;
        return {
          content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
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
