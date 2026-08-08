/**
 * interrupt.test.ts —— REQ-01/02 中断标记 + 并发导入锁（方案 D，批次 4）
 *
 * 契约：
 *   - 中断标记写入/读取/清除
 *   - interruptGuidance 引导文案（含 rebuild-vector）
 *   - 并发导入锁：获取/重复拒绝/释放/SIGKILL 残留清理
 *
 * 运行：npx jiti test/interrupt.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import {
  writeInterruptMark,
  readInterruptMark,
  interruptGuidance,
  clearInterruptMark,
  acquireImportLock,
  releaseImportLock,
  getInterruptMarkPath,
  getImportLockPath,
} from '../src/lib/interrupt.js';
import { ensureScopeDir } from '../src/lib/store.js';

const scope = `intr-${Date.now()}`;

describe('interrupt 中断标记 + 导入锁', () => {
  before(async () => {
    registerTestScope(scope);
    ensureScopeDir(scope);
  });

  after(() => {
    cleanupTestConfig();
  });

  it('写/读中断标记', () => {
    writeInterruptMark(scope, { processedFiles: 3, totalFiles: 10, signal: 'SIGINT' });
    const mark = readInterruptMark(scope);
    assert.ok(mark);
    assert.strictEqual(mark.processedFiles, 3);
    assert.strictEqual(mark.totalFiles, 10);
    assert.strictEqual(mark.signal, 'SIGINT');
    assert.ok(mark.interruptedAt);
  });

  it('引导文案含 rebuild-vector', () => {
    const g = interruptGuidance(scope);
    assert.ok(g && g.includes('rebuild-vector'), `引导应含 rebuild-vector：${g}`);
    assert.ok(g && g.includes('3/10'), `引导应含进度：${g}`);
  });

  it('清除标记后引导消失', () => {
    clearInterruptMark(scope);
    assert.strictEqual(interruptGuidance(scope), null);
    assert.ok(!fs.existsSync(getInterruptMarkPath(scope)));
  });

  it('并发锁：获取/重复拒绝/释放', () => {
    assert.strictEqual(acquireImportLock(scope), true, '首次获取应成功');
    assert.strictEqual(acquireImportLock(scope), false, '重复获取应拒绝');
    releaseImportLock(scope);
    assert.strictEqual(acquireImportLock(scope), true, '释放后可再获取');
    releaseImportLock(scope);
    assert.ok(!fs.existsSync(getImportLockPath(scope)), '释放后锁文件应删除');
  });

  it('SIGKILL 残留锁自动清理（pid 不存在）', () => {
    // 模拟残留锁：pid 不存在（999999）
    const lockPath = getImportLockPath(scope);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }));
    assert.strictEqual(acquireImportLock(scope), true, '残留锁（pid 不存在）应自动清理并获取成功');
    releaseImportLock(scope);
  });
});
