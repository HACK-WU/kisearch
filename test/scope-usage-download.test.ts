/**
 * scope 用量三元组：只读取件计量（REQ-20261124-002 · S-01）
 *
 * 守三件事：
 *   1. **旧二元组文件可读**：`[read, write]` 不报错、不迁移，`download` 视为 0；
 *   2. **download 独立计量**：只调 `download` 时 `read` / `write` 必须仍为 0
 *      （并入 read 会把冷库刷热，污染 heat 与评分衰减 —— Q2 拍板的约束）；
 *   3. **合并不丢数**：旧二元组 + 新增 download 写回后三项各自正确。
 *
 * 运行：npx jiti test/scope-usage-download.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  formatLocalDate,
  flushScopeUsage,
  getUsageStorePath,
  initScopeUsage,
  readScopeUsage,
  recordScopeUsage,
  resetScopeUsageForTest,
} from '../src/lib/scope-usage.js';

let dataDir: string;

before(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-usage-dl-'));
});

after(() => {
  resetScopeUsageForTest();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** 直接铺一份统计文件（模拟旧版本写下的数据） */
function writeUsageFile(scopes: Record<string, unknown>): void {
  const file = getUsageStorePath({ dataDir });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ v: 1, updatedAt: new Date().toISOString(), scopes }), 'utf-8');
}

function legacyRecord(days: number[]): Record<string, unknown> {
  const today = formatLocalDate(Date.now());
  return { firstSeen: today, lastUsedAt: Date.now(), days: { [today]: days } };
}

describe('scope 用量三元组', () => {
  it('旧二元组文件可读，download 缺省为 0', () => {
    resetScopeUsageForTest();
    writeUsageFile({ legacy: legacyRecord([3, 2]) });
    const snap = readScopeUsage({ dataDir }, 7);
    assert.equal(snap?.get('legacy')?.read, 3);
    assert.equal(snap?.get('legacy')?.write, 2);
    assert.equal(snap?.get('legacy')?.download, 0);
  });

  it('只记 download 时 read / write 仍为 0（不污染 heat 输入）', () => {
    resetScopeUsageForTest();
    fs.rmSync(getUsageStorePath({ dataDir }), { force: true });
    initScopeUsage({ dataDir });
    recordScopeUsage('withdl', 'download');
    flushScopeUsage();
    const snap = readScopeUsage({ dataDir }, 7);
    assert.equal(snap?.get('withdl')?.download, 1);
    assert.equal(snap?.get('withdl')?.read, 0);
    assert.equal(snap?.get('withdl')?.write, 0);
    // 但「最近使用时间」要体现（展示用），否则下载过的库看起来「从未使用」
    assert.ok((snap?.get('withdl')?.lastUsedAt ?? 0) > 0);
  });

  it('旧二元组与新 download 合并后三项各自正确', () => {
    resetScopeUsageForTest();
    writeUsageFile({ mix: legacyRecord([5, 4]) });
    initScopeUsage({ dataDir });
    recordScopeUsage('mix', 'download');
    recordScopeUsage('mix', 'read');
    flushScopeUsage();
    const snap = readScopeUsage({ dataDir }, 7);
    assert.equal(snap?.get('mix')?.download, 1);
    assert.equal(snap?.get('mix')?.read, 6);
    assert.equal(snap?.get('mix')?.write, 4);
  });
});
