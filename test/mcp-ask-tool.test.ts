/**
 * `ki_ask` 工具面与安全闸门（REQ-20261113-001 · S-02 §8）
 *
 * 覆盖 8 条不变量：
 *   ① 三个清单口径互斥：只读白名单 / 模型消耗型 / 检索统计
 *   ② 只读 Token 的拒绝文案四要素（原因 / 现象 / 出路 / 双因）
 *   ③ 能力点映射 `ki_ask → knowledge.ask`（与 `knowledge.read` 分离）
 *   ④ 调度车道：`kindForMcpToolNames(['ki_ask']) === 'read'`（不阻塞导入）
 *   ⑤ **防递归守卫**：`CHAT_MCP_TOOLS` 不含 `ki_ask`
 *   ⑥ 配置分组 `MCP_TOOL_GROUPS` 不含 `ki_ask`（否则内层工具面会出现它）
 *   ⑦ `SEARCH_TOOL_NAMES` 不含 `ki_ask`（1 次问答 ≠ 1 次检索，否则冷热榜虚高）
 *   ⑧ 注册装配：读写 / 免鉴权会话有 `ki_ask`，只读会话没有
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-ask-tool.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  READ_ONLY_TOOL_NAMES,
  SEARCH_TOOL_NAMES,
  MODEL_CONSUMING_TOOL_NAMES,
  TOKEN_MODEL_FORBIDDEN,
  TOKEN_READONLY,
  isModelConsumingTool,
  isReadOnlyTool,
  modelConsumingRejectMessage,
} from '../src/lib/mcp-tools/tool-access.js';
import { TOOL_CAPABILITIES } from '../src/lib/auth/tool-permissions.js';
import { kindForMcpToolNames } from '../src/lib/operation-coordinator.js';
import { CHAT_MCP_TOOLS } from '../src/lib/chat/mcp-tool-registry.js';
import { MCP_TOOL_GROUPS } from '../src/lib/chat/prompt-config.js';
import { buildKiMcpServer } from '../src/lib/mcp-server-factory.js';

/** 读取 McpServer 已注册的工具名（SDK 未公开的注册表，白盒断言用） */
function registeredToolNames(server: McpServer): string[] {
  const internal = server as unknown as { _registeredTools?: Record<string, unknown> };
  return Object.keys(internal._registeredTools ?? {}).sort();
}

describe('ki_ask · 清单口径', () => {
  it('① 只读白名单与模型消耗型互斥，且 ki_ask 只在后者', () => {
    assert.ok(MODEL_CONSUMING_TOOL_NAMES.includes('ki_ask'));
    assert.ok(!READ_ONLY_TOOL_NAMES.includes('ki_ask'), '放进只读白名单 = 只读 Token 可烧模型额度');
    for (const name of MODEL_CONSUMING_TOOL_NAMES) {
      assert.ok(!READ_ONLY_TOOL_NAMES.includes(name), `${name} 不应同时出现在只读白名单`);
    }
    assert.equal(isReadOnlyTool('ki_ask'), false);
    assert.equal(isModelConsumingTool('ki_ask'), true);
    assert.equal(isModelConsumingTool('ki_search'), false, '普通读工具不应被当成模型消耗型');
  });

  it('② 只读 Token 的拒绝文案具备四要素，且不复用写入口径', () => {
    const text = modelConsumingRejectMessage('ki_ask', 'tok-abc');
    assert.match(text, /只读/, '① 原因：写明只读');
    assert.match(text, /快照/, '② 现象解释：工具列表可能是建连快照');
    assert.match(text, /读写 Token/, '③ 出路：换读写 Token');
    assert.match(text, /llm/, '④ 双因提示：模型未配置时换 Token 也没用');
    assert.match(text, /tok-abc/, '带上 token id 便于管理员定位');
    assert.doesNotMatch(text, /写入工具 ki_ask/, '不得说成写入工具（归因错误）');
    assert.notEqual(TOKEN_MODEL_FORBIDDEN, TOKEN_READONLY, '两个错误码必须分开');
  });

  it('③ 能力点映射：knowledge.ask 而非 knowledge.read', () => {
    assert.equal(TOOL_CAPABILITIES['ki_ask'], 'knowledge.ask');
  });

  it('④ 调度车道：ki_ask 走读车道（不阻塞导入 / 写入）', () => {
    assert.equal(kindForMcpToolNames(['ki_ask']), 'read');
    assert.equal(kindForMcpToolNames(['ki_ask', 'ki_search']), 'read');
    assert.equal(kindForMcpToolNames(['ki_ask', 'ki_store']), 'write', '混入写工具仍整批回退 write');
  });

  it('⑤ 防递归守卫：CHAT_MCP_TOOLS 不含 ki_ask', () => {
    const names = CHAT_MCP_TOOLS.map((t) => t.name);
    assert.ok(!names.includes('ki_ask'), '登记后内层 LLM 可自调 ki_ask，maxToolRounds 挡不住递归');
  });

  it('⑥ 配置分组 MCP_TOOL_GROUPS 不含 ki_ask', () => {
    const all = MCP_TOOL_GROUPS.flatMap((g) => [...g.names]);
    assert.ok(!all.includes('ki_ask'));
  });

  it('⑦ 检索统计口径：SEARCH_TOOL_NAMES 不含 ki_ask', () => {
    assert.ok(!SEARCH_TOOL_NAMES.includes('ki_ask'), '1 次问答 = 多次检索，计入会让冷热榜虚高');
  });
});

describe('ki_ask · 注册装配', () => {
  it('⑧ 读写 / 免鉴权会话注册 ki_ask；只读会话不注册', () => {
    const rw = registeredToolNames(buildKiMcpServer({ scopes: ['all'], readOnly: false }));
    assert.ok(rw.includes('ki_ask'), '读写会话必须能看见 ki_ask');

    const local = registeredToolNames(buildKiMcpServer(null));
    assert.ok(local.includes('ki_ask'), '回环 / stdio 免鉴权会话必须能看见 ki_ask');

    const ro = registeredToolNames(buildKiMcpServer({ scopes: ['all'], readOnly: true }));
    assert.ok(!ro.includes('ki_ask'), '只读会话不得注册（会消耗模型额度并外发内容）');
    assert.deepEqual(ro, [...READ_ONLY_TOOL_NAMES].sort(), '只读会话仍只有 6 个纯读工具');
  });
});
