/**
 * 任务列表行模型单测（REQ-20261022-002）
 *
 * 锁住全宽列表的六列口径：
 *   - 状态 / 任务 / 知识库 / 来源 / 结果摘要 / 时间；
 *   - 失败错误与摘要并列，不互相覆盖；
 *   - 运行中进度、排队/运行中时间提示；
 *   - 任务列不再展示任务 ID（完整 ID 在详情抽屉）；
 *   - 时间列 2026-10-30 起为 `YYYY-MM-DD HH:mm:ss`（用户指定，精确到秒）；
 *   - 全 0 摘要压缩成「无变更」，但失败 / 状态未知除外。
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
const { buildTaskListRow } = await vite.ssrLoadModule('/src/lib/taskListModel.ts');
const { operationLabel, sourceLabel, stateLabel } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');

after(async () => { await vite.close(); });

const NOW = 1_790_000_000_000;

function baseTask(overrides = {}) {
  return {
    id: 'abcdef1234567890',
    source: 'web',
    operation: 'import',
    scope: 'langchain',
    state: 'succeeded',
    createdAt: NOW,
    updatedAt: NOW,
    heartbeatAt: NOW,
    startedAt: NOW + 1_000,
    finishedAt: NOW + 8_000,
    result: {
      files: {
        scanned: 251, completed: 251, incomplete: 0, skipped: 0,
        unchanged: 224, duplicatesSkipped: 0,
        skippedReasons: { conflict: 0, duplicate: 0, other: 0 },
      },
      groups: ['deepagents'],
    },
    ...overrides,
  };
}

describe('任务列表行：六列口径', () => {
  it('完成态给出操作 / 状态 / 来源 / 摘要 / 持续时间（不再带任务 ID）', () => {
    const row = buildTaskListRow(baseTask());
    assert.equal(row.stateLabel, '已完成');
    assert.equal(row.operationLabel, '上传导入');
    assert.equal(row.sourceLabel, '网页');
    assert.equal(row.scope, 'langchain');
    assert.equal(row.resultSummary, '成功 251 · 跳过 0 · 未完成 0');
    assert.equal('shortId' in row, false, '列表行不再输出短 ID');
    assert.equal('id' in row, false, '列表行不再输出任务 ID');
    assert.equal(row.durationLabel, '7s');
    assert.equal(row.progressPercent, null);
    assert.equal(row.resultTone, 'normal');
    assert.equal(row.resultError, undefined);
    assert.match(row.timeLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.match(row.ariaLabel, /已完成，上传导入，langchain，网页/);
  });

  it('失败态：错误与摘要并列，颜色转 danger', () => {
    const row = buildTaskListRow(baseTask({
      state: 'failed',
      error: '磁盘写满，无法写入元数据',
      result: undefined,
    }));
    assert.equal(row.stateLabel, '失败');
    assert.equal(row.resultTone, 'danger');
    assert.equal(row.resultError, '磁盘写满，无法写入元数据');
    assert.match(row.ariaLabel, /磁盘写满/);
  });

  it('部分完成 / 取消给 warn，不被当成成功或失败', () => {
    assert.equal(buildTaskListRow(baseTask({ state: 'partial' })).resultTone, 'warn');
    assert.equal(buildTaskListRow(baseTask({ state: 'cancelled', result: undefined })).resultTone, 'warn');
  });

  it('运行中给出进度百分比与「运行中」持续时间', () => {
    const row = buildTaskListRow(baseTask({
      state: 'running',
      finishedAt: undefined,
      result: undefined,
      progress: { phase: 'vectorize', done: 42, total: 100 },
    }));
    assert.equal(row.stateLabel, '运行中');
    assert.equal(row.progressPercent, 42);
    assert.equal(row.durationLabel, '运行中');
    assert.equal(row.resultSummary, '向量化 42/100 段');
  });

  it('排队中按创建时间展示，持续时间留空', () => {
    const row = buildTaskListRow(baseTask({
      state: 'queued',
      startedAt: undefined,
      finishedAt: undefined,
      result: undefined,
      progress: undefined,
    }));
    assert.equal(row.stateLabel, '排队中');
    assert.equal(row.durationLabel, '—', '排队中还没有持续时间');
    assert.match(row.timeLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('无总数不渲染进度条（避免 0/0 被算成 100%）', () => {
    const row = buildTaskListRow(baseTask({
      state: 'running',
      finishedAt: undefined,
      result: undefined,
      progress: { phase: 'scan', done: 0, total: 0 },
    }));
    assert.equal(row.progressPercent, null);
  });

  it('终态不渲染进度条（完成的任务行下留绿条会被读成还在跑）', () => {
    const row = buildTaskListRow(baseTask({
      progress: { phase: 'persist', done: 1, total: 1 },
    }));
    assert.equal(row.progressPercent, null);
  });
});

describe('结果摘要：新增文档数与摘要横排', () => {
  const withResult = (result) => baseTask({ result: { ...baseTask().result, ...result } });

  it('createdTotal 优先，接在摘要后面同一行', () => {
    const row = buildTaskListRow(withResult({
      createdTotal: 308,
      created: [['langchain', 'a.md']],
    }));
    assert.equal(row.resultSummary, '成功 251 · 跳过 0 · 未完成 0 · 新增文档 308 篇', '明细被截断也按总数显示');
    assert.match(row.ariaLabel, /新增文档 308 篇/);
  });

  it('只有 created 明细时退回条目数', () => {
    const row = buildTaskListRow(withResult({
      created: [['langchain', 'a.md'], ['langchain', 'b.md']],
    }));
    assert.equal(row.resultSummary, '成功 251 · 跳过 0 · 未完成 0 · 新增文档 2 篇');
  });

  it('新增 0 篇照实显示（增量同步未变时不能消失）', () => {
    const row = buildTaskListRow(withResult({ createdTotal: 0, created: [] }));
    assert.equal(row.resultSummary, '成功 251 · 跳过 0 · 未完成 0 · 新增文档 0 篇');
  });

  it('旧记录没有该快照时摘要不变（不能显示成 0 篇）', () => {
    assert.equal(buildTaskListRow(baseTask()).resultSummary, '成功 251 · 跳过 0 · 未完成 0');
  });
});

describe('时间格式：2026-10-30 15:57:55', () => {
  it('终态用开始时间，精确到秒', () => {
    const row = buildTaskListRow(baseTask({ createdAt: Date.UTC(2026, 9, 30, 7, 57, 55), startedAt: Date.UTC(2026, 9, 30, 7, 57, 55), finishedAt: Date.UTC(2026, 9, 30, 7, 57, 58) }));
    assert.match(row.timeLabel, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(row.timeTitle, row.timeLabel, '未排队时提示与正文一致');
  });

  it('排队过（创建 ≠ 开始）时提示补出创建时间', () => {
    const row = buildTaskListRow(baseTask({
      createdAt: NOW,
      startedAt: NOW + 30_000,
      finishedAt: NOW + 31_000,
    }));
    assert.match(row.timeTitle, /^创建 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} · 开始 \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('结果摘要：全 0 压缩为「无变更」', () => {
  const zero = () => baseTask({
    state: 'succeeded',
    result: {
      files: { scanned: 0, completed: 0, incomplete: 0, skipped: 0, unchanged: 0, duplicatesSkipped: 0 },
      createdTotal: 0,
      created: [],
    },
  });

  it('成功且全 0 → 无变更', () => {
    assert.equal(buildTaskListRow(zero()).resultSummary, '无变更');
  });

  it('失败 / 状态未知 / 已取消不压缩（否则异常被伪装成正常结束）', () => {
    const failed = zero();
    failed.state = 'failed';
    failed.error = '磁盘写满，无法写入元数据';
    assert.notEqual(buildTaskListRow(failed).resultSummary, '无变更');
    const unknown = zero();
    unknown.state = 'unknown';
    assert.notEqual(buildTaskListRow(unknown).resultSummary, '无变更');
    const cancelled = zero();
    cancelled.state = 'cancelled';
    assert.notEqual(buildTaskListRow(cancelled).resultSummary, '无变更', '已取消不能被读成「跑完没变化」');
  });

  it('有新建立即不压缩', () => {
    const task = zero();
    task.result.createdTotal = 3;
    assert.match(buildTaskListRow(task).resultSummary, /新增文档 3 篇/);
  });
});

describe('文案映射与回退', () => {
  it('状态 / 操作 / 来源使用统一中文口径', () => {
    assert.equal(stateLabel('unknown'), '状态未知');
    assert.equal(operationLabel('rebuild-vector'), '向量重建');
    assert.equal(operationLabel('restore-snapshot'), '快照还原');
    assert.equal(operationLabel('datasource-sync'), '数据源同步');
    assert.equal(operationLabel('datasource-add-remote'), '添加 Git 数据源');
    assert.equal(sourceLabel('cli'), 'CLI');
    assert.equal(sourceLabel('daemon'), '后台服务');
    assert.equal(sourceLabel('scheduler'), '定时同步', '2026-10-30：「定时」→「定时同步」');
  });

  it('未知操作原样回退，不显示 undefined', () => {
    assert.equal(operationLabel('custom-op'), 'custom-op');
    assert.equal(buildTaskListRow(baseTask({ operation: 'custom-op' })).operationLabel, 'custom-op');
  });
});
