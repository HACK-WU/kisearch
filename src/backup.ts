#!/usr/bin/env node
/**
 * backup.ts —— ki backup 手动备份命令
 *
 * 用法：
 *   ki backup <scope>               备份 scope 目录快照
 *   ki backup <scope> --list        列出已有备份
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, getScopeDataDir } from './lib/config.js';
import { validateScope } from './lib/scope.js';
import {
  backupScopeSnapshot,
  listBackups,
} from './lib/backup.js';
import { detectUnknownFlags, failJson, toErrorPayload } from './lib/cli-args.js';

// ─── 工具 ───

function output(result: Record<string, unknown>): void {
  console.log(JSON.stringify(result, null, 2));
}

// ─── 参数解析 ───

const args = process.argv.slice(2);

// 未知参数检测（NEG-01）：仅 --list 为合法 flag
detectUnknownFlags(args, ['--list']);

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
  const config = loadConfig();

  if (listMode) {
    // 列出备份
    const backups = listBackups(config, scope);
    output({
      ok: true,
      action: 'backup_list',
      scope,
      ...backups,
    });
  } else {
    // 执行备份
    const scopeDataDir = getScopeDataDir(config, scope);

    if (!fs.existsSync(scopeDataDir)) {
      throw new Error(`scope 数据目录不存在：${scopeDataDir}`);
    }

    // 检查是否有 relations-cache.json（确认 scope 已初始化）
    const rcPath = path.join(scopeDataDir, 'relations-cache.json');
    if (!fs.existsSync(rcPath)) {
      throw new Error(
        `scope "${scope}" 尚未初始化（缺少 relations-cache.json），请先执行 import`
      );
    }

    const backupDir = config.backupDir;
    const snapshotPath = backupScopeSnapshot(backupDir, scope, scopeDataDir);

    output({
      ok: true,
      action: 'backup',
      scope,
      snapshot: path.basename(snapshotPath),
      snapshotPath,
      message: `scope 快照已保存：${snapshotPath}`,
    });
  }
} catch (err) {
  output(toErrorPayload(err));
  process.exit(1);
}
