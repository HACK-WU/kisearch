import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeQueryGroup } from '../../query-group.js';
import { loadConfig } from '../config.js';
import { resolveScopeTargets } from '../scope-view.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerGroupListTool(server: McpServer): void {
  server.tool(
    'ki_group_list',
    '列出 Group 树 + Relations，支持 hot/warm/cold/emerging/full 分区与向量语义兜底',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（视图会自动展开为成员库并按库分桶；省略则用 default；strict 模式下必须传且须在白名单内）'),
      groups: z.string().optional().describe('逗号分隔的 Group 路径列表（支持模糊匹配），展示各 Group 的 Relations（与 subtree 互斥）'),
      group: z.string().optional().describe('groups 的单数别名（两者同时传时以 groups 为准）'),
      subtree: z.string().optional().describe('以指定 Group 路径为根输出子树结构（结构导航视角，支持模糊匹配；与 groups 互斥）'),
      hot_count: z.number().int().positive().optional().default(5).describe('热门展示个数'),
      depth: z.number().int().min(1).max(10).optional().default(4).describe('索引层级深度'),
      mode: z.string().optional().default('hot')
        .describe('展示分区：hot|warm|cold|emerging|full（支持逗号分隔）'),
      auto_fallback: z.boolean().optional().default(true)
        .describe('是否启用语义兜底（默认开启）'),
    },
    async (args) => {
      try {
        const queryOpts = {
          groupsParam: args.groups ?? args.group,
          subtreeParam: args.subtree,
          hotCount: args.hot_count ?? 5,
          depth: args.depth ?? 4,
          modes: (args.mode ?? 'hot').split(',').map(m => m.trim()),
          autoFallback: args.auto_fallback,
        };

        /**
         * 视图：**按成员库分桶**，不合并同名 Group。
         * 两个库都有 `projects` 时各自一棵树 —— 合并后 Agent 无法判断文档属于哪个库。
         */
        const targets = resolveScopeTargets(loadConfig(), args.scope);
        if (targets.views.length > 0 && targets.scopes.length > 1) {
          const buckets: { scope: string; output?: string; error?: string }[] = [];
          for (const member of targets.scopes) {
            try {
              const r = await withTimeout(
                executeQueryGroup({ scope: member, ...queryOpts }),
                TOOL_TIMEOUT.READ,
                'ki_group_list',
              );
              buckets.push(r.ok ? { scope: member, output: r.output } : { scope: member, error: r.error });
            } catch (err) {
              // 单成员失败不拖垮整个视图
              buckets.push({ scope: member, error: (err as Error).message });
            }
          }
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                view: targets.views[0],
                members: targets.scopes,
                buckets,
                ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
              }, null, 2),
            }],
          };
        }

        const result = await withTimeout(
          executeQueryGroup({
            scope: args.scope,
            groupsParam: args.groups ?? args.group,
            subtreeParam: args.subtree,
            hotCount: args.hot_count ?? 5,
            depth: args.depth ?? 4,
            modes: (args.mode ?? 'hot').split(',').map(m => m.trim()),
            autoFallback: args.auto_fallback,
          }),
          TOOL_TIMEOUT.READ,
          'ki_group_list',
        );
        if (result.ok) {
          return {
            content: [{ type: 'text', text: result.output }],
          };
        }
        return {
          isError: true,
          content: [{ type: 'text', text: result.error }],
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
