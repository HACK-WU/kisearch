/**
 * 对外 MCP 通道的取图工具（REQ-20261123-008 · B6 → **REQ-20261124-002 · S-04 降级**）
 *
 * ═══ 这个文件在守什么（2026-11-24 起）═══
 * B6 当时的断言是「`result.content` 里有 `{type:'image', data, mimeType}`」。协议层确实对
 * （真 HTTP + 真 SDK 断言过，199KB base64、PNG 魔数正确），但**IDE 侧 MCP 客户端**把图片
 * 转成 `image_url` 后不解码，反而把 base64 当文本注入并截断 → 模型拿不到图（事件 #90）。
 *
 * 消费方修不了，所以本层降级为 **text-only**：给清单 + 两条 HTTP 取件链接 + hint。
 * 现在的回归锁相应变成：
 *   ① 仍然只有 **text** content，**不再有 image part**（降级的全部意义）；
 *   ② 清单字段完整（ref / mime / bytes）+ `apiUrl` / `humanUrl` 可解析；
 *   ③ `hint` 必须说明「本通道不返回图片内容」并给替代路径；
 *   ④ 零命中仍 `isError: true`（不能变成"成功但空"）。
 *
 * ⚠️ chat 面板不受本降级影响：它走 `chat/mcp-tool-registry.ts` → 执行层
 * `asset-image.ts::executeGetImage`，不经过本协议适配层（回归见 `test/chat/tool-image.test.ts`）。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-get-image.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

import { useTempHome } from './isolate-home.js';
import { createMcpHttpServer } from '../src/lib/mcp-http.js';
import { buildKiMcpServer } from '../src/lib/mcp-server-factory.js';
import { ensureScopeDir } from '../src/lib/store.js';
import { getAssetsDir } from '../src/lib/scope.js';

const tempHome = useTempHome('ki-mcp-image-');
process.env.KI_CONFIG_PATH = path.join(tempHome.home, 'ki-config.json');
fs.writeFileSync(
  process.env.KI_CONFIG_PATH,
  JSON.stringify({ scopeMode: 'default', embedding: { provider: 'mock', model: 'mock' } }),
);

const SCOPE = 'mcpscope';
const GROUP = 'demo/pic';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let close: () => Promise<void> = async () => undefined;
let base = '';

/** 建服务 + 造一张可读的 PNG */
before(async () => {
  ensureScopeDir(SCOPE);
  const assets = getAssetsDir(SCOPE, GROUP);
  fs.mkdirSync(assets, { recursive: true });
  fs.writeFileSync(path.join(assets, 'shot.png'), Buffer.concat([PNG_MAGIC, Buffer.alloc(128, 5)]));

  const { httpServer, closeAllSessions } = createMcpHttpServer({
    authEnabled: false,
    resolveClientAddr: () => '127.0.0.1',
    // ★ 用真实工厂：验证的是"实际注册进 /mcp 的那个工具"，不是测试替身
    buildServer: () => buildKiMcpServer(null),
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()));
  const addr = httpServer.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
  close = async () => {
    await closeAllSessions();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };
});

after(async () => {
  await close();
});

/** initialize → sessionId */
async function initialize(): Promise<string> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
    }),
  });
  assert.equal(res.status, 200, `initialize 应 200，实际 ${res.status}`);
  const sid = res.headers.get('mcp-session-id');
  assert.ok(sid, 'initialize 应返回 mcp-session-id');
  await res.text();
  return sid!;
}

/** tools/call 并返回解析后的 JSON-RPC 响应 */
async function callTool(sid: string, name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'mcp-session-id': sid,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(res.status, 200, `tools/call 应 200，实际 ${res.status}`);
  const text = await res.text();
  // 传输层可能返回 SSE（`data: {...}`）或裸 JSON，两种都要能解析
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('data: ') || l.startsWith('{'))
    .map((l) => (l.startsWith('data: ') ? l.slice(6) : l))
    .reverse()
    .find((l) => {
      try {
        return Boolean((JSON.parse(l) as { result?: unknown }).result);
      } catch {
        return false;
      }
    });
  assert.ok(line, `响应里找不到 JSON-RPC result：${text.slice(0, 200)}`);
  return JSON.parse(line!) as Record<string, unknown>;
}

interface DegradedSummary {
  ok?: boolean;
  count?: number;
  images?: Array<{ ref?: string; mime?: string; bytes?: number; apiUrl?: string; humanUrl?: string }>;
  hint?: string;
  text?: string;
}

describe('S-04：对外 MCP 取图已降级为 text-only', () => {
  it('tools/call ki_get_image 只返回 text（无 image part），且给清单 + 两条链接 + hint', async () => {
    const sid = await initialize();
    const payload = await callTool(sid, 'ki_get_image', { scope: SCOPE, group: GROUP, refs: ['shot.png'] });

    const result = payload.result as { content?: Array<Record<string, unknown>>; isError?: boolean };
    assert.ok(Array.isArray(result.content), 'result.content 必须是数组');
    const content = result.content!;

    // ① 降级的核心：不再有 image content
    assert.equal(content.filter((c) => c.type === 'image').length, 0, '降级后不得再下发 image content');

    // ② 只有一个 text part，且是可解析的 JSON 摘要
    const textParts = content.filter((c) => c.type === 'text');
    assert.equal(textParts.length, 1, `应只有 1 个 text part，实际 ${textParts.length}`);
    const raw = String(textParts[0]!.text);
    const summary = JSON.parse(raw) as DegradedSummary;

    assert.equal(summary.count, 1);
    const img = summary.images?.[0];
    assert.equal(img?.ref, 'shot.png');
    assert.equal(img?.mime, 'image/png');
    assert.ok((img?.bytes ?? 0) > 0);

    // ③ 两条链接：apiUrl（/open/v1，对外契约）与 humanUrl（/api，浏览器可直开）
    assert.ok(img?.apiUrl, '应有 apiUrl');
    assert.ok(img?.humanUrl, '应有 humanUrl');
    const api = new URL(img.apiUrl);
    const human = new URL(img.humanUrl);
    assert.equal(api.pathname, '/open/v1/asset');
    assert.equal(human.pathname, '/api/asset');
    assert.equal(api.searchParams.get('scope'), SCOPE);
    assert.equal(api.searchParams.get('group'), GROUP);
    assert.equal(api.searchParams.get('path'), 'shot.png');

    // ④ hint 必须解释原因并给替代路径
    assert.match(summary.hint ?? '', /不返回图片内容/);
    assert.match(summary.hint ?? '', /humanUrl/);
    assert.match(summary.hint ?? '', /ki-client asset get/);

    // ⑤ 不是错误
    assert.notEqual(result.isError, true);
  });

  it('图片不存在时给可读错误，而不是空 content', async () => {
    const sid = await initialize();
    const payload = await callTool(sid, 'ki_get_image', { scope: SCOPE, group: GROUP, refs: ['nope.png'] });
    const result = payload.result as { content?: Array<Record<string, unknown>>; isError?: boolean };
    assert.equal(result.isError, true, '一张都没取到时应标 isError');
    const textPart = result.content!.find((c) => c.type === 'text');
    assert.match(String(textPart!.text), /没有成功读取|未成功/);
  });
});
