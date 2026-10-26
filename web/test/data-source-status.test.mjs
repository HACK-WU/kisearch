/**
 * 数据源「当前状态」口径单测（web/src/lib/dataSourceDetailModel.ts）
 *
 * 锁住的不变量：
 *   1) 运行态（running/queued）优先于 lastSync——同步中不得显示「从未同步」或上次结果；
 *   2) 空闲时才回落到 lastSync.state，从未同步才是「从未同步」；
 *   3) 抽屉头部与列表共用同一口径；运行态提示解释"为什么"；
 *   4) 无 lastSync 时「上次同步」显示 —（不是「从未同步」，避免与状态列重复/矛盾）。
 *
 * 运行：cd web && npm test
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
const { dataSourceStatusView, datasourceStateTone, buildDataSourceDetail, buildDataSourceListSummary, resolveDataSourceActiveState } = await vite.ssrLoadModule('/src/lib/dataSourceDetailModel.ts');

after(async () => { await vite.close(); });

const NOW = 1_792_558_513_966;

function lastSync(overrides = {}) {
  return {
    at: NOW,
    durationMs: 42_498,
    state: 'ok',
    params: { group: null, conflictMode: 'incremental', vector: true, chunkSize: null, chunkOverlap: null },
    result: {
      files: { scanned: 241, completed: 241, unchanged: 29, skipped: 0, incomplete: 0, duplicatesSkipped: 0 },
      vectorized: 2240,
      fullTextIndexed: 0,
      groups: ['g'],
      conflicts: [],
      failures: [],
    },
    pendingDelete: {
      computedAt: NOW,
      total: 0,
      overLimit: false,
      truncated: false,
      items: [],
      untouchedGroups: [],
      unableCount: 0,
      eligibleCount: 0,
      stale: false,
      staleReason: null,
      blocked: null,
    },
    ...overrides,
  };
}

function record(overrides = {}) {
  return {
    version: 1,
    scope: 'demo',
    dir: '/tmp/demo',
    group: null,
    conflictMode: 'incremental',
    conflictSuffix: '_{n}',
    vector: true,
    chunkSize: null,
    chunkOverlap: null,
    createdAt: NOW,
    updatedAt: NOW,
    lastSync: null,
    ...overrides,
  };
}

describe('dataSourceStatusView', () => {
  it('running 优先于上次成功结果', () => {
    const view = dataSourceStatusView({ activeState: 'running', lastSync: lastSync() });
    assert.equal(view.label, '同步中');
    assert.equal(view.tone, 'running');
    assert.equal(view.active, true);
  });

  it('running + 从未同步（首次同步中）不再显示「从未同步」', () => {
    const view = dataSourceStatusView({ activeState: 'running', lastSync: null });
    assert.equal(view.label, '同步中');
    assert.notEqual(view.label, '从未同步');
  });

  it('旧 daemon 缺 activeState 时用 running 兜底（不得把空闲判成进行中）', () => {
    assert.equal(resolveDataSourceActiveState(undefined, true), 'running');
    assert.equal(resolveDataSourceActiveState(undefined, false), null);
    assert.equal(resolveDataSourceActiveState(null, true), 'running');
    assert.equal(resolveDataSourceActiveState('queued', true), 'queued');
    assert.equal(dataSourceStatusView({ activeState: undefined, running: true, lastSync: lastSync() }).label, '同步中');
    assert.equal(dataSourceStatusView({ activeState: undefined, running: false, lastSync: lastSync() }).label, '成功');
  });

  it('queued 显示「排队中」且 tone=queued', () => {
    const view = dataSourceStatusView({ activeState: 'queued', lastSync: lastSync() });
    assert.equal(view.label, '排队中');
    assert.equal(view.tone, 'queued');
    assert.equal(view.active, true);
  });

  it('空闲 + 有结果：回落到上次结果', () => {
    assert.deepEqual(
      dataSourceStatusView({ activeState: null, lastSync: { state: 'partial' } }),
      { state: 'partial', label: '部分失败', tone: 'partial', active: false },
    );
  });

  it('空闲 + 无结果：从未同步', () => {
    const view = dataSourceStatusView({ activeState: null, lastSync: null });
    assert.equal(view.label, '从未同步');
    assert.equal(view.tone, 'queued');
    assert.equal(view.active, false);
  });

  it('tone 映射与任务页一致（ok → succeeded）', () => {
    assert.equal(datasourceStateTone('ok'), 'succeeded');
    assert.equal(datasourceStateTone('failed'), 'failed');
    assert.equal(datasourceStateTone('running'), 'running');
    assert.equal(datasourceStateTone('never'), 'queued');
  });

  it('空闲态的失败/已取消标签', () => {
    assert.equal(dataSourceStatusView({ activeState: null, lastSync: { state: 'failed' } }).label, '失败');
    assert.equal(dataSourceStatusView({ activeState: null, lastSync: { state: 'cancelled' } }).label, '已取消');
  });
});

describe('buildDataSourceDetail 头部与时间口径', () => {
  it('首次同步中：头部「同步中」+ 提示开始时间 + 上次同步 —', () => {
    const model = buildDataSourceDetail(record(), { activeState: 'running', activeStartedAt: NOW - 42_498 });
    assert.equal(model.header.stateLabel, '同步中');
    assert.equal(model.header.tone, 'running');
    assert.match(model.notices[0].text, /同步进行中（本次开始于 .+）/);
    assert.deepEqual(model.times, [{ label: '上次同步', value: '—' }]);
  });

  it('二次同步中：头部不显示上次的「成功」，仍为「同步中」', () => {
    const model = buildDataSourceDetail(record({ lastSync: lastSync() }), { activeState: 'running', activeStartedAt: NOW });
    assert.equal(model.header.stateLabel, '同步中');
    assert.equal(model.header.tone, 'running');
    assert.ok(typeof model.times[0].value === 'string' && model.times[0].value !== '—');
    assert.match(model.notices[0].text, /下方执行结果与明细为上次同步数据/);
  });

  it('排队中：头部「排队中」+ 排队提示', () => {
    const model = buildDataSourceDetail(record({ lastSync: lastSync() }), { activeState: 'queued' });
    assert.equal(model.header.stateLabel, '排队中');
    assert.equal(model.header.tone, 'queued');
    assert.match(model.notices[0].text, /排队/);
  });

  it('无 startedAt 的 running 不退化成「本次开始于 undefined」', () => {
    const model = buildDataSourceDetail(record(), { activeState: 'running', activeStartedAt: null });
    assert.equal(model.notices[0].text, '同步进行中');
  });

  it('空闲 + 无结果：头部「从未同步」+ 上次同步 —', () => {
    const model = buildDataSourceDetail(record());
    assert.equal(model.header.stateLabel, '从未同步');
    assert.deepEqual(model.times, [{ label: '上次同步', value: '—' }]);
  });

  it('候选 stale / blocked / overLimit 各有可读提示', () => {
    const base = lastSync();
    const stale = buildDataSourceDetail(record({
      lastSync: lastSync({ pendingDelete: { ...base.pendingDelete, stale: true, staleReason: 'source-missing' } }),
    }));
    assert.match(stale.notices[0].text, /源目录当前不存在/);

    const blocked = buildDataSourceDetail(record({
      lastSync: lastSync({ pendingDelete: { ...base.pendingDelete, blocked: 'GATE_SCALE', skipDetail: '删除占比过高' } }),
    }));
    assert.match(blocked.notices[0].text, /删除占比过高/);

    const overLimit = buildDataSourceDetail(record({
      lastSync: lastSync({
        pendingDelete: {
          ...base.pendingDelete, overLimit: true, total: 600,
          items: [{ group: 'g', relation: 'a' }],
        },
      }),
    }));
    assert.match(overLimit.notices[0].text, /超过单次上限/);
  });
});

describe('buildDataSourceDetail Git / 增量口径', () => {
  const base = lastSync();
  const gitSync = lastSync({
    params: { ...base.params, mode: 'incremental' },
    result: {
      ...base.result,
      files: { ...base.result.files, fullScanned: 241, changed: 3 },
    },
    git: {
      commit: 'a'.repeat(40),
      runCommit: 'b'.repeat(40),
      shortCommit: 'bbbbbbb',
      subject: 'feat: git sync',
      authorTime: NOW,
      changedCount: 3,
      fullScanned: 241,
      untrackedMarkdown: 2,
      update: 'failed',
      updateDetail: 'not possible to fast-forward',
      fetch: 'ok',
    },
    warnings: [
      { code: 'GIT_UPDATE_FAILED', message: '自动更新失败：not possible to fast-forward；本地工作区未改动，本次同步本地内容' },
      { code: 'GIT_UNTRACKED_SKIPPED', message: '检测到 2 个未跟踪文件不参与增量；需要同步请执行全量同步' },
    ],
  });
  const gitRecord = record({
    type: 'git',
    git: {
      repoRoot: '/root/learning',
      relativeRoot: 'langchain',
      branch: 'main',
      remoteUrl: null,
      managed: false,
      remoteBranch: null,
    },
    lastSync: gitSync,
  });

  it('参数含类型 / Git 仓库 / 分支 / 最近提交 / 同步模式', () => {
    const model = buildDataSourceDetail(gitRecord);
    const byLabel = new Map(model.params.map((row) => [row.label, row]));
    assert.equal(byLabel.get('类型').value, 'Git 仓库');
    assert.equal(byLabel.get('Git 仓库').value, '/root/learning');
    assert.equal(byLabel.get('分支').value, 'main');
    assert.match(byLabel.get('最近提交').value, /bbbbbbb.*feat: git sync/);
    assert.equal(byLabel.get('同步模式').value, '增量');
  });

  it('结果区分全量扫描 / 本次变更 / 处理', () => {
    const model = buildDataSourceDetail(gitRecord);
    const byLabel = new Map(model.results.map((row) => [row.label, row]));
    assert.equal(byLabel.get('全量扫描').value, '241');
    assert.equal(byLabel.get('本次变更').value, '3');
    assert.equal(byLabel.get('处理').value, '241');
    assert.equal(byLabel.get('完成').hint, '其中内容未变 29 篇');
  });

  it('目录源不显示「本次变更」（无 diff 语义，避免 250/250 误读）', () => {
    const model = buildDataSourceDetail(record({ type: 'directory', lastSync: lastSync() }));
    const labels = model.results.map((row) => row.label);
    assert.equal(labels.includes('本次变更'), false);
    assert.equal(labels.includes('全量扫描'), true);
  });

  it('服务端 warnings 直出；untracked 为 info，其余为 warn', () => {
    const model = buildDataSourceDetail(gitRecord);
    const untracked = model.notices.find((item) => item.text.includes('未跟踪文件'));
    const update = model.notices.find((item) => item.text.includes('自动更新失败'));
    assert.equal(untracked.tone, 'info');
    assert.equal(update.tone, 'warn');
  });

  it('partial + commit 未推进时有明确提示', () => {
    const model = buildDataSourceDetail(record({
      type: 'git',
      git: gitRecord.git,
      lastSync: lastSync({ ...gitSync, state: 'partial' }),
    }));
    assert.ok(model.notices.some((item) => item.text.includes('commit 水位未推进')));
  });

  it('旧快照无 fullScanned/changed 时回退 scanned 并加 hint', () => {
    const model = buildDataSourceDetail(record({
      lastSync: lastSync({
        result: {
          ...base.result,
          files: { scanned: 10, completed: 10, unchanged: 8, skipped: 0, incomplete: 0, duplicatesSkipped: 0 },
        },
      }),
    }));
    const byLabel = new Map(model.results.map((row) => [row.label, row]));
    assert.equal(byLabel.get('全量扫描').value, '10');
    assert.equal(byLabel.get('本次变更').value, '10');
    assert.match(byLabel.get('本次变更').hint, /旧快照无增量字段/);
  });

  it('本次无变更时给出显式提示（避免只看到全 0）', () => {
    const model = buildDataSourceDetail(record({
      type: 'git',
      git: gitRecord.git,
      lastSync: lastSync({
        params: { ...base.params, mode: 'incremental' },
        result: {
          ...base.result,
          files: { scanned: 0, fullScanned: 5, changed: 0, completed: 0, unchanged: 0, skipped: 0, incomplete: 0, duplicatesSkipped: 0 },
        },
        git: { ...gitSync.git, changedCount: 0, fullScanned: 5 },
        warnings: [],
      }),
    }));
    assert.ok(model.notices.some((item) => item.title === '本次同步无变更' && item.text.includes('全量扫描 5 篇')));
  });
});

describe('buildDataSourceListSummary', () => {
  it('同步中的行不计入「从未同步」，并单独计数', () => {
    const summary = buildDataSourceListSummary(2, [
      { lastSync: null, activeState: 'running', running: true, stale: true },
      { lastSync: null, activeState: null, running: false, stale: true },
    ]);
    assert.equal(summary, '共 2 个数据源 · 1 个从未同步 · 1 个同步中');
  });

  it('「超过 24h」只数有上次结果且过期的', () => {
    const summary = buildDataSourceListSummary(2, [
      { lastSync: { state: 'ok' }, activeState: null, running: false, stale: true },
      { lastSync: { state: 'ok' }, activeState: null, running: false, stale: false },
    ]);
    assert.equal(summary, '共 2 个数据源 · 1 个超过 24h 未同步');
  });

  it('排队中单独计数，且旧 daemon 的 running 兜底为同步中', () => {
    const summary = buildDataSourceListSummary(2, [
      { lastSync: null, activeState: 'queued', running: true, stale: true },
      { lastSync: { state: 'ok' }, activeState: undefined, running: true, stale: false },
    ]);
    assert.equal(summary, '共 2 个数据源 · 1 个同步中 · 1 个排队中');
  });

  it('空列表只显示总数', () => {
    assert.equal(buildDataSourceListSummary(0, []), '共 0 个数据源');
  });
});
