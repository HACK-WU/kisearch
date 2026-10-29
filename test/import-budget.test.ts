/**
 * import-budget.test.ts —— S0-3（REQ-20260930-002）导入整批预算预检回归
 *
 * 纯单元测试（不触引擎/网络）：resolveImportBudget 优先级、preflightImportBudget
 * 三项判定、budgetViolationMessage 文案、以及护栏 #1——默认预算不挡既有成功规模
 * （1,866 文件 / 13,680 chunk）。
 *
 * 运行：npx jiti test/import-budget.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveImportBudget,
  preflightImportBudget,
  budgetViolationMessage,
  IMPORT_BUDGET_EXCEEDED,
  DEFAULT_MAX_BATCH_FILES,
  DEFAULT_MAX_BATCH_BYTES,
  DEFAULT_MAX_BATCH_CHUNKS,
} from '../src/lib/import-budget.js';

describe('resolveImportBudget：优先级与显式关闭', () => {
  it('缺省全走默认值', () => {
    const b = resolveImportBudget(undefined, undefined);
    assert.equal(b.maxBatchFiles, DEFAULT_MAX_BATCH_FILES);
    assert.equal(b.maxBatchBytes, DEFAULT_MAX_BATCH_BYTES);
    assert.equal(b.maxBatchChunks, DEFAULT_MAX_BATCH_CHUNKS);
  });

  it('配置 NaN（config.ts 已过滤为 undefined）→ 回落默认而非显式关闭', () => {
    // config 层 batchNum 会把 NaN 过滤为 undefined；此处锁 resolveImportBudget
    // 对 undefined 配置的语义：不进 DISABLED 分支（护栏：笔误不得静默拆预算）
    const b = resolveImportBudget(undefined, { maxBatchFiles: undefined });
    assert.equal(b.maxBatchFiles, DEFAULT_MAX_BATCH_FILES, 'undefined 配置回落默认值');
  });

  it('CLI 显式值 > scope 配置 > 默认值', () => {
    const b = resolveImportBudget(
      { maxBatchFiles: 100 },
      { maxBatchFiles: 50, maxBatchBytes: 1024 },
    );
    assert.equal(b.maxBatchFiles, 100, 'CLI 覆盖配置');
    assert.equal(b.maxBatchBytes, 1024, '配置覆盖默认');
    assert.equal(b.maxBatchChunks, DEFAULT_MAX_BATCH_CHUNKS, '未涉及项走默认');
  });

  it('CLI 传 ≤0 显式关闭该项（配置有值也关闭）', () => {
    const b = resolveImportBudget({ maxBatchFiles: 0 }, { maxBatchFiles: 50 });
    assert.equal(b.maxBatchFiles, undefined, 'CLI ≤0 = 关闭，不回落到配置');
  });

  it('配置 ≤0 也视为关闭', () => {
    const b = resolveImportBudget(undefined, { maxBatchBytes: -1 });
    assert.equal(b.maxBatchBytes, undefined);
  });
});

describe('preflightImportBudget：三项判定', () => {
  const base = { budget: { maxBatchFiles: 10, maxBatchBytes: 1000, maxBatchChunks: 100 } };

  it('三项均未超 → ok:true 且 stats 正确', () => {
    const r = preflightImportBudget({ ...base, files: ['a', 'b'], totalBytes: 500, estimatedChunks: 50 });
    assert.equal(r.ok, true);
    assert.deepEqual(r.violations, []);
    assert.deepEqual(r.stats, { fileCount: 2, totalBytes: 500, estimatedChunks: 50 });
  });

  it('单项超限 → 恰好一条 violation，类型/数值正确', () => {
    const r = preflightImportBudget({ ...base, files: new Array(11).fill('x'), totalBytes: 500, estimatedChunks: 50 });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1);
    assert.equal(r.violations[0].kind, 'files');
    assert.equal(r.violations[0].current, 11);
    assert.equal(r.violations[0].limit, 10);
  });

  it('多项同时超限 → 全部列出（不静默截断）', () => {
    const r = preflightImportBudget({ ...base, files: new Array(20).fill('x'), totalBytes: 5000, estimatedChunks: 500 });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 3);
    assert.deepEqual(r.violations.map((v) => v.kind), ['files', 'bytes', 'chunks']);
  });

  it('undefined 项 = 不限制（逃生口生效）', () => {
    const r = preflightImportBudget({
      budget: { maxBatchFiles: 1 },
      files: ['a', 'b', 'c'],
      totalBytes: 999999,
      estimatedChunks: 999999,
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 1, '仅检查显式设置项');
  });
});

describe('budgetViolationMessage：文案与错误码', () => {
  it('含每项明细与三条处理建议，人类可读字节单位', () => {
    const r = preflightImportBudget({
      budget: { maxBatchFiles: 1, maxBatchBytes: 1024 },
      files: ['a', 'b'],
      totalBytes: 5 * 1024 * 1024,
      estimatedChunks: 1,
    });
    const msg = budgetViolationMessage(r);
    assert.ok(msg.includes('文件数 2 超过上限 1'), '文件数明细');
    assert.ok(msg.includes('5.00 MiB'), '字节人类可读单位');
    assert.ok(msg.includes('拆分目录分批导入'), '处理建议 1');
    assert.ok(msg.includes('maxBatchFiles'), '配置项指引');
    assert.equal(IMPORT_BUDGET_EXCEEDED, 'IMPORT_BUDGET_EXCEEDED');
  });
});

describe('护栏 #1：默认预算不挡既有成功规模（S0-3 验收红线）', () => {
  it('1,866 文件 / 30 MiB / 13,680 chunk 样本在默认预算下 ok:true', () => {
    // ai-docs 2026-09-30 实测样本规模：1,866 文件、KB 29.3MB、13,680 chunk
    const r = preflightImportBudget({
      budget: resolveImportBudget(undefined, undefined),
      files: new Array(1866).fill('doc.md'),
      totalBytes: 30 * 1024 * 1024,
      estimatedChunks: 13680,
    });
    assert.equal(r.ok, true, '既有成功规模必须通过默认预算（护栏 #1）');
  });

  it('目标规模常规分批（10 万文档 ÷ 5 批 = 2 万/批）在默认预算下 ok:true', () => {
    const r = preflightImportBudget({
      budget: resolveImportBudget(undefined, undefined),
      files: new Array(20_000).fill('doc.md'),
      totalBytes: 2 * 1024 * 1024 * 1024, // 2 GiB
      estimatedChunks: 200_000,
    });
    assert.equal(r.ok, true, '默认预算须覆盖目标规模分批导入（护栏 #1）');
  });

  it('明显异常批次（目录级误操作量级）被拒绝', () => {
    const r = preflightImportBudget({
      budget: resolveImportBudget(undefined, undefined),
      files: new Array(50_000).fill('doc.md'),
      totalBytes: 10 * 1024 * 1024 * 1024,
      estimatedChunks: 800_000,
    });
    assert.equal(r.ok, false);
    assert.equal(r.violations.length, 3);
  });
});
