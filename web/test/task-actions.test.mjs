/**
 * 任务详情动作区模型单测（lib/taskActions.ts，2026-10-13）
 *
 * 锁住的不变量：
 *   1) 成功任务**没有**任何动作（修复前恒定显示「前往导入页处理 →」，与状态不符）；
 *   2) 有未完成清单且可重试 ⇒ 主按钮「重试未完成 N 篇」（不依赖浏览器凭据）；
 *   3) 不可重试 ⇒ 说清原因 + 给整批重导入口，绝不"点了没反应"；
 *   4) `unknown`（心跳丢失）**刻意不给重试**（进程可能仍在跑）；
 *   5) CLI 来源额外给可复制命令；非导入任务（重建/还原）只给命令（Web 无执行入口）；
 *   6) 归属异常（legacy / 清单已被覆盖）在 hint 里如实说明，不假装是本任务的清单。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});
const { taskDetailActions, cliCommandFor } = await vite.ssrLoadModule('/src/lib/taskActions.ts');
after(async () => vite.close());

/** 造一条任务（只覆盖关心字段） */
const task = (over = {}) => ({
  id: 'task-1',
  scope: 'ai-docs',
  operation: 'import',
  state: 'failed',
  source: 'web',
  ...over,
});

const kinds = (result) => result.actions.map((a) => a.kind);

describe('taskDetailActions：状态分流', () => {
  it('成功任务 → 无动作（不再显示「前往导入页处理」）', () => {
    const result = taskDetailActions({ task: task({ state: 'succeeded' }) });
    assert.deepEqual(result.actions, []);
    assert.equal(result.note, undefined);
  });

  it('进行中（running/queued）→ 无动作 + 进行中提示', () => {
    for (const state of ['running', 'queued']) {
      const result = taskDetailActions({ task: task({ state }) });
      assert.deepEqual(result.actions, []);
      assert.match(result.note, /进行中/);
    }
  });

  it('unknown（心跳丢失）→ **不给重试**，但给「重新检查」+ 确认后重导（否则用户被卡住）', () => {
    const result = taskDetailActions({
      task: task({ state: 'unknown' }),
      incomplete: { canRetry: true, itemCount: 5 },
    });
    assert.deepEqual(kinds(result), ['recheck', 'goto-import']);
    assert.equal(result.actions.some((a) => a.kind === 'retry-incomplete'), false);
    assert.match(result.note, /仍在运行|已中断/);
    assert.equal(result.noteTone, 'warn');
  });

  it('非导入任务（向量重建失败）→ 只给 CLI 命令（Web 无执行入口）', () => {
    const result = taskDetailActions({ task: task({ operation: 'rebuild-vector', state: 'failed' }) });
    assert.deepEqual(kinds(result), ['cli-command']);
    assert.equal(result.actions[0].command, 'ki restore ai-docs --rebuild-vector --yes');
  });
});

describe('taskDetailActions：import 任务的可重试分支', () => {
  it('可重试 → 主按钮「重试未完成 N 篇」+ 沿用说明', () => {
    const result = taskDetailActions({
      task: task({ state: 'partial' }),
      incomplete: { canRetry: true, itemCount: 1075, sourceKind: 'upload' },
    });
    assert.deepEqual(kinds(result), ['retry-incomplete']);
    assert.equal(result.actions[0].label, '重试未完成 1075 篇');
    assert.equal(result.actions[0].primary, true);
    assert.match(result.actions[0].hint, /只处理未完成文件/);
    assert.equal(result.note, undefined);
  });

  it('CLI 来源可重试 → 重试按钮 + 终端命令（命令用 scope，不含路径）', () => {
    const result = taskDetailActions({
      task: task({ state: 'cancelled', source: 'cli' }),
      incomplete: { canRetry: true, itemCount: 3, sourceKind: 'external' },
    });
    assert.deepEqual(kinds(result), ['retry-incomplete', 'cli-command']);
    assert.equal(result.actions[1].command, 'ki import -s ai-docs --retry-incomplete');
    assert.equal(result.actions[1].command.includes('/'), false, '命令不得含真实路径');
  });

  it('legacy 清单 → hint 说明归属未知（仍给重试）', () => {
    const result = taskDetailActions({
      task: task({ state: 'partial' }),
      incomplete: { canRetry: true, itemCount: 2, legacy: true, sourceKind: 'upload' },
    });
    assert.deepEqual(kinds(result), ['retry-incomplete']);
    assert.match(result.actions[0].hint, /无法确认归属/);
  });

  it('清单已属于另一个任务（taskId 不一致）→ **不给重试按钮**（否则必然 409），指路最新任务', () => {
    const result = taskDetailActions({
      task: task({ id: 'task-old', state: 'failed' }),
      incomplete: { canRetry: true, itemCount: 4, taskId: 'task-new', sourceKind: 'upload' },
    });
    assert.deepEqual(kinds(result), ['goto-import']);
    assert.match(result.note, /已被后续导入覆盖/);
    assert.match(result.note, /task-new|最新的导入任务/);
    assert.equal(result.noteTone, 'warn');
  });

  it('CLI 来源 + 归属冲突 → 仍给终端命令（CLI 按清单重试，不受 taskId 约束）', () => {
    const result = taskDetailActions({
      task: task({ id: 'task-old', state: 'failed', source: 'cli' }),
      incomplete: { canRetry: true, itemCount: 4, taskId: 'task-new', sourceKind: 'external' },
    });
    assert.deepEqual(kinds(result), ['goto-import', 'cli-command']);
    assert.equal(result.actions[1].command, 'ki import -s ai-docs --retry-incomplete');
  });

  it('itemCount=0 → 不给重试（边界）', () => {
    const result = taskDetailActions({
      task: task({ state: 'failed' }),
      incomplete: { canRetry: true, itemCount: 0, sourceKind: 'upload' },
    });
    assert.deepEqual(kinds(result), ['goto-import']);
  });
});

describe('taskDetailActions：import 任务的不可重试分支', () => {
  it('无清单 → 说清原因 + 整批重导入口', () => {
    const result = taskDetailActions({
      task: task({ state: 'failed' }),
      incomplete: { canRetry: false, itemCount: 0, reason: '没有待重试的未完成清单（可能已全部导入完成）' },
    });
    assert.deepEqual(kinds(result), ['goto-import']);
    assert.equal(result.actions[0].label, '前往导入页重新导入');
    assert.match(result.note, /没有待重试的未完成清单/);
    assert.match(result.note, /不会重复已完成文档/);
    assert.equal(result.noteTone, 'warn');
  });

  it('CLI 来源无清单 → 追加整批重导命令', () => {
    const result = taskDetailActions({
      task: task({ state: 'failed', source: 'cli' }),
      incomplete: { canRetry: false, itemCount: 0, reason: '源目录已不存在' },
    });
    assert.deepEqual(kinds(result), ['goto-import', 'cli-command']);
    assert.equal(result.actions[1].command, 'ki import -s ai-docs --source <目录>');
  });

  it('清单查询失败 → 与"无清单"区分（error 级别提示）', () => {
    const result = taskDetailActions({ task: task({ state: 'failed' }), incompleteError: true });
    assert.deepEqual(kinds(result), ['goto-import']);
    assert.match(result.note, /查询失败/);
    assert.equal(result.noteTone, 'error');
  });

  it('清单查询中 → 提示进行中且暂不给动作（避免误判"没有可重试项"）', () => {
    const result = taskDetailActions({ task: task({ state: 'failed' }), incompleteLoading: true });
    assert.deepEqual(result.actions, []);
    assert.match(result.note, /正在检查未完成清单/);
  });
});

describe('cliCommandFor：各操作的命令映射', () => {
  it('三种 operation 均给出不带路径的命令；未知 operation 返回 undefined', () => {
    assert.equal(cliCommandFor('import', 's1'), 'ki import -s s1 --retry-incomplete');
    assert.equal(cliCommandFor('rebuild-vector', 's1'), 'ki restore s1 --rebuild-vector --yes');
    assert.equal(cliCommandFor('restore-snapshot', 's1'), 'ki restore s1 --from-snapshot --yes');
    assert.equal(cliCommandFor('something-else', 's1'), undefined);
  });
});
