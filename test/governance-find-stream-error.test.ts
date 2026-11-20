/**
 * governance-find-stream-error.test.ts —— 「AI 查找」流式分支的**错误通道**（回归）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/governance-find-stream-error.test.ts
 *
 * 守的是 `POST /governance/events/:id/refs/search?stream=1` 的失败路径。背景（2026-11-20 线上现象）：
 *   · 200 + `text/event-stream` 在查找开始**之前**就已发出，门禁/超时/上游异常都没有 HTTP 状态码可用；
 *   · 旧实现直接让异常冒到统一错误出口 → `sendJson` 二次 `writeHead` →
 *     `ERR_HTTP_HEADERS_SENT` → 从 `catch` 里逃出去成 unhandledRejection → **整个 daemon 退出**；
 *   · 客户端只看到连接被掐断，面板显示「流式响应未返回结果（连接可能被中断）」，真实原因全丢。
 *
 * 因此这里用**真实 http server**（而不是响应桩）验证两件事：
 *   ① 失败必须以 `event: error` 帧下发，且带真实错误码；绝不能没有终帧就断开；
 *   ② 同一个进程在失败后仍能正常处理后续请求（不允许出现未捕获异常打死服务）。
 *
 * 用例借测试配置（无 `llm` 段）稳定命中 `FIND_LLM_UNAVAILABLE` 门禁 —— 门禁位于 SSE 头之后，
 * 与线上失败走的是同一条路径。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { getKbDir } from '../src/lib/scope.js';
import { createEvent } from '../src/lib/events/event-service.js';
import { handleGovernanceRoutes } from '../src/lib/governance-http.js';

const scope = `gov-find-stream-${Date.now()}`;

let server: http.Server;
let base = '';
let eventId = '';

/** 照抄 daemon 的两层出口：governance 自己兜一层，mcp-http-api 外层再兜一层 */
function startServer(): http.Server {
  return http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      try {
        const handled = await handleGovernanceRoutes(req, res, url, { authScopes: null });
        if (!handled) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end('{"ok":false}'); }
      } catch (err) {
        if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
      }
    })();
  });
}

/** 按前端 `findRefCandidatesStream` 的口径切帧 */
function parseSse(raw: string): Array<{ event: string | undefined; data: unknown }> {
  const frames: Array<{ event: string | undefined; data: unknown }> = [];
  for (const chunk of raw.split('\n\n')) {
    if (!chunk.trim()) continue;
    const event = /^event: (\w+)$/m.exec(chunk)?.[1];
    const dataLine = /^data: (.*)$/m.exec(chunk)?.[1];
    if (!dataLine) continue;
    try { frames.push({ event, data: JSON.parse(dataLine) }); } catch { /* 非 JSON 帧忽略 */ }
  }
  return frames;
}

before(async () => {
  registerTestScope(scope);
  initScope(scope);
  eventId = (await createEvent(scope, { title: '流式错误通道回归', typeId: 'et_1' })).id;
  server = startServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('流式 AI 查找的失败路径', () => {
  it('门禁失败 → 下发 event: error（带真实错误码），且没有 result 帧', async () => {
    const res = await fetch(`${base}/api/governance/events/${encodeURIComponent(eventId)}/refs/search?stream=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, 200, 'SSE 头在查找开始前就已发出，失败时状态码仍是 200');
    assert.match(String(res.headers.get('content-type')), /text\/event-stream/);

    const raw = await res.text();
    const frames = parseSse(raw);
    const errFrame = frames.find((f) => f.event === 'error');

    assert.ok(errFrame, `必须有 event: error 终帧，实际收到：${JSON.stringify(raw)}`);
    assert.equal((errFrame.data as { ok?: boolean }).ok, false);
    assert.equal((errFrame.data as { code?: string }).code, 'FIND_LLM_UNAVAILABLE', '必须透出真实错误码，不能压成通用文案');
    assert.match(String((errFrame.data as { error?: string }).error), /模型/, '必须给出可操作的原因');
    assert.equal(frames.some((f) => f.event === 'result'), false, '失败时不得有 result 帧');
  });

  it('失败后同一进程仍能正常服务（不允许未捕获异常打死 daemon）', async () => {
    const res = await fetch(`${base}/api/governance/events?scope=${encodeURIComponent(scope)}`, {
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(res.status, 200);
    const body = await res.json() as { ok?: boolean };
    assert.equal(body.ok, true);
  });
});
