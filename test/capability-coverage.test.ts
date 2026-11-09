/**
 * capability-coverage.test.ts —— 能力注册表覆盖率（REQ-20261103-001 · S-03）
 *
 * 运行：npx jiti test/capability-coverage.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { matchRoute } from '../src/lib/auth/route-permissions.js';
import {
  ALL_TOOL_NAMES,
  TOOL_CAPABILITIES,
  canUseTool,
} from '../src/lib/auth/tool-permissions.js';
import {
  ROLE_CAPABILITIES,
  TOKEN_CAPABILITIES,
} from '../src/lib/auth/capabilities.js';
import { CHAT_MCP_TOOLS } from '../src/lib/chat/mcp-tool-registry.js';
import { READ_ONLY_TOOL_NAMES } from '../src/lib/mcp-tools/tool-access.js';
import { buildKiMcpServer } from '../src/lib/mcp-server-factory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** 读取 McpServer 已注册的工具名（SDK 未公开的注册表，白盒断言用） */
function registeredToolNames(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(internal._registeredTools ?? {}).sort();
}

describe('capability coverage', () => {
  it('所有 handler 路径字面量都在路由注册表中', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/lib/mcp-http-api.ts'),
      'utf8',
    );
    const literals = new Set(
      [...source.matchAll(/\bp === '([^']+)'/g)].map((m) => m[1]),
    );
    assert.ok(literals.size > 20, '路径字面量扫描数量异常（正则可能失效）');
    for (const p of literals) {
      const known = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
        .some((method) => matchRoute(method, p).kind !== 'unknown');
      assert.equal(known, true, `路由未登记：${p}`);
    }
  });

  it('动态路径 / 关键能力映射', () => {
    assert.equal(matchRoute('GET', '/tasks/abc').capability, 'tasks.read');
    assert.equal(matchRoute('GET', '/tasks/abc/log').capability, 'tasks.read');
    assert.equal(matchRoute('DELETE', '/tasks/abc').capability, 'tasks.delete');
    assert.equal(matchRoute('GET', '/users').capability, 'users.manage');
    assert.equal(matchRoute('PATCH', '/users/u1').capability, 'users.manage');
    assert.equal(matchRoute('GET', '/chat/conversations').capability, 'chat.use');
    assert.equal(matchRoute('PUT', '/chat/prompt-config').capability, 'ops.write');
    assert.equal(matchRoute('POST', '/datasource/remove').capability, 'datasource.delete');
    assert.equal(matchRoute('POST', '/datasource/prune').capability, 'datasource.delete');
    assert.equal(matchRoute('POST', '/import/prune').capability, 'datasource.delete');
    assert.equal(matchRoute('POST', '/datasource/sync').capability, 'datasource.write');
    assert.equal(matchRoute('POST', '/restore/run').capability, 'ops.write');
    assert.equal(matchRoute('POST', '/import/cancel').capability, 'tasks.cancel');
    assert.equal(matchRoute('POST', '/doc/edit').capability, 'knowledge.write');
    assert.equal(matchRoute('GET', '/doc/edit').capability, 'knowledge.read');
    assert.equal(matchRoute('POST', '/auth/password').kind, 'authenticated');
    assert.equal(matchRoute('GET', '/nope').kind, 'unknown');
  });

  it('所有 MCP 主通道工具都有能力（chat 是子集）；默认拒绝未知工具', () => {
    /*
     * 对齐口径用「MCP 主通道实际注册的工具」而不是 chat 工具清单：
     * chat 通道**刻意只暴露一部分**（如 ki_view_list 这类枚举工具对会话级模型无用），
     * 用 chat 清单当全集会让"注册了但没登记能力"漏检，也让新增仅主通道工具必然挂测试。
     */
    const registered = registeredToolNames(buildKiMcpServer(null));
    assert.deepEqual(
      new Set(ALL_TOOL_NAMES),
      new Set(registered),
      '能力登记表与主通道实际注册工具集必须一一对应',
    );

    const chatNames = CHAT_MCP_TOOLS.map((t) => t.name);
    assert.equal(chatNames.length, 13);
    for (const name of chatNames) {
      assert.ok(registered.includes(name), `chat 工具未在主通道注册：${name}`);
      assert.ok(TOOL_CAPABILITIES[name], `工具未登记：${name}`);
    }
    for (const name of READ_ONLY_TOOL_NAMES) {
      assert.equal(TOOL_CAPABILITIES[name], 'knowledge.read');
      assert.equal(canUseTool(ROLE_CAPABILITIES.viewer, name), true);
    }
    assert.equal(canUseTool(ROLE_CAPABILITIES.viewer, 'ki_store'), false);
    assert.equal(canUseTool(ROLE_CAPABILITIES.editor, 'ki_store'), true);
    assert.equal(canUseTool(ROLE_CAPABILITIES.admin, 'ki_store'), true);
    assert.equal(canUseTool(new Set(), 'ki_search'), false);
    assert.equal(canUseTool(ROLE_CAPABILITIES.admin, 'unknown_tool'), false);
  });

  it('Token 能力不新增 users.manage / tasks.delete', () => {
    assert.equal(TOKEN_CAPABILITIES.has('users.manage'), false);
    assert.equal(TOKEN_CAPABILITIES.has('tasks.delete'), false);
    assert.equal(TOKEN_CAPABILITIES.has('knowledge.write'), true);
    assert.equal(TOKEN_CAPABILITIES.has('datasource.delete'), true);
  });
});
