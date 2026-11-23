/**
 * 对外 MCP 通道的取图（REQ-20261123-008 · B6）
 *
 * ═══ 守什么 ═══
 * 内部对话链路能看图 ≠ 外部 MCP 客户端能看图。这条链路上有三处会悄悄吃掉图片：
 *   ① 工厂把工具注册到**写块**（只读 Token 看不见）—— ki_get_image 必须在只读块；
 *   ② 只读 Token 的能力白名单漏登记（`TOOL_CAPABILITIES` 默认拒绝）；
 *   ③ 传输层对 content 做过滤或截断（本项目没有，但一旦有人加就会静默坏掉）。
 *
 * 这里走**真 HTTP + 真 MCP SDK + 真工具**：initialize 拿 sessionId → tools/call →
 * 断言 JSON-RPC `result.content` 里有 `{type:'image', data, mimeType}`。
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

describe('B6：对外 MCP 取图', () => {
  it('tools/call ki_get_image 返回 text 摘要 + image content（base64）', async () => {
    const sid = await initialize();
    const payload = await callTool(sid, 'ki_get_image', { scope: SCOPE, group: GROUP, refs: ['shot.png'] });

    const result = payload.result as { content?: Array<Record<string, unknown>>; isError?: boolean };
    assert.ok(Array.isArray(result.content), 'result.content 必须是数组');
    const content = result.content!;

    // ① 第一块是给模型/人看的摘要
    const textPart = content.find((c) => c.type === 'text');
    assert.ok(textPart, '应有 text 摘要');
    assert.match(String(textPart!.text), /已读取 1 张图片/);
    assert.match(String(textPart!.text), /shot\.png/);

    // ② 必须有 image content，且是标准 MCP 形状（type/data/mimeType）
    const imageParts = content.filter((c) => c.type === 'image');
    assert.equal(imageParts.length, 1, `应有 1 个 image content，实际 ${imageParts.length}`);
    const img = imageParts[0]!;
    assert.equal(img.mimeType, 'image/png');
    assert.equal(typeof img.data, 'string');
    const b64 = String(img.data);
    assert.ok(b64.length > 100, 'base64 载荷不能为空');
    // 载荷必须是"纯 base64"——PNG 魔数的 base64 前缀 iVBORw0KGgo
    assert.equal(b64.startsWith('iVBORw0KGgo'), true, '应是 PNG 的 base64 数据');
    assert.equal(b64.includes('data:'), false, 'MCP image content 不带 data: 前缀');

    // ③ 不应被标成错误
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
