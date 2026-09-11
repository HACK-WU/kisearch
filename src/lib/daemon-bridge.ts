import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import fs from 'node:fs';
import { ensureDaemon } from './daemon-client.js';
import { loadConfig } from './config.js';
import { DEFAULT_MCP_HTTP_HOST, DEFAULT_MCP_HTTP_PORT, getHttpLockPath } from './mcp-http.js';
import { acquireStdioLock, getStdioLockDir, releaseStdioLock } from './mcp-stdio-lock.js';

/** 将 stdio MCP 原样桥接到本机 daemon 的 HTTP MCP，会话与鉴权由 HTTP 端处理。 */
export async function startStdioDaemonBridge(): Promise<void> {
  await ensureDaemon();
  const lockDir = getStdioLockDir();
  acquireStdioLock(lockDir);
  let released = false;
  const release = (exitAfter = false): void => {
    if (released) {
      // 已释放过（例如 onclose 后再收到信号）：仍应退出，否则进程会残留。
      if (exitAfter) process.exit(0);
      return;
    }
    released = true;
    releaseStdioLock(lockDir);
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    // 注册了 SIGINT/SIGTERM 监听器就会抑制 Node 的默认终止行为：不显式 exit
    // 的话 Ctrl+C 只释放锁而桥接进程继续存活（stdio 传输、HTTP 连接都还在），
    // 用户需要按第二次 Ctrl+C 才真能杀掉——典型的“看起来能 Ctrl+C 但杀不掉”。
    if (exitAfter) process.exit(0);
  };
  const onSignal = (): void => { release(true); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const cfg = loadConfig().mcp?.http ?? {};
    let host = cfg.host ?? DEFAULT_MCP_HTTP_HOST;
    let port = cfg.port ?? DEFAULT_MCP_HTTP_PORT;
    try {
      const lock = JSON.parse(fs.readFileSync(getHttpLockPath(), 'utf8')) as { host?: string; port?: number };
      if (lock.host) host = lock.host;
      if (Number.isInteger(lock.port)) port = lock.port!;
    } catch { /* daemon 默认端点 */ }
    const target = host === '0.0.0.0' || host === '::' || host === 'localhost' ? '127.0.0.1' : host;
    const httpTransport = new StreamableHTTPClientTransport(new URL(`http://${target}:${port}/mcp`), {
      requestInit: { headers: process.env.KI_MCP_TOKEN ? { Authorization: `Bearer ${process.env.KI_MCP_TOKEN}` } : undefined },
    });
    await httpTransport.start();
    const stdio = new StdioServerTransport();
    httpTransport.onmessage = (message) => { void stdio.send(message); };
    // daemon 中途挂掉时必须明确断连：只写 stderr 会让 IDE 侧看到一个“静默无
    // 响应”的会话（既不报错也不结束），违背 fail-loud + 给出路。与 onclose 保持一致。
    httpTransport.onerror = (error) => {
      process.stderr.write(
        `daemon MCP 连接失败：${error.message}\n`
        + '请执行 ki mcp --status 确认 daemon 状态，必要时 ki mcp restart 重启。\n',
      );
      release();
      void stdio.close();
    };
    httpTransport.onclose = () => { release(); void stdio.close(); };
    stdio.onmessage = (message) => {
      void httpTransport.send(message).catch((err) => {
        process.stderr.write(`daemon MCP 请求失败：${(err as Error).message}\n`);
      });
    };
    stdio.onclose = () => { release(); void httpTransport.close(); };
    await stdio.start();
  } catch (err) {
    release();
    throw err;
  }
}
