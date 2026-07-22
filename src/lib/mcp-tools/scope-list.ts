import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeScopeList } from '../../scope.js';

export function registerScopeListTool(server: McpServer): void {
  server.tool(
    'ki_scope_list',
    '列出所有 scope（KB 目录层 + 向量语义层并集，标注每个 scope 存在于哪层、是否已在配置注册）',
    {},
    async () => {
      try {
        const result = await executeScopeList();
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
