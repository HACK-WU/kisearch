import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeManageCreate, executeListScopes, executeManageDeleteEmpty } from '../../manage-index.js';
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
    '列出所有 scope（含已注册但未初始化的）及其顶层 Group，带 registered/initialized 标注',
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

  // ✅ 注册 delete 工具（仅限空节点，NEG-15 边界内）
  //
  // NEG-15 决策（更新）：级联删除（relations-cache + 本地KB + wiki + 向量）属于
  // 不可逆的破坏性操作，且 MCP 调用缺少 CLI 的二次确认交互，仍仅通过 CLI
  //（`ki manage-index --action delete --force`）暴露。但纯空节点（无子节点、
  // 无 relation、无本地 KB）的删除是非破坏性的，且 Agent 清理自己创建的
  // 测试/误建节点是高频需求，故开放这一受限子集；非空节点一律拒绝并引导
  // 走 ki_delete_relation（逐条）或 CLI（级联，带确认）。
  server.tool(
    'ki_manage_index_delete',
    '删除 Group 树中的空节点（仅限无子节点、无 relation、无本地 KB 的节点；非空节点请用 ki_delete_relation 清空后重试，或用 CLI 级联删除）',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      name: z.string().describe('要删除的节点名称（不能包含 /）'),
      parent: z.string().optional().describe('父节点路径（省略则在顶层查找）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeManageDeleteEmpty({
            scope: args.scope,
            name: args.name,
            parent: args.parent,
          }),
          TOOL_TIMEOUT.WRITE,
          'ki_manage_index_delete'
        );
        return {
          ...(result.ok ? {} : { isError: true as const }),
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
