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
import { registerScopeListTool } from './lib/mcp-tools/scope-list.js';
import { registerTagListTool } from './lib/mcp-tools/tag-list.js';
import { closeEngine } from './lib/vector-client.js';
import { loadConfig } from './lib/config.js';
import { runHealthCheck, renderHealthReport } from './lib/health-check.js';
import { readKiVersion, startVersionGuard } from './lib/version-guard.js';

export async function startMcpServer(): Promise<void> {
  // ─── 启动预检（REQ-16）：复用 ki doctor 检查逻辑 ───
  // stdio 协议占用 stdout，报告一律写 stderr；有失败项拒绝启动。
  try {
    const config = loadConfig();
    const report = await runHealthCheck(config);
    process.stderr.write(renderHealthReport(report) + '\n');
    if (report.fail > 0) {
      process.stderr.write(
        '\n启动预检失败：存在 ❌ 检查项，拒绝启动。请运行 `ki doctor` 排查或 `ki config init` 重新配置。\n'
      );
      process.exit(1);
    }
    if (report.warn > 0) {
      process.stderr.write('\n启动预检存在 ⚠️ 警告，继续启动。\n');
    }
  } catch (err) {
    process.stderr.write(`启动预检异常（配置加载失败）：${(err as Error).message}\n`);
    process.exit(1);
  }

  const server = new McpServer({
    name: 'KiSearch',
    version: readKiVersion(),
  });

  // NEG-13：长驻进程版本自检 banner + 升级监听（升级后提示重启）
  const stopVersionGuard = startVersionGuard('KiSearch');

  // 注册所有工具
  registerQueryGroupTool(server);
  registerGetModuleInfoTool(server);
  registerSyncRelationTool(server);
  registerManageIndexTools(server);
  registerSearchTool(server);
  registerStoreTool(server);
  registerBulkStoreTool(server);
  registerDeleteRelationTool(server);
  registerScopeListTool(server);
  registerTagListTool(server);

  // 长驻进程：engine 在首次向量调用时惰性打开并跨请求复用（不 per-call 关闭），
  // 仅在进程退出时统一 terminate worker + 释放 LOCK。
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      stopVersionGuard();
    } catch {
      /* 忽略 */
    }
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
