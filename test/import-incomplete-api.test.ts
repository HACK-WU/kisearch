/**
 * import-incomplete-api.test.ts —— 任务中心「重试未完成」两个接口（2026-10-13）
 *
 * 契约：
 *   1. `GET /api/import/incomplete`：只读摘要——无清单 / 有清单（external、upload）/
 *      源目录不存在 / 清单损坏 / 旧清单（legacy）各分支；**响应不含绝对路径**。
 *   2. `POST /api/import/retry-incomplete`：校验分支（缺 scope / 无清单 / 损坏 /
 *      归属不匹配 409 / 源目录不存在）；成功路径起 job，并按清单 `onlyRelPaths` 生效
 *      （源目录不含清单内文件 ⇒ job fail-loud 报「均不存在」，证明 onlyRelPaths 被传递）。
 *   3. 归属：清单 `taskId` 与请求 `taskId` 不一致 ⇒ 409（护栏 6：不静默重试错对象）。
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/import-incomplete-api.test.ts
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ─── 测试隔离：临时 HOME（uploadsRoot / kb 全落 tmpHome），避免污染真实 ~/.ki ───
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-incomplete-api-'));
process.env.HOME = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

const { createMcpHttpServer } = await import('../src/lib/mcp-http.js');
const { writeImportIncomplete, getImportIncompletePath, getImportIncompletePrevPath } =
  await import('../src/lib/import-retry.js');
const { getKbDir } = await import('../src/lib/scope.js');
const { createTaskReporter } = await import('../src/lib/task-registry.js');
const { loadConfig } = await import('../src/lib/config.js');

// 维度快照刷新会尝试打开引擎：本套件不测引擎，打桩避免拖慢/吊住事件循环（与导入无关的旁路）。
const snapshotMod = await import('../src/lib/vector-dimension-snapshot.js');
(snapshotMod as any).refreshVectorDimensionSnapshot = async () => ({ ok: true, updated: false });

const SCOPE = 'default';
const uploadsRoot = path.join(tmpHome, '.ki', 'import-uploads');

function buildTestServer(): McpServer {
  const server = new McpServer({ name: 'kisearch', version: '0.0.0-test' });
  server.tool('ping', 'test ping', {}, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
  return server;
}

let handle: { base: string; close: () => Promise<void> } | null = null;

before(async () => {
  fs.mkdirSync(getKbDir(SCOPE), { recursive: true });
  const { httpServer, closeAllSessions } = createMcpHttpServer({ authEnabled: false, buildServer: buildTestServer, webDir: null });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  handle = {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
});

after(async () => {
  await handle?.close();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  // 清单是 scope 级单文件：用例之间必须清干净（含跨源备份）
  for (const file of [getImportIncompletePath(SCOPE), getImportIncompletePrevPath(SCOPE)]) {
    if (fs.existsSync(file)) fs.rmSync(file, { force: true });
  }
});

function mkExternalSource(): string {
  const dir = fs.mkdtempSync(path.join(tmpHome, 'src-'));
  return dir;
}

/** 写入一份清单（默认：external 来源、1 个不存在于源目录的条目、无 taskId） */
function seedIncomplete(overrides: {
  sourceDir: string;
  taskId?: string;
  items?: { path?: string }[];
  vector?: boolean;
}): void {
  writeImportIncomplete(SCOPE, {
    version: 1,
    scope: SCOPE,
    createdAt: new Date().toISOString(),
    sourceDir: overrides.sourceDir,
    params: { vector: overrides.vector ?? false },
    items: overrides.items ?? [{ path: 'ghost.md' }],
    ...(overrides.taskId !== undefined ? { taskId: overrides.taskId } : {}),
  });
}

async function getSummary(): Promise<Record<string, unknown>> {
  const res = await fetch(`${handle!.base}/api/import/incomplete?scope=${SCOPE}`);
  assert.equal(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  assert.equal(body.ok, true);
  return body;
}

async function postRetry(payload: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${handle!.base}/api/import/retry-incomplete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

/** 轮询 job 终态（起 job 是异步的） */
async function waitJob(jobId: string, timeoutMs = 10_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${handle!.base}/api/import/status?jobId=${encodeURIComponent(jobId)}`);
    const body = await res.json() as { job?: { state?: string } };
    const state = body.job?.state;
    if (state === 'failed' || state === 'done' || state === 'cancelled') return body.job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('job 未在超时内结束');
}

describe('GET /api/import/incomplete（只读摘要）', () => {
  it('无清单：hasRecord=false + canRetry=false + 原因可展示，且响应不含绝对路径', async () => {
    const body = await getSummary();
    assert.equal(body.hasRecord, false);
    assert.equal(body.corrupted, false);
    assert.equal(body.canRetry, false);
    assert.equal(typeof body.reason, 'string');
    assert.equal((body.reason as string).length > 0, true);
    // 护栏 3：不向浏览器回显绝对路径
    assert.equal(JSON.stringify(body).includes(tmpHome), false);
  });

  it('external 来源清单：itemCount / taskId / sourceKind / canRetry 正确', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src, taskId: 'task-A', items: [{ path: 'a.md' }, { path: 'b.md' }] });
    const body = await getSummary();
    assert.equal(body.hasRecord, true);
    assert.equal(body.itemCount, 2);
    assert.equal(body.taskId, 'task-A');
    assert.equal(body.legacy, false);
    assert.equal(body.sourceKind, 'external');
    assert.equal(body.sourceExists, true);
    assert.equal(body.canRetry, true);
    assert.equal(JSON.stringify(body).includes(tmpHome), false);
  });

  it('upload 来源清单（暂存目录）：sourceKind=upload 且可重试', async () => {
    const uploadId = '11111111-1111-4111-8111-111111111111';
    const dir = path.join(uploadsRoot, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.scope'), SCOPE, 'utf8');
    seedIncomplete({ sourceDir: dir, taskId: 'task-upload' });
    const body = await getSummary();
    assert.equal(body.sourceKind, 'upload');
    assert.equal(body.sourceExists, true);
    assert.equal(body.canRetry, true);
  });

  it('源目录已不存在：canRetry=false + 原因说明', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src, taskId: 'task-gone' });
    fs.rmSync(src, { recursive: true, force: true });
    const body = await getSummary();
    assert.equal(body.canRetry, false);
    assert.match(String(body.reason), /源目录|暂存目录/);
  });

  it('旧清单（无 taskId）：legacy=true 但可重试（归属未知，放行 + 提示）', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src });
    const body = await getSummary();
    assert.equal(body.legacy, true);
    assert.equal(body.taskId, undefined);
    assert.equal(body.canRetry, true);
  });

  it('清单损坏：corrupted=true + canRetry=false（与"没有待办"区分）', async () => {
    fs.writeFileSync(getImportIncompletePath(SCOPE), '{ not json', 'utf8');
    const body = await getSummary();
    assert.equal(body.corrupted, true);
    assert.equal(body.canRetry, false);
    assert.equal(body.hasRecord, false);
  });

  it('结构不合格（缺 params）→ 并入 corrupted（下游不会以 TypeError 收场）', async () => {
    const src = mkExternalSource();
    fs.writeFileSync(
      getImportIncompletePath(SCOPE),
      JSON.stringify({ version: 1, scope: SCOPE, sourceDir: src, items: [{ path: 'a.md' }] }),
      'utf8',
    );
    const body = await getSummary();
    assert.equal(body.corrupted, true);
    assert.equal(body.canRetry, false);
  });

  it('stopReason.reason 带绝对路径 → 摘要脱敏为 [path]（响应不含绝对路径）', async () => {
    const src = mkExternalSource();
    writeImportIncomplete(SCOPE, {
      version: 1,
      scope: SCOPE,
      createdAt: new Date().toISOString(),
      sourceDir: src,
      params: { vector: true },
      items: [{ path: 'a.md' }],
      taskId: 'task-leak',
      stopReason: { kind: 'provider-unavailable', code: 'HTTP_503', phase: 'embedding', reason: `读取 ${src}/a.md 失败` },
    });
    const body = await getSummary();
    assert.equal(JSON.stringify(body).includes(tmpHome), false, '摘要不得回显绝对路径');
    assert.match(String((body.stopReason as { reason?: string })?.reason), /\[path\]/);
  });
});

describe('POST /api/import/retry-incomplete（重试入口）', () => {
  it('缺 scope → 400', async () => {
    const { status, body } = await postRetry({});
    assert.equal(status, 400);
    assert.equal(body.ok, false);
  });

  it('无清单 → 400 INCOMPLETE_LIST_MISSING', async () => {
    const { status, body } = await postRetry({ scope: SCOPE, taskId: 'task-x' });
    assert.equal(status, 400);
    assert.equal(body.code, 'INCOMPLETE_LIST_MISSING');
  });

  it('清单损坏 → 400 INCOMPLETE_LIST_CORRUPTED', async () => {
    fs.writeFileSync(getImportIncompletePath(SCOPE), '{ not json', 'utf8');
    const { status, body } = await postRetry({ scope: SCOPE });
    assert.equal(status, 400);
    assert.equal(body.code, 'INCOMPLETE_LIST_CORRUPTED');
  });

  it('归属不匹配 → 409 INCOMPLETE_TASK_MISMATCH（不静默重试错对象）', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src, taskId: 'task-new' });
    const { status, body } = await postRetry({ scope: SCOPE, taskId: 'task-old' });
    assert.equal(status, 409);
    assert.equal(body.code, 'INCOMPLETE_TASK_MISMATCH');
    assert.equal(body.currentTaskId, 'task-new');
  });

  it('源目录不存在 → 400 INCOMPLETE_SOURCE_MISSING', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src, taskId: 'task-1' });
    fs.rmSync(src, { recursive: true, force: true });
    const { status, body } = await postRetry({ scope: SCOPE, taskId: 'task-1' });
    assert.equal(status, 400);
    assert.equal(body.code, 'INCOMPLETE_SOURCE_MISSING');
  });

  it('成功路径：起 job（202）且 onlyRelPaths 按清单生效（源目录无该文件 ⇒ 报「均不存在」）', async () => {
    const src = mkExternalSource();
    // 源目录里有一个真实 md，但**不在清单内**：只有 onlyRelPaths 真的被传递，才会因名单内文件
    // 均不存在而 fail-loud；若漏传（处理全部），该文件会被正常导入（断言即失败）。
    fs.writeFileSync(path.join(src, 'keep.md'), '# keep\n\n不应在本轮被处理', 'utf8');
    seedIncomplete({ sourceDir: src, taskId: 'task-ok', items: [{ path: 'ghost.md' }] });
    const started = await postRetry({ scope: SCOPE, taskId: 'task-ok' });
    assert.equal(started.status, 202);
    assert.equal(started.body.ok, true);
    assert.equal(typeof started.body.jobId, 'string');
    assert.equal(started.body.itemCount, 1);
    assert.equal(started.body.sourceKind, 'external');
    assert.equal(started.body.legacy, undefined);

    const job = await waitJob(started.body.jobId);
    assert.equal(job.state, 'failed');
    // onlyRelPaths=['ghost.md'] 被传递 ⇒ 在扫描阶段即 fail-loud（未打开引擎、未写任何数据）
    assert.match(String(job.error), /均不存在/);
  });

  it('旧清单（legacy）成功路径：202 响应带 legacy=true（归属未知）', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src });
    const started = await postRetry({ scope: SCOPE });
    assert.equal(started.status, 202);
    assert.equal(started.body.legacy, true);
    await waitJob(started.body.jobId);
  });

  it('清单条数超限 → 400 INCOMPLETE_LIST_TOO_LARGE（与 /api/import/run 共用上限）', async () => {
    const src = mkExternalSource();
    const items = Array.from({ length: 50_001 }, (_, index) => ({ path: `f${index}.md` }));
    writeImportIncomplete(SCOPE, {
      version: 1,
      scope: SCOPE,
      createdAt: new Date().toISOString(),
      sourceDir: src,
      params: { vector: false },
      items,
      taskId: 'task-big',
    });
    const { status, body } = await postRetry({ scope: SCOPE, taskId: 'task-big' });
    assert.equal(status, 400);
    assert.equal(body.code, 'INCOMPLETE_LIST_TOO_LARGE');
  });

  it('同 scope 已有导入在跑 → 409 INCOMPLETE_IMPORT_RUNNING（防重复重试，2026-10-13 用户反馈）', async () => {
    const src = mkExternalSource();
    seedIncomplete({ sourceDir: src, taskId: 'task-busy', items: [{ path: 'a.md' }] });
    // 造一条正在跑的同 scope 导入任务（任务台账，与真实闸门判据同源）
    const reporter = createTaskReporter(loadConfig(), { id: 'busy-import-running', source: 'web', operation: 'import', scope: SCOPE });
    reporter.update({ state: 'running', startedAt: Date.now() });
    try {
      const { status, body } = await postRetry({ scope: SCOPE, taskId: 'task-busy' });
      assert.equal(status, 409);
      assert.equal(body.code, 'INCOMPLETE_IMPORT_RUNNING');
      assert.deepEqual(body.activeTaskIds, ['busy-import-running']);
    } finally {
      reporter.finish('failed', { error: '验证收尾：本用例造的在跑任务' });
    }
  });

  it('常规导入（/api/import/run 无 onlyRelPaths）同样被闸门拦住 → 409（评审 P2：闸门统一到 createJob 前）', async () => {
    const uploadId = '55555555-5555-4555-8555-555555555555';
    const dir = path.join(uploadsRoot, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.scope'), SCOPE, 'utf8');
    const reporter = createTaskReporter(loadConfig(), { id: 'busy-for-plain-run', source: 'web', operation: 'import', scope: SCOPE });
    reporter.update({ state: 'running', startedAt: Date.now() });
    try {
      const res = await fetch(`${handle!.base}/api/import/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: SCOPE, uploadId }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { code?: string };
      assert.equal(body.code, 'INCOMPLETE_IMPORT_RUNNING');
    } finally {
      reporter.finish('failed', { error: '验证收尾：本用例造的在跑任务' });
    }
  });

  it('导入页子集重试（/api/import/run + onlyRelPaths）同样被并发闸门拦住 → 409（两入口判据一致）', async () => {
    const uploadId = '33333333-3333-4333-8333-333333333333';
    const dir = path.join(uploadsRoot, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.scope'), SCOPE, 'utf8');
    const reporter = createTaskReporter(loadConfig(), { id: 'busy-for-run', source: 'web', operation: 'import', scope: SCOPE });
    reporter.update({ state: 'running', startedAt: Date.now() });
    try {
      const res = await fetch(`${handle!.base}/api/import/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: SCOPE, uploadId, onlyRelPaths: ['a.md'] }),
      });
      assert.equal(res.status, 409);
      const body = await res.json() as { code?: string; activeTaskIds?: string[] };
      assert.equal(body.code, 'INCOMPLETE_IMPORT_RUNNING');
      assert.deepEqual(body.activeTaskIds, ['busy-for-run']);
    } finally {
      reporter.finish('failed', { error: '验证收尾：本用例造的在跑任务' });
    }
  });

  it('upload 来源但批次未传完 → 409（与 /api/import/run 同口径，半上传目录不得重试）', async () => {
    const uploadId = '22222222-2222-4222-8222-222222222222';
    const dir = path.join(uploadsRoot, uploadId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.scope'), SCOPE, 'utf8');
    fs.writeFileSync(
      path.join(dir, '.upload-session.json'),
      JSON.stringify({ scope: SCOPE, updatedAt: Date.now(), state: 'uploading', batchCount: 3, completedBatches: [0] }),
      'utf8',
    );
    seedIncomplete({ sourceDir: dir, taskId: 'task-half', items: [{ path: 'a.md' }] });
    const { status, body } = await postRetry({ scope: SCOPE, taskId: 'task-half' });
    assert.equal(status, 409);
    assert.match(String(body.error), /批次/);
  });
});
