#!/usr/bin/env node
/**
 * 跨平台执行 jiti 测试集合。
 *
 * 替代 `for f in test/*.test.ts; do npx jiti "$f"; done` —— bash 循环在 Windows 的
 * cmd.exe 下直接语法错误，npx 也无法被 execFile 直接 spawn。
 *
 * 用法：
 *   node scripts/run-tests.mjs                   # test/*.test.ts + test/chat/*.test.ts
 *   node scripts/run-tests.mjs test/chat         # 只跑指定目录
 *   node scripts/run-tests.mjs --jobs 8          # 并发文件数（默认 min(4, CPU/2)，最小 1）
 *   node scripts/run-tests.mjs --serial          # 串行执行
 *   node scripts/run-tests.mjs --timeout 300     # 单文件超时秒数（默认 120，0=不限）
 *
 * 为什么分批：每个测试文件是一个独立 Node 进程（jiti 转译 + 模块图加载），
 * 其中还有大量「文件内再 spawn CLI」的用例，串行时总体是各文件耗时之和。
 * 但依赖固定端口或真实 daemon 的用例并行会互相抢端口，因此这类文件单独串行。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jitiCliPath } from '../src/lib/jiti-cli.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const dirs = [];
  let jobs = Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2)));
  let timeoutSec = 120;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--serial') jobs = 1;
    else if (arg === '--jobs') jobs = Math.max(1, Number(argv[++i]) || 1);
    else if (arg === '--timeout') timeoutSec = Math.max(0, Number(argv[++i]) || 0);
    else if (arg.startsWith('--')) {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    } else dirs.push(arg);
  }
  return { dirs: dirs.length > 0 ? dirs : ['test', 'test/chat'], jobs, timeoutSec };
}

/**
 * 依赖固定端口（7423）或真实 daemon 的用例不能并行：会互相抢端口，
 * 也会和本机已有的 kisearch 实例冲突。命中即放到串行车道。
 */
function isPortOrDaemonSensitive(absolutePath) {
  const content = fs.readFileSync(absolutePath, 'utf8');
  return content.includes('bin/ki.mjs') || content.includes('7423') || content.includes('hasTestEmbeddingKey');
}

const { dirs, jobs, timeoutSec } = parseArgs(process.argv.slice(2));

const files = dirs.flatMap((target) => {
  const absolute = path.join(root, target);
  if (!fs.existsSync(absolute)) return [];
  if (fs.statSync(absolute).isFile()) return target.endsWith('.test.ts') ? [target] : [];
  return fs.readdirSync(absolute)
    .filter((name) => name.endsWith('.test.ts'))
    .sort()
    .map((name) => path.join(target, name));
});

if (files.length === 0) {
  console.error(`未找到测试文件：${dirs.join(', ')}`);
  process.exit(1);
}

const serialFiles = files.filter((file) => isPortOrDaemonSensitive(path.join(root, file)));
const parallelFiles = files.filter((file) => !serialFiles.includes(file));

const failures = [];
const timeouts = [];
const startedAt = Date.now();

function runOne(file) {
  return new Promise((resolve) => {
    const fileStartedAt = Date.now();
    const child = spawn(process.execPath, [jitiCliPath, path.join(root, file)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    let output = '';
    let timedOut = false;

    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });

    const timer = timeoutSec > 0
      ? setTimeout(() => {
        timedOut = true;
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
        } else {
          try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已退出 */ }
        }
      }, timeoutSec * 1000)
      : null;

    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      const took = ((Date.now() - fileStartedAt) / 1000).toFixed(1);
      if (timedOut) {
        timeouts.push(file);
        console.log(`✗ ${file}（超时 ${timeoutSec}s 已终止，用时 ${took}s；累计 ${seconds}s）`);
        failures.push(file);
      } else if (code !== 0) {
        console.log(`✗ ${file}（exit ${code}，用时 ${took}s；累计 ${seconds}s）\n${output}`);
        failures.push(file);
      } else {
        console.log(`✓ ${file}（${took}s，累计 ${seconds}s）`);
      }
      resolve();
    });
  });
}

async function runSerial(list, label) {
  if (list.length === 0) return;
  console.log(`\n── ${label}（${list.length} 个）──`);
  for (const file of list) {
    await runOne(file);
  }
}

async function runParallel(list, concurrency) {
  if (list.length === 0) return;
  console.log(`\n── 并行（${list.length} 个，并发 ${concurrency}）──`);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, list.length) }, async () => {
    while (index < list.length) {
      const file = list[index++];
      await runOne(file);
    }
  });
  await Promise.all(workers);
}

// 串行车道先跑：避免与并行车道抢占 7423 / daemon
await runSerial(serialFiles, '串行：端口 / daemon / 真实 embedding 相关');
await runParallel(parallelFiles, jobs);

const total = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n共 ${files.length} 个文件，用时 ${total}s，失败 ${failures.length} 个${timeouts.length ? `（其中超时 ${timeouts.length} 个）` : ''}`);
if (failures.length > 0) {
  console.log('失败清单：');
  for (const file of failures) console.log(`  - ${file}`);
  process.exit(1);
}
console.log('全部通过');
