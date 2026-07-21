import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerQueryGroupTool } from './lib/mcp-tools/query-group.js';
import { registerGetModuleInfoTool } from './lib/mcp-tools/get-module-info.js';
import { registerSyncRelationTool } from './lib/mcp-tools/sync-relation.js';
import { registerManageIndexTools } from './lib/mcp-tools/manage-index.js';
import { registerSearchTool } from './lib/mcp-tools/search.js';
import { registerStoreTool } from './lib/mcp-tools/store.js';
import { registerBulkStoreTool } from './lib/mcp-tools/bulk-store.js';
import { registerDeleteRelationTool } from './lib/mcp-tools/delete-relation.js';
import { closeEngine } from './lib/vector-client.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'KiSearch',
    version: '0.1.0',
  });

  // 注册所有工具
  registerQueryGroupTool(server);
  registerGetModuleInfoTool(server);
  registerSyncRelationTool(server);
  registerManageIndexTools(server);
  registerSearchTool(server);
  registerStoreTool(server);
  registerBulkStoreTool(server);
  registerDeleteRelationTool(server);

  // 长驻进程：engine 在首次向量调用时惰性打开并跨请求复用（不 per-call 关闭），
  // 仅在进程退出时统一 terminate worker + 释放 LOCK。
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await closeEngine();
    } catch {
      /* 关闭失败不阻塞退出 */
    }
    process.exit(code);
  };
  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });

  // 启动 stdio 传输
  const transport = new StdioServerTransport();
  // stdio 关闭（客户端断开）时释放 engine，避免 worker 线程悬挂导致进程无法退出
  transport.onclose = () => { void shutdown(0); };
  await server.connect(transport);
}

// 入口
startMcpServer().catch((err) => {
  console.error('MCP Server 启动失败:', err);
  process.exit(1);
});
