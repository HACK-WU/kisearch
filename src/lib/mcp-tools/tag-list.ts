import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeTagList } from '../../tag.js';
import { loadConfig } from '../config.js';
import { resolveScopeTargets } from '../scope-view.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerTagListTool(server: McpServer): void {
  server.tool(
    'ki_tag_list',
    '列出指定 scope 下用过的 tag（含文档数，按数量降序，只读）；用于在 ki_search / doc 过滤前发现可用 tag',
    {
      scope: z.string().optional().default('default').describe('知识库名或视图名（视图会合并各成员库的 tag 并累加计数；省略则用 default）'),
    },
    async (args) => {
      try {
        /**
         * 视图：**合并 + 计数累加**（与 group/doc 的分桶不同）。
         * tag 是跨库筛选维度，Agent 要的是"整个视图有哪些 tag、各多少篇"；
         * 分桶会让它逐库调一遍才知道全貌。
         */
        const targets = resolveScopeTargets(loadConfig(), args.scope);
        if (targets.views.length > 0 && targets.scopes.length > 1) {
          const merged = new Map<string, { tag: string; count: number; scopes: string[] }>();
          const skipped: { scope: string; reason: string }[] = [...targets.skipped];
          for (const member of targets.scopes) {
            try {
              const r = await withTimeout(
                executeTagList({ scope: member }),
                TOOL_TIMEOUT.READ,
                'ki_tag_list',
              );
              if (!r.ok) { skipped.push({ scope: member, reason: r.error }); continue; }
              for (const t of r.tags) {
                const hit = merged.get(t.tag);
                if (hit) {
                  hit.count += t.count;
                  if (!hit.scopes.includes(member)) hit.scopes.push(member);
                } else {
                  merged.set(t.tag, { tag: t.tag, count: t.count, scopes: [member] });
                }
              }
            } catch (err) {
              skipped.push({ scope: member, reason: (err as Error).message });
            }
          }
          const tags = [...merged.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                ok: true,
                view: targets.views[0],
                members: targets.scopes,
                count: tags.length,
                tags,
                ...(skipped.length > 0 ? { skipped } : {}),
              }, null, 2),
            }],
          };
        }

        const result = await withTimeout(
          executeTagList({ scope: args.scope }),
          TOOL_TIMEOUT.READ,
          'ki_tag_list'
        );
        if (!result.ok) {
          return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          };
        }
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
