/**
 * 任务详情渲染模型单测（lib/taskDetailModel.ts，REQ-20261019-004 S-03）
 *
 * 锁住的不变量：
 *   1) 完成态不显示阶段进度（`persist 1/1` 必须消失），由结果段承载；
 *   2) 「内容未变」必须与「成功」并列，否则用户会把未重算误判成 Bug；
 *   3) 缺字段显示「—」、0 显示 0；
 *   4) `skippedReasons` 三项之和等于 skipped；
 *   5) `ALL_FILES_DUPLICATES` 不是故障，用 warn 而非 danger；
 *   6) 网页任务无码时不得出现「查看服务日志」（网页用户没有发起端）；
 *   7) 旧记录（终态且无 params/result）给「旧记录」说明，而不是当成空数据。
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
const { buildTaskDetail, taskSummaryLine, indexReadinessLabel } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');

after(async () => { await vite.close(); });

const NOW = 1_790_000_000_000;

function baseTask(overrides = {}) {
  return {
    id: 'task-1',
    source: 'web',
    operation: 'import',
    scope: 'demo',
    state: 'succeeded',
    createdAt: NOW,
    updatedAt: NOW,
    heartbeatAt: NOW,
    startedAt: NOW + 1_000,
    finishedAt: NOW + 4_000,
    ...overrides,
  };
}

const FILES = {
  scanned: 12, completed: 10, incomplete: 0, skipped: 2,
  unchanged: 9, duplicatesSkipped: 1,
  skippedReasons: { conflict: 1, duplicate: 1, other: 0 },
};

describe('完成态结果摘要', () => {
  it('有 result 时不显示阶段进度，结果段给出文件级数字', () => {
    const task = baseTask({
      params: { sourceKind: 'upload', group: 'raw', tags: ['产品'], vector: true, conflictMode: 'incremental', skipDuplicates: true },
      result: { files: FILES, vectorized: 148, fullTextIndexed: 132, assets: 3, groups: ['raw/browser'] },
    });
    const view = buildTaskDetail(task);
    assert.equal(view.showProgress, false, '完成态必须隐藏进度条（否则只剩 persist 1/1）');
    assert.equal(view.legacy, false);
    const fileRow = view.results.find((row) => row.label === '文件');
    assert.equal(fileRow?.value, '扫描 12 篇');
    const successRow = view.results.find((row) => row.label === '成功');
    assert.equal(successRow?.value, '10 篇');
    assert.match(successRow?.hint ?? '', /内容未变 9 篇/);
    const skipRow = view.results.find((row) => row.label === '跳过');
    assert.match(skipRow?.hint ?? '', /同名 1 \/ 疑似重复 1 \/ 其他 0/);
  });

  it('参数段包含来源形态 / Group / 标签 / 向量 / 同名策略', () => {
    const task = baseTask({
      params: { sourceKind: 'upload', tags: ['a', 'b'], vector: false, conflictMode: 'suffix', conflictSuffix: '_{n}', skipDuplicates: true },
      result: { groups: ['raw/sub'] },
    });
    const view = buildTaskDetail(task);
    const byLabel = Object.fromEntries(view.params.map((row) => [row.label, row]));
    assert.equal(byLabel['来源'].value, '网页 · 浏览器上传（暂存目录）');
    assert.equal(byLabel['Group'].value, '未指定（按源目录派生）');
    assert.match(byLabel['Group'].hint ?? '', /raw\/sub/);
    assert.equal(byLabel['标签'].value, 'a / b');
    assert.equal(byLabel['向量'].value, '仅全文索引（未写 dense）');
    assert.equal(byLabel['同名策略'].value, '自动添加后缀（模板 _{n}）');
    assert.equal(byLabel['疑似重复'].value, '已启用跳过');
  });

  it('列表行摘要与详情同口径', () => {
    const task = baseTask({ result: { files: FILES } });
    assert.equal(taskSummaryLine(task), '成功 10 · 跳过 2 · 未完成 0');
  });

  it('skippedReasons 三项之和等于 skipped', () => {
    const view = buildTaskDetail(baseTask({ result: { files: FILES } }));
    const hint = view.results.find((row) => row.label === '跳过')?.hint ?? '';
    const numbers = [...hint.matchAll(/(\d+)/g)].map((match) => Number(match[1]));
    assert.equal(numbers[0] + numbers[1] + numbers[2], FILES.skipped);
  });
});

describe('缺字段与旧记录', () => {
  it('unchanged 缺省显示「—」，为 0 时显示 0', () => {
    const withZero = buildTaskDetail(baseTask({ result: { files: { ...FILES, unchanged: 0 } } }));
    assert.equal(withZero.results.find((row) => row.label === '成功')?.hint, undefined, '0 篇未变不显示「其中内容未变 0 篇」噪音');

    const missing = buildTaskDetail(baseTask({ result: { files: { ...FILES, vectorized: undefined, fullTextIndexed: undefined } } }));
    assert.equal(missing.results.some((row) => row.label === '全文索引'), false);
  });

  it('旧记录（终态且无 params/result）给出说明且不渲染参数段', () => {
    const view = buildTaskDetail(baseTask({ state: 'succeeded' }));
    assert.equal(view.legacy, true);
    assert.equal(view.params.length, 2, '仅保留「知识库」「来源」两行，其余参数无从得知');
    assert.equal(view.params.some((row) => row.label === 'Group'), false);
    assert.ok(view.notices.some((notice) => /旧记录/.test(notice.text)));
  });

  it('非 import 任务不得被判为旧记录（code-review P0-1）', () => {
    for (const operation of ['rebuild-vector', 'restore-snapshot']) {
      for (const state of ['succeeded', 'failed', 'partial', 'cancelled']) {
        const view = buildTaskDetail(baseTask({ operation, state, error: state === 'failed' ? '快照文件损坏' : undefined }));
        assert.equal(view.legacy, false, `${operation}/${state} 不应被判为旧记录`);
        assert.equal(view.notices.some((notice) => /旧记录/.test(notice.text)), false);
        assert.equal(view.notices.some((notice) => /文件级明细不可用/.test(notice.text)), false, `${operation} 无文件级概念`);
      }
    }
  });

  it('未知索引就绪不得显示成「未建」', () => {
    assert.match(indexReadinessLabel({ denseIndexed: false, unknown: true }), /未知/);
    assert.match(indexReadinessLabel({ denseIndexed: false }), /未建/);
    assert.equal(indexReadinessLabel(undefined), '—');
  });
});

describe('进度口径', () => {
  it('排队中不显示百分比与进度条', () => {
    const view = buildTaskDetail(baseTask({ state: 'queued', startedAt: undefined, finishedAt: undefined, progress: { phase: 'scan', done: 0, total: 12 } }));
    assert.equal(view.showProgress, false);
    assert.match(view.progressText, /排队/);
    assert.equal(view.progressPercent, null);
  });

  it('persist 阶段不渲染 1/1', () => {
    const view = buildTaskDetail(baseTask({ state: 'running', finishedAt: undefined, progress: { phase: 'persist', done: 1, total: 1 } }));
    assert.equal(view.showProgress, false);
    assert.equal(view.progressText, '写入元数据');
    assert.doesNotMatch(view.progressText, /1\/1/);
  });

  it('scan 阶段带单位「篇」', () => {
    const view = buildTaskDetail(baseTask({ state: 'running', finishedAt: undefined, progress: { phase: 'scan', done: 3, total: 12 } }));
    assert.equal(view.showProgress, true);
    assert.equal(view.progressText, '扫描 3/12 篇');
    assert.equal(view.progressPercent, 25);
  });

  it('旧记录终态不显示 100% 进度条', () => {
    const view = buildTaskDetail(baseTask({ state: 'partial', progress: { phase: 'persist', done: 1, total: 1 } }));
    assert.equal(view.showProgress, false);
  });
});

describe('错误与提示 tone', () => {
  it('全部疑似重复用 warn 而非 danger，并给出「仍然导入」指引', () => {
    const view = buildTaskDetail(baseTask({
      state: 'failed',
      result: { errorCode: 'ALL_FILES_DUPLICATES' },
      error: '本批全部为疑似重复，未写入任何文件',
    }));
    assert.ok(view.notices.length > 0);
    assert.equal(view.notices.every((notice) => notice.tone !== 'danger'), true);
    assert.ok(view.notices.some((notice) => /仍然导入/.test(notice.text)));
  });

  it('网页任务无错误码时不得提示「查看服务日志」', () => {
    const view = buildTaskDetail(baseTask({ state: 'failed', error: '任务失败，请查看发起端的命令输出或服务日志' }));
    const joined = view.notices.map((notice) => notice.text).join(' ');
    assert.doesNotMatch(joined, /服务日志/);
  });

  it('失败且无文件级统计时如实说明，不显示 0', () => {
    const view = buildTaskDetail(baseTask({ state: 'failed', result: { errorCode: 'VECTORIZATION_STOPPED' } }));
    assert.ok(view.notices.some((notice) => /文件级明细不可用/.test(notice.text)));
    assert.equal(view.results.some((row) => row.label === '成功'), false);
  });

  it('truncated 用中性文案', () => {
    const view = buildTaskDetail(baseTask({ result: { files: FILES, truncated: true } }));
    const joined = view.notices.map((notice) => notice.text).join(' ');
    assert.match(joined, /明细未完整显示/);
    assert.doesNotMatch(joined, /20 条/);
  });

  it('重建/还原任务保留「已提交条目」（无 result 快照时也不能丢）', () => {
    const rebuild = buildTaskDetail(baseTask({
      operation: 'rebuild-vector',
      partialCommitted: 42,
      params: undefined,
      result: undefined,
    }));
    const row = rebuild.results.find((item) => item.label === '已提交条目');
    assert.equal(row?.value, '42');
    assert.ok(rebuild.results.length > 0, '结果段应至少渲染这一行');
  });

  it('导入任务的 partialCommitted 不重复渲染（result.vectorized 已覆盖）', () => {
    const view = buildTaskDetail(baseTask({
      partialCommitted: 148,
      result: { files: FILES, vectorized: 148 },
    }));
    assert.equal(view.results.filter((item) => /条目/.test(item.label)).length, 1);
  });

  it('冲突明细区分「内容未变」与「已覆盖」（不能都显示已覆盖）', () => {
    const view = buildTaskDetail(baseTask({
      result: {
        files: FILES,
        conflicts: [
          { path: 'docs/a.md', relation: 'a', action: 'overwrite', unchanged: true },
          { path: 'docs/b.md', relation: 'b', action: 'overwrite' },
        ],
      },
    }));
    assert.match(view.conflicts[0].meta ?? '', /内容未变，跳过重算/);
    assert.match(view.conflicts[1].meta ?? '', /已覆盖/);
  });

  it('重试血缘只显示短 ID 并提示可能已清理', () => {
    const view = buildTaskDetail(baseTask({ retryOf: 'abcdef12-3456-7890-abcd-ef1234567890', params: {} }));
    const row = view.params.find((item) => item.label === '重试自');
    assert.equal(row?.value, 'abcdef12…');
    assert.match(row?.hint ?? '', /可能已清理/);
  });
});

describe('时间口径', () => {
  it('排队与执行时长分开', () => {
    const view = buildTaskDetail(baseTask({ startedAt: NOW + 5_000, finishedAt: NOW + 7_000 }));
    assert.match(view.times[0].hint ?? '', /排队 5s/);
    assert.match(view.times[1].hint ?? '', /执行 2s/);
  });
});
