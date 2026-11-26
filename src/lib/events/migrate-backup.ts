/**
 * 内置类型升级的共用备份（技术债四阶段 / 末位已关闭）。
 *
 * 为什么抽出来：两条迁移都会改同一份 `_types.json`，各自实现备份就会出现
 * 「后跑的覆盖前跑的备份」—— 回滚点指向半成品，比没有备份更危险。
 *
 * 约束：**不覆盖已有 `.bak`**。已存在时改用带时间戳的新文件，两份都留在盘上。
 */

import fs from 'node:fs';
import path from 'node:path';

import { getKbDir } from '../scope.js';

export function typesFilePath(scope: string): string {
  return path.join(getKbDir(scope), '.events', '_types.json');
}

/** 写盘前留一份备份；文件不存在（新 scope）返回 null —— 那种库本来就用内置定义，无需迁移 */
export function backupTypesFile(scope: string): string | null {
  const src = typesFilePath(scope);
  if (!fs.existsSync(src)) return null;
  let dest = `${src}.bak`;
  if (fs.existsSync(dest)) dest = `${src}.bak.${Date.now()}`;
  fs.copyFileSync(src, dest);
  return dest;
}
