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
const { buildTaskDetail, buildGroupTreeLines, buildPathTree, taskSummaryLine, indexReadinessLabel } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');

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
    // 参数段只给数量（整份落点曾在两处各抄一遍，601 字把栅格拉断）
    assert.match(byLabel['Group'].hint ?? '', /实际落点 1 个 Group/);
    assert.doesNotMatch(byLabel['Group'].hint ?? '', /raw\/sub/, '落点明细不得再进参数段 hint');
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

  it('数据源 clone / 首次同步排队阶段有中文标签（不暴露英文 phase）', () => {
    const cloning = buildTaskDetail(baseTask({ state: 'running', finishedAt: undefined, progress: { phase: 'clone', done: 42, total: 100 } }));
    assert.match(cloning.progressText, /克隆仓库/);
    assert.doesNotMatch(cloning.progressText, /clone/);
    const queuedSync = buildTaskDetail(baseTask({ state: 'running', finishedAt: undefined, progress: { phase: 'queued-sync', done: 0, total: 0 } }));
    assert.match(queuedSync.progressText, /首次同步/);
  });

  it('旧记录终态不显示 100% 进度条', () => {
    const view = buildTaskDetail(baseTask({ state: 'partial', progress: { phase: 'persist', done: 1, total: 1 } }));
    assert.equal(view.showProgress, false);
  });
});

describe('落点 Group 展示形态（2026-10-20）', () => {
  it('落点只出现在结果段一次，且独占整行', () => {
    const groups = ['langchain', 'langchain/stages', 'langchain/stages/lessons'];
    const view = buildTaskDetail(baseTask({ params: { sourceKind: 'upload' }, result: { groups } }));
    const landing = view.results.find((row) => row.label === '落点 Group');
    assert.deepEqual(landing?.tree?.items, groups, '结果段持有完整落点');
    assert.equal(landing?.tree?.summary, undefined, '只有 3 个落点直接摊开，别让人多点一次');
    assert.equal(landing?.full, true, '长值独占整行，否则把双列栅格的另一格拉出大片空白');
    const paramHint = view.params.find((row) => row.label === 'Group')?.hint ?? '';
    assert.equal(groups.some((group) => paramHint.includes(group)), false, '参数段不得复制落点正文');
  });

  it('树形合并公共根，父级只出现一次', () => {
    assert.deepEqual(
      buildGroupTreeLines(['a', 'a/b', 'a/b/c', 'a/d']),
      ['a', '├ b', '│  └ c', '└ d'],
    );
  });

  it('多个根时顶端带连接符', () => {
    assert.deepEqual(buildGroupTreeLines(['x/1', 'y/2']), ['├ x', '│  └ 1', '└ y', '   └ 2']);
  });

  it('空列表与单值不产生空行', () => {
    assert.deepEqual(buildGroupTreeLines([]), []);
    assert.deepEqual(buildGroupTreeLines(['only']), ['only']);
  });
});

describe('落点折叠阈值（2026-10-20）', () => {
  it('≥4 个落点才折叠，摘要量词由 model 给', () => {
    for (const count of [2, 3]) {
      const groups = Array.from({ length: count }, (_, i) => `g/${i}`);
      const row = buildTaskDetail(baseTask({ params: { sourceKind: 'upload' }, result: { groups } }))
        .results.find((item) => item.label === '落点 Group');
      assert.equal(row?.tree?.summary, undefined, `${count} 个应直接摊开`);
    }
    const four = buildTaskDetail(baseTask({
      params: { sourceKind: 'upload' },
      result: { groups: ['a', 'b', 'c', 'd'] },
    })).results.find((item) => item.label === '落点 Group');
    assert.equal(four?.tree?.summary, '全部 4 个 Group');
  });
});

describe('明细树形缩进（2026-10-20）', () => {
  it('明细按目录建树，说明只挂在条目行', () => {
    const lines = buildPathTree([
      { path: 'docs/guides/a.md', meta: '库中已有：raw/a' },
      { path: 'docs/guides/b.md', meta: '库中已有：raw/b' },
      { path: 'docs/intro.md', meta: '→ intro（已覆盖）' },
    ]);
    assert.deepEqual(
      lines.map((line) => line.text),
      ['docs', '├ guides', '│  ├ a.md', '│  └ b.md', '└ intro.md'],
      '目录前缀只出现一次，不再 20 行重复同一段路径',
    );
    assert.deepEqual(lines.map((line) => line.item), [false, false, true, true, true], '中间目录行不是条目');
    assert.equal(lines[2].meta, '库中已有：raw/a');
    assert.equal(lines[0].meta, undefined, '目录行不得凭空带说明');
  });

  it('只有一条明细时也不能丢说明（单根即叶子）', () => {
    assert.deepEqual(
      buildPathTree([{ path: 'a.md', meta: '→ a（已覆盖）' }]),
      [{ text: 'a.md', item: true, meta: '→ a（已覆盖）' }],
    );
  });

  it('条目没有说明时仍算条目（不能靠 meta 反推）', () => {
    const lines = buildPathTree([{ path: 'a/b.md' }, { path: 'a/c.md', meta: '→ 已覆盖' }]);
    const leaf = lines.find((line) => line.text.endsWith('b.md'));
    assert.equal(leaf?.item, true, '没说明也是条目；靠 meta 判定会把它渲染成目录行（颜色变淡）');
    assert.equal(leaf?.meta, undefined);
  });

  it('落点树是纯路径（不带说明）', () => {
    assert.deepEqual(buildGroupTreeLines(['a/b', 'a/c']), ['a', '├ b', '└ c']);
  });

  it('库里位置与源路径相同时不重复打印路径', () => {
    const view = buildTaskDetail(baseTask({
      result: {
        files: FILES,
        duplicates: [
          { path: 'docs/guides/a.md', existingGroup: 'docs/guides', existingRelation: 'a' },
          { path: 'docs/guides/b.md', existingGroup: 'other/place', existingRelation: 'b' },
        ],
      },
    }));
    assert.equal(view.duplicates[0].meta, '库中已有同一路径', '同落点不必把路径抄第二遍');
    assert.match(view.duplicates[1].meta ?? '', /other\/place\/b/, '真跨 Group 时要写清位置');
  });

  it('冲突动作在 relation 就是源路径时不重复路径', () => {
    const view = buildTaskDetail(baseTask({
      result: {
        files: FILES,
        conflicts: [
          { path: 'docs/a.md', relation: 'docs/a', action: 'overwrite' },
          { path: 'docs/b.md', relation: 'moved/b', action: 'suffix' },
        ],
      },
    }));
    assert.equal(view.conflicts[0].meta, '→ 已覆盖');
    assert.equal(view.conflicts[1].meta, '→ moved/b（已改名）');
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

  it('同一天不重复打印日期（日期移到 hint，避免半宽列折行）', () => {
    const same = buildTaskDetail(baseTask({ startedAt: NOW + 5_000, finishedAt: NOW + 7_000 }));
    // 区间里只剩「16:56:07 → 16:56:12」，两个 yyyy/MM/dd 会既读成「跨了一天」又撑爆列宽
    assert.doesNotMatch(same.times[0].value, /\//, `同一天区间内不应出现日期：${same.times[0].value}`);
    assert.match(same.times[0].hint ?? '', /\d{2}\/\d{2}/, '日期必须还有地方可看（hint）');
    assert.doesNotMatch(same.times[1].value, /\//, `结束行同一天也不重复日期：${same.times[1].value}`);

    const crossDay = buildTaskDetail(baseTask({ startedAt: NOW + 90_000_000, finishedAt: NOW + 90_000_000 }));
    assert.equal(crossDay.times[0].value.split('/').length - 1, 4, `跨天必须各写一次完整日期：${crossDay.times[0].value}`);
    assert.doesNotMatch(crossDay.times[0].hint ?? '', /\d{2}\/\d{2}$/, '跨天时日期已在 value 里，hint 不再重复');
  });
});

describe('执行结果概览（与数据源详情同构）', () => {
  it('summary / metrics 与结果段同口径，指标按数据源顺序排列', () => {
    const task = baseTask({
      params: { sourceKind: 'upload', group: 'raw' },
      result: { files: { ...FILES, incomplete: 2 }, vectorized: 148, fullTextIndexed: 132, assets: 3, groups: ['raw/browser'] },
    });
    const view = buildTaskDetail(task);
    assert.deepEqual(view.summary, {
      scanned: 12, completed: 10, incomplete: 2, skipped: 2, unchanged: 9,
      vectorized: 148, fullText: 132,
    });
    assert.deepEqual(view.metrics.map((m) => m.label), ['全量扫描', '处理', '跳过', '未完成', '向量条目', '全文条目']);
    assert.equal(view.metrics.find((m) => m.label === '未完成')?.tone, 'danger', '未完成 > 0 时指标走危险色');
    assert.equal(view.metrics.find((m) => m.label === '全量扫描')?.value, 12);
  });

  it('缺向量/全文计数时指标仍为 6 格（按 0 补齐）', () => {
    const task = baseTask({ params: { sourceKind: 'upload' }, result: { files: FILES } });
    const view = buildTaskDetail(task);
    assert.equal(view.metrics.length, 6);
    assert.equal(view.metrics.find((m) => m.label === '向量条目')?.value, 0);
    assert.equal(view.metrics.find((m) => m.label === '全文条目')?.value, 0);
  });

  it('resultExtras 只保留指标网格未覆盖的行（落点 Group 等）', () => {
    const task = baseTask({
      params: { sourceKind: 'upload', group: 'raw' },
      result: { files: FILES, vectorized: 1, fullTextIndexed: 1, assets: 3, groups: ['raw/browser'] },
    });
    const view = buildTaskDetail(task);
    assert.deepEqual(view.resultExtras.map((row) => row.label), ['附件', '落点 Group'], '附件降为参数行，网格保持 6 格');
    assert.deepEqual(view.resultExtras.find((row) => row.label === '落点 Group')?.tree?.items, ['raw/browser']);
    // results 仍保留完整行（旧消费方/单测口径不变）
    assert.ok(view.results.some((row) => row.label === '文件'));
  });

  it('无文件级结果时不产出概览（restore/rebuild 走原结果行）', () => {
    const task = baseTask({ operation: 'rebuild-vector', state: 'succeeded', partialCommitted: 5 });
    const view = buildTaskDetail(task);
    assert.equal(view.summary, null);
    assert.deepEqual(view.metrics, []);
    assert.deepEqual(view.resultExtras.map((row) => row.label), ['已提交条目']);
  });
});
