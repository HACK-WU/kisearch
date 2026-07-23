import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeManageCreate, executeListScopes } from '../../manage-index.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

export function registerManageIndexTools(server: McpServer): void {
  // ✅ 注册 create 工具
  server.tool(
    'ki_manage_index_create',
    '在 Group 树中创建新节点（scope 不存在则自动创建）',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      name: z.string().describe('新节点名称（不能包含 /）'),
      parent: z.string().optional().describe('父节点路径（省略则挂在根层）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeManageCreate({
            scope: args.scope,
            name: args.name,
            parent: args.parent,
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_manage_index_create'
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

  // ❌ 有意不注册 delete 工具 —— Agent 无法通过 MCP 删除任何 Group/Relation 节点。
  //
  // NEG-15 决策：delete 属于不可逆的破坏性操作（级联删除 relations-cache + 本地KB +
  // wiki 文件 + 向量数据），且 MCP 调用缺少 CLI 的二次确认交互，一旦被 Agent 误触
  // 将造成不可恢复的数据丢失。因此 delete 仅通过 CLI（`ki manage-index delete`，带
  // 交互确认）暴露，绝不通过 MCP 工具面向 Agent 开放。
  //
  // 如需在自动化流程中删除节点，请改用 `ki_delete_relation`（粒度更细、仅删单个
  // Relation）或人工执行带确认的 CLI 命令。
}
