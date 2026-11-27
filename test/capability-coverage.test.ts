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
import { INTERNAL_ONLY_TOOL_NAMES, READ_ONLY_TOOL_NAMES } from '../src/lib/mcp-tools/tool-access.js';
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
    /*
     * 模型消耗型标记（#96 · Q2）：只有「发起追问」两个入口带 `modelConsuming`，
     * 停止与读记录不带 —— 能力都是 knowledge.ask，若按能力判会连收回一起拦掉。
     */
    assert.equal(matchRoute('POST', '/governance/events/e1/analysis/ask').modelConsuming, true);
    assert.equal(matchRoute('POST', '/governance/events/e1/analysis/ask/stream').modelConsuming, true);
    assert.equal(matchRoute('POST', '/governance/events/e1/analysis/ask/cancel').modelConsuming, undefined);
    assert.equal(matchRoute('GET', '/governance/events/e1/analysis/ask').modelConsuming, undefined);
    // 写能力路由不该被误标（两条维度正交）
    assert.equal(matchRoute('POST', '/doc/edit').modelConsuming, undefined);
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
    /*
     * 口径：能力表 = 主通道已注册 + 仅内部工具。
     * `INTERNAL_ONLY_TOOL_NAMES`（目前只有 ki_get_image）是 2026-11-25 从 `/mcp` 移除、
     * 但 chat / 分析面仍需能力登记的例外，见 tool-access.ts 的说明。
     */
    assert.deepEqual(
      new Set(ALL_TOOL_NAMES),
      new Set([...registered, ...INTERNAL_ONLY_TOOL_NAMES]),
      '能力登记表与「主通道实际注册工具集 + 仅内部工具」必须一一对应',
    );
    for (const name of INTERNAL_ONLY_TOOL_NAMES) {
      assert.equal(
        registered.includes(name), false,
        `${name} 在 INTERNAL_ONLY_TOOL_NAMES 里却仍被主通道注册（清单已过期）`,
      );
    }

    const chatNames = CHAT_MCP_TOOLS.map((t) => t.name);
    // 2026-11-25：ki_get_image 从 /mcp 移除但保留在 chat，工具数仍为 14
    // 2026-11-27：源码只读 4 个进对话工具面（REQ-20261127-001），14 → 18
    assert.equal(chatNames.length, 18);
    for (const name of chatNames) {
      assert.ok(
        registered.includes(name) || INTERNAL_ONLY_TOOL_NAMES.includes(name),
        `chat 工具既未在主通道注册、也不在仅内部清单中：${name}`,
      );
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
