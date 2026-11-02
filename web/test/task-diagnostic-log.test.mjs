/**
 * 任务诊断（S-01 前端映射 + S-04 原因与日志区）单测
 *
 * 锁住的不变量：
 *   1) `result.errorCode` 必须被消费 —— 不得再对 Git 失败显示「未记录可判别原因」；
 *   2) 未知码必须回退原文（吞信息与被修的缺陷同族）；
 *   3) `describeErrorText` 的匹配顺序：`clone 超时` 必须先于 `clone 失败`；
 *   4) catalog 的键与条目内的 `code` 一致（防复制粘贴错行）；
 *   5) 成功任务整区不渲染；失败任务给出可复制的 `ki log <taskId>`；
 *   6) 日志正文与台账解耦：`expired` 时仍渲染正文并标注来源。
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
const { buildLogSection } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');
const { TASK_ERROR_CATALOG, describeErrorText, describeTaskError, formatTaskError } =
  await vite.ssrLoadModule('/src/lib/taskErrorCatalog.ts');
const { cliCommandFor } = await vite.ssrLoadModule('/src/lib/taskActions.ts');

after(async () => { await vite.close(); });

const NOW = 1_790_000_000_000;

function task(overrides = {}) {
  return {
    id: '46aa5f08-14c0-425b-af8a-c47bcb8199c2',
    source: 'web',
    operation: 'datasource-add-remote',
    scope: 'ai-docs',
    state: 'failed',
    phase: 'clone',
    createdAt: NOW,
    updatedAt: NOW,
    heartbeatAt: NOW,
    startedAt: NOW,
    finishedAt: NOW + 10_000,
    ...overrides,
  };
}

function readyLog(overrides = {}) {
  return {
    ok: true,
    taskId: 'x',
    expired: false,
    logFile: 'x.log',
    head: { source: 'web', operation: 'datasource-add-remote', scope: 'ai-docs', createdAt: '2026-11-02T04:01:39.123Z' },
    lines: ['2026-11-02T04:01:39.500Z INFO  state queued', '2026-11-02T04:01:50.000Z ERROR failed code=CLONE_FAILED msg=boom'],
    totalLines: 2,
    rotated: false,
    bytes: 200,
    ...overrides,
  };
}

describe('错误码映射（S-01 前端）', () => {
  it('Git 失败给出原因 + 下一步，不再是「未记录可判别原因」', () => {
    const described = describeTaskError('GIT_NETWORK_FAILED');
    assert.equal(described.reason, '无法连接远端仓库');
    assert.match(described.next, /网络|DNS/);
    assert.equal(described.tone, 'danger');
    assert.equal(
      formatTaskError(described),
      '无法连接远端仓库（GIT_NETWORK_FAILED）；检查网络 / DNS / 代理后再试',
    );
  });

  it('未知码返回 undefined（调用方必须回退原文，不得吞）', () => {
    assert.equal(describeTaskError('SOME_NEW_CODE'), undefined);
    assert.equal(describeTaskError(undefined), undefined);
  });

  it('catalog 的键与条目 code 一致（防错行）', () => {
    for (const [key, entry] of Object.entries(TASK_ERROR_CATALOG)) {
      assert.equal(entry.code, key, `条目 ${key} 的 code 不一致`);
      assert.ok(entry.reason.length > 0);
      assert.ok(entry.tone === 'danger' || entry.tone === 'warn');
    }
  });

  it('文本兜底顺序：clone 超时先于 clone 失败', () => {
    assert.equal(describeErrorText('clone 超时（10 分钟）')?.code, 'GIT_CLONE_TIMEOUT');
    assert.equal(describeErrorText('clone 失败：fatal: boom')?.code, 'CLONE_FAILED');
    assert.equal(describeErrorText('远端分支不存在（fatal: remote branch dev not found）')?.code, 'GIT_BRANCH_NOT_FOUND');
    assert.equal(describeErrorText('无关文本')?.code, undefined);
  });
});

describe('原因与日志区（S-04）', () => {
  it('成功任务整区不渲染', () => {
    const section = buildLogSection(task({ state: 'succeeded', result: { errorCode: 'SYNC_ENQUEUE_FAILED' } }), { phase: 'idle' });
    assert.equal(section.visible, false);
  });

  it('失败态给出 meta（错误码/阶段/耗时）与可复制命令', () => {
    const t = task({ result: { errorCode: 'GIT_NETWORK_FAILED' } });
    const section = buildLogSection(t, { phase: 'ready', log: readyLog() });
    assert.equal(section.visible, true);
    assert.equal(section.title, '原因与日志');
    const labels = section.metaRows.map((row) => row.label);
    assert.deepEqual(labels, ['错误码', '阶段', '耗时']);
    assert.equal(section.metaRows[2].value, '10s');
    assert.equal(section.command, `ki log ${t.id}`);
  });

  it('有日志正文时 body=lines，并提供复制文本', () => {
    const section = buildLogSection(task(), { phase: 'ready', log: readyLog() });
    assert.equal(section.body.kind, 'lines');
    assert.equal(section.body.lines.length, 2);
    assert.equal(section.body.total, 2);
    assert.match(section.copyText, /ERROR failed code=CLONE_FAILED/);
  });

  it('日志文件在但没有正文 → 空态提示（不显示成「读取失败」）', () => {
    const section = buildLogSection(task(), { phase: 'ready', log: readyLog({ lines: [], totalLines: 0 }) });
    assert.equal(section.body.kind, 'empty');
    assert.match(section.body.notice, /还没有正文/);
    assert.equal(section.copyText, null);
  });

  it('接口 404 → missing 空态，并解释原因', () => {
    const section = buildLogSection(task(), { phase: 'missing' });
    assert.equal(section.body.kind, 'empty');
    assert.match(section.body.notice, /7 天保留期/);
    // 即使没有日志，也要给命令（用户可在终端再确认）
    assert.match(section.command, /^ki log /);
  });

  it('接口报错 → error 态带原因，不影响其它区块', () => {
    const section = buildLogSection(task(), { phase: 'error', message: 'HTTP 500' });
    assert.equal(section.body.kind, 'error');
    assert.match(section.body.notice, /日志读取失败：HTTP 500/);
  });

  it('台账过期降级：仍渲染正文，并标注元信息来源', () => {
    const section = buildLogSection(
      task({ state: 'unknown' }),
      { phase: 'ready', log: readyLog({ expired: true }) },
    );
    assert.equal(section.metaRows[0].label, '记录');
    assert.match(section.metaRows[0].value, /台账已过期/);
    assert.equal(section.body.kind, 'lines');
  });
});

describe('数据源类操作的排查命令', () => {
  it('有 taskId 时生成 ki log（此前只有一句「请在终端执行」却没有命令）', () => {
    assert.equal(cliCommandFor('datasource-add-remote', 'ai-docs', 'task-9'), 'ki log task-9');
    assert.equal(cliCommandFor('datasource-sync', 'ai-docs', 'task-9'), 'ki log task-9');
  });

  it('缺 taskId 时保持旧行为（不产出半截命令）', () => {
    assert.equal(cliCommandFor('datasource-add-remote', 'ai-docs'), undefined);
  });

  it('既有的 import / 重建 / 还原命令不变', () => {
    assert.equal(cliCommandFor('import', 'ai-docs'), 'ki import -s ai-docs --retry-incomplete');
    assert.equal(cliCommandFor('rebuild-vector', 'ai-docs'), 'ki restore ai-docs --rebuild-vector --yes');
    assert.equal(cliCommandFor('restore-snapshot', 'ai-docs'), 'ki restore ai-docs --from-snapshot --yes');
  });
});
