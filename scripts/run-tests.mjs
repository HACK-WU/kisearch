#!/usr/bin/env node
/**
 * 跨平台执行 jiti 测试集合。
 *
 * 替代 `for f in test/*.test.ts; do npx jiti "$f"; done` —— bash 循环在 Windows 的
 * cmd.exe 下直接语法错误，npx 也无法被 execFile 直接 spawn。
 *
 * 用法：
 *   node scripts/run-tests.mjs            # test/*.test.ts + test/chat/*.test.ts
 *   node scripts/run-tests.mjs test/chat  # 只跑指定目录
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jitiCliPath } from '../src/lib/jiti-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['test', 'test/chat'];

const files = dirs.flatMap((dir) => {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => path.join(dir, name));
});

if (files.length === 0) {
  console.error(`未找到测试文件：${dirs.join(', ')}`);
  process.exit(1);
}

for (const file of files) {
  console.log(`\n▶ ${file}`);
  const result = spawnSync(process.execPath, [jitiCliPath, path.join(root, file)], {
    stdio: 'inherit',
    cwd: root,
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n全部通过：${files.length} 个测试文件`);
