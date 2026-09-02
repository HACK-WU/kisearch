import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeGetModuleInfo, executeGetModuleInfoBatch } from '../../get-module-info.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerGetModuleInfoTool(server: McpServer): void {
  server.tool(
    'ki_get_module_info',
    '读取指定 Group 下某个/多个 Relation 的本地 KB Markdown 内容（批量 ≤10 条，须同 Group）',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      group: z.string().describe('Group 路径（支持向量语义兜底）'),
      relation: z.string().optional().describe('Relation 名称（精确匹配）。单条查询用；与 relations 二选一'),
      relations: z.array(z.string()).max(10).optional().describe('同 Group 下批量查询（≤10 条，超限报错），逐条返回 results（部分失败不影响其他）。与 relation 二选一'),
    },
    async (args) => {
      try {
        if (args.relation && args.relations) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'relation 与 relations 只能二选一：单条用 relation，批量（≤10 条）用 relations' }],
          };
        }
        if (!args.relation && !args.relations) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'relation 与 relations 必须二选一传入' }],
          };
        }
        const result = args.relations
          ? await withTimeout(
              executeGetModuleInfoBatch({ scope: args.scope, group: args.group, relations: args.relations }),
              TOOL_TIMEOUT.READ,
              'ki_get_module_info'
            )
          : await withTimeout(
              executeGetModuleInfo({ scope: args.scope, group: args.group, relation: args.relation as string }),
              TOOL_TIMEOUT.READ,
              'ki_get_module_info'
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
