/**
 * 第三方上传（/open/v1）的任务命名与来源（2026-11-09 用户要求）
 *
 * 锁住的不变量：
 *   1) operation 仍是 `import`（改了会打断 coordinator 的 engine-only 与结果快照），
 *      靠 **source=open-api** 区分命名 —— 任务列显示「open api upload」；
 *   2) 网页导入仍是「上传导入」，不被顺手改掉；
 *   3) 来源列对第三方通道显示「OpenAPI」，不能谎称「网页」；
 *   4) 列表行与详情标题同口径（两处都传 source）。
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
const { operationLabel, sourceLabel } = await vite.ssrLoadModule('/src/lib/taskDetailModel.ts');
const { buildTaskListRow } = await vite.ssrLoadModule('/src/lib/taskListModel.ts');

after(async () => { await vite.close(); });

function task(overrides = {}) {
  return {
    id: 't1',
    source: 'web',
    operation: 'import',
    scope: 'default',
    state: 'succeeded',
    operator: { type: 'token', label: 'Token abc123' },
    createdAt: 1_792_558_513_966,
    updatedAt: 1_792_558_520_000,
    heartbeatAt: 1_792_558_520_000,
    ...overrides,
  };
}

describe('operationLabel：按来源区分任务名', () => {
  it('open-api + import → open api upload', () => {
    assert.equal(operationLabel('import', 'open-api'), 'open api upload');
  });
  it('网页导入仍叫「上传导入」（不被顺手改掉）', () => {
    assert.equal(operationLabel('import', 'web'), '上传导入');
    assert.equal(operationLabel('import'), '上传导入');
  });
  it('其他来源的其他操作不受影响', () => {
    assert.equal(operationLabel('datasource-sync', 'scheduler'), '数据源同步');
    assert.equal(operationLabel('open-api-only-future-op', 'open-api'), 'open-api-only-future-op');
  });
});

describe('sourceLabel：来源列文案', () => {
  it('open-api → OpenAPI（不能谎称网页）', () => {
    assert.equal(sourceLabel('open-api'), 'OpenAPI');
    assert.equal(sourceLabel('web'), '网页');
  });
});

describe('任务列表行：两列同时生效', () => {
  it('第三方上传任务：任务列 open api upload + 来源列 OpenAPI', () => {
    const row = buildTaskListRow(task({ source: 'open-api' }));
    assert.equal(row.operationLabel.trim(), 'open api upload');
    assert.equal(row.sourceLabel.trim(), 'OpenAPI');
  });
  it('网页导入任务不受影响', () => {
    const row = buildTaskListRow(task({ source: 'web' }));
    assert.equal(row.operationLabel.trim(), '上传导入');
    assert.equal(row.sourceLabel.trim(), '网页');
  });
});
