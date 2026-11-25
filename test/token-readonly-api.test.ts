/**
 * token-readonly-api.test.ts —— 只读 Token 对 `/api` 写接口的门禁（#96）
 *
 * 覆盖三件事：
 *   1. 只读 Token 在**全部**登记为写能力的 `/api` 路由上返回 403 `TOKEN_READONLY`
 *      （路由清单从 `auth/route-permissions.ts` 源码解析，避免"新增写路由又漏拦"）
 *   2. 同一批路由上 viewer 会话仍是 403 `USER_READONLY`（错误码不能串，两条出路文案不同）
 *   3. 只读限制的是"写"：读接口、AI 追问（knowledge.ask）仍放行；chat 工具面按能力集收窄
 *
 * 运行：npx jiti test/token-readonly-api.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { createUser } from '../src/lib/user-store.js';
import { clearSessions } from '../src/lib/web-session-store.js';
import { resetLoginRateLimit } from '../src/lib/web-auth.js';
import {
  TOKEN_CAPABILITIES,
  WRITE_CAPABILITIES,
  withoutWriteCapabilities,
  type Capability,
} from '../src/lib/auth/capabilities.js';
import { canUseTool } from '../src/lib/auth/tool-permissions.js';
import { TOKEN_MODEL_FORBIDDEN, TOKEN_READONLY } from '../src/lib/mcp-tools/tool-access.js';

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-token-ro-api-'));
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalConfig = process.env.KI_CONFIG_PATH;
process.env.HOME = tmpHome;
process.env.USERPROFILE = tmpHome;
process.env.KI_CONFIG_PATH = path.join(tmpHome, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

let currentClientAddr = '203.0.113.10';
let handle: { base: string; close: () => Promise<void> } | null = null;

interface Resp { status: number; body: Record<string, unknown>; cookie: string }

async function jsonFetch(url: string, init: RequestInit = {}): Promise<Resp> {
  const res = await fetch(url, init);
  let body: Record<string, unknown> = {};
  try { body = await res.json() as Record<string, unknown>; } catch { /* 非 JSON */ }
  const setCookie = res.headers.get('set-cookie') ?? '';
  return { status: res.status, body, cookie: setCookie.split(';')[0] ?? '' };
}

async function login(username: string, password: string): Promise<string> {
  const r = await jsonFetch(`${handle!.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(r.status, 200, `login ${username} 失败：${r.status}`);
  return r.cookie;
}

async function mintToken(cookie: string, label: string, readOnly: boolean): Promise<string> {
  const r = await jsonFetch(`${handle!.base}/api/me/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ label, readOnly, scopes: ['all'] }),
  });
  assert.equal(r.status, 201, `建 Token 失败：${r.status} ${JSON.stringify(r.body)}`);
  return String(r.body.token ?? '');
}

/** 调一次 /api 路由（gate 在 handler 之前，写入不会真的发生） */
async function callApi(
  method: string,
  p: string,
  identity: { cookie?: string; token?: string },
): Promise<Resp> {
  const headers: Record<string, string> = {};
  if (identity.cookie) headers.cookie = identity.cookie;
  if (identity.token) headers.authorization = `Bearer ${identity.token}`;
  const hasBody = method !== 'GET' && method !== 'DELETE';
  if (hasBody) headers['Content-Type'] = 'application/json';
  return jsonFetch(`${handle!.base}/api${p}`, {
    method,
    headers,
    ...(hasBody ? { body: '{}' } : {}),
  });
}

/**
 * 从路由注册表源码解析出「写能力」路由样本。
 *
 * 不用手工清单：手工清单的下场就是新增写路由时漏拦（正是 #96 的成因）。
 * `pattern` 的正则用 `[^/]+ → sample` 物化成可请求路径 —— 本表里的正则都只有这一种占位。
 */
function writeRouteSamples(): { method: string; path: string; capability: Capability }[] {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/lib/auth/route-permissions.ts'), 'utf8');
  const samples: { method: string; path: string; capability: Capability }[] = [];
  for (const line of source.split('\n')) {
    const m = /(exact|pattern)\('([A-Z]+)',\s*(.+?),\s*'permission',\s*'([a-z.]+)'\)/.exec(line);
    if (!m) continue;
    const [, kind, method, rawPath, capability] = m;
    if (!WRITE_CAPABILITIES.has(capability as Capability)) continue;
    let p: string;
    if (kind === 'exact') {
      p = (rawPath ?? '').trim().replace(/^'/, '').replace(/'$/, '');
    } else {
      const literal = (rawPath ?? '').trim();
      p = literal.slice(1, literal.lastIndexOf('/')) // 去首尾 `/`
        .replace(/^\^/, '')
        .replace(/\$$/, '')
        .replace(/\\\//g, '/')
        .replace(/\[\^\/\]\+/g, 'sample');
    }
    samples.push({ method, path: p, capability: capability as Capability });
  }
  // 通配规则（`{ method: '*', ... }`）不是 exact/pattern 字面量，需显式补
  samples.push({ method: 'POST', path: '/users', capability: 'users.manage' });
  return samples;
}

const WRITE_SAMPLES = writeRouteSamples();

before(async () => {
  createUser({ username: 'admin1', password: 'AdminPass1!', role: 'admin' });
  createUser({ username: 'viewer1', password: 'ViewerPass1!', role: 'viewer' });
  createUser({ username: 'editor1', password: 'EditorPass1!', role: 'editor' });
  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: true,
    buildServer: () => new McpServer({ name: 'kisearch', version: '0.0.0-test' }),
    webDir: null,
    resolveClientAddr: () => currentClientAddr,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  handle = {
    base: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      await closeAllSessions();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
  resetLoginRateLimit();
  clearSessions();
});

after(async () => {
  await handle?.close();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = originalUserProfile;
  if (originalConfig === undefined) delete process.env.KI_CONFIG_PATH; else process.env.KI_CONFIG_PATH = originalConfig;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('只读 Token × /api 写接口', () => {
  it('路由样本解析到足量写能力路由（解析器失效会让下面的用例空跑）', () => {
    assert.ok(WRITE_SAMPLES.length >= 40, `写能力路由样本过少（${WRITE_SAMPLES.length}），解析器可能失效`);
    assert.ok(WRITE_SAMPLES.some((s) => s.capability === 'knowledge.write'));
  });

  it('只读 Token：全部写能力路由 403（TOKEN_READONLY / FORBIDDEN）', async () => {
    const viewerCookie = await login('viewer1', 'ViewerPass1!');
    // viewer 自助建 Token 被服务端强制 readOnly
    const token = await mintToken(viewerCookie, 'ro-api-viewer', true);
    const failures: string[] = [];
    for (const sample of WRITE_SAMPLES) {
      const r = await callApi(sample.method, sample.path, { token });
      // Token 能力表本身没有的能力（users.manage / tasks.delete）在能力判定就被拦，错误码是 FORBIDDEN
      const expected = TOKEN_CAPABILITIES.has(sample.capability) ? TOKEN_READONLY : 'FORBIDDEN';
      if (r.status !== 403 || r.body.code !== expected) {
        failures.push(`${sample.method} ${sample.path} → ${r.status} ${String(r.body.code ?? '')}（期望 403 ${expected}）`);
      }
    }
    assert.deepEqual(failures, [], `下列写路由未拦住只读 Token：\n${failures.join('\n')}`);
  });

  it('viewer 会话：同一批路由仍是 403 USER_READONLY（错误码不串）', async () => {
    const viewerCookie = await login('viewer1', 'ViewerPass1!');
    const failures: string[] = [];
    for (const sample of WRITE_SAMPLES) {
      const r = await callApi(sample.method, sample.path, { cookie: viewerCookie });
      if (r.status !== 403 || r.body.code !== 'USER_READONLY') {
        failures.push(`${sample.method} ${sample.path} → ${r.status} ${String(r.body.code ?? '')}`);
      }
    }
    assert.deepEqual(failures, [], `下列写路由未按账号只读拒绝：\n${failures.join('\n')}`);
  });

  it('只读 Token：读接口不受限，发起 AI 追问按模型消耗拦（与 /mcp 同码）', async () => {
    const viewerCookie = await login('viewer1', 'ViewerPass1!');
    const token = await mintToken(viewerCookie, 'ro-api-read', true);

    const list = await callApi('GET', '/doc/list?scope=default', { token });
    assert.notEqual(list.status, 403, `读接口被误拦：${list.status} ${JSON.stringify(list.body)}`);

    // 发起 AI 追问是模型消耗型：与 /mcp 的 ki_ask 同码拒绝（#96 · Q2 对齐）
    const ask = await callApi('POST', '/governance/events/nope/analysis/ask', { token });
    assert.equal(ask.status, 403);
    assert.equal(ask.body.code, TOKEN_MODEL_FORBIDDEN, `发起追问应与 /mcp 同码：${JSON.stringify(ask.body)}`);
    const askStream = await callApi('POST', '/governance/events/nope/analysis/ask/stream', { token });
    assert.equal(askStream.body.code, TOKEN_MODEL_FORBIDDEN, 'SSE 追问同口径');

    // 但「停止追问」与「读追问记录」不调模型，不得被拦
    // （临时 HOME 没有 default 库，会先撞 SCOPE 层 403 FORBIDDEN_SCOPE，那是环境而非本次门禁）
    for (const [method, path] of [
      ['POST', '/governance/events/nope/analysis/ask/cancel'],
      ['GET', '/governance/events/nope/analysis/ask'],
    ] as const) {
      const r = await callApi(method, path, { token });
      assert.notEqual(r.body.code, TOKEN_MODEL_FORBIDDEN, `${method} ${path} 不该按模型消耗拦`);
      assert.notEqual(r.body.code, TOKEN_READONLY, `${method} ${path} 不该按只读写拦`);
    }

    // 视图写：Token 能力表本就没有 views.write，仍按 FORBIDDEN 拒绝（与 readOnly 无关）
    const views = await callApi('POST', '/views', { token });
    assert.equal(views.status, 403);
    assert.equal(views.body.code, 'FORBIDDEN');

    // viewer **会话**不受模型消耗门禁影响：viewer 本就有 knowledge.ask，能提问是既有产品口径
    const viewerAsk = await callApi('POST', '/governance/events/nope/analysis/ask', { cookie: viewerCookie });
    assert.notEqual(viewerAsk.body.code, TOKEN_MODEL_FORBIDDEN, 'viewer 会话的追问能力被误伤');
  });

  it('读写 Token 与进程级 Token 不受影响', async () => {
    const editorCookie = await login('editor1', 'EditorPass1!');
    const rwToken = await mintToken(editorCookie, 'rw-api-editor', false);
    for (const sample of [
      { method: 'POST', path: '/doc/edit' },
      { method: 'POST', path: '/import/run' },
    ]) {
      const r = await callApi(sample.method, sample.path, { token: rwToken });
      assert.notEqual(r.status, 403, `读写 Token 被误拦：${sample.method} ${sample.path} → ${r.status}`);
    }
  });
});

describe('只读身份的能力集收窄（chat 通道）', () => {
  it('withoutWriteCapabilities 剔净写能力，读与提问保留', () => {
    const narrowed = withoutWriteCapabilities(TOKEN_CAPABILITIES);
    for (const cap of WRITE_CAPABILITIES) {
      assert.equal(narrowed.has(cap), false, `写能力未剔除：${cap}`);
    }
    assert.equal(narrowed.has('knowledge.read'), true);
    assert.equal(narrowed.has('knowledge.ask'), true);
    assert.equal(narrowed.has('chat.use'), true);
  });

  it('收窄后 chat 工具面真的少掉写工具（断的是实际消费点 canUseTool，不是只看能力集）', () => {
    const narrowed = withoutWriteCapabilities(TOKEN_CAPABILITIES);
    // 写工具必须被过滤掉
    for (const name of ['ki_store', 'ki_sync_relation', 'ki_event_edit', 'ki_delete_relation']) {
      assert.equal(canUseTool(narrowed, name), false, `写工具仍可见：${name}`);
    }
    // 读工具与预取不能误伤（ki_recall / ki_get_image 都按 knowledge.read 登记）
    for (const name of ['ki_search', 'ki_get_module_info', 'ki_group_list', 'ki_recall', 'ki_get_image']) {
      assert.equal(canUseTool(narrowed, name), true, `读工具被误伤：${name}`);
    }
    assert.equal(canUseTool(narrowed, 'ki_ask'), true, 'knowledge.ask 应保留');
  });

  it('只读 Token 的对话请求仍可用（chat ctx 拿到的是收窄后的能力集，不是 403）', async () => {
    const viewerCookie = await login('viewer1', 'ViewerPass1!');
    const token = await mintToken(viewerCookie, 'ro-api-chat', true);
    const r = await callApi('GET', '/chat/conversations?scope=default', { token });
    assert.notEqual(r.status, 403, `只读 Token 的会话列表被拦：${r.status} ${JSON.stringify(r.body)}`);
  });
});
