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
      group: z.string().describe('Group 路径（支持 / 层级嵌套）；留空（""）则写入「根」目录（对齐 ki import 的根目录口径）'),
      relation: z.string().describe('Relation 名称'),
      module_info: z.string().describe('本地 KB Markdown 内容'),
      vector: z.boolean().optional().default(true).describe('是否写入 dense 向量层。false=FTS-only：不调用 embedding，写入独立全文 Collection'),
      tags: z.string().optional().describe('文档内容自定义标签（逗号分隔多个，叠加在默认 ki-search 之上，如 "api,auth"）'),
      lifecycle: z.enum(['wiki', 'temp', 'event']).optional().describe('文档分类：wiki=永久保留（缺省）/ temp=到期进回收站 / event=跟随事件阶段。覆盖已有文档时不传=保持原值'),
      ttl_days: z.number().int().min(1).max(365).optional().describe('仅 lifecycle=temp：期限天数（1~365）。不传会报 TTL_REQUIRED，不猜期限'),
      event: z.string().optional().describe('仅 lifecycle=event：事件 id（evt_…）或 #3。可用 ki_event_list 查未收口事件、ki_event_create 新建；已收口事件不可绑定，已属其他未收口事件会被拒（DOC_BOUND_TO_OTHER_EVENT）'),
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
            lifecycle: args.lifecycle,
            ttlDays: args.ttl_days,
            eventId: args.event,
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
