#!/usr/bin/env node
/**
 * config.ts —— ki config 管理命令
 *
 * 子命令：
 *   init    生成配置文件模板到 .ki/config.yaml（YAML 格式，含注释）
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

/** 展开 $HOME / ~ 前缀（供 mkdir 用） */
function expandHome(input: string): string {
  const home = os.homedir();
  return input.replace(/^\$HOME\b/, home).replace(/^~/, home);
}

// ─── 模板生成 ───

interface ConfigTemplateValues {
  dataDir: string;
  backupDir: string;
  vectorDir: string;
}

/**
 * 探测配置模板的默认路径值
 *
 * dataDir 探测顺序：
 *  1. KI_DATA_DIR 环境变量（存量用户迁移）
 *  2. {KI_ROOT}/kb 目录是否存在且有内容
 *  3. 默认值 $HOME/.ki-data
 */
function buildConfigTemplateValues(kiRoot: string): ConfigTemplateValues {
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
    vectorDir: '$HOME/.ki/vector',
  };
}

/**
 * 渲染带注释的 YAML 配置模板（用模板字符串拼接以保留注释）
 * 字段与 lib/config.ts 的 KiConfig / DEFAULT_EMBEDDING 对齐。
 */
function renderConfigYaml(v: ConfigTemplateValues): string {
  const now = new Date().toISOString();
  return `# KiSearch 配置文件
# 生成时间: ${now}
# 文档: https://github.com/your-repo/knowledge-indexer

# ─── 基础路径 ───
# KB 源数据目录：存放各 scope 的 markdown / ai-results.json / group-index.json
dataDir: ${v.dataDir}

# 备份目录：snapshot tar.gz 存放位置
backupDir: ${v.backupDir}

# ─── 向量配置 ───
# zvec collection 目录：向量数据库存储位置（独立，不进备份）
# 所有 scope 共享一个 collection，靠 metadata 字段隔离
vectorDir: ${v.vectorDir}

# Embedding 提供方配置
# apiKey 从环境变量 SILICONFLOW_API_KEY 读取，不写在此文件中
embedding:
  provider: siliconflow                    # embedding 提供方: siliconflow | openai-compatible
  baseURL: https://api.siliconflow.cn/v1   # API 端点
  model: Qwen/Qwen3-Embedding-8B           # 模型名称
  dimension: 4096                          # 向量维度（必须与建库时一致）

# ─── scope 护栏 ───
# default: 未传 --scope 时静默落 default（任意 scope 自动创建）
# strict:  必须显式传入已注册 scope，否则报错（fail-loud）
scopeMode: default

# ─── KB 目录映射 ───
# 每个 scope 可配置 KB 目录映射；未配置 kbDir 的 scope 数据落在 dataDir/{scope}
scopes:
  # 默认 scope：未传 --scope 时使用。留空（{}）即数据落在 dataDir/default
  default: {}
  # 自定义 scope 示例（按需取消注释）：
  #   注意 kbDir 会在其下自动创建 kb/{scope} 子目录（避免污染源码目录）
  # my-project:
  #   kbDir: /data/special-kb          # 实际数据在 /data/special-kb/kb/my-project
  #   sourceDir: ~/projects/my-wiki    # 源文件目录（wiki-sync / diff / import 依赖）
  #   rootName: wiki                   # Group 树根名
  #   wikiSync:                        # 可选: Wiki 自动同步
  #     enabled: true
  #     sourceDir: ~/projects/my-wiki
`;
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
  const configFile = path.join(configDir, 'config.yaml');

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

  // 创建 .ki 目录
  fs.mkdirSync(configDir, { recursive: true });

  // 生成模板
  const kiRoot = getKiRoot();
  const values = buildConfigTemplateValues(kiRoot);
  const yamlText = renderConfigYaml(values);

  fs.writeFileSync(configFile, yamlText, 'utf-8');

  // 同时创建 dataDir / backupDir / vectorDir（REQ-15）
  const createdDirs: string[] = [];
  for (const dir of [values.dataDir, values.backupDir, values.vectorDir]) {
    try {
      const abs = expandHome(dir);
      fs.mkdirSync(abs, { recursive: true });
      createdDirs.push(abs);
    } catch {
      // 目录创建失败不阻断 init（doctor 会检出）
    }
  }

  output({
    ok: true,
    action: 'config_init',
    configPath: configFile,
    existed: false,
    createdDirs,
    message: `配置文件已生成（YAML）：${configFile}\n请根据实际需要修改 dataDir / vectorDir / embedding / scopes 字段。\napiKey 请通过环境变量 SILICONFLOW_API_KEY 提供。`,
  });
}

// ─── CLI 注册 ───

const program = new Command();
program.name('config').description('ki 配置管理');

program
  .command('init')
  .description('生成配置文件模板到 .ki/config.yaml')
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
