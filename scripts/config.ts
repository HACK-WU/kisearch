#!/usr/bin/env node
/**
 * config.ts —— ki config 管理命令
 *
 * 子命令：
 *   init    生成配置文件模板到 .ki/config.json
 *
 * 用法：
 *   ki config init [--dir <path>] [--force]
 */

import { Command } from 'commander';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getKiRoot } from './lib/config.js';

// ─── 工具 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── 模板生成 ───

/**
 * 构建配置模板，自动探测现有数据目录
 *
 * 探测顺序：
 *  1. KI_DATA_DIR 环境变量（存量用户迁移）
 *  2. {KI_ROOT}/kb 目录是否存在且有内容
 *  3. 默认值 $HOME/.ki-data
 */
function buildConfigTemplate(kiRoot: string): Record<string, unknown> {
  let dataDir = '$HOME/.ki-data';

  if (process.env.KI_DATA_DIR) {
    dataDir = process.env.KI_DATA_DIR;
  } else {
    const defaultKb = path.join(kiRoot, 'kb');
    if (fs.existsSync(defaultKb)) {
      try {
        const entries = fs.readdirSync(defaultKb);
        if (entries.length > 0) {
          dataDir = defaultKb;
        }
      } catch {
        // ignore — fallback to default
      }
    }
  }

  return {
    dataDir,
    backupDir: '$HOME/.ki-backup',
    scopes: {},
  };
}

// ─── config init 处理 ───

interface ConfigInitOptions {
  dir?: string;
  force?: boolean;
}

function handleConfigInit(options: ConfigInitOptions): void {
  const targetDir = options.dir
    ? path.resolve(options.dir)
    : os.homedir();

  const configDir = path.join(targetDir, '.ki');
  const configFile = path.join(configDir, 'config.json');

  // 幂等检查
  if (fs.existsSync(configFile) && !options.force) {
    output({
      ok: true,
      action: 'config_init',
      configPath: configFile,
      existed: true,
      message: `配置文件已存在：${configFile}（使用 --force 覆盖）`,
    });
    return;
  }

  // 创建目录
  fs.mkdirSync(configDir, { recursive: true });

  // 生成模板
  const kiRoot = getKiRoot();
  const template = buildConfigTemplate(kiRoot);

  fs.writeFileSync(configFile, JSON.stringify(template, null, 2) + '\n', 'utf-8');

  output({
    ok: true,
    action: 'config_init',
    configPath: configFile,
    existed: false,
    message: `配置文件已生成：${configFile}\n请根据实际需要修改 dataDir / backupDir / scopes 字段。`,
  });
}

// ─── CLI 注册 ───

const program = new Command();
program.name('config').description('ki 配置管理');

program
  .command('init')
  .description('生成配置文件模板到 .ki/config.json')
  .option('--dir <path>', '目标目录，默认 $HOME')
  .option('--force', '强制覆盖已有配置文件')
  .action((opts) => {
    try {
      handleConfigInit(opts);
    } catch (err) {
      output({ ok: false, error: (err as Error).message });
      process.exit(1);
    }
  });

// 未匹配子命令时输出帮助
program.action(() => {
  program.outputHelp();
});

program.parse();
