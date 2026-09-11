#!/usr/bin/env node
/**
 * backup.ts —— ki backup 手动备份命令
 *
 * 用法：
 *   ki backup <scope>               备份 scope 目录快照
 *   ki backup <scope> --list        列出已有备份
 */

import { validateScope } from './lib/scope.js';
import {
  executeBackup,
  executeBackupList,
} from './lib/backup.js';
import { detectUnknownFlags, failJson, toErrorPayload } from './lib/cli-args.js';
import { callDaemon, shouldUseDaemonClient } from './lib/daemon-client.js';

// ─── 工具 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── 参数解析 ───

const args = process.argv.slice(2);

/** 帮助文本：-h/--help 与未知参数时共用 */
const BACKUP_HELP = `ki backup - 备份 scope 目录快照

用法：
  ki backup <scope>               备份 scope 目录快照
  ki backup <scope> --list        列出已有备份

选项：
  --list            列出已有备份（只读）
  -h, --help        显示帮助`;

// -h/--help：打印帮助后直接退出（-h 不带 -- 前缀，detectUnknownFlags 拦不住）
if (args.includes('-h') || args.includes('--help')) {
  console.log(BACKUP_HELP);
  process.exit(0);
}

// 未知参数检测（NEG-01）：仅 --list 为合法 flag；未知参数回退到帮助
detectUnknownFlags(args, ['--list'], [], BACKUP_HELP);

// 检查 --list
const listMode = args.includes('--list');
const filteredArgs = args.filter((a) => a !== '--list');

// scope 参数
const scope = filteredArgs[0];

if (!scope) {
  failJson('用法：ki backup <scope> [--list]', 'MISSING_SCOPE');
}

// ─── 主逻辑 ───

try {
  validateScope(scope);
  if (listMode) {
    const result = shouldUseDaemonClient()
      ? await callDaemon<Record<string, unknown>>('backup-list', { scope }, 0)
      : executeBackupList(scope);
    output(result as Record<string, unknown>);
  } else {
    const result = shouldUseDaemonClient()
      ? await callDaemon<Record<string, unknown>>('backup', { scope }, 0)
      : executeBackup({ scope });
    output(result as Record<string, unknown>);
  }
} catch (err) {
  output(toErrorPayload(err));
  process.exit(1);
}
