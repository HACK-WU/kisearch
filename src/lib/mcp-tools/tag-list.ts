import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { tagListByScope } from '../tag-list-view.js';
import { TOOL_TIMEOUT } from './util.js';

export function registerTagListTool(server: McpServer): void {
  server.tool(
    'ki_tag_list',
    '列出指定 scope 下用过的 tag（含文档数，按数量降序，只读）；用于在 ki_search / doc 过滤前发现可用 tag',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（视图 / 逗号分隔的多库都会合并各成员库的 tag 并累加计数；省略则用 default）'),
    },
    async (args) => {
      try {
        /**
         * 视图展开统一交给 `tagListByScope`（CLI / 对话侧共用）。
         * ★ 判据是「名字命中视图」，不能叠加成员数：单成员视图落到单库分支
         *   会拿视图名去 `vectorListTags`，返回空列表冒充"没有 tag"（静默错误答案）。
         */
        const outcome = await tagListByScope(args.scope, {
          timeout: { ms: TOOL_TIMEOUT.READ, label: 'ki_tag_list' },
        });

        if (outcome.kind === 'view-empty') {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: false,
                view: outcome.view,
                error: `视图 ${outcome.view} 没有可用的成员库`,
                skipped: outcome.skipped,
              }, null, 2),
            }],
          };
        }

        if (outcome.kind === 'view') {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                view: outcome.view,
                members: outcome.members,
                count: outcome.tags.length,
                tags: outcome.tags,
                ...(outcome.skipped.length > 0 ? { skipped: outcome.skipped } : {}),
              }, null, 2),
            }],
          };
        }

        if (!outcome.result.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(outcome.result, null, 2) }],
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        };
      }
    },
  );
}
