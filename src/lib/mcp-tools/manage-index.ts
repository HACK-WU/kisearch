import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeManageCreate, executeListScopes } from '../../manage-index.js';

export function registerManageIndexTools(server: McpServer): void {
  // ✅ 注册 create 工具
  server.tool(
    'ki_manage_index_create',
    '在 Group 树中创建新节点（scope 不存在则自动创建）',
    {
      scope: z.string().describe('项目隔离标识'),
      name: z.string().describe('新节点名称（不能包含 /）'),
      parent: z.string().optional().describe('父节点路径（省略则挂在根层）'),
    },
    async (args) => {
      try {
        const result = await executeManageCreate({
          scope: args.scope,
          name: args.name,
          parent: args.parent,
        });
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

  // ✅ 注册 list-scopes 工具
  server.tool(
    'ki_manage_index_list',
    '列出所有存在的 scope 及其顶层 Group',
    {},
    async () => {
      try {
        const result = executeListScopes();
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

  // ❌ 不注册 delete 工具 — Agent 无法通过 MCP 删除任何节点
}
