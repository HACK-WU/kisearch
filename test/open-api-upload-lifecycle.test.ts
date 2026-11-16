/**
 * open-api-upload-lifecycle.test.ts —— 上传接口的分类（生命周期 / 事件）
 *
 * 背景（2026-11-16 用户拍板）：`ki_sync_relation` 早已支持 lifecycle / ttl_days / event，
 * 但对外上传接口 `POST /open/v1/import/upload` 一个都不认 —— 根因不是"忘了加参数"，而是
 * 上传文档在导入内核里被打成 `isImported: true` 并强制清空分类（S-01 R4「数据源文档强制 wiki」），
 * 设计文档明确把这条通道列为"不加参数"。
 *
 * 本次把上传通道与数据源通道分开：上传的文档是**普通文档**（可分类），
 * 数据源同步 / `ki import --source` / Web 上传的文档身份与行为完全不变。
 *
 * 覆盖：
 *   A. temp：分片落 lifecycle/ttlDays/expiresAt，且 isImported=false
 *   B. 未传分类 = wiki，**不跟随 group 默认**（用户拍板的上传通道口径）
 *   C. 覆盖语义：未传 → 保持原值；显式 wiki → 清空
 *   D. 参数校验（收流前 400、不建任务）：TTL_REQUIRED / TTL_INVALID / ARG_CONFLICT / LIFECYCLE_INVALID
 *   E. 事件：不存在 → 400；已收口 → 400；hidden 阶段 → 上传成功但索引摘除并回显
 *   F. 数据源口径不变：缺省 isImported=true 且分类被清空；上传覆盖数据源文档 → 分类锁定跳过
 *
 * 运行：npx jiti test/open-api-upload-lifecycle.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { registerTestScope, cleanupTestConfig, testConfigPath } from './test-config.js';
import { handleOpenApiImportStatus, handleOpenApiImportUpload } from '../src/lib/open-api/routes/import.js';
import type { OpenApiContext } from '../src/lib/open-api/index.js';
import { createJob, getJobById, runImportJob } from '../src/lib/mcp-http-api.js';
import { loadConfig, resetConfigCache } from '../src/lib/config.js';
import { ensureScopeDir, writeJson } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { loadGroupCache } from '../src/lib/group-cache.js';
import { getGovernancePath } from '../src/lib/governance-store.js';
import { allocateShortId, newEventId, writeEvent, writeTypesDoc } from '../src/lib/events/store.js';
import type { EventRecord, EventTypeRecord } from '../src/lib/events/types.js';
import { resolveVisibilityOfRelation } from '../src/lib/visibility-index.js';
import { ftsSearch } from '../src/lib/fts-client.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-openapi-lifecycle-'));
// 上传暂存根目录取自 os.homedir()（~/.ki/import-uploads）：把 HOME 指到临时目录避免污染真实家目录
process.env.HOME = tmpRoot;

const scope = `openapi-lifecycle-${Date.now()}`;
registerTestScope(scope);
const rawConfig = JSON.parse(fs.readFileSync(testConfigPath, 'utf-8'));
rawConfig.scopes[scope] = {};
fs.writeFileSync(testConfigPath, JSON.stringify(rawConfig), 'utf-8');
resetConfigCache();
ensureScopeDir(scope);

const BOUNDARY = '----ki-lifecycle-boundary';

function multipartBody(filename: string, content: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\n`
    + `Content-Type: text/markdown\r\n\r\n${content}\r\n--${BOUNDARY}--\r\n`,
    'utf8',
  );
}

function fakeReq(buffer: Buffer): http.IncomingMessage {
  const req = Readable.from([buffer]) as unknown as http.IncomingMessage;
  (req as unknown as { headers: Record<string, string> }).headers = {
    'content-type': `multipart/form-data; boundary=${BOUNDARY}`,
  };
  return req;
}

function fakeRes(): { res: http.ServerResponse; state: { status: number; body: string; ended: boolean } } {
  const state = { status: 0, body: '', ended: false };
  const res = {
    get writableEnded(): boolean { return state.ended; },
    writeHead(code: number): unknown { state.status = code; return res; },
    end(chunk?: string): void { if (chunk) state.body += chunk; state.ended = true; },
  };
  return { res: res as unknown as http.ServerResponse, state };
}

function openApiContext(): OpenApiContext {
  return {
    resolveTokenAuth: () => undefined,
    uploadApi: true,
    uploadMaxBytes: 16 * 1024 * 1024,
    config: loadConfig(),
  };
}

async function waitForJob(taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = getJobById(taskId);
    if (job && (job.state === 'done' || job.state === 'failed' || job.state === 'cancelled')) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`导入任务 ${taskId} 超时未结束`);
}

/** 走真实上传路由（含收流前参数校验）；返回 HTTP 状态与响应体（200 时顺带等导入结束） */
async function upload(query: string, filename: string, content: string) {
  const { res, state } = fakeRes();
  await handleOpenApiImportUpload({
    req: fakeReq(multipartBody(filename, content)),
    res,
    url: new URL(`http://127.0.0.1/open/v1/import/upload?${query}`),
    ctx: openApiContext(),
    principal: { scopes: [scope], readOnly: false },
  });
  const body = JSON.parse(state.body || '{}') as Record<string, unknown>;
  const taskId = typeof body.taskId === 'string' ? body.taskId : '';
  const job = state.status === 200 && taskId ? await waitForJob(taskId) : undefined;
  return { status: state.status, body, job };
}

function relationOf(group: string, name: string) {
  const doc = loadGroupCache(scope, group);
  return doc?.hot_relations.find((rel) => rel.text === name);
}

const q = (params: Record<string, string>): string =>
  new URLSearchParams({ scope, vector: '0', ...params }).toString();

after(() => {
  try { fs.rmSync(getKbDir(scope), { recursive: true, force: true }); } catch { /* best effort */ }
  cleanupTestConfig();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('A. temp 分类：上传即落临时期限', () => {
  it('lifecycle=temp&ttlDays=7 → 分片有 lifecycle/ttlDays/expiresAt，且不是数据源文档', async () => {
    const { status, job } = await upload(
      q({ group: '临时组', lifecycle: 'temp', ttlDays: '7' }),
      'temp-doc.md',
      '# 临时文档\n\n7 天后进回收站。\n',
    );
    assert.equal(status, 200);
    assert.equal(job?.state, 'done', `导入应成功：${job?.error ?? ''}`);

    const rel = relationOf('临时组', 'temp-doc');
    assert.ok(rel, '分片里应有该文档');
    assert.equal(rel.lifecycle, 'temp');
    assert.equal(rel.ttlDays, 7);
    assert.equal(typeof rel.expiresAt, 'number');
    // 上传的文档不是数据源文档：这正是分类能生效的前提
    assert.equal(rel.isImported, false);

    const summary = (job?.result as { lifecycle?: { requested?: string; applied?: number } } | undefined)?.lifecycle;
    assert.equal(summary?.requested, 'temp');
    assert.equal(summary?.applied, 1);
  });

  it('status 的 result 透出分类汇总（不泄漏服务端路径）', async () => {
    const { job } = await upload(
      q({ group: '临时组', lifecycle: 'temp', ttlDays: '3' }),
      'temp-status.md',
      '# 临时文档二\n\n看 status。\n',
    );
    const statusRes = fakeRes();
    await handleOpenApiImportStatus({
      req: fakeReq(Buffer.alloc(0)),
      res: statusRes.res,
      url: new URL(`http://127.0.0.1/open/v1/import/status?taskId=${job?.id ?? ''}`),
      ctx: openApiContext(),
      principal: { scopes: [scope], readOnly: false },
    });
    const payload = JSON.parse(statusRes.state.body) as {
      result?: { lifecycle?: { requested?: string; applied?: number; hidden?: string[]; lockedSkipped?: string[] } };
    };
    assert.equal(payload.result?.lifecycle?.requested, 'temp');
    assert.equal(payload.result?.lifecycle?.applied, 1);
    assert.deepEqual(payload.result?.lifecycle?.hidden, []);
    assert.deepEqual(payload.result?.lifecycle?.lockedSkipped, []);
  });
});

describe('B. 未传分类 = wiki，且不跟随 group 默认', () => {
  const group = '目录默认组';
  fs.writeFileSync(
    getGovernancePath(scope),
    JSON.stringify({
      version: 1,
      scope,
      groupDefaults: { [group]: { kind: 'temp', ttlDays: 7 } },
      updatedAt: new Date().toISOString(),
    }),
    'utf-8',
  );

  it('group 配了默认 temp，上传不带 lifecycle → 文档仍是 wiki', async () => {
    const { status, job } = await upload(q({ group }), 'default-group-doc.md', '# 目录默认不该生效\n\n正文。\n');
    assert.equal(status, 200);
    assert.equal(job?.state, 'done', `导入应成功：${job?.error ?? ''}`);

    const rel = relationOf(group, 'default-group-doc');
    assert.ok(rel);
    assert.equal(rel.lifecycle, undefined, '上传通道未传分类必须落 wiki，不读 group 默认');
    assert.equal(rel.expiresAt, undefined);
    assert.equal((job?.result as { lifecycle?: unknown } | undefined)?.lifecycle, undefined, '未传分类时结果不出现 lifecycle 字段');
  });
});

describe('C. 覆盖语义：未传保持原值 / 显式 wiki 清空', () => {
  const group = '覆盖组';
  it('先 temp 再重传不带分类 → 仍保持 temp', async () => {
    await upload(q({ group, lifecycle: 'temp', ttlDays: '5' }), 'keep-doc.md', '# 保持\n\n第一版。\n');
    const before = relationOf(group, 'keep-doc');
    assert.equal(before?.lifecycle, 'temp');

    const second = await upload(q({ group }), 'keep-doc.md', '# 保持\n\n第二版正文变了。\n');
    assert.equal(second.job?.state, 'done', `第二次导入应成功：${second.job?.error ?? ''}`);
    const after = relationOf(group, 'keep-doc');
    assert.equal(after?.lifecycle, 'temp', '未传分类的重传不得抹掉已有分类');
    assert.equal(after?.ttlDays, 5);
  });

  it('显式 lifecycle=wiki → 清空分类字段', async () => {
    const { job } = await upload(q({ group, lifecycle: 'wiki' }), 'keep-doc.md', '# 保持\n\n第三版，改回长期。\n');
    assert.equal(job?.state, 'done', `导入应成功：${job?.error ?? ''}`);
    const rel = relationOf(group, 'keep-doc');
    assert.equal(rel?.lifecycle, undefined);
    assert.equal(rel?.expiresAt, undefined);
    assert.equal(rel?.ttlDays, undefined);
  });
});

describe('D. 参数校验：收流前 400，不创建任务', () => {
  const cases: { name: string; query: Record<string, string>; code: string; reason?: string }[] = [
    { name: 'temp 缺 ttlDays', query: { lifecycle: 'temp' }, code: 'OPEN_API_INVALID_LIFECYCLE', reason: 'TTL_REQUIRED' },
    { name: 'wiki 带 ttlDays', query: { lifecycle: 'wiki', ttlDays: '7' }, code: 'OPEN_API_INVALID_LIFECYCLE', reason: 'LIFECYCLE_ARG_CONFLICT' },
    { name: 'ttlDays 越界', query: { lifecycle: 'temp', ttlDays: '0' }, code: 'OPEN_API_INVALID_LIFECYCLE', reason: 'TTL_INVALID' },
    { name: 'ttlDays 非整数', query: { lifecycle: 'temp', ttlDays: '1.5' }, code: 'OPEN_API_INVALID_LIFECYCLE', reason: 'TTL_INVALID' },
    { name: 'lifecycle 非法值', query: { lifecycle: 'bogus' }, code: 'OPEN_API_INVALID_LIFECYCLE', reason: 'LIFECYCLE_INVALID' },
    { name: 'event 缺失', query: { lifecycle: 'event' }, code: 'OPEN_API_INVALID_LIFECYCLE', reason: 'EVENT_REQUIRED' },
  ];

  for (const item of cases) {
    it(`${item.name} → 400 ${item.code}`, async () => {
      const { status, body, job } = await upload(q({ group: '校验组', ...item.query }), 'bad.md', '# bad\n');
      assert.equal(status, 400, `应被拒绝：${JSON.stringify(body)}`);
      assert.equal(body.code, item.code);
      if (item.reason) assert.equal(body.reason, item.reason, `reason 应为 ${item.reason}：${JSON.stringify(body)}`);
      assert.equal(job, undefined, '参数非法时不得创建导入任务');
    });
  }
});

describe('E. 事件：存在性 / 收口 / hidden 阶段', () => {
  const typeId = 'et_lifecycle_test';
  const typeRecord: EventTypeRecord = {
    id: typeId,
    scope,
    name: '分类测试类型',
    builtin: false,
    stages: [
      { key: 'st_1', name: '计划中', visibility: 'hidden' },
      { key: 'st_2', name: '进行中', visibility: 'full' },
    ],
    terminalAction: 'keep',
    fallbackDays: 90,
    revision: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  writeTypesDoc(scope, { version: 1, revision: 1, types: [typeRecord] });
  const base = { scope, typeId, stageKey: 'st_1', stageIndex: 0, revision: 1, createdAt: Date.now(), updatedAt: Date.now() };
  const openEvent: EventRecord = {
    ...base,
    id: newEventId(),
    shortId: allocateShortId(scope),
    title: '未收口事件',
    closedAt: null,
  };
  const closedEvent: EventRecord = {
    ...base,
    id: newEventId(),
    shortId: allocateShortId(scope),
    title: '已收口事件',
    closedAt: Date.now(),
  };
  writeEvent(scope, openEvent);
  writeEvent(scope, closedEvent);

  it('事件不存在 → 400 OPEN_API_EVENT_NOT_FOUND（附可用事件）', async () => {
    const { status, body, job } = await upload(q({ group: '事件组', lifecycle: 'event', event: '#999' }), 'e1.md', '# e1\n');
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, 'OPEN_API_EVENT_NOT_FOUND');
    assert.ok(Array.isArray(body.available), '应给出可用事件列表');
    assert.equal(job, undefined);
  });

  it('事件已收口 → 400 OPEN_API_EVENT_CLOSED', async () => {
    const { status, body } = await upload(
      q({ group: '事件组', lifecycle: 'event', event: `#${closedEvent.shortId}` }),
      'e2.md',
      '# e2\n',
    );
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(body.code, 'OPEN_API_EVENT_CLOSED');
  });

  it('绑定 hidden 阶段事件 → 上传成功、分类为 event，索引被真正摘除', async () => {
    // 对照文档：同样正文、不绑事件 —— 用来证明"0 命中"不是因为分词搜不到
    const body = '# 对照与隐藏\n\n量子纠缠耳语者的正文。\n';
    const visible = await upload(q({ group: '可见组' }), 'visible-doc.md', body);
    assert.equal(visible.job?.state, 'done', `对照文档导入应成功：${visible.job?.error ?? ''}`);

    const { status, body: resp, job } = await upload(
      q({ group: '事件组', lifecycle: 'event', event: `#${openEvent.shortId}` }),
      'hidden-doc.md',
      body,
    );
    assert.equal(status, 200, JSON.stringify(resp));
    assert.equal(job?.state, 'done', `导入应成功：${job?.error ?? ''}`);

    const rel = relationOf('事件组', 'hidden-doc');
    assert.ok(rel);
    assert.equal(rel.lifecycle, 'event');
    assert.equal(rel.eventId, openEvent.id);
    assert.equal(resolveVisibilityOfRelation(scope, rel).mode, 'hidden', '阶段判据必须认 event + stageKey');

    const summary = (job?.result as { lifecycle?: { hidden?: { group: string; relation: string }[] } } | undefined)?.lifecycle;
    assert.equal(summary?.hidden?.length, 1, 'hidden 文档必须回显（否则调用方以为它可检索）');
    assert.equal(summary?.hidden?.[0]?.relation, 'hidden-doc');

    // ★ 只断言回显是不够的：`applyVisibility` 的 from 缺省时会按"当前语义"算成 hidden，
    //   计划退化成空操作，接口照样回显 hidden、检索照样命中（真机实测过）。
    //   所以这里直接查全文索引：对照命中、hidden 不命中。
    const hits = await ftsSearch({ scope, query: '量子纠缠耳语者', limit: 10 });
    assert.ok(
      hits.some((hit) => hit.relation === 'visible-doc'),
      `对照文档应能被检索命中（否则本断言无语义）：${JSON.stringify(hits.map((h) => h.relation))}`,
    );
    assert.equal(
      hits.some((hit) => hit.relation === 'hidden-doc'),
      false,
      `hidden 阶段文档不得被检索命中：${JSON.stringify(hits.map((h) => h.relation))}`,
    );
  });
});

describe('E2. 档位守卫：hidden 文档被普通覆盖写不能"索引回来"', () => {
  it('再次上传不带分类（keep）→ 内容重写，但索引仍被摘除', async () => {
    // 判据必须是"落盘后的实际分类"而不是"本次入参有没有 event"：
    // 只看入参时 keep 路径会整段跳过守卫，而内容已被重新写进 dense/FTS（sync-relation 同款红线）
    const { job } = await upload(
      q({ group: '事件组' }),
      'hidden-doc.md',
      '# 对照与隐藏\n\n量子纠缠耳语者的正文（第二版）。\n',
    );
    assert.equal(job?.state, 'done', `导入应成功：${job?.error ?? ''}`);

    const modified = (job?.result as { modified?: { relation: string }[] } | undefined)?.modified ?? [];
    assert.ok(
      modified.some((item) => item.relation === 'hidden-doc'),
      `应走覆盖重写（证明内容确实被重新写入）：${JSON.stringify(modified)}`,
    );

    const rel = relationOf('事件组', 'hidden-doc');
    assert.equal(rel?.lifecycle, 'event', '不带分类的重传必须保持原分类');
    assert.equal(resolveVisibilityOfRelation(scope, rel as never).mode, 'hidden');

    const hits = await ftsSearch({ scope, query: '量子纠缠耳语者', limit: 10 });
    assert.equal(
      hits.some((hit) => hit.relation === 'hidden-doc'),
      false,
      `hidden 文档被覆盖写后不得重新出现在索引里：${JSON.stringify(hits.map((h) => h.relation))}`,
    );
  });
});

describe('F. 数据源口径不变（回归）', () => {
  const dsGroup = '数据源组';
  const srcDir = path.join(tmpRoot, 'ds-src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'ds-locked.md'), '# 数据源文档\n\n由目录同步维护。\n', 'utf-8');

  it('缺省（数据源同步/Web 上传口径）→ isImported=true', async () => {
    const job = createJob(scope, 'import', loadConfig(), {
      operator: { type: 'token', label: 'Token test' },
      source: 'open-api',
    });
    await runImportJob(job, { scope, sourceDir: srcDir, group: dsGroup, vector: false }, loadConfig());
    assert.equal(job.state, 'done', `导入应成功：${job.error ?? ''}`);
    assert.equal(relationOf(dsGroup, 'ds-locked')?.isImported, true);
  });

  it('上传带分类覆盖数据源文档 → 分类锁定，该文件被跳过（不改身份、不写分类）', async () => {
    const { job } = await upload(
      q({ group: dsGroup, lifecycle: 'temp', ttlDays: '9' }),
      'ds-locked.md',
      '# 数据源文档\n\n上传试图改分类。\n',
    );
    assert.equal(job?.state, 'failed', '唯一文件被跳过时不得报成功');
    assert.match(String(job?.error ?? ''), /分类被锁定/, `错误文案要点明原因：${job?.error ?? ''}`);

    const rel = relationOf(dsGroup, 'ds-locked');
    assert.equal(rel?.isImported, true, '上传不得把数据源文档降级');
    assert.equal(rel?.lifecycle, undefined, '分类锁定文档不得被写上分类');
  });
});
