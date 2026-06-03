#!/usr/bin/env node

/**
 * knowledge-indexer CLI 入口
 * 
 * 使用方式：
 *   knowledge-indexer <command> [options]
 * 
 * 示例：
 *   knowledge-indexer scan-kb import --scope my-project --results ai-results.json
 *   knowledge-indexer manage-index --scope my-project --action create-root --root-name "我的项目"
 *   knowledge-indexer query-group --scope my-project
 */

import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

// 命令映射
const COMMANDS = {
  'scan-kb': 'scripts/scan-kb.ts',
  'manage-index': 'scripts/manage-index.ts',
  'query-group': 'scripts/query-group.ts',
  'get-module-info': 'scripts/get-module-info.ts',
  'sync-relation': 'scripts/sync-relation.ts',
  'import-kb': 'scripts/import-kb.ts',
  'migrate-keywords': 'scripts/migrate-keywords.ts',
};

// 获取命令和参数
const args = process.argv.slice(2);
const command = args[0];

// 显示帮助
if (!command || command === '--help' || command === '-h') {
  console.log(`
knowledge-indexer - AI 知识索引整理工具

用法：
  knowledge-indexer <command> [options]

命令：
  scan-kb           统一入口：import / diff / scan / vectorize
  manage-index      Group 树 CRUD
  query-group       查询 Group + 词云 + 分区
  get-module-info   读取本地 KB 原文
  sync-relation     写入 Relation + 关键词校验
  import-kb         @deprecated 旧导入
  migrate-keywords  数据迁移

示例：
  knowledge-indexer scan-kb import --scope my-project --results ai-results.json
  knowledge-indexer manage-index --scope my-project --action create-root --root-name "我的项目"
  knowledge-indexer query-group --scope my-project
  knowledge-indexer get-module-info --scope my-project --group "我的项目/API" --relation "用户登录"

详细帮助：
  knowledge-indexer <command> --help
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
const scriptArgs = args.slice(1);

try {
  // 使用 jiti 执行 TypeScript 脚本
  execFileSync('npx', ['jiti', scriptPath, ...scriptArgs], {
    stdio: 'inherit',
    cwd: PROJECT_ROOT,
  });
} catch (error) {
  // 如果脚本执行失败，退出码与子进程一致
  process.exit(error.status || 1);
}