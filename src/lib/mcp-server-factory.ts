/**
 * mcp-server-factory.ts —— MCP Server 装配（按会话授权注册哪些工具）。
 *
 * 从 `src/mcp-server.ts` 抽出的原因：该文件末尾有 `startMcpServer()` 入口副作用，
 * 任何 import 它的单测都会真的把服务跑起来；装配逻辑独立成模块后可直接白盒验证
 * 「只读会话到底注册了哪几个工具」。
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerGroupListTool } from './mcp-tools/group-list.js';
import { registerGetModuleInfoTool } from './mcp-tools/get-module-info.js';
import { registerSyncRelationTool } from './mcp-tools/sync-relation.js';
import { registerEditRelationTool } from './mcp-tools/edit-relation.js';
import { registerBulkSyncRelationTool } from './mcp-tools/bulk-sync-relation.js';
import { registerGroupTools } from './mcp-tools/group.js';
import { registerSearchTool } from './mcp-tools/search.js';
import { registerStoreTool } from './mcp-tools/store.js';
import { registerBulkStoreTool } from './mcp-tools/bulk-store.js';
import { registerDeleteRelationTool } from './mcp-tools/delete-relation.js';
import { registerScopeListTool } from './mcp-tools/scope-list.js';
import { registerTagListTool } from './mcp-tools/tag-list.js';
import { READ_ONLY_INSTRUCTIONS } from './mcp-tools/tool-access.js';
import { readKiVersion } from './version-guard.js';
import { SERVICE_NAME } from './constants.js';
import type { TokenAuth } from './mcp-token.js';

/**
 * 构建一个 kisearch McpServer 并按会话授权注册工具。
 * stdio 与 HTTP 传输复用同一工厂：HTTP 模式下每个会话新建一个实例，
 * daemon 进程内按 scope 复用 Collection engine，并由 coordinator 统一调度。
 *
 * @param auth 会话授权（null = 免鉴权，如本机 stdio / 回环 HTTP）；只读会话只注册读工具，
 *   并通过 MCP `instructions` 告知客户端「当前为只读」，避免 AI 只能靠猜为什么没有写入工具。
 */
export function buildKiMcpServer(auth: TokenAuth | null = null): McpServer {
  const readOnly = auth?.readOnly === true;
  const authScopes = auth ? auth.scopes : null;
  const server = new McpServer(
    {
      name: SERVICE_NAME,
      version: readKiVersion(),
    },
    readOnly ? { instructions: READ_ONLY_INSTRUCTIONS } : undefined,
  );
  // ── 读工具（5 个）：只读会话同样注册 ──
  // ⚠️ 新增读工具时同步加入 mcp-tools/tool-access.ts::READ_ONLY_TOOL_NAMES，
  //    否则只读 Token 看不见它（方向安全，但功能缺失）。
  registerSearchTool(server);
  registerGetModuleInfoTool(server);
  registerGroupListTool(server);
  registerScopeListTool(server, authScopes);
  registerTagListTool(server);
  // ── 写工具（8 个）：只读会话**不注册** ⇒ tools/list 不出现（用户诉求「不显示」）──
  // ⚠️ 新增写工具必须放在本块内，否则会暴露给只读 Token；
  //    tools/call 侧另有一道白名单拦截（mcp-http.ts::findReadOnlyViolation）兜住缓存/构造调用。
  if (!readOnly) {
    registerSyncRelationTool(server);
    registerEditRelationTool(server);
    registerBulkSyncRelationTool(server);
    registerGroupTools(server);
    registerStoreTool(server);
    registerBulkStoreTool(server);
    registerDeleteRelationTool(server);
  }
  return server;
}
