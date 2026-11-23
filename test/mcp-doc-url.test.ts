/**
 * mcp-doc-url.test.ts —— 写工具结果里的文档链接注入（REQ-20261123-003 · S-02）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-doc-url.test.ts
 *
 * 覆盖：ki_sync_relation（有/无 Web、根目录 group）/ ki_bulk_sync_relation 逐条 /
 *       ki_edit_relation 首轮编辑 / ki_delete_relation 永不给链接。
 *
 * 说明：直接调用 `_registeredTools[name].handler(args, extra)`（与 `mcp-event-tools.test.ts`
 * 同一手法），不经 InMemoryTransport —— 这里验证的是「返回体怎么组装」，走传输只会引入不确定性。
 * `extra` 造出 SDK 在 HTTP 会话下发的形状（`{ requestInfo: { headers } }`）。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope } from '../src/lib/store.js';
import { resetWebRuntime, setWebRuntime, type WebRuntime } from '../src/lib/mcp-runtime.js';
import { registerSyncRelationTool } from '../src/lib/mcp-tools/sync-relation.js';
import { registerBulkSyncRelationTool } from '../src/lib/mcp-tools/bulk-sync-relation.js';
import { registerEditRelationTool } from '../src/lib/mcp-tools/edit-relation.js';
import { registerDeleteRelationTool } from '../src/lib/mcp-tools/delete-relation.js';
import { executeGetModuleInfoLocal } from '../src/get-module-info.js';

const scope = `mcp-doc-url-${Date.now()}`;
const GROUP = '专题记忆/文档链接测试';

const WEB: WebRuntime = { webEnabled: true, publicUrl: null };
const OFF: WebRuntime = { webEnabled: false, publicUrl: null };

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: unknown, extra: unknown) => Promise<ToolResult>;

function buildTools(): Record<string, ToolHandler> {
  const server = new McpServer({ name: 'doc-url-test', version: '0' });
  registerSyncRelationTool(server);
  registerBulkSyncRelationTool(server);
  registerEditRelationTool(server);
  registerDeleteRelationTool(server);
  return (server as unknown as { _registeredTools: Record<string, ToolHandler> })._registeredTools;
}

/** 造 SDK 在 HTTP 会话里下发的最小 extra */
function httpExtra(host = '127.0.0.1:7433'): unknown {
  return { requestInfo: { headers: { host } } };
}

function payload(res: ToolResult): Record<string, unknown> {
  return JSON.parse(res.content[0].text) as Record<string, unknown>;
}

/** 校验 url 指向该文档，并返回三个查询参数 */
function assertDocUrl(url: unknown, expectGroup: string, expectRelation: string): void {
  assert.equal(typeof url, 'string', '期望结果带 url');
  const u = new URL(url as string);
  assert.equal(u.origin, 'http://127.0.0.1:7433');
  assert.equal(u.pathname, '/browse');
  assert.equal(u.searchParams.get('scope'), scope);
  assert.equal(u.searchParams.get('group'), expectGroup);
  assert.equal(u.searchParams.get('relation'), expectRelation);
}

const tools = buildTools();

before(() => {
  registerTestScope(scope);
  initScope(scope);
});

after(async () => {
  resetWebRuntime();
  // 引擎句柄不关，node:test 会跑完不出汇总（与 sync-relation.test.ts 同因）
  try {
    const { closeEngine } = await import('../src/lib/vector-client.js');
    await closeEngine();
  } catch { /* 未打开时忽略 */ }
  try {
    const { closeFtsEngine } = await import('../src/lib/fts-client.js');
    await closeFtsEngine();
  } catch { /* 同上 */ }
  cleanupTestConfig();
});

describe('ki_sync_relation', () => {
  it('成功时带 url，并回显实际落盘的 group', async () => {
    setWebRuntime(WEB);
    const res = await tools.ki_sync_relation.handler({
      scope,
      group: GROUP,
      relation: '带链接的文档',
      module_info: '# 带链接\n\n正文。',
      vector: false,
    }, httpExtra());

    const body = payload(res);
    assert.equal(body.ok, true);
    assert.equal(body.group, GROUP, 'group 必须回显落盘值（拼链接靠它）');
    assertDocUrl(body.url, GROUP, '带链接的文档');
  });

  it('未开启 Web 页面时结果里没有 url 字段（不是空串）', async () => {
    setWebRuntime(OFF);
    const res = await tools.ki_sync_relation.handler({
      scope,
      group: GROUP,
      relation: '没有链接的文档',
      module_info: '正文。',
      vector: false,
    }, httpExtra());

    const body = payload(res);
    assert.equal(body.ok, true);
    assert.equal('url' in body, false, '取不到地址时不应出现该字段');
  });

  it('group 留空落根 → 回显 __root__ 且链接可用', async () => {
    setWebRuntime(WEB);
    const res = await tools.ki_sync_relation.handler({
      scope,
      group: '',
      relation: '根目录文档',
      module_info: '根文档正文。',
      vector: false,
    }, httpExtra());

    const body = payload(res);
    assert.equal(body.group, '__root__');
    assertDocUrl(body.url, '__root__', '根目录文档');
  });
});

describe('ki_bulk_sync_relation', () => {
  it('逐条附 url，且各自的 group/relation 正确', async () => {
    setWebRuntime(WEB);
    const res = await tools.ki_bulk_sync_relation.handler({
      scope,
      items: [
        { group: GROUP, relation: '批量甲', module_info: '甲正文。' },
        { group: `${GROUP}/子组`, relation: '批量乙', module_info: '乙正文。' },
      ],
      vector: false,
    }, httpExtra());

    const body = payload(res) as { ok: boolean; results: Array<Record<string, unknown>> };
    assert.equal(body.ok, true);
    assert.equal(body.results.length, 2);
    assertDocUrl(body.results[0].url, GROUP, '批量甲');
    assertDocUrl(body.results[1].url, `${GROUP}/子组`, '批量乙');
  });

  it('未开启 Web 时每一条都没有 url', async () => {
    setWebRuntime(OFF);
    const res = await tools.ki_bulk_sync_relation.handler({
      scope,
      items: [{ group: GROUP, relation: '批量丙', module_info: '丙正文。' }],
      vector: false,
    }, httpExtra());

    const body = payload(res) as { results: Array<Record<string, unknown>> };
    assert.equal(body.results.some((item) => 'url' in item), false);
  });
});

describe('ki_edit_relation', () => {
  it('首轮 edit 也带 url（草稿阶段就能回看）', async () => {
    setWebRuntime(WEB);
    const live = await executeGetModuleInfoLocal({ scope, group: GROUP, relation: '带链接的文档' });
    assert.equal(live.ok, true);
    const revision = (live as { revision?: string }).revision;
    assert.ok(revision, '需要拿正式正文的 revision 才能开草稿');

    const res = await tools.ki_edit_relation.handler({
      action: 'edit',
      scope,
      group: GROUP,
      relation: '带链接的文档',
      expected_revision: revision,
      edits: [{ start_line: 1, end_line: 1, new_text: '# 带链接（已改）' }],
    }, httpExtra());

    const body = payload(res);
    assert.equal(body.ok, true, `edit 应成功，实际：${String(body.error ?? '')}`);
    assert.equal(body.group, GROUP);
    assert.equal(body.relation, '带链接的文档');
    assertDocUrl(body.url, GROUP, '带链接的文档');
  });
});

describe('ki_delete_relation', () => {
  it('删除后不返回链接（避免死链）', async () => {
    setWebRuntime(WEB);
    const res = await tools.ki_delete_relation.handler({
      scope,
      group: '__root__',
      relation: '根目录文档',
    }, httpExtra());

    const body = payload(res);
    assert.equal('url' in body, false);
  });
});
