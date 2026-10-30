/**
 * 只读 Token 测试 —— 存储层（readOnly 字段）+ 工具白名单 + tools/call 拦截
 *
 * 覆盖：
 *   - TokenRecord.readOnly 的创建 / 兼容 / 严格布尔兜底 / 局部更新
 *   - READ_ONLY_TOOL_NAMES 名单内容与 13 个工具的关系（读 5 / 写 8）
 *   - findReadOnlyViolation：单条、batch、未知工具名（fail-safe）、非 tools/call
 *   - 拒绝文案四要素且不含会误关库级只读的 `ki scope readonly`
 *
 * 运行：npx jiti test/mcp-token-readonly.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createToken,
  updateToken,
  listTokens,
  findTokenAuth,
  findTokenScopes,
  isReadOnlyFieldInvalid,
  ALL_SCOPES,
} from '../src/lib/mcp-token.js';
import {
  READ_ONLY_TOOL_NAMES,
  isReadOnlyTool,
  readonlyRejectMessage,
  READ_ONLY_INSTRUCTIONS,
  TOKEN_READONLY,
} from '../src/lib/mcp-tools/tool-access.js';
import { findReadOnlyViolation } from '../src/lib/mcp-http.js';
import { buildKiMcpServer } from '../src/lib/mcp-server-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** 8 个写工具（与 mcp-server.ts 的写工具注册块一致） */
const WRITE_TOOLS = [
  'ki_store',
  'ki_bulk_store',
  'ki_sync_relation',
  'ki_bulk_sync_relation',
  'ki_edit_relation',
  'ki_group_create',
  'ki_group_delete_empty',
  'ki_delete_relation',
];

let tmpDir: string;
let tokensPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-token-ro-'));
  tokensPath = path.join(tmpDir, 'mcp-tokens.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ─────────────────────────────────────────────
// 存储层
// ─────────────────────────────────────────────

describe('createToken：readOnly 落盘与向后兼容', () => {
  it('readOnly=true 时落字段，findTokenAuth 返回只读', () => {
    const r = createToken(['team-a'], tokensPath, true);
    assert.equal(r.readOnly, true);
    const auth = findTokenAuth(r.token, tokensPath);
    assert.deepEqual(auth, { id: r.id, scopes: ['team-a'], readOnly: true });
  });

  it('缺省（不传）为读写，且**不写** readOnly 字段（保持旧文件格式）', () => {
    const r = createToken(['team-a'], tokensPath);
    assert.equal(r.readOnly, undefined);
    const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf-8')) as Array<Record<string, unknown>>;
    assert.equal('readOnly' in raw[0]!, false);
    assert.equal(findTokenAuth(r.token, tokensPath)?.readOnly, false);
  });

  it('旧记录（无 readOnly 字段）按读写处理，无需迁移', () => {
    fs.writeFileSync(tokensPath, JSON.stringify([{
      id: 'legacy01',
      token: 'legacy-token',
      scopes: [ALL_SCOPES],
      createdAt: new Date().toISOString(),
    }]), 'utf-8');
    const auth = findTokenAuth('legacy-token', tokensPath);
    assert.deepEqual(auth, { id: 'legacy01', scopes: [ALL_SCOPES], readOnly: false });
    assert.equal(isReadOnlyFieldInvalid({ id: 'x', token: 'y', scopes: [], createdAt: '' }), false);
  });

  it('readOnly 字段类型非法（"true" / 1）→ 按读写 + 可被 list 告警识别', () => {
    for (const bad of ['true', 1, null]) {
      fs.writeFileSync(tokensPath, JSON.stringify([{
        id: 'bad00001',
        token: 'bad-token',
        scopes: ['s'],
        createdAt: new Date().toISOString(),
        readOnly: bad,
      }]), 'utf-8');
      const auth = findTokenAuth('bad-token', tokensPath);
      assert.equal(auth?.readOnly, false, `readOnly=${JSON.stringify(bad)} 应按读写兜底`);
      const record = listTokens(tokensPath)[0]!;
      assert.equal(isReadOnlyFieldInvalid(record), true, `readOnly=${JSON.stringify(bad)} 应被标记为非法`);
    }
  });

  it('findTokenScopes 保持原语义（只返回 scopes，供 /api 通道使用）', () => {
    const r = createToken(['team-a', 'team-b'], tokensPath, true);
    assert.deepEqual(findTokenScopes(r.token, tokensPath), ['team-a', 'team-b']);
  });

  it('未命中返回 undefined', () => {
    createToken(['a'], tokensPath, true);
    assert.equal(findTokenAuth('wrong-token', tokensPath), undefined);
  });
});

describe('updateToken：scope 与访问模式可独立修改', () => {
  it('只改 readOnly，scopes 不变（避免顺手改错授权范围）', () => {
    const r = createToken(['team-a'], tokensPath);
    const updated = updateToken(r.id, { readOnly: true }, tokensPath);
    assert.equal(updated.readOnly, true);
    assert.deepEqual(updated.scopes, ['team-a']);
  });

  it('只改 scopes，只读标记保持', () => {
    const r = createToken(['team-a'], tokensPath, true);
    const updated = updateToken(r.id, { scopes: ['team-a', 'team-b'] }, tokensPath);
    assert.deepEqual(updated.scopes, ['team-a', 'team-b']);
    assert.equal(updated.readOnly, true);
  });

  it('切回读写时删除字段（不写 false）', () => {
    const r = createToken(['team-a'], tokensPath, true);
    updateToken(r.id, { readOnly: false }, tokensPath);
    const raw = JSON.parse(fs.readFileSync(tokensPath, 'utf-8')) as Array<Record<string, unknown>>;
    assert.equal('readOnly' in raw[0]!, false);
    assert.equal(findTokenAuth(r.token, tokensPath)?.readOnly, false);
  });

  it('两项都不给 → MCP_TOKEN_UPDATE_NOTHING_TO_DO', () => {
    const r = createToken(['team-a'], tokensPath);
    assert.throws(
      () => updateToken(r.id, {}, tokensPath),
      (err: Error & { code?: string }) => err.code === 'MCP_TOKEN_UPDATE_NOTHING_TO_DO',
    );
  });

  it('id 不存在 → TOKEN_NOT_FOUND', () => {
    assert.throws(
      () => updateToken('nope1234', { readOnly: true }, tokensPath),
      (err: Error & { code?: string }) => err.code === 'TOKEN_NOT_FOUND',
    );
  });
});

// ─────────────────────────────────────────────
// 工具白名单
// ─────────────────────────────────────────────

describe('READ_ONLY_TOOL_NAMES：名单内容', () => {
  it('恰好 5 个读工具，与 8 个写工具互不重叠', () => {
    assert.deepEqual(
      [...READ_ONLY_TOOL_NAMES].sort(),
      ['ki_get_module_info', 'ki_group_list', 'ki_scope_list', 'ki_search', 'ki_tag_list'],
    );
    for (const writeTool of WRITE_TOOLS) {
      assert.equal(isReadOnlyTool(writeTool), false, `${writeTool} 不得出现在只读白名单`);
    }
  });

  it('ki_tag_list 在只读名单内（调度口径 READ_MCP_TOOLS 不收它，两者口径不同）', () => {
    assert.equal(isReadOnlyTool('ki_tag_list'), true);
  });

  it('未知工具默认不允许（白名单方向：漏登记 = 拒绝，而非放行）', () => {
    assert.equal(isReadOnlyTool('ki_future_write_tool'), false);
  });
});

describe('readonlyRejectMessage：文案四要素', () => {
  it('含原因 / 列表快照解释 / 正确出路 / 双因提示', () => {
    const msg = readonlyRejectMessage('ki_store', 'abc12345');
    assert.match(msg, /只读/);
    assert.match(msg, /快照/);
    assert.match(msg, /token update <id> --read-write/);
    assert.match(msg, /只读库/);
    assert.match(msg, /abc12345/);
  });

  it('绝不含会误关库级只读的 ki scope readonly', () => {
    assert.doesNotMatch(readonlyRejectMessage('ki_store'), /scope readonly/);
  });

  it('错误码与 SCOPE_READONLY 不同名', () => {
    assert.equal(TOKEN_READONLY, 'TOKEN_READONLY');
    assert.notEqual(TOKEN_READONLY, 'SCOPE_READONLY');
  });

  it('instructions 告知只读并提供正确出路', () => {
    assert.match(READ_ONLY_INSTRUCTIONS, /只读/);
    assert.match(READ_ONLY_INSTRUCTIONS, /--read-write/);
  });
});

// ─────────────────────────────────────────────
// tools/call 拦截（fail-safe 白名单）
// ─────────────────────────────────────────────

describe('findReadOnlyViolation', () => {
  const call = (name: string, args: Record<string, unknown> = { scope: 's' }) => ({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args },
  });

  it('写工具 → 返回工具名（需拒绝）', () => {
    for (const name of WRITE_TOOLS) {
      assert.equal(findReadOnlyViolation(call(name)), name);
    }
  });

  it('读工具 → null（放行）', () => {
    for (const name of READ_ONLY_TOOL_NAMES) {
      assert.equal(findReadOnlyViolation(call(name)), null);
    }
  });

  it('batch 中混入写工具 → 拦截（防"首项合法后续越权"）', () => {
    const batch = [call('ki_search'), call('ki_delete_relation')];
    assert.equal(findReadOnlyViolation(batch), 'ki_delete_relation');
  });

  it('未知工具名 → 拦截（fail-safe，新增工具漏登记也不会被只读 Token 调通）', () => {
    assert.equal(findReadOnlyViolation(call('ki_archived_write')), 'ki_archived_write');
  });

  it('非 tools/call 方法（initialize / tools/list / ping）→ null', () => {
    assert.equal(findReadOnlyViolation({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), null);
    assert.equal(findReadOnlyViolation({ jsonrpc: '2.0', id: 1, method: 'initialize' }), null);
  });

  it('异常入参（null / 字符串 / 无 params）→ null，不抛错', () => {
    assert.equal(findReadOnlyViolation(null), null);
    assert.equal(findReadOnlyViolation('x'), null);
    assert.equal(findReadOnlyViolation({ method: 'tools/call' }), null);
    assert.equal(findReadOnlyViolation({ method: 'tools/call', params: { name: 123 } }), null);
  });
});

// ─────────────────────────────────────────────
// Server 装配（真实 factory 白盒：读只读会话究竟注册了哪些工具）
// ─────────────────────────────────────────────

/** 读取 McpServer 已注册的工具名（SDK 未公开的注册表，白盒断言用） */
function registeredToolNames(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(internal._registeredTools ?? {}).sort();
}

/** 读取会话注入的 MCP instructions（Server 内部字段） */
function serverInstructions(server: McpServer): string | undefined {
  const internal = server as unknown as { server?: { _instructions?: string } };
  return internal.server?._instructions;
}

describe('buildKiMcpServer：按访问模式装配工具集', () => {
  it('只读会话只注册 5 个读工具（写工具不出现在 tools/list）', () => {
    const server = buildKiMcpServer({ scopes: ['all'], readOnly: true });
    assert.deepEqual(registeredToolNames(server), [...READ_ONLY_TOOL_NAMES].sort());
  });

  it('读写会话注册全部 13 个工具（5 读 + 8 写）', () => {
    const server = buildKiMcpServer({ scopes: ['all'], readOnly: false });
    const names = registeredToolNames(server);
    assert.equal(names.length, 13);
    for (const name of READ_ONLY_TOOL_NAMES) assert.ok(names.includes(name), `缺读工具 ${name}`);
    for (const name of WRITE_TOOLS) assert.ok(names.includes(name), `缺写工具 ${name}`);
  });

  it('免鉴权（null，stdio / 回环）与读写会话等价，且不注入只读 instructions', () => {
    const server = buildKiMcpServer(null);
    assert.equal(registeredToolNames(server).length, 13);
    assert.equal(serverInstructions(server), undefined);
  });

  it('只读会话注入 instructions（告知 AI 只读 + 正确出路）', () => {
    const server = buildKiMcpServer({ scopes: ['all'], readOnly: true });
    const text = serverInstructions(server);
    assert.equal(typeof text, 'string');
    assert.match(text!, /只读/);
    assert.match(text!, /--read-write/);
    assert.doesNotMatch(text!, /scope readonly/);
  });
});
