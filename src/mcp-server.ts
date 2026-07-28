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
  fetchHealthz,
  probeHost,
  DEFAULT_MCP_HTTP_PORT,
  DEFAULT_MCP_HTTP_HOST,
} from './lib/mcp-http.js';
import { readLiveStdioLock, acquireStdioLock, releaseStdioLock } from './lib/mcp-stdio-lock.js';
import { stopMcpInstances } from './lib/mcp-stop.js';
import {
  createManagedToken,
  resetManagedToken,
  readManagedToken,
  managedTokenInfo,
} from './lib/mcp-token.js';

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
  let resolvedToken = token;
  let tokenSource = tokenFromFlag !== undefined ? '--token 参数' : token ? '环境变量 KI_MCP_TOKEN' : '';

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

  // 非回环绑定必须提供 token（远程裸奔不安全）；
  // 显式来源（--token/env）缺失时自动回退到托管 Token（~/.ki/mcp-token，ki mcp token generate 生成）。
  // 回环绑定不读托管文件：鉴权本就禁用，Token 不会生效。
  if (!isLoopbackHost(host) && (!resolvedToken || !resolvedToken.trim())) {
    const managed = readManagedToken();
    if (managed) {
      resolvedToken = managed;
      tokenSource = '托管文件 ~/.ki/mcp-token';
    } else {
      failJson(
        `HTTP 模式绑定非回环地址（${host}）时必须提供鉴权 Token：` +
          `推荐执行 ki mcp token generate 一键生成托管 Token，或设置环境变量 KI_MCP_TOKEN / 传入 --token <值>。` +
          `（若仅本机访问，可用默认回环绑定免鉴权）`,
        'MCP_HTTP_TOKEN_REQUIRED',
      );
    }
  }

  // REQ-04：非回环模式明示 Token 来源，避免“改了文件/环境变量为何不生效”的困惑
  if (!isLoopbackHost(host) && tokenSource) {
    process.stderr.write(`鉴权 Token 来源：${tokenSource}（优先级 --token > KI_MCP_TOKEN > 托管文件）。\n`);
  }

  return { http: true, host, port, token: resolvedToken, allowedHosts };
}

/** ki mcp token <generate|show|reset> 子命令：托管 Token 的生成、查看与轮换（JSON 输出契约） */
function runTokenCommand(args: string[]): void {
  const action = args[0];
  if (action === 'generate') {
    try {
      const { token, path: tokenPath } = createManagedToken();
      console.log(
        JSON.stringify(
          {
            ok: true,
            token,
            path: tokenPath,
            hint:
              'Token 已生成并托管（0600）。启动远程模式无需 export：ki mcp --http --host 0.0.0.0；' +
              'IDE 客户端配置 Authorization: Bearer <token>。后续可用 ki mcp token show 再次查看。',
          },
          null,
          2,
        ),
      );
    } catch (err) {
      const e = err as Error & { code?: string };
      failJson(e.message, e.code ?? 'MCP_TOKEN_GENERATE_FAILED');
    }
    return;
  }
  if (action === 'show') {
    // 只读查看：权限等价于文件拥有者 cat ~/.ki/mcp-token，不新增暴露面
    const info = managedTokenInfo();
    const token = readManagedToken(info.path);
    if (!token) {
      // 区分“文件不存在”与“文件存在但为空”：后者若引导 generate 会撞上 MCP_TOKEN_EXISTS 形成死循环
      failJson(
        info.exists
          ? `托管 Token 文件为空（${info.path}）。请执行 ki mcp token reset --yes 重建。`
          : `托管 Token 不存在（${info.path}）。请先执行 ki mcp token generate 生成。`,
        info.exists ? 'MCP_TOKEN_EMPTY' : 'MCP_TOKEN_NOT_FOUND',
      );
    }
    console.log(
      JSON.stringify(
        {
          ok: true,
          token,
          path: info.path,
          createdAt: info.exists ? info.createdAt : undefined,
          hint: 'IDE 客户端配置 Authorization: Bearer <token>。请勿将输出粘贴到公开渠道。',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (action === 'reset') {
    if (!args.includes('--yes')) {
      failJson(
        '重置托管 Token 是破坏性操作：所有已配置该 Token 的客户端将立即失效，' +
          '运行中的 HTTP 服务需重启后才使用新 Token。确认请加 --yes：ki mcp token reset --yes',
        'MCP_TOKEN_RESET_CONFIRM',
      );
    }
    const { token, path: tokenPath } = resetManagedToken();
    console.log(
      JSON.stringify(
        {
          ok: true,
          token,
          path: tokenPath,
          hint:
            'Token 已重置。请更新所有 IDE 客户端的 Authorization 头，' +
            '并重启运行中的 HTTP 服务（旧 Token 在重启前仍生效）。' +
            '注意：若启动环境设有 KI_MCP_TOKEN 或传了 --token，其优先级高于托管文件，需一并更新/移除。' +
            '后续可用 ki mcp token show 再次查看。',
        },
        null,
        2,
      ),
    );
    return;
  }
  failJson(
    `未知的 token 子命令（${action ?? '缺失'}）。可用：ki mcp token generate | ki mcp token show | ki mcp token reset --yes`,
    'MCP_TOKEN_UNKNOWN_ACTION',
  );
}

export async function startMcpServer(): Promise<void> {
  const argv = process.argv.slice(2);

  // ─── ki mcp token <generate|reset>：托管 Token 管理，不启动服务、跳过预检 ───
  if (argv[0] === 'token') {
    runTokenCommand(argv.slice(1));
    return;
  }

  // ─── ki mcp --status：只读诊断，读 lock + 探活，跳过预检与启动（NEG-01/02） ───
  if (argv.includes('--status')) {
    const config = loadConfig();
    const httpCfg = config.mcp?.http ?? {};
    const host = getFlagValue(argv, '--host') ?? httpCfg.host ?? DEFAULT_MCP_HTTP_HOST;
    const port = resolveHttpPort(argv, httpCfg);
    await printHttpStatus(host, port);
    return;
  }

  // ─── ki mcp stop：一键关闭本机所有 ki mcp 实例（stdio + HTTP）并清理 lock，跳过预检 ───
  // 按 lock/healthz 定位真正的服务进程直接发信号，规避「杀顶层壳留下持锁孤儿」的多层进程链坑。
  if (argv[0] === 'stop') {
    const config = loadConfig();
    const httpCfg = config.mcp?.http ?? {};
    const host = getFlagValue(argv, '--host') ?? httpCfg.host ?? DEFAULT_MCP_HTTP_HOST;
    const port = resolveHttpPort(argv, httpCfg);
    const report = await stopMcpInstances({ host, port });
    const nothing = report.stopped.length === 0 && report.cleanedLocks.length === 0;
    console.log(
      JSON.stringify(
        {
          ok: true,
          stopped: report.stopped,
          cleanedLocks: report.cleanedLocks,
          hint: nothing
            ? '未发现运行中的 ki mcp 实例，也没有残留 lock。' +
              '注意：升级前启动的旧 stdio 进程不写 lock，本命令无法定位；' +
              '如怀疑仍有残留，可用 ps -ef | grep mcp-server 人工确认后 kill。'
            : '已关闭的实例若由 IDE 以 command 型配置拉起，IDE 可能自动重启它；' +
              '如需长期使用 HTTP 单例，请将 IDE 配置迁移为 URL 型接入后再 ki mcp --http。',
        },
        null,
        2,
      ),
    );
    return;
  }

  const opts = parseMcpArgs(argv);

  // ─── 启动守卫（预检之前）：幂等复用 / 多实例冲突检测 ───
  // 探活与 lock 检查必须前置，保证「已有实例可复用/该被拒绝」的判定不被预检
  // （如缺 embedding Key 的异构 shell）拦截——重复运行在任何环境下都安全。
  if (opts.http) {
    // 命中健康实例 → 复用退出，全程不做预检
    const live = await fetchHealthz(opts.host, opts.port);
    if (live?.ok === true && live?.name === 'KiSearch') {
      process.stderr.write(
        `已有健康的 KiSearch 实例在 ${opts.host}:${opts.port}（pid ${live.pid}），复用该实例，本次不再启动。\n`,
      );
      process.exit(0);
    }
    // 存活的 stdio 实例会与 HTTP 单例争抢向量库锁 → 启动前指明冲突来源并拒绝（而非等取锁失败才报占用）
    const stdioLock = readLiveStdioLock();
    if (stdioLock) {
      process.stderr.write(
        `检测到存活的 ki mcp stdio 实例（pid ${stdioLock.pid}，启动于 ${stdioLock.startedAt}），` +
          `它与 HTTP 单例并存会争抢向量库锁导致降级，拒绝启动。\n` +
          `请先关闭该 stdio 进程（kill ${stdioLock.pid}）并将对应 IDE 配置迁移为 URL 型接入，再启动 HTTP 服务。\n`,
      );
      process.exit(1);
    }
  } else {
    // stdio 守卫①：已有健康 HTTP 单例 → 拒绝启动，引导迁移 URL 接入（fail-loud + 明确出路）
    let guardHost: string = DEFAULT_MCP_HTTP_HOST;
    let guardPort: number = DEFAULT_MCP_HTTP_PORT;
    try {
      const httpCfg = loadConfig().mcp?.http ?? {};
      if (httpCfg.host) guardHost = httpCfg.host;
      if (Number.isInteger(httpCfg.port) && httpCfg.port! >= 1 && httpCfg.port! <= 65535) {
        guardPort = httpCfg.port!;
      }
    } catch {
      /* 配置异常交由后续预检报告，此处用默认地址探活 */
    }
    const live = await fetchHealthz(guardHost, guardPort);
    if (live?.ok === true && live?.name === 'KiSearch') {
      // 展示用地址同步归一（0.0.0.0 等监听写法不是可连接地址）
      const connectHost = probeHost(guardHost);
      process.stderr.write(
        `已有健康的 KiSearch HTTP 单例在 ${connectHost}:${guardPort}（pid ${live.pid}），` +
          `stdio 模式与其并存会争抢向量库锁，拒绝启动。\n` +
          `请将本 IDE 的 MCP 配置改为 URL 型接入：{ "url": "http://${connectHost}:${guardPort}/mcp" }。\n`,
      );
      process.exit(1);
    }
    // stdio 守卫②：原子独占创建自身 lock，并发启动时竞态输家在此被拒
    // （陈旧锁在创建时已自动清理，不会误拦）；必须在预检之前登记，
    // 避免多 IDE 同时拉起时在预检窗口内静默共存。
    const conflict = acquireStdioLock();
    if (conflict) {
      process.stderr.write(
        `已有 ki mcp stdio 实例在运行（pid ${conflict.pid}，启动于 ${conflict.startedAt}），` +
          `多个 stdio 进程会争抢向量库锁，拒绝启动。\n` +
          `建议迁移 HTTP 单例模式：执行 ki mcp --http 后，将所有 IDE 配置改为 URL 型接入 ` +
          `http://${probeHost(guardHost)}:${guardPort}/mcp。\n`,
      );
      process.exit(1);
    }
    // 'exit' 钩子保证预检失败/shutdown/process.exit 各路径都释放
    // （kill -9 残留由下次启动的存活校验清理）
    process.on('exit', () => releaseStdioLock());
  }

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

  // ─── stdio 模式（默认，单客户端单进程） ───
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
