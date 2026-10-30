import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { buildKiMcpServer } from './lib/mcp-server-factory.js';
import { enableIdleClose } from './lib/vector-client.js';

// MCP Server 装配已抽到 lib/mcp-server-factory.ts —— 本文件末尾有 startMcpServer() 入口副作用，
// 任何单测 import 它都会真的把服务跑起来。这里 re-export 保持既有契约（stdio 与 HTTP 共用同一工厂）。
export { buildKiMcpServer };
import { loadConfig, invalidateConfigFreshness, getConfigLoadIssue } from './lib/config.js';
import { captureDaemonIdentity, isDaemonIdentityDrifted } from './lib/scope-collection.js';
import { getSharedOperationCoordinator } from './lib/operation-coordinator.js';
import { runHealthCheck, renderHealthReport } from './lib/health-check.js';
import { readKiVersion, startVersionGuard } from './lib/version-guard.js';
import { SERVICE_NAME } from './lib/constants.js';
import { jitiCliPath } from './lib/jiti-cli.mjs';
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
import { listLiveStdioLocks } from './lib/mcp-stdio-lock.js';
import { startDaemonRpcServer } from './lib/daemon-rpc.js';
import { startStdioDaemonBridge } from './lib/daemon-bridge.js';
import { startDataSourceScheduler, stopDataSourceScheduler } from './lib/datasource-scheduler.js';

/**
 * 向量库空闲释放锁超时（ms）：daemon 空闲后释放已打开的 Collection。
 *
 * 2026-09-14 并发查询实测：3s 过于激进——空闲后首个查询需重付 open（实测 355–418ms，
 * 占冷查总延迟 20–40%），且频繁 close/open 放大与在途请求的竞态窗口。
 * daemon 是向量库的唯一 owner，持锁本身不影响其他使用者，故放宽到 30s。
 */
const VECTOR_IDLE_CLOSE_MS = 30_000;
import { stopMcpInstances } from './lib/mcp-stop.js';
import {
  createToken,
  updateToken,
  deleteToken,
  listTokensStrict,
  resolveScopesArg,
  tokenCount,
  isReadOnlyFieldInvalid,
  ALL_SCOPES,
} from './lib/mcp-token.js';

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
  ki mcp                        stdio 模式（默认，桥接本机 daemon）
  ki mcp --http                 HTTP 共享单例/唯一 zvec owner（默认回环 127.0.0.1:7423，本机免鉴权）
  ki mcp --http --daemon        HTTP 模式后台常驻运行（-d 同义，脱离终端）
  ki mcp restart                重启 HTTP 单例（仅 HTTP 模式，后台常驻）
  ki mcp --status               查看 HTTP 单例运行状态（只读，不启动服务）
  ki mcp stop                   关闭本机所有 ki mcp 实例并清理 lock
  ki mcp token generate --scope <scope> [--read-only]  生成授权 Token（scope 必填：单个/逗号分隔多个/all）
  ki mcp token list             列出所有 Token（含明文、授权 scope、访问模式）
  ki mcp token update <id> [--scope <scope>] [--read-only|--read-write]
                                改授权 scope / 切换只读（两项至少给一个）
  ki mcp token delete <id>      删除指定 Token（立即失效）

只读 Token：远程 MCP 客户端连上后看不到写工具（new/update/delete 均不可用），
  且即使构造 tools/call 也会被拒绝。适用于只应检索、不应改库的 AI 客户端。

HTTP 模式参数：
  --host <addr>                 绑定地址（默认 127.0.0.1；非回环绑定需鉴权 Token）
  --port <port>                 端口（默认 7423）
  --token <value>               全权临时 Token（进程级，优先级高于多 Token 存储；也可用环境变量 KI_MCP_TOKEN）
  --allowed-hosts <a,b>         允许的 Host 头白名单（逗号分隔）
  --web                         HTTP 模式下同时提供前端静态页面（web/dist，浏览器访问 http://<host>:<port>/）
  --no-web                      显式关闭前端页面（restart 时用于覆盖上次的 --web 延续）
  --daemon, -d                  后台常驻运行（仅 HTTP 模式，含 --web；脱离终端）

提示：CLI、stdio MCP、HTTP MCP 共用同一 daemon；daemon 不可用时客户端会自动拉起，失败将明确报错。`;

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

/**
 * `ki mcp token` 子命令允许的 flag。
 * ⚠️ 缺了这道校验，`--readonly`（少一个连字符）、`--readOnly` 这类拼错会被静默忽略 ——
 * 用户以为已经设成只读，实际仍是读写（安全属性静默失效）。
 */
const TOKEN_ALLOWED_FLAGS = ['--scope', '--read-only', '--read-write'];

/**
 * 拼写近似匹配：把 `--readonly` / `--readOnly` / `--Read-Only` 这类写法归一到
 * `--read-only`，在错误文案里给出「您是否想输入 …？」。
 *
 * ★ 不把这些变体做成别名：`--read-only` 与 `--read-write` 是成对语义，
 *   多一套拼写只会让文档与 `--help` 分裂；而拼错必须**报错**——
 *   改动前 `--readonly` 会被静默忽略，命令返回 ok 但 Token 仍是读写（安全属性静默失效）。
 */
function suggestTokenFlag(name: string): string | undefined {
  const normalize = (s: string): string => s.replace(/^-+/, '').replace(/[-_]/g, '').toLowerCase();
  const target = normalize(name);
  return TOKEN_ALLOWED_FLAGS.find((f) => normalize(f) === target);
}

function rejectUnknownTokenFlags(args: string[]): void {
  for (const a of args) {
    if (!a.startsWith('--')) continue; // action / id 等位置参数
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (TOKEN_ALLOWED_FLAGS.includes(name)) continue;
    const suggestion = suggestTokenFlag(name);
    failJson(
      `未知参数 ${name}（ki mcp token 支持：${TOKEN_ALLOWED_FLAGS.join(' / ')}）。`
        + (suggestion
          ? `您是否想输入 ${suggestion}？`
          : '注意：--read-only 与 --read-write 需完整连字符，不是 --readonly。'),
      'MCP_TOKEN_UNKNOWN_OPTION',
    );
  }
}

/** 解析 `--read-only` / `--read-write` → boolean；都没传返回 undefined（保持当前模式）；同传报冲突 */
function resolveAccessModeFlag(args: string[]): boolean | undefined {
  const wantReadOnly = args.includes('--read-only');
  const wantReadWrite = args.includes('--read-write');
  if (wantReadOnly && wantReadWrite) {
    failJson(
      '--read-only 与 --read-write 不能同时使用：请二选一（都不传则保持当前访问模式）。',
      'MCP_TOKEN_FLAGS_CONFLICT',
    );
  }
  if (wantReadOnly) return true;
  if (wantReadWrite) return false;
  return undefined;
}

/** 访问模式标签（generate / list / update 输出统一口径） */
function accessModeLabel(readOnly: boolean): string {
  return readOnly ? '只读' : '读写';
}

/** ki mcp token <generate|list|update|delete> 子命令：多 Token + scope 授权 + 访问模式的生命周期管理 */
function runTokenCommand(args: string[]): void {
  const action = args[0];
  // 未知参数校验在**所有子命令**统一做（含 list/delete）：`--readonly` 这类拼错若被静默忽略，
  // 用户会以为设置已生效，而实际权限没变（安全属性静默失效）。
  rejectUnknownTokenFlags(args);

  // generate：生成授权 Token，必须显式指定 scope；--read-only 生成只读 Token
  if (action === 'generate') {
    try {
      const scopes = resolveScopesFlag(args, 'generate');
      const readOnly = resolveAccessModeFlag(args) === true;
      const record = createToken(scopes, undefined, readOnly);
      console.log(
        JSON.stringify(
          {
            ok: true,
            id: record.id,
            token: record.token,
            scopes: record.scopes,
            readOnly,
            accessMode: accessModeLabel(readOnly),
            createdAt: record.createdAt,
            hint:
              'Token 已生成（0600 落盘到 ~/.ki/mcp-tokens.json）。' +
              `授权 scope：${record.scopes.join(', ')}；访问模式：${accessModeLabel(readOnly)}。` +
              (readOnly
                ? '远程 MCP 客户端连上后只会看到读工具（检索/读取），写工具不会出现在工具列表里，构造调用也会被拒绝。'
                  + '注意：只读仅对**非回环来源**生效——本机 127.0.0.1 直连免鉴权，不受该限制；'
                  + '验证请从其他机器（或本机非回环 IP）连接。'
                : '该 Token 可读写。') +
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

  // list：列出所有 Token（含明文、授权 scope、访问模式，用户明确要求）
  if (action === 'list') {
    try {
      const records = listTokensStrict(); // 损坏时报错（MCP_TOKEN_CORRUPT），避免静默空列表误导
      const tokens = records.map((r) => {
        const readOnly = r.readOnly === true;
        // 字段被手改坏（"true" / 1）时按读写处理 —— 必须显式告警，否则只读限制静默失效
        const invalid = isReadOnlyFieldInvalid(r);
        return {
          ...r,
          readOnly,
          accessMode: accessModeLabel(readOnly),
          ...(invalid
            ? {
              warning:
                `readOnly 字段非法（值：${JSON.stringify(r.readOnly)}），已按读写处理；` +
                `如需只读请执行 ki mcp token update ${r.id} --read-only`,
            }
            : {}),
        };
      });
      console.log(
        JSON.stringify(
          {
            ok: true,
            count: tokens.length,
            tokens,
            hint:
              'Token 明文已列出（按需回显）。请勿将输出粘贴到公开渠道；' +
              '用 ki mcp token delete <id> 吊销，' +
              'ki mcp token update <id> [--scope <...>] [--read-only|--read-write] 改权限。',
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

  // update <id> [--scope <...>] [--read-only|--read-write]：改授权 scope / 切换访问模式
  if (action === 'update') {
    const id = args[1];
    if (!id) {
      failJson(
        'update 需要指定 Token 短 ID：ki mcp token update <id> [--scope <...>] [--read-only|--read-write]'
          + '（用 ki mcp token list 查看 id）。',
        'MCP_TOKEN_ID_REQUIRED',
      );
    }
    try {
      // scope 与访问模式均可单独修改：只想切只读时不必复述 scope（避免顺手改错授权范围）
      const patch: { scopes?: string[]; readOnly?: boolean } = {};
      const scopeRaw = getFlagValue(args, '--scope');
      if (scopeRaw !== undefined) patch.scopes = resolveScopesArg(scopeRaw);
      const mode = resolveAccessModeFlag(args);
      if (mode !== undefined) patch.readOnly = mode;
      if (patch.scopes === undefined && patch.readOnly === undefined) {
        failJson(
          'update 至少需要一项变更：--scope <...> 或 --read-only/--read-write（都不传则无任何改动）。',
          'MCP_TOKEN_UPDATE_NOTHING_TO_DO',
        );
      }
      const record = updateToken(id, patch);
      const readOnly = record.readOnly === true;
      console.log(
        JSON.stringify(
          {
            ok: true,
            id: record.id,
            scopes: record.scopes,
            readOnly,
            accessMode: accessModeLabel(readOnly),
            createdAt: record.createdAt,
            hint: `Token（id: ${record.id}）已更新：授权 scope = ${record.scopes.join(', ')}，`
              + `访问模式 = ${accessModeLabel(readOnly)}。`
              + '该变更对新请求立即生效；已连接的客户端需重连（或重启 IDE）才能刷新工具列表'
              + `（切回读写后写工具才会重新出现）。`,
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

/** pid 存活校验（与 listLiveStdioLocks 同手法：信号 0 探测，EPERM 也算存活） */
function isPidAlive(pid?: number): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
 * 以守护进程方式重新拉起 HTTP 单例（detached + stdio 忽略，父进程负责回传预检报告）。
 * 与 bin/ki.mjs 的 daemon 启动路径一致：当前 Node 进程直接执行本地 jiti CLI，
 * 避免 Windows 下无法 spawn npx.cmd。
 * 返回子进程句柄，供 restart 就绪等待使用（探测子进程是否在启动阶段退出）。
 */
function spawnMcpDaemon(args: string[]): ChildProcess {
  const mcpServerPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [jitiCliPath, mcpServerPath, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  return child;
}

/**
 * restart 就绪等待参数：jiti 冷启动（编译 TS）+ 启动预检（真实 embedding 探测 + 逐 Collection
 * 维度诊断）实测可达 1~2 分钟，故窗口默认 120s，并每 5s 输出心跳——旧实现静默轮询 30s，
 * 用户看到的是"命令挂住不动"。可用 KI_RESTART_READY_TIMEOUT_MS 覆盖。
 */
const RESTART_READY_TIMEOUT_MS = (() => {
  const raw = Number(process.env.KI_RESTART_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
})();
const RESTART_POLL_INTERVAL_MS = 300;
/** 就绪等待期间的心跳间隔：避免前台命令静默数分钟被误认为卡死 */
const RESTART_READY_HEARTBEAT_MS = 5_000;

/**
 * 等待重启后的新实例就绪（healthz ok）。
 * - 子进程在启动阶段退出 / spawn 失败 → fail-loud（复用 bin/ki.mjs 直启探测的语义，补齐 restart 链路缺口）
 * - 就绪 → 返回 true（此时新实例 lock 已写，后续 --status 目标解析正确）
 * - 超时 → 返回 false（不判死，调用方以"仍在启动中"提示收尾，--status 兜底）
 */
async function waitForRestartReady(child: ChildProcess, host: string, port: number): Promise<boolean> {
  // 用对象包装承载闭包赋值（TS 不追踪回调内的直接变量赋值收窄）
  const spawnError: { msg: string | null } = { msg: null };
  child.on('error', (err) => { spawnError.msg = err.message; });

  const start = Date.now();
  let lastHeartbeat = start;
  while (Date.now() - start < RESTART_READY_TIMEOUT_MS) {
    if (spawnError.msg) {
      failJson(
        `重启失败 —— daemon 进程启动异常（${spawnError.msg}）。` +
        `请前台运行同样命令（去掉 -d/--daemon）查看具体错误：\n  ki mcp --http --host ${host} --port ${port}`,
        'MCP_RESTART_FAILED',
      );
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      failJson(
        `重启失败 —— 新实例在启动阶段退出（exit ${child.exitCode ?? child.signalCode}），旧实例已停止。` +
        `请前台运行同样命令（去掉 -d/--daemon）查看具体错误：\n  ki mcp --http --host ${host} --port ${port}`,
        'MCP_RESTART_FAILED',
      );
    }
    const info = await fetchHealthz(probeHost(host), port, 1500);
    if (info?.ok === true && info.name === SERVICE_NAME) {
      process.stderr.write(`新实例已就绪（pid ${info.pid}，用时 ${Math.round((Date.now() - start) / 1000)}s）。\n`);
      return true;
    }
    if (Date.now() - lastHeartbeat >= RESTART_READY_HEARTBEAT_MS) {
      lastHeartbeat = Date.now();
      process.stderr.write(
        `  等待新实例就绪… ${Math.round((Date.now() - start) / 1000)}s`
        + '（冷启动需编译 TS + 启动预检，属正常慢启动，非卡死）\n',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, RESTART_POLL_INTERVAL_MS));
  }
  return false;
}

/**
 * 预检进度输出（单行覆盖写 stderr）：健康检查里的长耗时阶段（embedding 批量探测、
 * 逐 Collection 维度诊断）必须可见，否则 `ki doctor` / `ki mcp restart` 会静默数分钟。
 * 非 TTY（重定向/日志采集）不刷行，避免把日志塞满控制字符。
 */
function reportHealthProgress(done: number, total: number, label: string): void {
  if (total <= 0 || !process.stderr.isTTY) return;
  process.stderr.write(`\r  [${done}/${total}] ${label}`.padEnd(78).slice(0, 78));
}

/** 结束进度行（清掉残影，让后续报告从行首开始打印） */
function finishHealthProgress(): void {
  if (process.stderr.isTTY) process.stderr.write(`\r${' '.repeat(78)}\r`);
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

  // 仅拦截升级前遗留的直连 stdio 实例；新版本 stdio 是 daemon 桥接，不会持有 zvec 锁。
  // 若在此静默 kill 旧实例会让用户某 IDE 的连接无提示中断，因此 fail-loud。
  const stdioLocks = listLiveStdioLocks();
  if (stdioLocks.length > 0) {
    const first = stdioLocks[0];
    const extra = stdioLocks.length > 1 ? `（另有 ${stdioLocks.length - 1} 个 stdio 实例）` : '';
    process.stderr.write(
      `检测到升级前遗留的直连 ki mcp stdio 实例（pid ${first.pid}，启动于 ${first.startedAt}${extra}），` +
        `restart 不会静默关闭它，以免中断正在使用该实例的 IDE 连接。\n` +
        `请先关闭该旧实例（或重启对应 IDE）后，再执行 ki mcp restart。\n`,
    );
    process.exit(1);
  }

  // 守卫②（对齐 startMcpServer 的非回环 token 校验）：重启后新进程才会 fail-loud 校验 token，
  // 若此处不提前拦截，restart 会先打印 ok:true 造成「重启成功」假象，随后新进程因缺 token 退出。
  // 复用 parseMcpArgs 的完整 token 校验链（--token > KI_MCP_TOKEN > 托管文件），仅用于验证不采信其返回值。
  if (!isLoopbackHost(host)) {
    parseMcpArgs(['--http', '--host', host, '--port', String(port)]);
  }

  // 重启前在父进程完成预检：embedding 外部服务失败重试 1 次后只告警，
  // 同时让配置/目录等硬错误在停止旧实例前就 fail-loud，避免先停掉可用服务。
  // ⚠️ 这里**不做**逐 Collection 维度诊断（checkCollectionDimensions:false）：它是 O(scope)
  // 操作（每个 scope 开一次 Collection），1000 个 scope 会让"重启"变成分钟级阻塞，
  // 且旧实例仍在运行时每个持锁 scope 还要等探测超时。维度冲突在写入/检索时会按需拦截并给出
  // ki restore <scope> --rebuild-vector 指引；需要全量体检请单独跑 ki doctor。
  process.stderr.write('重启预检中（配置 / embedding；不含逐 scope 维度诊断）…\n');
  const preflight = await runHealthCheck(config, {
    embeddingFailure: 'warn',
    collectionDimensionFailure: 'warn',
    checkCollectionDimensions: false,
    onProgress: reportHealthProgress,
  });
  finishHealthProgress();
  process.stderr.write(renderHealthReport(preflight) + '\n');
  if (preflight.fail > 0) {
    failJson(
      '重启预检失败：存在 ❌ 硬失败项，旧实例未停止。请运行 `ki doctor` 排查配置或目录问题。',
      'MCP_RESTART_PREFLIGHT_FAILED',
    );
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
  const child = spawnMcpDaemon(spawnArgs);

  // 就绪等待（bug 修复）：此前 spawn 后立即 ok:true，新实例尚在 jiti 冷启动/预检阶段，
  // lock 未写、healthz 未服务——紧随的 --status 读不到 lock 回退默认端口（探错地址）报
  // running:false。现等待 healthz 就绪再返回；子进程早期退出则 fail-loud 暴露真实失败。
  const ready = await waitForRestartReady(child, probeHost(host), port);

  const nothing = report.stopped.length === 0 && report.cleanedLocks.length === 0;
  console.log(
    JSON.stringify(
      {
        ok: true,
        restarted: true,
        ready,
        target: { host: probeHost(host), port },
        stopped: report.stopped,
        cleanedLocks: report.cleanedLocks,
        hint: !ready
          ? `已后台重启，但 ${RESTART_READY_TIMEOUT_MS / 1000}s 内未就绪（可能仍在启动），请稍后执行 ki mcp --status 确认。`
          : nothing
          ? '未发现运行中的实例，已直接后台启动并就绪（幂等）。'
          : '已后台重启 kisearch HTTP 服务（daemon 模式），新实例已就绪。',
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
    // 探测目标解析（与 restart 语义对齐）：CLI 显式 > lock（pid 存活的运行值）> 配置 > 默认。
    // 此前 status 只走 CLI > 配置 > 默认——daemon 启动在非默认地址时，裸 --status 探错地址
    // 报 running:false，而输出里明明展示了 lock（target 与 lock 同屏不一致却不交叉验证）。
    // 陈旧 lock 防护：pid 已死的 lock 不参与回退（否则服务跑在 config 地址时反而探错）。
    const lock = readHttpLock();
    const liveLock = lock && isPidAlive(lock.pid) ? lock : null;
    const host = getFlagValue(argv, '--host') ?? liveLock?.host ?? httpCfg.host ?? DEFAULT_MCP_HTTP_HOST;
    const port = getFlagValue(argv, '--port') !== undefined
      ? resolveHttpPort(argv, httpCfg)
      : (liveLock?.port ?? resolveHttpPort(argv, httpCfg));
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

  // stdio 作为薄桥接，不在客户端进程打开 zvec；首次使用时自动拉起本机 daemon。
  if (!opts.http) {
    await startStdioDaemonBridge();
    return;
  }

  // ─── 启动守卫（预检之前）：幂等复用 / 多实例冲突检测 ───
  // 探活与 lock 检查必须前置，保证「已有实例可复用/该被拒绝」的判定不被预检
  // （如缺 embedding Key 的异构 shell）拦截——重复运行在任何环境下都安全。
  // 命中健康实例 → 复用退出，全程不做预检
  const live = await fetchHealthz(opts.host, opts.port);
  if (live?.ok === true && live?.name === SERVICE_NAME) {
    process.stderr.write(
      `已有健康的 kisearch 实例在 ${opts.host}:${opts.port}（pid ${live.pid}），复用该实例，本次不再启动。\n`,
    );
    process.exit(0);
  }
  // 旧版 stdio 实例仍可能直接持有旧布局的 zvec 锁；拒绝其与新 owner 并存，
  // 避免旧客户端绕过 daemon 造成跨进程锁竞争。
  const stdioLocks = listLiveStdioLocks();
  if (stdioLocks.length > 0) {
    const pids = stdioLocks.map((l) => l.pid).join(' ');
    process.stderr.write(
      `检测到存活的旧版 ki mcp stdio 实例（pid ${pids}），` +
        `它可能绕过 daemon 直接占用向量库，拒绝启动。\n` +
        `请先关闭该 stdio 进程（kill ${pids}）后再启动 HTTP daemon。\n`,
    );
    process.exit(1);
  }

  // ─── 启动预检（REQ-16）：复用 ki doctor 检查逻辑 ───
  // stdio 协议占用 stdout，报告一律写 stderr；embedding 外部服务失败仅警告，配置/目录等硬失败仍拒绝启动。
  // ⚠️ 不做逐 Collection 维度诊断（O(scope)：1000 个 scope 会让启动阻塞数分钟，且开机对每个
  // Collection 做 probe/open 正是历史上批量撞锁/泄漏 flock 的放大器）。维度冲突改为按需拦截：
  // 写入/检索命中时返回 VECTOR_DIMENSION_MISMATCH + 重建指引，前端两个页面也按该状态提示。
  try {
    const config = loadConfig();
    const report = await runHealthCheck(config, {
      embeddingFailure: 'warn',
      collectionDimensionFailure: 'warn',
      checkCollectionDimensions: false,
      // 启动预检是最长的启动阶段（真实 embedding 探测），输出进度便于运维判断"慢"而非"卡"
      onProgress: reportHealthProgress,
    });
    finishHealthProgress();
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

  // HTTP 进程即为唯一 zvec owner，同时开放本地 RPC 给 CLI/stdio 使用。
  process.env.KI_DAEMON_OWNER = '1';
  // 捕获启动时的身份指纹（vectorDir + dataDir）。loadConfig 已支持 mtime 热失效：
  // scope 授权类变更可热生效（否则撤权后仍 fail-open），但 vectorDir/dataDir 变更
  // 会让内存 engine 与新解析路径不一致，必须由 assertDaemonIdentityCurrent fail-loud。
  // 注意：客户端与 daemon 读同一份配置文件，热失效后两边指纹仍相同，ping 拦不住
  // 这类漂移（它比的是“客户端 vs 磁盘”，而漂移是“daemon 内存 vs 磁盘”）。
  captureDaemonIdentity(loadConfig());
  // 配置热失效的已知边界：statSync 只能看 mtimeMs + size，若配置文件被改写为
  // **字节数相同**的内容且落在同一毫秒内（如脚本 sed -i 原地替换同长度值），
  // 缓存不会失效 —— 实测可复现且非确定性（同长度改名零间隔：一次检出、一次漏检）。
  // 因该窗口涉及授权（撤权后仍可能放行），提供 SIGHUP 作为确定性出路（Unix 惯例）。
  // 仅对真正的后台 daemon 注册：前台 `ki mcp --http` 仍在终端进程组内，注册监听器
  // 会抑制 Node 默认终止行为 → 关终端后服务不退出、成为继续占用 HTTP 端口/RPC
  // socket/zvec 锁的孤儿；前台模式保留 SIGHUP 的默认终止语义。
  if (process.env.KI_DAEMON_DETACHED === '1') {
    process.on('SIGHUP', () => {
      // 队列非空时拒绝刷新：长操作（import/restore 可达数分钟）中途切配置，会让
      // 同一请求的前后半段按不同路径解析（全仓 82 处独立 loadConfig、无请求级快照），
      // 造成数据混合落位。“确定性出路”不能本身就是一致性风险源。
      const snapshot = getSharedOperationCoordinator().snapshot();
      const pending = Object.values(snapshot.queues).reduce((sum, n) => sum + n, 0);
      if (snapshot.activeWorkers > 0 || pending > 0) {
        process.stderr.write(
          `[kisearch-daemon] SIGHUP 已忽略：当前有 ${snapshot.activeWorkers} 个操作在执行、${pending} 个在排队。`
          + '长操作中途切换配置会导致同一请求前后半段按不同路径解析（数据混合落位）；'
          + '请等操作完成后重发 SIGHUP，或用 ki mcp restart 重启。\n',
        );
        return;
      }
      // 必须「先失效新鲜度、再重读」而不是「先 resetConfigCache 再 loadConfig」：
      // 后者会先销毁 last-known-good、再去读可能已损坏的配置；而信号回调内抛异常
      // 无 uncaughtException 兜底 → daemon 当场崩溃并绕过优雅关闭（HTTP lock 与 RPC
      // socket 残留、在跑的写盘中途被斩断）—— 运维最需要它的时刻（怀疑配置有问题
      // → kill -HUP）反而变成自杀开关。
      try {
        invalidateConfigFreshness();
        const next = loadConfig();
        const issue = getConfigLoadIssue();
        process.stderr.write(
          '[kisearch-daemon] 收到 SIGHUP：配置缓存已强制刷新（scope 授权/token 类变更即时生效）。\n'
          + (isDaemonIdentityDrifted(next)
            ? '[kisearch-daemon] 注意：vectorDir/dataDir 已变，属身份漂移，必须 ki mcp stop && ki mcp --http --daemon 重启；SIGHUP 不能代替重启。\n'
            : '')
          + (issue ? `[kisearch-daemon] 注意：配置源当前有问题（${issue}），已沿用上一份配置。\n` : ''),
        );
      } catch (err) {
        // 走到这里说明连 last-known-good 都没有（首次加载即失败）：保留错误可见，
        // 但绝不让信号回调抛异常终止进程。
        process.stderr.write(
          `[kisearch-daemon] SIGHUP 刷新失败：${(err as Error).message}\n`
          + '请执行 ki doctor 排查配置文件；修复后重发 SIGHUP 即生效，无需重启。\n',
        );
      }
    });
  }
  const daemonRpc = await startDaemonRpcServer();

  // daemon 启用向量库空闲释放：空闲超时后释放已打开的 Collection，降低 mmap/worker 占用。
  enableIdleClose(VECTOR_IDLE_CLOSE_MS);

  await startHttpMcpServer({
    host: opts.host,
    port: opts.port,
    token: opts.token,
    allowedHosts: opts.allowedHosts,
    web: opts.web,
    buildServer: buildKiMcpServer,
    onShutdown: () => {
      stopDataSourceScheduler();
      stopVersionGuard();
      daemonRpc.close();
    },
  });
  // HTTP 服务已监听成功后才启动调度（重复实例会在 startHttpMcpServer 内直接 exit）
  startDataSourceScheduler();
}

// 入口
startMcpServer().catch((err: unknown) => {
  // 启动失败多为配置/端口类问题：直接打印 Error 对象会把唯一可读的信息淹没在
  // 几十行调用帧里（用户看到的是 "at parseAndExpand (...)" 而不是"配置哪错了"）。
  // 默认只输出 message，多行时统一缩进；完整堆栈用 KI_DEBUG=1 显式索取。
  const message = err instanceof Error ? err.message : String(err);
  console.error(`MCP Server 启动失败：\n  ${message.split('\n').join('\n  ')}`);
  if (process.env.KI_DEBUG === '1' && err instanceof Error && err.stack) {
    console.error(err.stack);
  }
  process.exit(1);
});
