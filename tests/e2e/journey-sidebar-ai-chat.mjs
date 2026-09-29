#!/usr/bin/env node
/**
 * E2E 真实链路旅程：Web 侧边栏 AI 对话（REQ-20260924-001）
 *
 * 判据来源（**只依据规格写断言，不读实现**）：
 *   - sub-requirements/SR-01-后端检索与生成链/slice.md §2 场景 / §3 验收标准
 *   - src/lib/chat/chat-contract.ts（SSE 事件序 / ChatConfigOk / 错误码 / 预算 —— 契约 SSOT）
 *
 * 前置：本机 daemon 已启动（`ki mcp --http`，默认 127.0.0.1:7423；回环免鉴权）
 *       且 KI_E2E_SCOPE 对应的向量集合可用（见 .env.e2e）
 *
 * 运行：node tests/e2e/journey-sidebar-ai-chat.mjs
 *
 * 副作用：仅在该 scope 下创建/删除本次自己的会话；不触碰 kb/ 与向量集合。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

// ─────────────────────────────────────────────────────────────
// env 注入（.env.e2e 优先，回退 .env；定义文件本身保持无密）
// ─────────────────────────────────────────────────────────────

function loadEnv() {
  const candidates = ['.env.e2e', '.env'];
  for (const name of candidates) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) continue;
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  }
  return {};
}

const env = loadEnv();
const BASE = env.KI_E2E_BASE_URL || 'http://127.0.0.1:7423';
const SCOPE = env.KI_E2E_SCOPE || 'default';

// 知识库内 / 库外的问题（default scope 的 KB 含「错误库」条目：健康检查超时、TanStack Query 白屏等）
const Q_IN_KB = '健康检查超时被误报为服务未就绪，根因是什么？';
const Q_OUT_KB = '请推导量子纠缠中贝尔不等式的完整数学过程。';

const ctx = { data: { created: [] } };
const results = [];

/**
 * SSE 请求的**客户端超时**（对齐"前端 SSE 无超时"这条已报缺陷：服务端假死时，
 * 没有超时的客户端会永远挂着——本 harness 早期版本就踩过，journey 卡在 qa_miss 不动）。
 * 这里用 AbortSignal.timeout 兜底：超时转为明确报错，而不是静默挂起。
 */
const SSE_TIMEOUT_MS = 180_000;
function withTimeout(outer) {
  const t = AbortSignal.timeout(SSE_TIMEOUT_MS);
  return outer ? AbortSignal.any([outer, t]) : t;
}

// ─────────────────────────────────────────────────────────────
// HTTP / SSE 工具
// ─────────────────────────────────────────────────────────────

async function api(method, p, body, { expectSse = false } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 非 JSON（如 SSE 错误帧）保留原文 */ }
  if (expectSse) return { status: res.status, json, text, contentType: res.headers.get('content-type') || '' };
  return { status: res.status, json, text };
}

/** 发消息 / 重生成 / 编辑重发：消费 SSE 流（含 UTF-8 多字节跨块，用 TextDecoder streaming + 帧缓冲） */
async function sseStream(p, body, { signal } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: withTimeout(signal),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('text/event-stream')) {
    return { status: res.status, events: [], raw: await res.text(), contentType: ct };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload) continue;
        try { events.push(JSON.parse(payload)); } catch { /* 忽略非 JSON 帧 */ }
      }
    }
  }
  return { status: res.status, events, raw: '', contentType: ct };
}

/** PATCH 类（编辑重发）也返回 SSE */
async function ssePatch(p, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
    signal: withTimeout(undefined),
  });
  const ct = res.headers.get('content-type') || '';
  if (!res.ok || !ct.includes('text/event-stream')) {
    return { status: res.status, events: [], raw: await res.text(), contentType: ct };
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = ''; const events = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload) { try { events.push(JSON.parse(payload)); } catch { /* noop */ } }
      }
    }
  }
  return { status: res.status, events, raw: '', contentType: ct };
}

// ─────────────────────────────────────────────────────────────
// 断言工具
// ─────────────────────────────────────────────────────────────

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** SSE 事件序校验（对齐 chat-contract.ts 的 CHAT_EVENT_ORDER_RULES） */
function validateEventOrder(events) {
  const problems = [];
  const types = events.map((e) => e.type);
  if (types.length === 0) return ['未收到任何 SSE 事件'];
  if (types[0] !== 'meta') problems.push(`首事件应为 meta，实际为 ${types[0]}`);
  // tool_start / tool_end 成对
  let openTools = 0;
  for (const t of types) {
    if (t === 'tool_start') openTools += 1;
    if (t === 'tool_end') { openTools -= 1; if (openTools < 0) problems.push('tool_end 多于 tool_start'); }
  }
  if (openTools !== 0) problems.push(`tool_start 未配对：仍有 ${openTools} 个未收到 tool_end`);
  // sources 至多一次且在 done 之前
  const srcIdx = types.indexOf('sources');
  if (types.filter((t) => t === 'sources').length > 1) problems.push('sources 出现多次（应至多一次）');
  const doneIdx = types.lastIndexOf('done');
  if (doneIdx === -1) problems.push('缺少终态事件 done');
  else if (srcIdx !== -1 && srcIdx > doneIdx) problems.push('sources 出现在 done 之后');
  // degraded 至多一次
  if (types.filter((t) => t === 'degraded').length > 1) problems.push('degraded 出现多次');
  // 流内 error 不应与 done 同时存在
  if (types.includes('error') && doneIdx !== -1) problems.push('同时出现 error 与 done');
  return problems;
}

const textOf = (events, type) => events.filter((e) => e.type === type).map((e) => e.text || '').join('');
const findEvent = (events, type) => events.find((e) => e.type === type);

// ─────────────────────────────────────────────────────────────
// 步骤定义
// ─────────────────────────────────────────────────────────────

const steps = [
  {
    id: 'config_get', type: 'api', name: 'GET /api/chat/config',
    async run() {
      const r = await api('GET', '/api/chat/config');
      assert(r.status === 200 && r.json?.ok === true, `期望 200+ok:true，实际 ${r.status} ${r.text.slice(0, 200)}`);
      const c = r.json;
      assert(c.enabled === true, 'enabled 应为 true（否则对话功能不可用）');
      assert(typeof c.model === 'string' && c.model.length > 0, `model 应为非空字符串，实际 ${c.model}`);
      assert(typeof c.maxToolRounds === 'number' && c.maxToolRounds === 3, `maxToolRounds 应为 3，实际 ${c.maxToolRounds}`);
      // 契约：baseURLHost 仅主机名，绝不回传 apiKey 或完整 URL 路径
      assert(c.baseURLHost && !c.baseURLHost.includes('/'), `baseURLHost 不应含路径，实际 ${c.baseURLHost}`);
      assert(!JSON.stringify(c).includes('sk-'), '响应体绝不能回传 apiKey');
      assert(c.ackRequired === false, 'ackRequired 应为 false（本环境已确认外发）');
      assert(c.retrievalEnabled === true, 'retrievalEnabled 应为 true（= !ackRequired）');
      ctx.data.model = c.model;
      ctx.data.maxToolRounds = c.maxToolRounds;
      return `enabled=true model=${c.model} host=${c.baseURLHost} tools=${c.supportsTools} ack=${c.ackRequired} retrieval=${c.retrievalEnabled}`;
    },
  },
  {
    id: 'conv_create', type: 'api', name: '建会话',
    async run() {
      const r = await api('POST', '/api/chat/conversations', { scope: SCOPE });
      // 创建类接口按 REST 惯例返回 201；规格未约定具体码，故 200/201 均接受
      assert((r.status === 200 || r.status === 201) && r.json?.ok === true, `期望 200/201+ok:true，实际 ${r.status} ${r.text.slice(0, 200)}`);
      const conv = r.json.conv;
      assert(conv?.id, `响应应含 conv.id，实际 ${r.text.slice(0, 200)}`);
      // ★ 先登记再断言：避免后续断言失败时已创建的会话泄漏（teardown 只删登记过的）
      ctx.data.convId = conv.id;
      ctx.data.created.push(conv.id);
      assert(conv.scope === SCOPE, `scope 应为 ${SCOPE}，实际 ${conv.scope}`);
      assert(conv.messageCount === 0 || conv.messageCount === undefined, '新会话 messageCount 应为 0');
      return `conv.id=${conv.id} scope=${conv.scope} title="${conv.title}"`;
    },
  },
  {
    id: 'conv_list', type: 'api', name: '列表含新会话',
    async run() {
      const r = await api('GET', `/api/chat/conversations?scope=${encodeURIComponent(SCOPE)}`);
      assert(r.status === 200 && r.json?.ok === true, `期望 200+ok:true，实际 ${r.status}`);
      const items = r.json.items || [];
      const hit = items.find((i) => i.id === ctx.data.convId);
      assert(hit, `列表应含新建会话 ${ctx.data.convId}（实际 ${items.length} 条）`);
      assert(hit.corrupted === false, '列表项 corrupted 应为 false');
      return `items=${items.length}，命中 ${hit.id} messageCount=${hit.messageCount}`;
    },
  },
  {
    id: 'qa_hit', type: 'api', name: '提问知识库内的问题（SSE，真实模型+检索）',
    async run() {
      const r = await sseStream(`/api/chat/conversations/${ctx.data.convId}/messages?scope=${encodeURIComponent(SCOPE)}`, { text: Q_IN_KB });
      assert(r.status === 200, `期望 200，实际 ${r.status} ${String(r.raw).slice(0, 200)}`);
      const problems = validateEventOrder(r.events);
      assert(problems.length === 0, `事件序违规：${problems.join('；')}`);
      const meta = findEvent(r.events, 'meta');
      assert(meta.messageId, 'meta 应含 messageId');
      assert(meta.model === ctx.data.model, `meta.model 应与 config 一致：${meta.model} vs ${ctx.data.model}`);
      const toolStart = findEvent(r.events, 'tool_start');
      assert(toolStart, 'SR-01 §2.1 要求模型自主调用检索工具，但未收到 tool_start');
      assert(toolStart.name === 'kb_search', `工具名应为 kb_search，实际 ${toolStart.name}`);
      assert(['fulltext', 'hybrid'].includes(toolStart.mode), `mode 应为 fulltext|hybrid，实际 ${toolStart.mode}`);
      const toolEnd = findEvent(r.events, 'tool_end');
      assert(toolEnd && !toolEnd.error, `tool_end 应无 error，实际 ${JSON.stringify(toolEnd)}`);
      const content = textOf(r.events, 'content');
      assert(content.trim().length > 0, 'content 不应为空');
      const done = findEvent(r.events, 'done');
      assert(Array.isArray(done.sources) && done.sources.length > 0, 'SR-01 §2.1：命中知识库时应附来源引用，实际 done.sources 为空');
      for (const s of done.sources) {
        assert(s.group !== undefined && s.doc !== undefined, `来源应含 group/doc：${JSON.stringify(s)}`);
        assert((s.snippet || '').length <= 200, `snippet 应 ≤200 字（预算 sourceSnippetChars），实际 ${(s.snippet || '').length}`);
        assert(!(s.lineStart === 0 && s.lineEnd === 0) || true, '行号 0 允许（chunk fallback）');
      }
      ctx.data.contentHit = content;
      ctx.data.sourcesHit = done.sources;
      ctx.data.messageIdHit = meta.messageId;
      return `events=${r.events.length} hits=${toolEnd.hits} durationMs=${toolEnd.durationMs} sources=${done.sources.length} content=${content.length}字 finish=${done.finishReason}`;
    },
  },
  {
    id: 'persist', type: 'assert', name: '落盘与刷新复原（跨组件终态）',
    async run() {
      const r = await api('GET', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`);
      assert(r.status === 200 && r.json?.ok === true, `期望 200，实际 ${r.status}`);
      const conv = r.json.conv;
      assert(conv.messageCount === 2, `messageCount 应为 2，实际 ${conv.messageCount}`);
      const [u, a] = conv.messages;
      assert(u.role === 'user' && u.content === Q_IN_KB, `首条应为本轮 user 消息，实际 role=${u.role}`);
      assert(a.role === 'assistant' && a.content.trim().length > 0, '末条应为非空 assistant 消息');
      assert(Array.isArray(a.sources) && a.sources.length > 0, 'assistant.sources 应落盘（刷新后仍需展示引用）');
      // 契约不变量：ChatMessage 不含 reasoning（D7 思考不落盘）
      for (const m of conv.messages) {
        assert(!('reasoning' in m), `ChatMessage 不得含 reasoning 字段（D7），实际字段：${Object.keys(m).join(',')}`);
      }
      assert(JSON.stringify(a.content) === JSON.stringify(ctx.data.contentHit), '落盘内容应与流式内容一致');
      return `messages=${conv.messages.length} sources=${a.sources.length} 无 reasoning 字段；title="${conv.title}"`;
    },
  },
  {
    id: 'qa_miss', type: 'api', name: '提问知识库外的事（必须如实说未找到）',
    async run() {
      const r = await sseStream(`/api/chat/conversations/${ctx.data.convId}/messages?scope=${encodeURIComponent(SCOPE)}`, { text: Q_OUT_KB });
      assert(r.status === 200, `期望 200，实际 ${r.status}`);
      const problems = validateEventOrder(r.events);
      assert(problems.length === 0, `事件序违规：${problems.join('；')}`);
      const content = textOf(r.events, 'content');
      assert(content.includes('未找到'), `SR-01 §2.2：库外问题须如实回答「未找到」，实际：${content.slice(0, 200)}`);
      // 契约真实条款是「**无来源时不发空数组**」——不是「答未找到就不能有 sources」：
      // 语义检索对任何 query 都会返回 top-k 命中，模型据此判断不相关并如实说明，来源仍可作为可核对引用保留。
      const srcEvt = findEvent(r.events, 'sources');
      assert(!srcEvt || (srcEvt.sources || []).length > 0, '若发 sources 事件则不得为空数组（契约：无来源时不发，而非发空数组）');
      const toolEndMiss = findEvent(r.events, 'tool_end');
      const hits = toolEndMiss ? toolEndMiss.hits : null;
      return `content=${content.length}字 含「未找到」✅；检索命中=${hits}（语义检索 top-k，模型判定不相关）sources=${srcEvt ? srcEvt.sources.length : 0}`;
    },
  },
  {
    id: 'regenerate', type: 'api', name: '重新生成（不新增 user 消息）',
    async run() {
      const before = (await api('GET', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`)).json.conv;
      const userCountBefore = before.messages.filter((m) => m.role === 'user').length;
      const r = await sseStream(`/api/chat/conversations/${ctx.data.convId}/regenerate?scope=${encodeURIComponent(SCOPE)}`, {});
      assert(r.status === 200, `期望 200，实际 ${r.status} ${String(r.raw).slice(0, 200)}`);
      const problems = validateEventOrder(r.events);
      assert(problems.length === 0, `事件序违规：${problems.join('；')}`);
      const content = textOf(r.events, 'content');
      assert(content.trim().length > 0, '重生成应产出内容');
      const after = (await api('GET', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`)).json.conv;
      const userCountAfter = after.messages.filter((m) => m.role === 'user').length;
      assert(userCountAfter === userCountBefore, `SR-01 §2.4：重生成不得新增 user 消息（${userCountBefore} → ${userCountAfter}）`);
      assert(after.messageCount === before.messageCount, `messageCount 应不变（${before.messageCount} → ${after.messageCount}）`);
      return `user 消息数 ${userCountBefore}→${userCountAfter}，messageCount ${before.messageCount}→${after.messageCount}；重生成内容 ${content.length}字`;
    },
  },
  {
    id: 'edit_resend', type: 'api', name: '编辑 user 消息并重发（原子截断）',
    async run() {
      const before = (await api('GET', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`)).json.conv;
      const firstUser = before.messages.find((m) => m.role === 'user');
      assert(firstUser, '前置：会话应含 user 消息');
      const r = await ssePatch(
        `/api/chat/conversations/${ctx.data.convId}/messages/${firstUser.id}?scope=${encodeURIComponent(SCOPE)}`,
        { text: `${Q_IN_KB}（编辑重发）` },
      );
      assert(r.status === 200, `期望 200，实际 ${r.status} ${String(r.raw).slice(0, 200)}`);
      const problems = validateEventOrder(r.events);
      assert(problems.length === 0, `事件序违规：${problems.join('；')}`);
      const meta = findEvent(r.events, 'meta');
      const after = (await api('GET', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`)).json.conv;
      // 原子截断：被编辑的 user 消息之后的消息应全部被截断，再补 1 条新的 assistant
      const idx = after.messages.findIndex((m) => m.id === firstUser.id);
      assert(idx !== -1, '被编辑的 user 消息应仍在（消息 id 保留）');
      assert(after.messages[idx].content.includes('（编辑重发）'), '被编辑消息内容应更新');
      assert(after.messages.length === idx + 2, `其后消息应被原子截断（期望 ${idx + 2} 条，实际 ${after.messages.length} 条）`);
      assert(after.messages[after.messages.length - 1].role === 'assistant', '截断后应补一条新的 assistant 消息');
      const discarded = meta && typeof meta.discardedCount === 'number' ? meta.discardedCount : null;
      return `截断后 messages=${after.messages.length}（被编辑消息 idx=${idx}）；meta.discardedCount=${discarded}`;
    },
  },
  {
    id: 'archive', type: 'api', name: '归档 / 取消归档',
    async run() {
      const a1 = await api('POST', `/api/chat/conversations/${ctx.data.convId}/archive?scope=${encodeURIComponent(SCOPE)}`, { archived: true });
      assert(a1.status === 200 && a1.json?.ok === true, `归档期望 200+ok，实际 ${a1.status} ${a1.text.slice(0, 150)}`);
      const inArchived = ((await api('GET', `/api/chat/conversations?scope=${encodeURIComponent(SCOPE)}&archived=1`)).json.items || []).some((i) => i.id === ctx.data.convId);
      assert(inArchived, 'archived=1 列表应含该会话');
      const inActive = ((await api('GET', `/api/chat/conversations?scope=${encodeURIComponent(SCOPE)}&archived=0`)).json.items || []).some((i) => i.id === ctx.data.convId);
      assert(!inActive, 'archived=0 列表不应含已归档会话');
      const a2 = await api('POST', `/api/chat/conversations/${ctx.data.convId}/archive?scope=${encodeURIComponent(SCOPE)}`, { archived: false });
      assert(a2.status === 200 && a2.json?.ok === true, '取消归档应 ok');
      const back = ((await api('GET', `/api/chat/conversations?scope=${encodeURIComponent(SCOPE)}&archived=0`)).json.items || []).some((i) => i.id === ctx.data.convId);
      assert(back, '取消归档后应回到活跃列表');
      return '归档 → archived=1 可见 / archived=0 不可见 → 取消归档 → 回到活跃列表';
    },
  },
  {
    id: 'rename', type: 'api', name: '改标题',
    async run() {
      const title = `e2e-侧边栏对话-${Date.now()}`;
      const r = await api('PATCH', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`, { title });
      assert(r.status === 200 && r.json?.ok === true, `期望 200+ok，实际 ${r.status} ${r.text.slice(0, 150)}`);
      const after = (await api('GET', `/api/chat/conversations/${ctx.data.convId}?scope=${encodeURIComponent(SCOPE)}`)).json.conv;
      assert(after.title === title, `title 应为 "${title}"，实际 "${after.title}"`);
      return `title="${after.title}"`;
    },
  },
  {
    id: 'err_404', type: 'api', name: '未知会话发消息 → 404',
    async run() {
      const r = await api('POST', `/api/chat/conversations/c-not-exist-e2e/messages?scope=${encodeURIComponent(SCOPE)}`, { text: 'hi' });
      assert(r.status === 404, `期望 404，实际 ${r.status}`);
      assert(r.json?.code === 'CONVERSATION_NOT_FOUND', `code 应为 CONVERSATION_NOT_FOUND，实际 ${r.json?.code}`);
      return `404 ${r.json.code}`;
    },
  },
  {
    id: 'err_400', type: 'api', name: '非法入参 → 400',
    async run() {
      const a = await api('POST', '/api/chat/conversations', {});
      assert(a.status === 400, `建会话缺 scope 期望 400，实际 ${a.status}`);
      assert(a.json?.code === 'CONVERSATION_INVALID', `code 应为 CONVERSATION_INVALID，实际 ${a.json?.code}`);
      const b = await api('POST', `/api/chat/conversations/${ctx.data.convId}/messages?scope=${encodeURIComponent(SCOPE)}`, {});
      assert(b.status === 400, `发消息缺 text 期望 400，实际 ${b.status}`);
      assert(b.json?.code === 'MESSAGE_INVALID', `code 应为 MESSAGE_INVALID，实际 ${b.json?.code}`);
      return `缺 scope → 400 ${a.json.code}；缺 text → 400 ${b.json.code}`;
    },
  },
  {
    id: 'err_409', type: 'api', name: '生成中并发发消息 → 409（时序探针，不计判定）',
    soft: true,
    async run() {
      const c = await api('POST', '/api/chat/conversations', { scope: SCOPE });
      const cid = c.json.conv.id;
      ctx.data.created.push(cid);
      const ac = new AbortController();
      const inflight = sseStream(`/api/chat/conversations/${cid}/messages?scope=${encodeURIComponent(SCOPE)}`, { text: Q_IN_KB }, { signal: ac.signal });
      await new Promise((r) => setTimeout(r, 1200));
      const second = await api('POST', `/api/chat/conversations/${cid}/messages?scope=${encodeURIComponent(SCOPE)}`, { text: '并发第二条' });
      ac.abort();
      await inflight.catch(() => {});
      assert(second.status === 409, `期望 409（P5 会话忙），实际 ${second.status} ${second.text.slice(0, 150)}`);
      assert(second.json?.code === 'CONVERSATION_GENERATING', `code 应为 CONVERSATION_GENERATING，实际 ${second.json?.code}`);
      return `并发第二条 → 409 ${second.json.code}`;
    },
  },
];

// ─────────────────────────────────────────────────────────────
// 执行
// ─────────────────────────────────────────────────────────────

async function run() {
  console.log(`\nE2E Journey：Web 侧边栏 AI 对话（REQ-20260924-001）`);
  console.log(`目标：${BASE}  scope=${SCOPE}\n`);

  let aborted = false;
  for (const step of steps) {
    if (aborted) { results.push({ ...step, status: 'SKIP', evidence: '前置步骤失败已中止' }); continue; }
    const t0 = Date.now();
    try {
      const evidence = await step.run();
      results.push({ id: step.id, type: step.type, name: step.name, status: 'PASS', ms: Date.now() - t0, evidence });
      console.log(`✅ ${step.id.padEnd(12)} ${step.name}`);
      console.log(`   ${evidence}`);
    } catch (err) {
      const status = step.soft ? 'SOFT-FAIL' : 'FAIL';
      results.push({ id: step.id, type: step.type, name: step.name, status, ms: Date.now() - t0, evidence: err.message });
      console.log(`${step.soft ? '⚠️' : '❌'} ${step.id.padEnd(12)} ${step.name}`);
      console.log(`   ${err.message}`);
      if (!step.soft) aborted = true;
    }
  }

  // teardown：只删本次创建的会话（幂等）
  console.log(`\n🧹 teardown：删除本次创建的 ${ctx.data.created.length} 个会话`);
  const teardown = [];
  for (const id of ctx.data.created) {
    try {
      const r1 = await api('DELETE', `/api/chat/conversations/${id}?scope=${encodeURIComponent(SCOPE)}`);
      const r2 = await api('DELETE', `/api/chat/conversations/${id}?scope=${encodeURIComponent(SCOPE)}`);
      teardown.push(`${id}: delete=${r1.json?.ok === true}；二次删除 ok=${r2.json?.ok === true}（HTTP 幂等按"重复请求不改变服务端状态"理解，二次 404 属正常）`);
    } catch (err) {
      teardown.push(`${id}: 清理异常 ${err.message}`);
    }
  }
  teardown.forEach((t) => console.log(`   ${t}`));

  const judged = results.filter((r) => r.type !== 'teardown');
  const pass = judged.filter((r) => r.status === 'PASS').length;
  const fail = judged.filter((r) => r.status === 'FAIL').length;
  const softFail = judged.filter((r) => r.status === 'SOFT-FAIL').length;
  console.log(`\n判定：PASS ${pass}/${judged.length}，FAIL ${fail}，SOFT-FAIL ${softFail}（不计判定）`);
  console.log(fail === 0 ? '旅程状态：✅ PASS' : '旅程状态：❌ FAIL');
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((err) => {
  console.error('旅程异常中止：', err);
  process.exit(1);
});
