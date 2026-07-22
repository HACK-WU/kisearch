/**
 * lib 模块单元测试
 * 
 * 覆盖：WAL 读写一致性、tmp 清理、scope 校验、评分公式、recordUse 防刷、
 *       hybridPartition 分区+截断+isImported 过滤、boundaryDecay 纯函数
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { walWrite, cleanupTmpFiles } from '../src/lib/wal.js';
import { validateScope, getKbDir, getGroupIndexPath } from '../src/lib/scope.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import {
  calculateScore,
  recordUse,
  hybridPartition,
  boundaryDecay,
  type Relation,
} from '../src/lib/scoring.js';
import { DEFAULT_PARTITION_CONFIG } from '../src/lib/constants.js';

// ─── 临时目录 ───

let tmpDir: string;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-test-'));

  // 隔离配置：创建测试专用 config.json，确保不依赖全局配置
  const testConfigDir = path.join(tmpDir, '.ki');
  fs.mkdirSync(testConfigDir, { recursive: true });
  const testConfig = { dataDir: path.join(tmpDir, 'kb'), backupDir: path.join(tmpDir, 'backup'), scopes: {} };
  fs.writeFileSync(path.join(testConfigDir, 'config.json'), JSON.stringify(testConfig));
  resetConfigCache();
  loadConfig(path.join(testConfigDir, 'config.json'));
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─── WAL 测试 ───

describe('WAL 写入', () => {
  it('写入后读取数据一致', () => {
    const filePath = path.join(tmpDir, 'test.json');
    const data = { version: 1, name: 'test', items: [1, 2, 3] };
    walWrite(filePath, data);

    const read = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.deepStrictEqual(read, data);
  });

  it('写入后无 .tmp 残留', () => {
    const filePath = path.join(tmpDir, 'test2.json');
    walWrite(filePath, { ok: true });

    const files = fs.readdirSync(tmpDir);
    assert.ok(!files.some((f) => f.endsWith('.tmp')));
  });

  it('覆盖写入保留数据完整性', () => {
    const filePath = path.join(tmpDir, 'test3.json');
    walWrite(filePath, { v: 1 });
    walWrite(filePath, { v: 2 });

    const read = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    assert.strictEqual(read.v, 2);
  });
});

describe('WAL 残留清理', () => {
  it('清理目录中的 .tmp 文件', () => {
    const cleanDir = path.join(tmpDir, 'clean-test');
    fs.mkdirSync(cleanDir, { recursive: true });
    fs.writeFileSync(path.join(cleanDir, 'a.tmp'), 'x');
    fs.writeFileSync(path.join(cleanDir, 'b.tmp'), 'y');
    fs.writeFileSync(path.join(cleanDir, 'c.json'), 'z');

    const count = cleanupTmpFiles(cleanDir);
    assert.strictEqual(count, 2);

    const remaining = fs.readdirSync(cleanDir);
    assert.deepStrictEqual(remaining, ['c.json']);
  });

  it('空目录返回 0', () => {
    const emptyDir = path.join(tmpDir, 'empty-test');
    fs.mkdirSync(emptyDir, { recursive: true });
    assert.strictEqual(cleanupTmpFiles(emptyDir), 0);
  });
});

// ─── Scope 校验测试 ───

describe('Scope 校验', () => {
  it('合法 scope 通过', () => {
    assert.doesNotThrow(() => validateScope('project-a'));
    assert.doesNotThrow(() => validateScope('my_project'));
    assert.doesNotThrow(() => validateScope('test123'));
  });

  it('非法 scope 拒绝', () => {
    assert.throws(() => validateScope(''), /不能为空/);
    assert.throws(() => validateScope('../etc'), /不合法/);
    assert.throws(() => validateScope('a/b'), /不合法/);
    assert.throws(() => validateScope('a b'), /不合法/);
    assert.throws(() => validateScope('a..b'), /不合法/);
  });

  it('路径构造函数使用合法 scope', () => {
    const kbDir = getKbDir('project-a');
    assert.ok(kbDir.endsWith('/project-a'), `kbDir should end with /project-a, got: ${kbDir}`);

    const indexPath = getGroupIndexPath('project-a');
    assert.ok(indexPath.endsWith('/project-a/group-index.json'));
  });
});

// ─── 评分公式测试 ───

describe('评分公式 calculateScore', () => {
  const now = Date.now();

  it('useCount=0 返回 0', () => {
    assert.strictEqual(calculateScore(0, null, now), 0);
  });

  it('高频使用（刚用过）≈ useCount', () => {
    const score = calculateScore(10, now - 6000, now); // 0.1 小时前
    assert.ok(score > 9.5);
  });

  it('中频使用（1天前）≈ 2.5', () => {
    const score = calculateScore(5, now - 24 * 3600000, now);
    assert.ok(Math.abs(score - 2.5) < 0.1);
  });

  it('新内容首次使用 = 1.0', () => {
    const score = calculateScore(1, now, now);
    assert.strictEqual(score, 1);
  });

  it('长时间未用自然衰减', () => {
    const score = calculateScore(3, now - 7 * 24 * 3600000, now); // 7天前
    assert.ok(score < 0.5);
  });

  it('lastUsedTime=null 视为刚使用', () => {
    const score = calculateScore(5, null, now);
    assert.strictEqual(score, 5);
  });

  it('halfLifeHours 参数生效', () => {
    const score1 = calculateScore(5, now - 24 * 3600000, now, 24);
    const score2 = calculateScore(5, now - 24 * 3600000, now, 48);
    assert.ok(score2 > score1); // 半衰期更长，衰减更慢
  });

  it('评分特性表验证', () => {
    // 低频使用（2天前）
    const score = calculateScore(2, now - 48 * 3600000, now);
    assert.ok(Math.abs(score - 0.67) < 0.1);
  });
});

// ─── recordUse 测试 ───

describe('recordUse 防刷分', () => {
  const now = Date.now();

  const baseRelation: Relation = {
    id: 'rel_001',
    text: '测试',
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    keywords: [],
    isImported: false,
  };

  it('首次使用 useCount=1', () => {
    const result = recordUse(baseRelation, now);
    assert.strictEqual(result.useCount, 1);
    assert.strictEqual(result.lastUsedTime, now);
  });

  it('5分钟内重复使用不计数', () => {
    const used = { ...baseRelation, useCount: 3, lastUsedTime: now };
    const result = recordUse(used, now + 2 * 60 * 1000); // 2分钟后
    assert.strictEqual(result.useCount, 3); // 不变
  });

  it('5分钟后使用计数+1', () => {
    const used = { ...baseRelation, useCount: 3, lastUsedTime: now };
    const result = recordUse(used, now + 6 * 60 * 1000); // 6分钟后
    assert.strictEqual(result.useCount, 4);
  });

  it('不超过 maxUseCount=10', () => {
    const maxed = { ...baseRelation, useCount: 10, lastUsedTime: now - 3600000 };
    const result = recordUse(maxed, now);
    assert.strictEqual(result.useCount, 10);
  });

  it('不修改原始对象', () => {
    const original = { ...baseRelation, useCount: 2, lastUsedTime: now - 3600000 };
    const result = recordUse(original, now);
    assert.strictEqual(original.useCount, 2); // 原始不变
    assert.strictEqual(result.useCount, 3);
  });
});

// ─── hybridPartition 测试 ───

describe('hybridPartition 冷热分区', () => {
  const now = Date.now();

  function makeRelation(id: string, useCount: number, hoursAgo: number, isImported = false): Relation {
    return {
      id,
      text: id,
      score: 0,
      useCount,
      lastUsedTime: hoursAgo >= 0 ? now - hoursAgo * 3600000 : null,
      keywords: [],
      isImported,
    };
  }

  it('基本分区功能', () => {
    const items = [
      makeRelation('r1', 10, 0.1),  // 高分
      makeRelation('r2', 5, 1),     // 中分
      makeRelation('r3', 2, 48),    // 低分
      makeRelation('r4', 1, 168),   // 很低
    ];

    const result = hybridPartition(items, now, DEFAULT_PARTITION_CONFIG);
    assert.ok(result.hot.length >= 1);
    assert.ok(result.warm.length >= 0);
    assert.ok(result.cold.length >= 0);
    assert.strictEqual(result.hot.length + result.warm.length + result.cold.length, 4);
  });

  it('上限截断 maxHotCount', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      makeRelation(`r${i}`, 10 - i * 0.5, i)
    );

    const config = { ...DEFAULT_PARTITION_CONFIG, maxHotCount: 3 };
    const result = hybridPartition(items, now, config);
    assert.ok(result.hot.length <= 3);
  });

  it('新兴热区基于最近使用，不区分 isImported', () => {
    const items = [
      makeRelation('imported', 10, 1, true), // 导入的，最近使用
      makeRelation('native', 5, 2, false),   // 原生的，最近使用
    ];

    const config = { ...DEFAULT_PARTITION_CONFIG, reservedEmerging: 5 };
    const result = hybridPartition(items, now, config);

    // 两者都应该在新兴热区（因为都是最近使用的）
    const importedInHot = result.hot.find((r) => r.id === 'imported');
    const nativeInHot = result.hot.find((r) => r.id === 'native');
    
    // 两者都应该在 hot 中（新兴热区）
    assert.ok(importedInHot, 'imported item should be in hot (emerging)');
    assert.ok(nativeInHot, 'native item should be in hot (emerging)');
  });
});

// ─── boundaryDecay 测试 ───

describe('boundaryDecay 边界衰减', () => {
  function makeRelation(id: string, score: number): Relation {
    return { id, text: id, score, useCount: 1, lastUsedTime: Date.now(), keywords: [], isImported: false };
  }

  it('不触发衰减（新分数低于热区最低）', () => {
    const hot = [makeRelation('h1', 10), makeRelation('h2', 5)];
    const warm = [makeRelation('w1', 3)];

    const result = boundaryDecay(hot, warm, 4);
    assert.strictEqual(result.triggered, false);
  });

  it('触发衰减（新分数高于热区最低）', () => {
    const hot = [makeRelation('h1', 10), makeRelation('h2', 5)];
    const warm = [makeRelation('w1', 3)];

    const result = boundaryDecay(hot, warm, 8);
    assert.strictEqual(result.triggered, true);
    assert.ok(result.originMax !== undefined);
  });

  it('纯函数：不修改输入', () => {
    const hot = [makeRelation('h1', 10), makeRelation('h2', 5)];
    const warm = [makeRelation('w1', 3)];
    const hotCopy = hot.map((r) => ({ ...r }));
    const warmCopy = warm.map((r) => ({ ...r }));

    boundaryDecay(hot, warm, 8);

    assert.deepStrictEqual(hot, hotCopy);
    assert.deepStrictEqual(warm, warmCopy);
  });

  it('衰减步长可配置', () => {
    const hot = [makeRelation('h1', 10)];
    const warm = [makeRelation('w1', 5)];

    const result3 = boundaryDecay(hot, warm, 12, 3);
    const result8 = boundaryDecay(hot, warm, 12, 8);

    // decayStep 越大，热区最高分衰减越多
    assert.ok(result3.hotItems[0].score > result8.hotItems[0].score);
  });
});
