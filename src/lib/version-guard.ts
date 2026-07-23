/**
 * version-guard.ts —— MCP 长驻进程版本自检（NEG-13）
 *
 * MCP 服务是长驻进程：升级 ki（npm i -g / 覆盖 dist）后，正在运行的 server
 * 仍执行内存中的旧代码，用户无从感知，容易「改了不生效」。
 *
 * 本模块：
 *   - 启动时读取 package.json 版本并打印 banner（版本 / PID / 启动时间）
 *   - 监听 package.json 变化，检测到升级后向 stderr 告警并提示重启
 */

import fs from 'fs';
import path from 'path';
import { KI_ROOT } from './constants.js';

/** 读取当前 ki 版本（读取失败降级为 unknown，不阻断启动） */
export function readKiVersion(): string {
  try {
    const pkgPath = path.join(KI_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * 启动版本 banner + 监听升级。
 * 返回一个停止监听的函数（供关闭时调用）。
 */
export function startVersionGuard(serverName: string): () => void {
  const version = readKiVersion();
  const startedAt = new Date().toISOString();
  process.stderr.write(
    `[${serverName}] 版本 v${version} | PID ${process.pid} | 启动于 ${startedAt}\n` +
      `  提示：升级 ki 后需重启本 MCP 服务方能生效（长驻进程不会热加载新代码）\n`
  );

  const pkgPath = path.join(KI_ROOT, 'package.json');
  let warned = false;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(pkgPath, () => {
      if (warned) return;
      const latest = readKiVersion();
      if (latest !== version) {
        warned = true;
        process.stderr.write(
          `\n⚠️  [${serverName}] 检测到 ki 版本变化：v${version} → v${latest}\n` +
            `  当前进程仍在运行旧代码，请重启 MCP 服务（ki mcp）以加载新版本。\n`
        );
      }
    });
  } catch {
    // 文件监听不可用（如某些容器/网络文件系统）时静默跳过，仅保留启动 banner
  }

  return () => {
    try {
      watcher?.close();
    } catch {
      /* ignore */
    }
  };
}
