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
import { detectUnknownFlags, parseIntArg, failJson } from './lib/cli-args.js';
import {
  startHttpMcpServer,
  printHttpStatus,
  isLoopbackHost,
  DEFAULT_MCP_HTTP_PORT,
  DEFAULT_MCP_HTTP_HOST,
} from './lib/mcp-http.js';

/**
 * 构建一个 KiSearch McpServer 并注册全部工具。
 * stdio 与 HTTP 传输复用同一工厂：HTTP 模式下每个会话新建一个实例，
 * 但它们共享 vector-client 的模块级单例 engine（单进程单锁）。
 */
export function buildKiMcpServer(): McpServer {
  const server = new McpServer({
    name: 'KiSearch',
    version: readKiVersion(),
  });
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
  return server;
}

interface McpCliOptions {
  http: boolean;
  host: string;
  port: number;
  token?: string;
  allowedHosts?: string[];
}

/** 从 args 取 --flag 的值（支持 --flag=value 与 --flag value 两种形式） */
function getFlagValue(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === name) return args[i + 1];
    if (a.startsWith(name + '=')) return a.slice(name.length + 1);
  }
  return undefined;
}

/** 解析 HTTP 绑定地址（CLI > 配置文件 > 默认），供 --status 与启动共用 */
function resolveHttpPort(args: string[], httpCfg: { port?: number }): number {
  const portRaw = getFlagValue(args, '--port');
  if (portRaw !== undefined) {
    return parseIntArg(portRaw, DEFAULT_MCP_HTTP_PORT, '--port', { min: 1, max: 65535 });
  }
  if (httpCfg.port !== undefined) {
    if (!Number.isInteger(httpCfg.port) || httpCfg.port < 1 || httpCfg.port > 65535) {
      failJson(
        `配置文件 mcp.http.port 非法（${String(httpCfg.port)}）：端口须为 1-65535 的整数。`,
        'MCP_HTTP_PORT_INVALID',
      );
    }
    return httpCfg.port;
  }
  return DEFAULT_MCP_HTTP_PORT;
}

/** 解析 ki mcp 的命令行参数（无 --http 时走 stdio，行为不变） */
function parseMcpArgs(args: string[]): McpCliOptions {
  const known = ['--http', '--host', '--port', '--token', '--allowed-hosts', '--status'];
  detectUnknownFlags(args, known, ['--host', '--port', '--token', '--allowed-hosts']);

  const http = args.includes('--http');
  if (!http) {
    return { http: false, host: '', port: 0 };
  }

  const config = loadConfig();
  const httpCfg = config.mcp?.http ?? {};

  const host = getFlagValue(args, '--host') ?? httpCfg.host ?? DEFAULT_MCP_HTTP_HOST;

  const port = resolveHttpPort(args, httpCfg);

  const tokenFromFlag = getFlagValue(args, '--token');
  if (tokenFromFlag !== undefined) {
    process.stderr.write(
      '提示：通过 --token 传入 Token 会暴露在进程列表/命令历史中，推荐改用环境变量 KI_MCP_TOKEN。\n',
    );
  }
  const token = tokenFromFlag ?? process.env.KI_MCP_TOKEN;

  // NEG-03：回环绑定时鉴权被禁用，此时提供 Token 不生效，明确告知避免安全误判
  if (isLoopbackHost(host) && (tokenFromFlag !== undefined || process.env.KI_MCP_TOKEN)) {
    process.stderr.write(
      `提示：当前绑定回环地址（${host}），鉴权已禁用，提供的 Token 不生效；` +
        `如需鉴权请绑定非回环地址（--host 0.0.0.0 或具体 IP）。\n`,
    );
  }
  const allowedHostsRaw = getFlagValue(args, '--allowed-hosts');
  const allowedHosts = allowedHostsRaw
    ? allowedHostsRaw.split(',').map((s) => s.trim()).filter(Boolean)
    : httpCfg.allowedHosts;

  // 非回环绑定必须提供 token（远程裸奔不安全）
  if (!isLoopbackHost(host) && (!token || !token.trim())) {
    failJson(
      `HTTP 模式绑定非回环地址（${host}）时必须提供鉴权 Token：` +
        `请设置环境变量 KI_MCP_TOKEN 或传入 --token <值>。` +
        `（若仅本机访问，可用 --host 127.0.0.1 绑定回环地址免鉴权）`,
      'MCP_HTTP_TOKEN_REQUIRED',
    );
  }

  return { http: true, host, port, token, allowedHosts };
}

export async function startMcpServer(): Promise<void> {
  const argv = process.argv.slice(2);

  // ─── ki mcp --status：只读诊断，读 lock + 探活，跳过预检与启动（NEG-01/02） ───
  if (argv.includes('--status')) {
    const config = loadConfig();
    const httpCfg = config.mcp?.http ?? {};
    const host = getFlagValue(argv, '--host') ?? httpCfg.host ?? DEFAULT_MCP_HTTP_HOST;
    const port = resolveHttpPort(argv, httpCfg);
    await printHttpStatus(host, port);
    return;
  }

  const opts = parseMcpArgs(argv);

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

  // NEG-13：长驻进程版本自检 banner + 升级监听（升级后提示重启）
  const stopVersionGuard = startVersionGuard('KiSearch');

  // ─── HTTP 共享单例模式（多 IDE 共享同一持锁进程） ───
  if (opts.http) {
    await startHttpMcpServer({
      host: opts.host,
      port: opts.port,
      token: opts.token,
      allowedHosts: opts.allowedHosts,
      buildServer: buildKiMcpServer,
      onShutdown: stopVersionGuard,
    });
    return;
  }

  // ─── stdio 模式（默认，行为与以往完全一致） ───
  process.stderr.write(
    'KiSearch MCP 以 stdio 模式启动（默认，单客户端单进程）。\n' +
      '如需多个 IDE 共享同一持锁进程以避免向量库锁冲突，请改用 HTTP 单例模式：ki mcp --http。\n',
  );
  const server = buildKiMcpServer();

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
