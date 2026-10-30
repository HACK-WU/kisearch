/**
 * 任务列表查询模型单测（2026-10-30）
 *
 * 锁住「卡片即筛选」之后的口径：
 *   - 4 个筛选态与卡片计数同判据（原「最近结束」已删）；
 *   - 搜索支持知识库 / 操作 / 来源 / 错误 / 摘要 / **状态关键词**；
 *   - 默认开始时间降序；点同列翻转、点新列回默认降序；
 *   - 持续时间排序：无耗时（运行中 / 排队中）固定排末尾，不随升降序翻转。
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
const {
  TASK_FILTERS, DEFAULT_TASK_SORT, countTasks, matchesTaskFilter, matchesTaskSearch,
  nextTaskSort, queryTasks, sortTasks, taskDurationSeconds, taskFilterLabel,
} = await vite.ssrLoadModule('/src/lib/taskQueryModel.ts');

after(async () => { await vite.close(); });

const NOW = 1_790_000_000_000;

function task(overrides = {}) {
  return {
    id: overrides.id ?? 'T1',
    source: 'web',
    operation: 'datasource-sync',
    scope: 'blog-es',
    state: 'succeeded',
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 3_000,
    ...overrides,
  };
}

const text = (summary = '', sourceText = '网页', operationText = '数据源同步') => ({ summary, sourceText, operationText });

describe('筛选：4 个筛选态与卡片同判据', () => {
  const tasks = [
    task({ id: 'a', state: 'succeeded' }),
    task({ id: 'b', state: 'failed' }),
    task({ id: 'c', state: 'unknown' }),
    task({ id: 'd', state: 'partial' }),
    task({ id: 'e', state: 'running', finishedAt: undefined }),
    task({ id: 'f', state: 'queued', startedAt: undefined, finishedAt: undefined }),
    task({ id: 'g', state: 'cancelled' }),
  ];

  it('卡片顺序与标签固定（全部任务在最左）', () => {
    assert.deepEqual(TASK_FILTERS.map((def) => def.key), ['all', 'failed', 'partial', 'running']);
    assert.equal(TASK_FILTERS[0].label, '全部任务');
    assert.equal(taskFilterLabel('failed'), '失败 / 状态未知');
  });

  it('各筛选态计数', () => {
    assert.equal(countTasks(tasks, 'all'), 7);
    assert.equal(countTasks(tasks, 'failed'), 2, '失败 + 状态未知');
    assert.equal(countTasks(tasks, 'partial'), 1);
    assert.equal(countTasks(tasks, 'running'), 2, '运行中 + 排队中');
  });

  it('已取消 / 已完成不落进任何异常筛选', () => {
    assert.equal(matchesTaskFilter(task({ state: 'cancelled' }), 'failed'), false);
    assert.equal(matchesTaskFilter(task({ state: 'succeeded' }), 'partial'), false);
  });
});

describe('搜索：支持状态关键词', () => {
  it('空关键词放行', () => {
    assert.equal(matchesTaskSearch(task(), '   ', text()), true);
  });

  it('状态词可命中（进行中 / 排队 / 失败 / 已完成）', () => {
    assert.equal(matchesTaskSearch(task({ state: 'running' }), '进行中', text()), true);
    assert.equal(matchesTaskSearch(task({ state: 'queued' }), '排队', text()), true);
    assert.equal(matchesTaskSearch(task({ state: 'failed' }), '失败', text()), true);
    assert.equal(matchesTaskSearch(task({ state: 'succeeded' }), '已完成', text()), true);
    assert.equal(matchesTaskSearch(task({ state: 'running' }), '已完成', text()), false);
  });

  it('知识库 / 操作 / 来源 / 错误 / 摘要均可命中', () => {
    assert.equal(matchesTaskSearch(task({ scope: 'langchain' }), 'langchain', text()), true);
    assert.equal(matchesTaskSearch(task(), '数据源同步', text('', '网页', '数据源同步')), true);
    assert.equal(matchesTaskSearch(task({ source: 'scheduler' }), '定时同步', text('', '定时同步')), true);
    assert.equal(matchesTaskSearch(task({ error: '磁盘写满' }), '磁盘', text()), true);
    assert.equal(matchesTaskSearch(task(), '新增文档 3 篇', text('成功 3 · 新增文档 3 篇')), true);
  });
});

describe('排序', () => {
  const a = task({ id: 'a', startedAt: NOW + 2_000, finishedAt: NOW + 2_000 + 45_000 });
  const b = task({ id: 'b', startedAt: NOW + 1_000, finishedAt: NOW + 1_000 + 500 });
  const c = task({ id: 'c', state: 'running', startedAt: NOW + 3_000, finishedAt: undefined });

  it('默认开始时间降序（最新在前）', () => {
    assert.deepEqual(DEFAULT_TASK_SORT, { key: 'start', dir: 'desc' });
    assert.deepEqual(sortTasks([b, a, c], DEFAULT_TASK_SORT).map((t) => t.id), ['c', 'a', 'b']);
  });

  it('同列翻转 / 换列回默认降序', () => {
    assert.deepEqual(nextTaskSort({ key: 'start', dir: 'desc' }, 'start'), { key: 'start', dir: 'asc' });
    assert.deepEqual(nextTaskSort({ key: 'start', dir: 'asc' }, 'duration'), { key: 'duration', dir: 'desc' });
  });

  it('持续时间降序：45s 在 0.5s 前', () => {
    assert.deepEqual(
      sortTasks([b, a, c], { key: 'duration', dir: 'desc' }).map((t) => t.id),
      ['a', 'b', 'c'],
    );
  });

  it('持续时间升序：无耗时行仍排末尾', () => {
    assert.deepEqual(
      sortTasks([a, c, b], { key: 'duration', dir: 'asc' }).map((t) => t.id),
      ['b', 'a', 'c'],
    );
  });

  it('<1s 记 0.4s，与 1s 可区分；缺时间戳为 null', () => {
    assert.equal(taskDurationSeconds(task({ startedAt: NOW, finishedAt: NOW + 300 })), 0.4);
    assert.equal(taskDurationSeconds(task({ startedAt: NOW, finishedAt: NOW + 1_000 })), 1);
    assert.equal(taskDurationSeconds(task({ state: 'running', finishedAt: undefined })), null);
  });
});

describe('组合查询', () => {
  const tasks = [
    task({ id: 'a', state: 'succeeded', scope: 'blog-es' }),
    task({ id: 'b', state: 'failed', scope: 'docs-site' }),
    task({ id: 'c', state: 'queued', scope: 'blog-es', startedAt: undefined }),
  ];

  it('筛选 + 搜索 + 排序 串起来', () => {
    const result = queryTasks({
      tasks,
      filter: 'all',
      query: 'blog-es',
      sort: DEFAULT_TASK_SORT,
      describe: () => text(),
    });
    assert.deepEqual(result.map((t) => t.id), ['a', 'c']);
  });

  it('筛选后搜索仍受筛选约束', () => {
    const result = queryTasks({
      tasks,
      filter: 'failed',
      query: 'blog-es',
      sort: DEFAULT_TASK_SORT,
      describe: () => text(),
    });
    assert.deepEqual(result.map((t) => t.id), []);
  });

  it('不修改入参数组', () => {
    const source = [...tasks];
    queryTasks({ tasks: source, filter: 'all', query: '', sort: DEFAULT_TASK_SORT, describe: () => text() });
    assert.deepEqual(source.map((t) => t.id), ['a', 'b', 'c']);
  });
});
