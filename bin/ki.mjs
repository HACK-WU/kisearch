#!/usr/bin/env node

/**
 * KiSearch CLI 入口
 * 
 * 使用方式：
 *   ki <command> [options]
 * 
 * 示例：
 *   ki scan-kb import --scope my-project --results ai-results.json
 *   ki manage-index --scope my-project --action create-root --root-name "我的项目"
 *   ki query-group --scope my-project
 */

import { execFileSync } from 'child_process';
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
  'scan-kb': 'scripts/scan-kb.ts',
  'manage-index': 'scripts/manage-index.ts',
  'query-group': 'scripts/query-group.ts',
  'get-module-info': 'scripts/get-module-info.ts',
  'sync-relation': 'scripts/sync-relation.ts',
  'import-kb': 'scripts/import-kb.ts',
  'migrate-keywords': 'scripts/migrate-keywords.ts',
  'mcp': 'scripts/mcp-server.ts',
  'setup': 'scripts/setup.ts',
  'search': 'src/search.ts',
  'store': 'src/store.ts',
  'bulk_store': 'src/bulk-store.ts',
  'config': 'scripts/config.ts',
  'backup': 'scripts/backup.ts',
  'restore': 'scripts/restore.ts',
  'export': 'scripts/export.ts',
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
  scan-kb           统一入口：import / diff / scan / vectorize
  manage-index      Group 树 CRUD
  query-group       查询 Group + 词云 + 分区
  get-module-info   读取本地 KB 原文
  sync-relation     写入 Relation + 关键词校验
  search            语义检索知识库内容
  store             存储文本到向量索引
  bulk_store        批量存储文本到向量索引
  config            配置管理：init
  backup            备份 scope 目录快照
  restore           从快照或 ai-results 还原
  export            导出 KB 为 Wiki Markdown
  import-kb         @deprecated 旧导入
  migrate-keywords  数据迁移
  mcp               启动 MCP Server (stdio 模式)
  setup             下载 Skills / Rules 到目标项目目录

全局参数：
  --config <path>   指定配置文件路径（可在任意命令位置使用）

示例：
  ki config init
  ki scan-kb import --scope my-project --results ai-results.json
  ki backup my-project
  ki restore my-project --from-snapshot --yes
  ki export my-project --output ./wiki-output
  ki manage-index --scope my-project --action create-root --root-name "我的项目"
  ki query-group --scope my-project
  ki search --scope my-project --query "用户登录流程"

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
  // 使用 jiti 执行 TypeScript 脚本
  // cwd 设为用户当前目录，确保相对路径参数（如 --results）正确解析
  execFileSync('npx', ['jiti', scriptPath, ...scriptArgs], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: childEnv,
  });
} catch (error) {
  // 如果脚本执行失败，退出码与子进程一致
  process.exit(error.status || 1);
}