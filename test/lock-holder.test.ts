/**
 * test/lock-holder.test.ts
 *
 * 「向量库被其他进程占用」时反查持锁者（`lockedHint` 增强）回归：
 *   ① parseProcLocks 只认主行 —— `1: -> POSIX ...` 是**等待者**，绝不能报成持有者；
 *   ② parseProcLocks 的 device 校验与 inode-only 回退；
 *   ③ ★ 真实链路：系统 `flock(1)` 占住文件时，findLockHolder 必须报出该 PID/进程名，退出后不再报；
 *   ④ ★ 集成：lockedHint 撞锁文案带出真实持锁 PID，且原首行与处置步骤不丢；
 *   ⑤ formatLockHolder：本进程自持与外部进程两种措辞（前者指向"重启本服务"）；
 *   ⑥ redactCmdline：命令行里的敏感参数值被遮蔽后才展示（提示会进日志/HTTP/前端）。
 *
 * 运行：npx jiti test/lock-holder.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

import {
  deviceKeyOf,
  findLockHolder,
  formatLockHolder,
  formatLockHolderBrief,
  formatUptime,
  parseProcLocks,
  parseProcStatStartTicks,
  redactCmdline,
} from '../src/lib/lock-holder.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 真实 `/proc/locks` 形态样本：含同一 inode 上的持有者与等待者（`->` 行） */
const SAMPLE = [
  '1: POSIX  ADVISORY  WRITE 1013432 08:30:5731390 0 EOF',
  '2: FLOCK  ADVISORY  WRITE 920577 08:30:5511234 0 EOF',
  '3: -> POSIX  ADVISORY  WRITE 999999 08:30:5511234 0 EOF',
].join('\n');

const flockAvailable = process.platform === 'linux'
  && spawnSync('flock', ['--version'], { stdio: 'ignore', timeout: 5_000 }).status === 0;
const skipReason = !flockAvailable ? 'flock(1) 不可用（非 Linux 或未安装 util-linux）' : false;

test('① 只认主行：等待者（-> 行）不得被当成持锁者', () => {
  assert.equal(parseProcLocks(SAMPLE, '5511234', '08:30'), 920577, '应取主行持有者，而非 -> 等待者');
  assert.equal(parseProcLocks(SAMPLE, '5511234'), 920577, '不传 device 时应按 inode 匹配');
});

test('② device 校验与回退：device 不一致时不匹配，inode 不存在时返回 null', () => {
  assert.equal(parseProcLocks(SAMPLE, '5511234', '08:31'), null, 'device 不一致不应匹配');
  assert.equal(parseProcLocks(SAMPLE, '9999999', '08:30'), null, 'inode 不存在应返回 null');
  assert.equal(parseProcLocks('', '5511234'), null, '空内容应返回 null');
  assert.match(deviceKeyOf(12345), /^[0-9a-f]+:[0-9a-f]+$/, 'deviceKeyOf 应为 major:minor 十六进制');
});

test('③ 真实链路：flock(1) 持锁时能反查到该进程，退出后不再报', { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-lock-holder-'));
  const lockFile = path.join(dir, 'LOCK');
  fs.writeFileSync(lockFile, '');
  // flock -x <file> sleep 10：flock 进程拿到排他锁后 exec sleep（PID 不变）
  const child = spawn('flock', ['-x', lockFile, 'sleep', '10'], { stdio: 'ignore' });
  try {
    await sleep(500); // 等 flock 真正拿到锁
    const holder = findLockHolder(lockFile);
    assert.ok(holder, '应能反查到持锁进程（/proc/locks 中应有该 inode 的记录）');
    assert.equal(holder.pid, child.pid, `PID 应为 ${child.pid}，实际 ${holder.pid}`);
    assert.equal(holder.self, false, '持锁者是子进程，不是当前进程');
    assert.match(holder.cmd, /(flock|sleep)/, `命令行应指向 flock/sleep，实际 "${holder.cmd}"`);
    // 运行时长用于区分「刚启动正在干活」与「干完不退的残留进程」（#109）
    assert.equal(typeof holder.uptimeMs, 'number', '应能算出运行时长');
    assert.ok(holder.uptimeMs! >= 0 && holder.uptimeMs! < 60_000, `运行时长应在合理区间，实际 ${holder.uptimeMs}`);
  } finally {
    child.kill('SIGKILL');
    await sleep(50);
    // 锁随进程退出释放：此时不应再反查到持锁者
    assert.equal(findLockHolder(lockFile), null, '进程退出后不应再报持锁者');
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('④ 集成：lockedHint 撞锁文案带出真实持锁 PID，原首行与处置步骤不丢', { skip: skipReason }, async () => {
  const { lockedHint } = await import('../src/lib/vector-client.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-lock-hint-'));
  const lockFile = path.join(dir, 'LOCK');
  fs.writeFileSync(lockFile, '');
  const child = spawn('flock', ['-x', lockFile, 'sleep', '10'], { stdio: 'ignore' });
  try {
    await sleep(500);
    const hint = lockedHint(dir);
    assert.match(hint, /向量库被其他进程占用或存在崩溃残留/, '原提示首行仍在');
    assert.match(
      hint,
      new RegExp(`持锁进程：PID ${child.pid} \\((sleep|flock)`),
      `应给出真实持锁 PID 与进程名，实际：\n${hint}`,
    );
    assert.match(hint, /处置方式：/, '增强不得挤掉原有处置步骤');
  } finally {
    child.kill('SIGKILL');
    await sleep(50);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('⑤ formatLockHolder：自持与外部进程两种措辞', () => {
  const external = formatLockHolder({ pid: 920577, name: 'node', cmd: 'node .../jiti temp/repro-real-upstream.ts', self: false });
  assert.match(external, /^ {2}● 持锁进程：PID 920577 \(node\)/, '应带稳定前缀与 PID/进程名（供上层按需提取）');
  assert.match(external, /repro-real-upstream\.ts/, '外部进程应给出命令行摘要');

  const self = formatLockHolder({ pid: process.pid, name: 'node', cmd: 'node', self: true });
  assert.match(self, /本进程/, '自持应显式标注');
  assert.match(self, /重启本服务/, '自持的处置应指向重启本服务，而不是找外部实例');
});

test('⑥ redactCmdline：敏感参数值被遮蔽后才展示（提示会进日志/HTTP/前端）', () => {
  assert.equal(redactCmdline('node x.js --api-key=abc123 --token:def456'), 'node x.js --api-key=*** --token:***');
  assert.equal(redactCmdline('jiti temp/repro.ts --password hunter2'), 'jiti temp/repro.ts --password ***');
  assert.equal(redactCmdline('node srv.js --authorization Bearer sk-live-123'), 'node srv.js --authorization ***');
  assert.equal(redactCmdline('ki mcp --web --http'), 'ki mcp --web --http', '普通参数不得被改写');
  assert.equal(redactCmdline('flock -x /tmp/x/LOCK sleep 10'), 'flock -x /tmp/x/LOCK sleep 10', '含 lock 的路径不得误判为敏感');
});

test('⑦ /proc/<pid>/stat 解析：comm 含空格与括号时 starttime 不得错位', () => {
  // 第 2 字段 comm 内嵌 ")" 与空格：必须从**最后一个** ")" 之后切分
  const stat = '4242 (node /path/with space (x)) S 1 4242 4242 0 -1 4194560 1000 0 0 0 5 6 0 0 20 0 1 0 987654 123 456';
  assert.equal(parseProcStatStartTicks(stat), 987654);
  assert.equal(parseProcStatStartTicks('garbage'), null, '没有 ")" 应返回 null');
  assert.equal(parseProcStatStartTicks('1 (x) R 1 2 3'), null, '字段不足应返回 null');
});

test('⑧ formatUptime：秒/分/小时/天四档', () => {
  assert.equal(formatUptime(0), '0秒');
  assert.equal(formatUptime(48_000), '48秒');
  assert.equal(formatUptime(922_000), '15分22秒');
  assert.equal(formatUptime(3 * 3600_000 + 7 * 60_000), '3小时7分');
  assert.equal(formatUptime(3 * 86_400_000 + 16 * 3600_000), '3天16小时');
});

test('⑨ 提示文案带运行时长；brief 版为单行（供撞锁重试日志）', () => {
  const holder = { pid: 42, name: 'node', cmd: 'jiti temp/repro.ts', self: false, uptimeMs: 48_000 };
  assert.match(formatLockHolder(holder), /已运行 48秒/, '完整提示应带运行时长');
  assert.match(formatLockHolder(holder), /jiti temp\/repro\.ts/, '完整提示仍带命令行');

  const brief = formatLockHolderBrief(holder);
  assert.equal(brief, 'PID 42 (node)，已运行 48秒 — jiti temp/repro.ts');
  assert.ok(!brief.includes('\n'), 'brief 不得含换行（要拼进一行重试日志）');

  // 读不到启动时刻时保持原文案，不出现空的「已运行」
  const noUptime = formatLockHolderBrief({ pid: 7, name: 'node', cmd: '?', self: true });
  assert.equal(noUptime, 'PID 7 (node，本进程)');
});
