#!/usr/bin/env node

/**
 * kisearch CLI 入口
 * 
 * 使用方式：
 *   ki <command> [options]
 * 
 * 示例：
 *   ki scan-kb import --scope my-project --source ./wiki --group wiki
 *   ki manage-index --scope my-project --action create-root --root-name "我的项目"
 *   ki query-group --scope my-project
 */

import { spawn } from 'child_process';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 读取版本号
const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf-8'));
const VERSION = pkg.version;

// 命令映射
const COMMANDS = {
  'scan-kb': 'src/scan-kb.ts',
  'manage-index': 'src/manage-index.ts',
  'query-group': 'src/query-group.ts',
  'get-module-info': 'src/get-module-info.ts',
  'sync-relation': 'src/sync-relation.ts',
  'delete-relation': 'src/delete-relation.ts',
  'mcp': 'src/mcp-server.ts',
  'search': 'src/search.ts',
  'store': 'src/store.ts',
  'bulk-store': 'src/bulk-store.ts',
  'scope': 'src/scope.ts',
  'doc': 'src/doc.ts',
  'tag': 'src/tag.ts',
  'config': 'src/config.ts',
  'doctor': 'src/doctor.ts',
  'backup': 'src/backup.ts',
  'restore': 'src/restore.ts',
  'export': 'src/export.ts',
  'wiki-backfill': 'src/wiki-backfill.ts',
};

// 获取命令和参数
const args = process.argv.slice(2);

// 预解析全局 --config 参数（可在任意位置）
let configPath = null;
const filteredArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--config' && i + 1 < args.length) {
    configPath = args[++i];
  } else {
    filteredArgs.push(args[i]);
  }
}

const command = filteredArgs[0];

// 显示版本（支持过滤 --config 后的位置）
if (command === '--version' || command === '-V' || command === '-v' || filteredArgs.includes('--version')) {
  console.log(VERSION);
  process.exit(0);
}

// 显示帮助
if (!command || command === '--help' || command === '-h') {
  console.log(`
ki - AI 知识索引整理工具 (knowledge-indexer)

用法：
  ki <command> [options]

命令：
  scan-kb           统一入口：import（--source 直导，幂等追加）
  manage-index      Group 树 CRUD
  query-group       查询 Group + 分区
  get-module-info   读取本地 KB 原文
  sync-relation     写入 Relation + 本地 KB
  delete-relation   删除 Relation 及其关联数据（cache + KB + wiki + 向量）
  search            语义检索知识库内容
  store             存储文本到向量索引
  bulk-store        批量存储文本到向量索引
  scope             scope 管理：list / delete / clear（KB + 向量两层）
  doc               向量文档管理：list / delete
  tag               向量 tag 发现：list（只读，含文档数）
  config            配置管理：init（生成 YAML）
  doctor            配置诊断（apiKey/连通性/维度/目录）
  backup            备份 scope 目录快照
  restore           从快照还原
  export            导出 KB 为 Wiki Markdown
  wiki-backfill     KB 历史关系全量写回 Wiki（幂等补齐）
  mcp               启动 MCP Server（stdio 默认 / --http 共享单例）

全局参数：
  --config <path>   指定配置文件路径（可在任意命令位置使用）

示例：
  ki config init
  ki doctor
  ki scan-kb import --scope my-project --source ./wiki --group wiki
  ki scope list
  ki doc list --scope my-project --limit 10
  ki tag list --scope my-project
  ki backup my-project
  ki restore my-project --from-snapshot --yes
  ki export my-project --output ./wiki-output
  ki manage-index --scope my-project --action create-root --root-name "我的项目"
  ki query-group --scope my-project
  ki search --scope my-project --query "用户登录流程"
  ki mcp                                  # stdio 模式（默认）
  ki mcp --http                           # HTTP 共享单例（默认回环 127.0.0.1，本机免鉴权）
  ki mcp --http --daemon                  # HTTP 模式后台常驻运行（-d 同义，脱离终端）
  ki mcp restart                          # 重启 HTTP 单例（仅 HTTP 模式，后台常驻）
  ki mcp token generate --scope team-a    # 生成授权 Token（必须指定 scope：单个/多个/all）
  ki mcp token list                       # 列出所有 Token（含明文与授权 scope）
  ki mcp token update <id> --scope all    # 修改指定 Token 的授权 scope
  ki mcp token delete <id>                # 删除指定 Token（立即失效）
  ki mcp --http --host 0.0.0.0            # 对外监听（远程需 Bearer Token，鉴权基于多 Token 存储）
  ki mcp --status                         # 查看 HTTP 单例运行状态（只读）

详细帮助：
  ki <command> --help
`);
  process.exit(0);
}

// 检查命令是否存在
if (!COMMANDS[command]) {
  console.error(`错误：未知命令 "${command}"`);
  console.error(`可用命令：${Object.keys(COMMANDS).join(', ')}`);
  process.exit(1);
}

// 构建脚本路径
const scriptPath = path.join(PROJECT_ROOT, COMMANDS[command]);

// 获取剩余参数
const scriptArgs = filteredArgs.slice(1);

// 构建子进程环境变量
const childEnv = { ...process.env, KI_ORIGINAL_CWD: process.cwd() };
if (configPath) {
  childEnv.KI_CONFIG_PATH = path.resolve(configPath);
}

try {
  // 守护进程模式：--daemon/-d 后台常驻，仅 HTTP 模式有效（须与 --http 同时出现）。
  // detached + stdio 忽略，子进程脱离终端与父进程组；父进程 unref 后立即退出。
  // 不带 --http 的 --daemon 走正常 spawn，交由 mcp-server 内的「仅 HTTP 模式」校验报错。
  const isDaemon =
    scriptArgs.includes('--http') && (scriptArgs.includes('--daemon') || scriptArgs.includes('-d'));

  // 使用 jiti 执行 TypeScript 脚本（spawn 异步 + 信号转发）
  // cwd 设为用户当前目录，确保相对路径参数（如 --results）正确解析
  const child = spawn('npx', ['jiti', scriptPath, ...scriptArgs], {
    stdio: isDaemon ? 'ignore' : 'inherit',
    detached: isDaemon,
    cwd: process.cwd(),
    env: childEnv,
  });

  if (isDaemon) {
    child.unref();
    console.log('kisearch MCP 服务已在后台启动（daemon 模式）。');
    console.log('查看状态：ki mcp --status    |    关闭：ki mcp stop    |    重启：ki mcp restart');
    process.exit(0);
  }

  // REQ-01 信号透传：父进程收到 SIGTERM/SIGINT → 转发给子进程（子进程的 handler 写中断标记/清理后退出）。
  // 否则 SIGTERM 打到 ki.mjs 时 execFileSync/spawnSync 默认行为直接终止父进程，子进程 handler 不执行，
  // 导致"导入中断标记"机制在真实 CLI 链路失效（P0）。
  const forward = (sig) => {
    try { child.kill(sig); } catch { /* ignore */ }
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  const code = await new Promise((resolve) => {
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      console.error(`错误：启动子进程失败 — ${err.message}`);
      resolve(1);
    });
  });
  // 子进程退出后移除转发 handler，避免父进程常驻
  process.removeListener('SIGINT', forward);
  process.removeListener('SIGTERM', forward);
  process.exit(code);
} catch (error) {
  // 如果脚本执行失败，退出码与子进程一致
  process.exit(error.status || 1);
}