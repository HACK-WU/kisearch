import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerQueryGroupTool } from './lib/mcp-tools/query-group.js';
import { registerGetModuleInfoTool } from './lib/mcp-tools/get-module-info.js';
import { registerSyncRelationTool } from './lib/mcp-tools/sync-relation.js';
import { registerManageIndexTools } from './lib/mcp-tools/manage-index.js';

export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'knowledge-indexer',
    version: '0.1.0',
  });

  // 注册所有工具
  registerQueryGroupTool(server);
  registerGetModuleInfoTool(server);
  registerSyncRelationTool(server);
  registerManageIndexTools(server);

  // 启动 stdio 传输
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// 入口
startMcpServer().catch((err) => {
  console.error('MCP Server 启动失败:', err);
  process.exit(1);
});
