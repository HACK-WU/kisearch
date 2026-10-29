import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { executeGroupCreate } from '../group-create.js';
import { executeGroupDelete } from '../group-delete.js';
import { withTimeout, TOOL_TIMEOUT } from './util.js';

/**
 * 注册 ki_group_* 工具（REQ-20261019-005）：
 * - ki_group_create：单一路径 {scope, path}，父级必须已存在；scope 不存在自动创建
 * - ki_group_delete_empty：仅空节点（NEG-15）；非空请用 CLI `ki group delete <path> --yes`
 */
export function registerGroupTools(server: McpServer): void {
  server.tool(
    'ki_group_create',
    '在 Group 树中创建单个节点（父级必须已存在；scope 不存在则自动创建并返回 createdScope）',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      path: z.string().describe('组路径，如 "工具库/Redis"（不提供 parent/name 参数）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeGroupCreate({ scope: args.scope, path: args.path }),
          TOOL_TIMEOUT.WRITE,
          'ki_group_create',
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
    },
  );

  server.tool(
    'ki_group_delete_empty',
    '删除空 Group 节点（仅限无子组、无 relation、无 KB 文件）；非空节点请用 CLI: ki group delete <path> --yes',
    {
      scope: z.string().optional().default('default').describe('项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内）'),
      path: z.string().describe('组路径，如 "工具库/Redis"（不提供 parent/name 参数）'),
    },
    async (args) => {
      try {
        const result = await withTimeout(
          executeGroupDelete({ scope: args.scope, path: args.path, requireEmpty: true }),
          TOOL_TIMEOUT.WRITE,
          'ki_group_delete_empty',
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
    },
  );
}
