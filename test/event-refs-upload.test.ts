/**
 * event-refs-upload.test.ts —— `POST /governance/events/:id/refs/upload` 的路由语义（REQ-20261118-001）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/event-refs-upload.test.ts
 *
 * 守的是**「先校验、后落盘」这条硬约束**与拒绝口径：
 *   ① 超数量 / 带目录路径 / 非白名单 / 超大 / 名额不足 —— 必须一个字节都不落盘就拒；
 *   ② 请求契约（202 + 默认落点 + accepted/rejected）稳定；
 *   ③ 导入结束后 `job.refsBinding` 一定给出（成功与否都要能解释"哪篇没挂上"）。
 *
 * 不覆盖：真实 embedding 质量（依赖本机模型与密钥），断言只到「job 落定 + 绑定结果存在」。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { createEvent } from '../src/lib/events/event-service.js';
import { listRefs } from '../src/lib/events/refs-service.js';
import { addRefDocs } from '../src/lib/events/refs-store.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';
import { matchRoute } from '../src/lib/auth/route-permissions.js';
import { getUploadsRoot, getJobById } from '../src/lib/mcp-http-api.js';
import { closeEngine } from '../src/lib/vector-client.js';

const scope = `evref-upload-${Date.now()}`;
let eventId = '';
let eventShortId = 0;

/** 最小请求桩：`readJsonBody` 只监听 data / end / error / aborted */
function mkReq(payload?: unknown): IncomingMessage {
  const req = new EventEmitter() as unknown as IncomingMessage;
  (req as unknown as { method: string }).method = 'POST';
  const raw = payload === undefined ? '' : JSON.stringify(payload);
  setImmediate(() => {
    // 该路由走 `http-body.readJsonBody`（Buffer 拼接），桩必须发 Buffer 而不是字符串
    if (raw) req.emit('data', Buffer.from(raw, 'utf-8'));
    req.emit('end');
  });
  return req;
}

/** 最小响应桩：记最后一次 writeHead 的状态码与 end 的 body */
function mkRes(): { res: ServerResponse; status: () => number; json: () => Record<string, unknown> } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead: (code: number) => { status = code; return res; },
    end: (b?: string) => { if (b) chunks.push(b); },
    writableEnded: false,
  } as unknown as ServerResponse;
  return {
    res,
    status: () => status,
    json: () => JSON.parse(chunks[chunks.length - 1] ?? '{}') as Record<string, unknown>,
  };
}

async function callUpload(
  payload: unknown,
  targetEventId = eventId,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { res, status, json } = mkRes();
  const handled = await handleGovernanceRoutes(
    mkReq(payload),
    res,
    new URL(`/api/governance/events/${encodeURIComponent(targetEventId)}/refs/upload`, 'http://localhost'),
    { authScopes: null },
  );
  assert.equal(handled, true, '必须被 governance 路由处理，不能落到上层 404');
  return { status: status(), body: json() };
}

const b64 = (text: string): string => Buffer.from(text, 'utf-8').toString('base64');
const mdFile = (name: string): { name: string; content: string } => ({
  name,
  content: b64(`# ${name}\n\n事件参考文档上传用例`),
});

/** 暂存目录快照：断言"拒绝路径不落盘" */
function uploadDirs(): string[] {
  try {
    return fs.readdirSync(getUploadsRoot()).sort();
  } catch {
    return [];
  }
}

before(async () => {
  registerTestScope(scope);
  initScope(scope);
  const event = await createEvent(scope, { title: '上传参考文档验证', typeId: 'et_1' });
  eventId = event.id;
  eventShortId = event.shortId;
});

after(async () => {
  // 真实导入会打开向量引擎句柄：不关掉本测试进程不会退出（与 import-* e2e 同口径）
  await closeEngine();
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('① 权限登记', () => {
  it('新路由登记为 knowledge.write（漏登记 = 404）', () => {
    const m = matchRoute('POST', '/governance/events/evt_x/refs/upload');
    assert.equal(m.kind, 'permission');
    assert.equal(m.capability, 'knowledge.write');
  });
});

describe('② 校验前置：被拒时一个字节都不落盘', () => {
  it('没有文件 → 400 REF_UPLOAD_NO_FILE', async () => {
    const before = uploadDirs();
    const { status, body } = await callUpload({ scope, files: [] });
    assert.equal(status, 400);
    assert.equal(body.code, 'REF_UPLOAD_NO_FILE');
    assert.deepEqual(uploadDirs(), before);
  });

  it('11 个文件 → 400 REF_UPLOAD_TOO_MANY（不截断）', async () => {
    const before = uploadDirs();
    const files = Array.from({ length: 11 }, (_, i) => mdFile(`超量-${i}.md`));
    const { status, body } = await callUpload({ scope, files });
    assert.equal(status, 400);
    assert.equal(body.code, 'REF_UPLOAD_TOO_MANY');
    assert.match(String(body.error), /单次最多 10 个/);
    assert.deepEqual(uploadDirs(), before, '拒绝路径不得创建暂存目录');
  });

  it('文件名带目录分隔符 → 400 REF_UPLOAD_INVALID_FILE（禁目录）', async () => {
    const before = uploadDirs();
    const { status, body } = await callUpload({ scope, files: [mdFile('目录/子文件.md')] });
    assert.equal(status, 400);
    assert.equal(body.code, 'REF_UPLOAD_INVALID_FILE');
    const details = body.details as { files: { error: string }[] };
    assert.match(details.files[0]!.error, /不支持上传目录或子路径/);
    assert.deepEqual(uploadDirs(), before);
  });

  it('非白名单扩展名 → 400 REF_UPLOAD_INVALID_FILE', async () => {
    const { status, body } = await callUpload({
      scope,
      files: [{ name: 'note.txt', content: b64('plain text') }],
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'REF_UPLOAD_INVALID_FILE');
    const details = body.details as { files: { error: string }[] };
    assert.match(details.files[0]!.error, /不支持的扩展名/);
  });

  it('单文件超上限（1MB）→ 400 REF_UPLOAD_INVALID_FILE', async () => {
    const big = Buffer.alloc(1100 * 1024, 0x61).toString('base64');
    const { status, body } = await callUpload({ scope, files: [{ name: 'big.md', content: big }] });
    assert.equal(status, 400);
    assert.equal(body.code, 'REF_UPLOAD_INVALID_FILE');
    const details = body.details as { files: { error: string }[] };
    assert.match(details.files[0]!.error, /文件超过大小上限/);
  });

  it('落点 Group 非法 → 400 REF_UPLOAD_GROUP_INVALID', async () => {
    const { status, body } = await callUpload({ scope, group: '../escape', files: [mdFile('a.md')] });
    assert.equal(status, 400);
    assert.equal(body.code, 'REF_UPLOAD_GROUP_INVALID');
  });

  it('名额不足 → 409 REF_LIMIT_EXCEEDED（先拒，避免孤儿文档）', async () => {
    // 独立事件 + 直接写 refs.json 顶到 45 条（避免造 45 篇真文档）
    const ev = await createEvent(scope, { title: '名额不足验证', typeId: 'et_1' });
    const now = Date.now();
    addRefDocs(
      scope,
      ev.id,
      Array.from({ length: 45 }, (_, i) => ({
        scope,
        group: '名额占位',
        name: `占位-${i}`,
        addedBy: 'manual' as const,
        addedAt: now,
      })),
      now,
    );
    const before = uploadDirs();
    const { status, body } = await callUpload({
      scope,
      files: Array.from({ length: 10 }, (_, i) => mdFile(`名额-${i}.md`)),
    }, ev.id);
    assert.equal(status, 409);
    assert.equal(body.code, 'REF_LIMIT_EXCEEDED');
    assert.match(String(body.error), /最多 50 篇/);
    assert.deepEqual(uploadDirs(), before, '名额不足必须在落盘前拒绝');
  });
});

describe('③ 正常链路：202 + 默认落点 + 绑定结果回执', () => {
  it('上传 1 个文件 → 202，落点默认 `事件参考/{短号}-{标题}`，job 落定后有 refsBinding', async () => {
    const { status, body } = await callUpload({ scope, files: [mdFile('上传成功示例.md')] });
    assert.equal(status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.group, `事件参考/${eventShortId}-上传参考文档验证`);
    const accepted = body.accepted as { name: string; relation: string }[];
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.relation, '上传成功示例', 'relation = 文件名去扩展名（与导入同源）');
    assert.equal(body.eventId, eventId);

    const jobId = String(body.jobId);
    assert.ok(jobId, '必须返回 jobId 供前端轮询');

    const deadline = Date.now() + 60_000;
    let job = getJobById(jobId);
    while (job && job.state === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      job = getJobById(jobId);
    }
    assert.ok(job, 'job 应可在同一进程内查到（与 /api/import/status 同一份 Map）');
    assert.notEqual(job!.state, 'running', 'job 应在超时前落定');

    // 绑定结果晚于 state=done：给一点余量
    const bindDeadline = Date.now() + 20_000;
    while (!job!.refsBinding && Date.now() < bindDeadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(job!.refsBinding, '导入落定后必须写 refsBinding（成功/失败都要能解释）');
    assert.equal(job!.refsBinding!.expected, 1);

    if (job!.refsBinding!.added === 1) {
      const refs = listRefs(scope, eventId).refs.filter((r) => r.group.startsWith('事件参考/'));
      assert.ok(refs.some((r) => r.name === '上传成功示例'), 'added=1 时引用列表里必须有这篇');
    } else {
      // 未挂上时必须给出原因（本机缺 embedding 时属预期，不是静默失败）
      assert.ok(job!.refsBinding!.failed.length > 0, '没挂上却没有任何失败说明 = 静默失败');
    }
  });
});

describe('④ 部分文件未通过校验：其余照常导入，失败逐条回执', () => {
  it('1 个 md + 1 个 txt → 只导入 md，txt 进 rejected 与 refsBinding.failed', async () => {
    const { status, body } = await callUpload({
      scope,
      files: [mdFile('部分成功示例.md'), { name: 'bad.txt', content: b64('nope') }],
    });
    assert.equal(status, 202);
    const accepted = body.accepted as { name: string }[];
    const rejected = body.rejected as { name: string; error: string }[];
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]!.name, '部分成功示例.md');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.name, 'bad.txt');

    const jobId = String(body.jobId);
    const deadline = Date.now() + 60_000;
    let job = getJobById(jobId);
    while (job && job.state === 'running' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
      job = getJobById(jobId);
    }
    const bindDeadline = Date.now() + 20_000;
    while (job && !job.refsBinding && Date.now() < bindDeadline) {
      await new Promise((r) => setTimeout(r, 100));
      job = getJobById(jobId);
    }
    assert.ok(job?.refsBinding, '必须给出绑定结果');
    assert.equal(job!.refsBinding!.expected, 1, 'expected 只数通过校验的文件');
    const failedNames = job!.refsBinding!.failed.map((f) => f.name);
    assert.ok(failedNames.includes('bad.txt'), '未通过校验的文件也必须出现在失败清单里（不能静默丢弃）');
  });
});

describe('⑤ 挂载点不越界', () => {
  it('非 /governance/* 返回 false', async () => {
    const { res } = mkRes();
    const handled = await handleGovernanceRoutes(
      mkReq({}),
      res,
      new URL('/api/doc/list', 'http://localhost'),
      { authScopes: null },
    );
    assert.equal(handled, false);
  });
});
