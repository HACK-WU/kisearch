/**
 * SR-01 越权负向用例（P1–P7）—— **可执行测试**
 *
 * 来源：`design/cross-cutting.md` §2.3「越权负向用例（**必须进片级验收清单**）」
 * 要求（`slice.md` §3 第 5 项）：落成**可执行用例**，且**加进本文件**（独立于
 * `acceptance-sr01.test.ts`，避免与第 2 项混淆）。
 *
 * 原则（cross-cutting §2.3）：
 *   **每条权限规则必须配一条越权负向用例** —— 否则权限只写在文档里，拼接期无人验。
 *
 * ⚠️ **P2 是最容易写错的一条**：直觉会写"查不到就 404"，而那正是信息泄露路径。
 *
 * 运行：`npx jiti test/chat/permissions-sr01.test.ts`
 *
 * @see design/cross-cutting.md §2.3
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── 隔离环境：临时 HOME + 临时配置 + 临时 chatDir（避免污染 ~/.ki）──
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-perm-test-'));
const CFG = path.join(TMP, '.ki', 'config.yaml');
const CHAT_ROOT = path.join(TMP, 'chat');
const DATA_ROOT = path.join(TMP, 'data');

fs.mkdirSync(path.dirname(CFG), { recursive: true });
fs.writeFileSync(CFG, [
  `dataDir: ${DATA_ROOT}`,
  `backupDir: ${path.join(TMP, 'backup')}`,
  `chatDir: ${CHAT_ROOT}`,
  'embedding:',
  '  provider: openai-compatible',
  '  baseURL: https://embed.example.com/v1',
  '  model: test-embed',
  '  dimension: 4096',
  '  queryTimeoutMs: 3000',
  '  apiKey: test-key',
].join('\n') + '\n');

process.env.KI_CONFIG_PATH = CFG;

// 动态 import：必须在设置 KI_CONFIG_PATH 之后
const { handleApiRequest } = await import('../../src/lib/mcp-http-api.js');
const store = await import('../../src/lib/chat/chat-store.js');

/** 起的进程内 HTTP server（转发到生产同一入口 handleApiRequest） */
let server: import('node:http').Server;
let port = 0;

/**
 * 场景 → ctx 映射
 *
 * ⚠️ 关键：**不设置 `ctx.token`**。`handleApiRequest` 的实现是
 * `if (bearer && ctx.token && tokenMatches(bearer, ctx.token)) scopes = [ALL_SCOPES]`
 * —— `ctx.token` 是**全权临时 token**，一旦设置，任何 bearer 都会拿到 `['all']`，
 * 越权用例会因"全权放行"而失去意义。因此这里只用 `resolveTokenScopes` 走多 token 存储路径。
 */
const SCENARIOS = {
  /** 鉴权未启用（回环免鉴权） */
  open: { authEnabled: false },
  /** 启用鉴权 + 非回环来源 + 无 token → 应 401 */
  'remote-no-token': { authEnabled: true, clientAddr: '10.0.0.9' },
  /** 启用鉴权 + 非回环来源 + 授权 scope=A（token=secret） */
  'token-scope-A': { authEnabled: true, clientAddr: '10.0.0.9' },
} as const;

type ScenarioKey = keyof typeof SCENARIOS;

/** token → 授权 scope 集合（注入 resolveTokenScopes） */
const TOKEN_SCOPES: Record<string, string[] | undefined> = {
  secret: ['A'],          // 仅授权 scope A
};

/** 基础配置内容（无 llm 段；用于 restore） */
const BASE_CONFIG_TEXT = fs.readFileSync(CFG, 'utf-8');

/**
 * 改写主配置，追加一段 llm 配置。
 *
 * ⚠️ 为什么是"改写同一路径"而不是"换 KI_CONFIG_PATH"：
 *    `loadConfig()` 的进程内缓存键是 `_cachedExplicitPath`（= **函数参数**），
 *    **不含 process.env.KI_CONFIG_PATH** → 换 env 不会让缓存失效，仍返回旧配置。
 *    而缓存的失效条件是来源文件的 **mtime/size 指纹**变化，故通过改写同路径生效。
 *
 * ⚠️ 每次写入的长度都不同（`_pad` 注释递增），以确保 size 变化而非仅依赖 mtime
 *    —— mtime 在部分文件系统上只有秒级精度，同秒内的两次改写会漏检。
 */
let configPad = 0;
function withLlmConfig(llm: Record<string, string | boolean>): void {
  configPad += 1;
  const lines = [
    BASE_CONFIG_TEXT.trimEnd(),
    'llm:',
    '  baseURL: https://llm.example.com/v1',
    '  model: test-model',
    '  apiKey: test-llm-key',
    ...Object.entries(llm).map(([k, v]) => `  ${k}: ${v}`),
    `# pad-${'x'.repeat(configPad)}`,
  ];
  fs.writeFileSync(CFG, lines.join('\n') + '\n');
}

/** 恢复基础配置（同样靠 size 变化让缓存失效） */
function restoreBaseConfig(): void {
  configPad += 1;
  fs.writeFileSync(CFG, `${BASE_CONFIG_TEXT.trimEnd()}\n# pad-${'y'.repeat(configPad)}\n`);
}

async function api(
  method: string,
  pathAndQuery: string,
  scenario: ScenarioKey,
  body?: unknown,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { __probe_scenario: scenario };
  if (scenario === 'token-scope-A') headers.authorization = 'Bearer secret';
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* SSE 或空 body */ }
  return { status: res.status, json, text };
}

before(async () => {
  const http = await import('node:http');
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://127.0.0.1');
    const which = (req.headers['__probe_scenario'] as string) ?? 'open';
    const base = SCENARIOS[which as ScenarioKey] ?? SCENARIOS.open;
    await handleApiRequest(req, res, url, {
      ...base,
      resolveTokenScopes: (t) => TOKEN_SCOPES[t],
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});

after(() => {
  server?.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 忽略 */ }
});

// ─────────────────────────────────────────────────────────────
// 准备：在 scope B 下造一个真实会话（P2/P3 需要"B 的会话 id"）
// ─────────────────────────────────────────────────────────────

let convInB = '';
let convInB2 = '';

before(async () => {
  const a = await store.createConversation('B', { title: 'B-会话' });
  convInB = a.id;
  const b = await store.createConversation('B', { title: 'B-会话2' });
  convInB2 = b.id;
  // scope A 下也造一个（证明 A 授权者能访问自己的、访问不了 B 的）
  await store.createConversation('A', { title: 'A-会话' });
});

// ─────────────────────────────────────────────────────────────
// P1–P7
// ─────────────────────────────────────────────────────────────

describe('SR-01 越权负向用例（cross-cutting.md §2.3）', () => {
  it('P1：token 授权 scope=A，GET /api/chat/conversations?scope=B → 403 SCOPE_FORBIDDEN', async () => {
    const r = await api('GET', '/api/chat/conversations?scope=B', 'token-scope-A');
    assert.equal(r.status, 403, `期望 403，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.ok, false);
    assert.match(String(r.json?.error ?? ''), /无权访问该 scope/);
  });

  it('P1-补：授权 scope=A 访问自己的 scope=A → 200（不是无差别拒绝）', async () => {
    const r = await api('GET', '/api/chat/conversations?scope=A', 'token-scope-A');
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.ok, true);
    assert.equal(r.json?.scope, 'A');
  });

  it('P2：token 授权 scope=A，GET /api/chat/conversations/{B 的会话 id} → 403（不得 404）', async () => {
    const r = await api('GET', `/api/chat/conversations/${convInB}`, 'token-scope-A');
    assert.equal(r.status, 403, `★ 期望 403（防状态码探测），实际 ${r.status}：${r.text}`);
    assert.notEqual(r.status, 404, 'P2 若是 404 即为信息泄露路径');
  });

  it('P2-补：不存在的 id 在授权范围内 → 404（区分"无权限"与"不存在"）', async () => {
    const r = await api('GET', '/api/chat/conversations/c-zzzzzzzz-zzzz', 'token-scope-A');
    assert.equal(r.status, 404, `期望 404，实际 ${r.status}：${r.text}`);
  });

  it('P2-补：格式非法 id 与不存在统一为 404（不泄露内部命名规则）', async () => {
    const r = await api('GET', '/api/chat/conversations/..%2F..%2Fetc%2Fpasswd', 'token-scope-A');
    assert.equal(r.status, 404, `期望 404，实际 ${r.status}：${r.text}`);
  });

  it('P3：token 授权 scope=A，DELETE /api/chat/conversations?scope=B → 403', async () => {
    const r = await api('DELETE', '/api/chat/conversations?scope=B', 'token-scope-A');
    assert.equal(r.status, 403, `期望 403，实际 ${r.status}：${r.text}`);
    // 且 B 的会话未被误删
    const stillThere = await store.readConversation('B', convInB);
    assert.ok(stillThere, '越权请求不得产生副作用（B 的会话应仍在）');
  });

  it('P3-补：PATCH/DELETE /api/chat/conversations/{B 的 id} 同样 403（不止 GET 走校验）', async () => {
    const patch = await api('PATCH', `/api/chat/conversations/${convInB}`, 'token-scope-A', { title: 'x' });
    assert.equal(patch.status, 403, `PATCH 期望 403，实际 ${patch.status}`);
    const del = await api('DELETE', `/api/chat/conversations/${convInB}`, 'token-scope-A');
    assert.equal(del.status, 403, `DELETE 期望 403，实际 ${del.status}`);
    const stillThere = await store.readConversation('B', convInB);
    assert.ok(stillThere, '越权请求不得产生副作用');
  });

  it('P4：未确认隐私（kbDisclosureAck 缺失）发消息 → 403 DISCLOSURE_REQUIRED', async () => {
    // 当前主配置无 llm 段 → CHAT_DISABLED 会先拦，验不到 P4 分支。
    // 故**改写主配置文件**（同路径，借 mtime/size 指纹让 loadConfig 缓存失效 ——
    // 换 KI_CONFIG_PATH 无效：loadConfig 的缓存键是 explicitPath 参数，不含 env）。
    withLlmConfig({ supportsTools: true /* 刻意不写 kbDisclosureAck */ });

    const r = await api('POST', `/api/chat/conversations/${convInB2}/messages`, 'open', { text: 'hi' });
    assert.equal(r.status, 403, `期望 403，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.code, 'DISCLOSURE_REQUIRED');

    restoreBaseConfig();
  });

  it('P5：会话正在生成中，调 API-11/12 → 409 CONVERSATION_GENERATING', async () => {
    // P5 的互斥门在 CHAT_DISABLED / DISCLOSURE_REQUIRED 之后判断，
    // 故必须先把 llm 配好且隐私已确认，才能验到这一层。
    withLlmConfig({ supportsTools: true, kbDisclosureAck: true });

    const chatRoutes = await import('../../src/lib/chat/chat-routes.js');
    // 直接登记生成态（模拟进行中的生成），验证互斥门真的生效
    chatRoutes.markGenerating(convInB, true);
    try {
      assert.equal(chatRoutes.isGenerating(convInB), true, 'markGenerating 应登记成功');

      const r11 = await api('POST', `/api/chat/conversations/${convInB}/regenerate`, 'open');
      assert.equal(r11.status, 409, `★ API-11 期望 409，实际 ${r11.status}：${r11.text}`);
      assert.equal(r11.json?.code, 'CONVERSATION_GENERATING');

      const m1 = (await store.readConversation('B', convInB))?.messages.find((m) => m.role === 'user');
      const msgId = m1?.id ?? 'm1';
      const r12 = await api('PATCH', `/api/chat/conversations/${convInB}/messages/${msgId}`, 'open', { text: 'edited' });
      assert.equal(r12.status, 409, `★ API-12 期望 409，实际 ${r12.status}：${r12.text}`);
      assert.equal(r12.json?.code, 'CONVERSATION_GENERATING');
    } finally {
      chatRoutes.markGenerating(convInB, false);
      assert.equal(chatRoutes.isGenerating(convInB), false, '释放后不应仍处于生成态');
      restoreBaseConfig();
    }
  });

  it('P6：DELETE /api/chat/conversations/:id 后，kb/{scope}/ 知识库资产零变化（N15）', async () => {
    // 造一个"知识库资产"目录（kb 语义路径：{dataDir}/{scope}/）
    const kbDir = path.join(DATA_ROOT, 'B');
    fs.mkdirSync(kbDir, { recursive: true });
    const kbFile = path.join(kbDir, 'group-index.json');
    fs.writeFileSync(kbFile, JSON.stringify({ keep: true, scope: 'B' }, null, 2));
    const kbBefore = fs.readFileSync(kbFile, 'utf-8');
    const kbStatBefore = fs.statSync(kbFile).size;
    const kbFile2 = path.join(kbDir, 'relations-cache.json');
    fs.writeFileSync(kbFile2, JSON.stringify({ keep: 2 }, null, 2));

    const target = await store.createConversation('B', { title: '待删' });
    const r = await api('DELETE', `/api/chat/conversations/${target.id}`, 'open');
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.deleted, true);

    // 会话文件已删
    assert.equal(await store.readConversation('B', target.id), null, '会话文件应已被物理删除');
    // ★ kb/ 零变化
    assert.ok(fs.existsSync(kbFile), 'kb/ 资产不得被删除');
    assert.equal(fs.readFileSync(kbFile, 'utf-8'), kbBefore, 'kb/ 资产内容不得被修改');
    assert.equal(fs.statSync(kbFile).size, kbStatBefore);
    assert.ok(fs.existsSync(kbFile2), 'kb/ 其他资产不得被删除');
  });

  it('P6-补：清空会话（API-14）同样不得触碰 kb/{scope}/', async () => {
    const kbDir = path.join(DATA_ROOT, 'C');
    fs.mkdirSync(kbDir, { recursive: true });
    const kbFile = path.join(kbDir, 'group-index.json');
    fs.writeFileSync(kbFile, JSON.stringify({ keep: 'C' }));
    await store.createConversation('C', { title: 'c1' });
    await store.createConversation('C', { title: 'c2' });

    const r = await api('DELETE', '/api/chat/conversations?scope=C', 'open');
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.ok((r.json?.deleted ?? 0) >= 2, `应至少删除 2 个会话，实际 ${r.json?.deleted}`);
    assert.ok(fs.existsSync(kbFile), '★ API-14 不得触碰 kb/');
  });

  it('P7：无 token（启用鉴权 + 非回环来源）访问任一 /api/chat/* → 401 UNAUTHORIZED', async () => {
    for (const p of [
      '/api/chat/config',
      '/api/chat/conversations?scope=A',
      '/api/chat/conversations/c-abc-0001',
    ]) {
      const r = await api('GET', p, 'remote-no-token');
      assert.equal(r.status, 401, `${p} 期望 401，实际 ${r.status}：${r.text}`);
      assert.match(String(r.json?.error ?? ''), /Unauthorized/i);
    }
    // 写接口同样被拦
    const post = await api('POST', '/api/chat/conversations', 'remote-no-token', { scope: 'A' });
    assert.equal(post.status, 401, `POST 期望 401，实际 ${post.status}`);
  });

  it('P7-补：鉴权未启用（回环）时不受影响 → 200（不是无差别拒绝）', async () => {
    const r = await api('GET', '/api/chat/config', 'open');
    assert.equal(r.status, 200, `期望 200，实际 ${r.status}：${r.text}`);
    assert.equal(r.json?.ok, true);
  });
});
