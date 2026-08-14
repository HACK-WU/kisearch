import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerQueryGroupTool } from './lib/mcp-tools/query-group.js';
import { registerGetModuleInfoTool } from './lib/mcp-tools/get-module-info.js';
import { registerSyncRelationTool } from './lib/mcp-tools/sync-relation.js';
import { registerBulkSyncRelationTool } from './lib/mcp-tools/bulk-sync-relation.js';
import { registerManageIndexTools } from './lib/mcp-tools/manage-index.js';
import { registerSearchTool } from './lib/mcp-tools/search.js';
import { registerStoreTool } from './lib/mcp-tools/store.js';
import { registerBulkStoreTool } from './lib/mcp-tools/bulk-store.js';
import { registerDeleteRelationTool } from './lib/mcp-tools/delete-relation.js';
import { registerScopeListTool } from './lib/mcp-tools/scope-list.js';
import { registerTagListTool } from './lib/mcp-tools/tag-list.js';
import { closeEngine, enableIdleClose } from './lib/vector-client.js';
import { loadConfig } from './lib/config.js';
import { runHealthCheck, renderHealthReport } from './lib/health-check.js';
import { readKiVersion, startVersionGuard } from './lib/version-guard.js';
import { SERVICE_NAME } from './lib/constants.js';
import { detectUnknownFlags, parseIntArg, failJson } from './lib/cli-args.js';
import {
  startHttpMcpServer,
  printHttpStatus,
  isLoopbackHost,
  fetchHealthz,
  probeHost,
  getHttpLockPath,
  DEFAULT_MCP_HTTP_PORT,
  DEFAULT_MCP_HTTP_HOST,
} from './lib/mcp-http.js';
import { listLiveStdioLocks, acquireStdioLock, releaseStdioLock } from './lib/mcp-stdio-lock.js';

/** 向量库空闲释放锁超时（ms）：常驻 MCP 空闲超时后自动 closeEngine 释放 LOCK */
const VECTOR_IDLE_CLOSE_MS = 3_000;
import { stopMcpInstances } from './lib/mcp-stop.js';
import {
  createToken,
  updateTokenScopes,
  deleteToken,
  listTokensStrict,
  resolveScopesArg,
  tokenCount,
  ALL_SCOPES,
} from './lib/mcp-token.js';

/**
 * 构建一个 kisearch McpServer 并注册全部工具。
 * stdio 与 HTTP 传输复用同一工厂：HTTP 模式下每个会话新建一个实例，
 * 但它们共享 vector-client 的模块级单例 engine（单进程单锁）。
 */
export function buildKiMcpServer(authScopes: string[] | null = null): McpServer {
  const server = new McpServer({
    name: SERVICE_NAME,
    version: readKiVersion(),
  });
  registerQueryGroupTool(server);
  registerGetModuleInfoTool(server);
  registerSyncRelationTool(server);
  registerBulkSyncRelationTool(server);
  registerManageIndexTools(server, authScopes);
  registerSearchTool(server);
  registerStoreTool(server);
  registerBulkStoreTool(server);
  registerDeleteRelationTool(server);
  registerScopeListTool(server, authScopes);
  registerTagListTool(server);
  return server;
}

interface McpCliOptions {
  http: boolean;
  host: string;
  port: number;
  token?: string;
  allowedHosts?: string[];
  /** --web：HTTP 模式下同时提供前端静态页面（web/dist） */
  web: boolean;
}

/** 帮助文本：-h/--help 与未知参数时共用 */
const MCP_HELP = `ki mcp - 启动 kisearch MCP Server

用法：
  ki mcp                        stdio 模式（默认，单客户端单进程）
  ki mcp --http                 HTTP 共享单例（默认回环 127.0.0.1:7423，本机免鉴权）
  ki mcp --http --daemon        HTTP 模式后台常驻运行（-d 同义，脱离终端）
  ki mcp restart                重启 HTTP 单例（仅 HTTP 模式，后台常驻）
  ki mcp --status               查看 HTTP 单例运行状态（只读，不启动服务）
  ki mcp stop                   关闭本机所有 ki mcp 实例并清理 lock
  ki mcp token generate --scope <scope>  生成授权 Token（必须指定 scope：单个/逗号分隔多个/all）
  ki mcp token list             列出所有 Token（含明文与授权 scope）
  ki mcp token update <id> --scope <scope>  修改指定 Token 的授权 scope
  ki mcp token delete <id>      删除指定 Token（立即失效）

HTTP 模式参数：
  --host <addr>                 绑定地址（默认 127.0.0.1；非回环绑定需鉴权 Token）
  --port <port>                 端口（默认 7423）
  --token <value>               全权临时 Token（进程级，优先级高于多 Token 存储；也可用环境变量 KI_MCP_TOKEN）
  --allowed-hosts <a,b>         允许的 Host 头白名单（逗号分隔）
  --web                         HTTP 模式下同时提供前端静态页面（web/dist，浏览器访问 http://<host>:<port>/）
  --no-web                      显式关闭前端页面（restart 时用于覆盖上次的 --web 延续）
  --daemon, -d                  后台常驻运行（仅 HTTP 模式，含 --web；脱离终端）

提示：多个 IDE 共享同一持锁进程以避免向量库锁冲突，请用 ki mcp --http。`;

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
  const known = ['--http', '--host', '--port', '--token', '--allowed-hosts', '--status', '--web', '--no-web', '--daemon'];
  detectUnknownFlags(args, known, ['--host', '--port', '--token', '--allowed-hosts'], MCP_HELP);

  const http = args.includes('--http');
  // --web 显式开启；--no-web 显式关闭（优先级高于 --web，二者同时出现时以后者为准）
  const web = args.includes('--web') && !args.includes('--no-web');
  const daemon = args.includes('--daemon');
  if (!http) {
    // --daemon/-d 仅 HTTP 模式有意义：stdio 依赖 stdin/stdout 通信，后台运行会丢失传输通道
    if (daemon) {
      failJson(
        '--daemon/-d 仅支持 HTTP 模式，需配合 --http 使用（如 ki mcp --http --daemon）。stdio 模式通过 stdin/stdout 通信，无法后台运行。',
        'MCP_DAEMON_REQUIRES_HTTP',
      );
    }
    return { http: false, host: '', port: 0, web };
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

  // 非回环绑定必须可鉴权（远程裸奔不安全）：
  //   - 显式全权临时 Token（--token/env）优先，进程级生效，优先级高于存储；
  //   - 否则走多 Token 存储（~/.ki/mcp-tokens.json，ki mcp token generate 创建），须至少存在一个。
  // 回环绑定不校验存储：鉴权本就禁用，Token 不会生效。
  if (!isLoopbackHost(host) && (!resolvedToken || !resolvedToken.trim())) {
    const count = tokenCount();
    if (count === 0) {
      failJson(
        `HTTP 模式绑定非回环地址（${host}）时需配置鉴权：` +
          `推荐执行 ki mcp token generate --scope <...> 创建授权 Token，` +
          `或设置环境变量 KI_MCP_TOKEN / 传入 --token <值>（全权临时 Token）。` +
          `（若仅本机访问，可用默认回环绑定免鉴权）`,
        'MCP_HTTP_TOKEN_REQUIRED',
      );
    }
    tokenSource = `多 Token 存储（~/.ki/mcp-tokens.json，共 ${count} 个）`;
  }

  // REQ-04：非回环模式明示 Token 来源，避免“改了文件/环境变量为何不生效”的困惑
  if (!isLoopbackHost(host) && tokenSource) {
    process.stderr.write(
      `鉴权 Token 来源：${tokenSource}（优先级 --token > KI_MCP_TOKEN > 多 Token 存储）。\n`,
    );
  }

  return { http: true, host, port, token: resolvedToken, allowedHosts, web };
}

/** 从 args 解析并校验 --scope 参数（必须显式指定），返回归一化后的 scope 集合 */
function resolveScopesFlag(args: string[], action: string): string[] {
  const raw = getFlagValue(args, '--scope');
  if (!raw || !raw.trim()) {
    failJson(
      `${action} 必须显式指定 --scope（单个 / 多个逗号分隔 / ${ALL_SCOPES} 表示全部）。` +
        `例如：ki mcp token ${action}${action === 'generate' ? '' : ' <id>'} --scope team-a,team-b`,
      'MCP_TOKEN_SCOPE_REQUIRED',
    );
  }
  return resolveScopesArg(raw);
}

/** ki mcp token <generate|list|update|delete> 子命令：多 Token + scope 授权的全生命周期管理 */
function runTokenCommand(args: string[]): void {
  const action = args[0];

  // generate：生成授权 Token，必须显式指定 scope
  if (action === 'generate') {
    try {
      const scopes = resolveScopesFlag(args, 'generate');
      const record = createToken(scopes);
      console.log(
        JSON.stringify(
          {
            ok: true,
            id: record.id,
            token: record.token,
            scopes: record.scopes,
            createdAt: record.createdAt,
            hint:
              'Token 已生成（0600 落盘到 ~/.ki/mcp-tokens.json）。' +
              `授权 scope：${record.scopes.join(', ')}。` +
              'IDE 客户端配置 Authorization: Bearer <token>。请勿将明文粘贴到公开渠道。',
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

  // list：列出所有 Token（含明文与授权 scope，用户明确要求）
  if (action === 'list') {
    try {
      const records = listTokensStrict(); // 损坏时报错（MCP_TOKEN_CORRUPT），避免静默空列表误导
      console.log(
        JSON.stringify(
          {
            ok: true,
            count: records.length,
            tokens: records,
            hint:
              'Token 明文已列出（按需回显）。请勿将输出粘贴到公开渠道；' +
              '用 ki mcp token delete <id> 吊销，ki mcp token update <id> --scope <...> 改权限。',
          },
          null,
          2,
        ),
      );
    } catch (err) {
      const e = err as Error & { code?: string };
      failJson(e.message, e.code ?? 'MCP_TOKEN_LIST_FAILED');
    }
    return;
  }

  // update <id> --scope <...>：修改授权 scope
  if (action === 'update') {
    const id = args[1];
    if (!id) {
      failJson(
        'update 需要指定 Token 短 ID：ki mcp token update <id> --scope <...>（用 ki mcp token list 查看 id）。',
        'MCP_TOKEN_ID_REQUIRED',
      );
    }
    try {
      const scopes = resolveScopesFlag(args, 'update');
      const record = updateTokenScopes(id, scopes);
      console.log(
        JSON.stringify(
          {
            ok: true,
            id: record.id,
            scopes: record.scopes,
            createdAt: record.createdAt,
            hint: `Token（id: ${record.id}）授权 scope 已更新为：${record.scopes.join(', ')}。`,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      const e = err as Error & { code?: string };
      failJson(e.message, e.code ?? 'MCP_TOKEN_UPDATE_FAILED');
    }
    return;
  }

  // delete <id>：删除 Token，立即失效
  if (action === 'delete') {
    const id = args[1];
    if (!id) {
      failJson(
        'delete 需要指定 Token 短 ID：ki mcp token delete <id>（用 ki mcp token list 查看 id）。',
        'MCP_TOKEN_ID_REQUIRED',
      );
    }
    try {
      deleteToken(id);
      console.log(
        JSON.stringify(
          {
            ok: true,
            deleted: id,
            hint: `Token（id: ${id}）已删除并立即失效；已用该 Token 建立的服务端会话仍保留，但新请求会 401。`,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      const e = err as Error & { code?: string };
      failJson(e.message, e.code ?? 'MCP_TOKEN_DELETE_FAILED');
    }
    return;
  }

  failJson(
    `未知的 token 子命令（${action ?? '缺失'}）。可用：` +
      `ki mcp token generate --scope <...> | ki mcp token list | ki mcp token update <id> --scope <...> | ki mcp token delete <id>`,
    'MCP_TOKEN_UNKNOWN_ACTION',
  );
}

/** 读取 HTTP 单例 lock 文件（host/port/web 供 restart 沿用上次运行值），缺失/损坏返回 null */
function readHttpLock(): {
  pid?: number;
  host?: string;
  port?: number;
  startedAt?: string;
  web?: boolean;
} | null {
  try {
    const raw = JSON.parse(fs.readFileSync(getHttpLockPath(), 'utf-8')) as {
      pid?: number;
      host?: string;
      port?: number;
      startedAt?: string;
      web?: boolean;
    };
    return raw;
  } catch {
    return null;
  }
}

/** 判断 args 中是否含某 --flag（支持 --flag=value 与 --flag value 两种形式） */
function hasFlagValue(args: string[], name: string): boolean {
  return args.some((a) => a === name || a.startsWith(name + '='));
}

/**
 * 以守护进程方式重新拉起 HTTP 单例（detached + stdio 忽略，父进程立即退出）。
 * 与 bin/ki.mjs 的 daemon 启动路径一致：npx jiti <mcp-server.ts> --http --daemon ...
 */
function spawnMcpDaemon(args: string[]): void {
  const mcpServerPath = fileURLToPath(import.meta.url);
  const child = spawn('npx', ['jiti', mcpServerPath, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}

/**
 * ki mcp restart：停止现有 HTTP 单例后，以守护进程方式后台重启（仅 HTTP 模式）。
 * host/port 解析优先级：CLI > lock 文件（上次运行值）> 配置文件 > 默认。
 * 无运行实例时等价于直接启动（幂等）；重启后默认后台常驻（daemon）。
 */
async function runRestartCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const httpCfg = config.mcp?.http ?? {};
  const lock = readHttpLock();

  // host：CLI > lock > 配置 > 默认
  const cliHost = getFlagValue(args, '--host');
  const host = cliHost ?? lock?.host ?? httpCfg.host ?? DEFAULT_MCP_HTTP_HOST;

  // port：CLI > lock > 配置 > 默认
  const cliPortRaw = getFlagValue(args, '--port');
  let port: number;
  if (cliPortRaw !== undefined) {
    port = parseIntArg(cliPortRaw, DEFAULT_MCP_HTTP_PORT, '--port', { min: 1, max: 65535 });
  } else if (
    typeof lock?.port === 'number' &&
    Number.isInteger(lock.port) &&
    lock.port >= 1 &&
    lock.port <= 65535
  ) {
    port = lock.port;
  } else {
    port = resolveHttpPort(args, httpCfg);
  }

  // 守卫①（对齐 startMcpServer 的 stdio 冲突守卫）：存活的 stdio 实例会与 HTTP 单例争抢向量库锁，
  // 若在此静默 kill 会让用户某 IDE 的 stdio 连接无提示中断。fail-loud 并引导迁移 URL 接入。
  const stdioLocks = listLiveStdioLocks();
  if (stdioLocks.length > 0) {
    const first = stdioLocks[0];
    const extra = stdioLocks.length > 1 ? `（另有 ${stdioLocks.length - 1} 个 stdio 实例）` : '';
    process.stderr.write(
      `检测到存活的 ki mcp stdio 实例（pid ${first.pid}，启动于 ${first.startedAt}${extra}），` +
        `restart 不会静默关闭它，以免中断正在使用该实例的 IDE 连接。\n` +
        `请先将该 IDE 配置迁移为 URL 型接入（http://${probeHost(host)}:${port}/mcp），` +
        `再执行 ki mcp restart。\n`,
    );
    process.exit(1);
  }

  // 守卫②（对齐 startMcpServer 的非回环 token 校验）：重启后新进程才会 fail-loud 校验 token，
  // 若此处不提前拦截，restart 会先打印 ok:true 造成「重启成功」假象，随后新进程因缺 token 退出。
  // 复用 parseMcpArgs 的完整 token 校验链（--token > KI_MCP_TOKEN > 托管文件），仅用于验证不采信其返回值。
  if (!isLoopbackHost(host)) {
    parseMcpArgs(['--http', '--host', host, '--port', String(port)]);
  }

  // 关闭现有实例（复用 stop 的身份校验 + SIGTERM 优雅退出 + SIGKILL 兜底 + lock 清理）
  const report = await stopMcpInstances({ host: probeHost(host), port });

  // 后台重启：强制 --http --daemon；host/port/web 未显式传入时补齐（web 沿用上次运行值），
  // 再透传其余参数（--allowed-hosts/--token 等）。
  const filteredArgs = args.filter((a) => a !== '--daemon' && a !== '-d');
  const spawnArgs = ['--http', '--daemon'];
  if (!hasFlagValue(filteredArgs, '--host')) spawnArgs.push('--host', host);
  if (!hasFlagValue(filteredArgs, '--port')) spawnArgs.push('--port', String(port));
  // --web 延续：上次以 --web 启动（lock.web===true）且本次未显式指定 web 状态时，自动补回。
  // --no-web 显式关闭优先（可覆盖 lock 延续，让用户能去掉 web）；--web 显式开启则原样透传。
  const webExplicit = hasFlagValue(filteredArgs, '--web') || hasFlagValue(filteredArgs, '--no-web');
  if (!webExplicit && lock?.web === true) spawnArgs.push('--web');
  spawnArgs.push(...filteredArgs);
  spawnMcpDaemon(spawnArgs);

  const nothing = report.stopped.length === 0 && report.cleanedLocks.length === 0;
  console.log(
    JSON.stringify(
      {
        ok: true,
        restarted: true,
        target: { host: probeHost(host), port },
        stopped: report.stopped,
        cleanedLocks: report.cleanedLocks,
        hint: nothing
          ? '未发现运行中的实例，已直接后台启动（幂等）。'
          : '已后台重启 kisearch HTTP 服务（daemon 模式）。',
      },
      null,
      2,
    ),
  );
}

export async function startMcpServer(): Promise<void> {
  let argv = process.argv.slice(2);

  // -d 是 --daemon 的短别名，统一归一为 --daemon，后续逻辑只看 --daemon。
  // 必须在 positional 检测之前：否则 -d 会被下方「未知短 flag」分支拦截报错。
  argv = argv.map((a) => (a === '-d' ? '--daemon' : a));

  // ─── ki mcp -h/--help：打印帮助后直接退出，绝不落入默认 stdio 启动 ───
  //（-h 不带 -- 前缀，detectUnknownFlags 拦不住；必须在所有分发之前处理）
  if (argv.includes('-h') || argv.includes('--help')) {
    console.log(MCP_HELP);
    return;
  }

  // ─── 裸参数（positional）校验：仅允许 stop / token / restart 三个子命令 ───
  // 其他裸参数（如误输入 status 而非 --status）在 detectUnknownFlags 拦截不到
  //（它只扫 -- 前缀），若不校验会被静默忽略并直接启动 stdio 服务（NEG-01）。
  // 注意：必须跳过 flag 的分离值（--host 127.0.0.1 中的 127.0.0.1），
  // 否则会把合法 flag 值误判为裸参数（P1 回归）。
  // 单横线短 flag（-status 等）同样拦截：-h 已在上方 return，此处出现的任何 -xxx 均为未知。
  const knownPositionals = ['stop', 'token', 'restart'];
  let positional: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      // 分离值形式：--flag <value> 时 value 不是 flag，跳过
      if (!a.includes('=') && i + 1 < argv.length && !argv[i + 1].startsWith('-')) i++;
      continue;
    }
    if (a.startsWith('-')) {
      // 未知短 flag（如 -status）：-h 已提前处理，此处应为非法输入
      const tip = a === '-status' ? '，您是否想输入 --status（注意双横线前缀）？' : '';
      process.stderr.write(MCP_HELP + '\n');
      failJson(`未知参数 ${a}${tip}`, 'UNKNOWN_OPTION');
    }
    positional = a; // 首个非 flag token 即裸参数
    break;
  }
  if (positional !== undefined && !knownPositionals.includes(positional)) {
    const tip = positional === 'status' ? '，您是否想输入 --status（注意带 -- 前缀）？' : '';
    process.stderr.write(MCP_HELP + '\n');
    failJson(`未知参数 ${positional}${tip}`, 'UNKNOWN_OPTION');
  }

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

  // ─── ki mcp restart：仅 HTTP 模式，stop + 后台常驻重启 ───
  if (argv[0] === 'restart') {
    await runRestartCommand(argv.slice(1));
    return;
  }

  const opts = parseMcpArgs(argv);

  // ─── 启动守卫（预检之前）：幂等复用 / 多实例冲突检测 ───
  // 探活与 lock 检查必须前置，保证「已有实例可复用/该被拒绝」的判定不被预检
  // （如缺 embedding Key 的异构 shell）拦截——重复运行在任何环境下都安全。
  if (opts.http) {
    // 命中健康实例 → 复用退出，全程不做预检
    const live = await fetchHealthz(opts.host, opts.port);
    if (live?.ok === true && live?.name === SERVICE_NAME) {
      process.stderr.write(
        `已有健康的 kisearch 实例在 ${opts.host}:${opts.port}（pid ${live.pid}），复用该实例，本次不再启动。\n`,
      );
      process.exit(0);
    }
    // 存活的 stdio 实例会与 HTTP 单例争抢向量库锁 → 启动前指明冲突来源并拒绝（而非等取锁失败才报占用）
    const stdioLocks = listLiveStdioLocks();
    if (stdioLocks.length > 0) {
      const pids = stdioLocks.map((l) => l.pid).join(' ');
      process.stderr.write(
        `检测到存活的 ki mcp stdio 实例（pid ${pids}），` +
          `它与 HTTP 单例并存会争抢向量库锁导致降级，拒绝启动。\n` +
          `请先关闭该 stdio 进程（kill ${pids}）并将对应 IDE 配置迁移为 URL 型接入，再启动 HTTP 服务。\n`,
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
    if (live?.ok === true && live?.name === SERVICE_NAME) {
      // 展示用地址同步归一（0.0.0.0 等监听写法不是可连接地址）
      const connectHost = probeHost(guardHost);
      process.stderr.write(
        `已有健康的 kisearch HTTP 单例在 ${connectHost}:${guardPort}（pid ${live.pid}），` +
          `stdio 模式与其并存会争抢向量库锁，拒绝启动。\n` +
          `请将本 IDE 的 MCP 配置改为 URL 型接入：{ "url": "http://${connectHost}:${guardPort}/mcp" }。\n`,
      );
      process.exit(1);
    }
    // stdio 守卫②：登记自身 lock（供 HTTP/restart 检测 stdio 冲突 + stop 定位）。
    // 不再拒绝多实例：多 stdio 实例靠向量库空闲释放锁 + 撞锁重试错开共享，
    // 「错开使用」互不影响。返回的其他存活实例仅提示，不阻断。
    const others = acquireStdioLock();
    if (others.length > 0) {
      const pids = others.map((o) => o.pid).join(', ');
      process.stderr.write(
        `检测到已有 ki mcp stdio 实例（pid ${pids}），` +
          `多实例将共享向量库（空闲自动释放锁，错开使用互不影响；同时使用时会短暂等待）。\n`,
      );
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
  const stopVersionGuard = startVersionGuard(SERVICE_NAME);

  // 常驻进程启用向量库空闲释放锁：空闲超时后自动 closeEngine 释放 LOCK，
  // 让多 stdio 实例 / CLI 能错开共享同一向量库（撞锁时 probe/open 自动重试）。
  enableIdleClose(VECTOR_IDLE_CLOSE_MS);

  // ─── HTTP 共享单例模式（多 IDE 共享同一持锁进程） ───
  if (opts.http) {
    await startHttpMcpServer({
      host: opts.host,
      port: opts.port,
      token: opts.token,
      allowedHosts: opts.allowedHosts,
      web: opts.web,
      buildServer: buildKiMcpServer,
      onShutdown: stopVersionGuard,
    });
    return;
  }

  // ─── stdio 模式（默认，单客户端单进程） ───
  process.stderr.write(
    'kisearch MCP 以 stdio 模式启动（默认）。\n' +
      '多个 stdio 实例与 CLI 共享同一向量库：空闲自动释放锁，错开使用互不影响。\n',
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
