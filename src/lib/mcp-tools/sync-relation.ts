import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeSyncRelation } from '../../sync-relation.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';
import { docUrl, withUrl } from './doc-link.js';

export function registerSyncRelationTool(server: McpServer): void {
  server.tool(
    'ki_sync_relation',
    '写入/更新 Relation + 本地 KB（自动补建 Group 树）。成功时结果里带 url——该文档在 Web 端的地址；请把它原样告知用户（便于点开查看或继续修改）。'
    + '**写调用链 / 数据流 / 分层依赖 / 状态机 / 时序类内容时优先配一张 mermaid 图**（```mermaid 围栏；层级与分支可用文字树、对照用表格），'
    + '但**图必须配一两句文字结论**：图块在向量化时会被整块剥离，只画图不写结论等于这条知识搜不到；'
    + '手写正文也不要引用 ![](./x.png) 真图片（手写没有 assets 目录、必然破图，真图片改走文档上传通道）。'
    + '正文超过 4000 字符时结果**仍为成功**但带 warning 字段：不要忽略它，按提示拆成多条 Relation，或把整篇内容改写成本地文档后走上传通道。',
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
    async (args, extra) => {
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
        // 链接只在成功时给；取不到（未开 --web / stdio 直连）就整个字段不出现（REQ-20261123-003）
        const url = result.ok
          ? docUrl({ scope: result.scope, group: result.group, relation: result.relation }, extra)
          : undefined;
        return {
          content: [{ type: 'text', text: JSON.stringify(withUrl(result, url), null, 2) }],
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
