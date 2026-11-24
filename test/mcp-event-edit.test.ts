/**
 * mcp-event-edit.test.ts —— `ki_event_edit` 的**工具面与参数形状**（REQ-20261123-009 · S-02）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-event-edit.test.ts
 *
 * 本文件只测参数层：互斥校验发生在**触达业务之前**，所以不需要真实 scope / 事件。
 * 5 个 action 的业务语义分别由：
 *   · `members` / `references` → `test/mcp-event-tools.test.ts`（③④）
 *   · `analysis`               → `test/events/analysis-store-external.test.ts`（S-01 内核）
 *   · `description` / `stage`  → 真机走查（见 `design/IMPL_PLAN.md` 第 2 批检查点）
 *
 * 守的是合并带来的**新风险**：一个工具承载 5 类动作后，AI 很容易"混着传"，
 * 半生效比报错更难排查；以及旧工具名必须真的不在了（缓存里还能调到就是事故）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEventEditTool } from '../src/lib/mcp-tools/event-edit.js';

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }

const server = new McpServer({ name: 'ki-event-edit-test', version: '0.0.0' });
registerEventEditTool(server);

function tools(): Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }> {
  return (server as unknown as {
    _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }>;
  })._registeredTools;
}

async function call(args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools().ki_event_edit;
  assert.ok(tool, 'ki_event_edit 未注册');
  return tool.handler(args, {});
}

function parse(res: ToolResult): Record<string, unknown> {
  const last = res.content[res.content.length - 1]!;
  return JSON.parse(last.text) as Record<string, unknown>;
}

describe('工具面', () => {
  it('只注册 ki_event_edit，旧的三个工具名已下线', () => {
    assert.deepEqual(Object.keys(tools()).sort(), ['ki_event_edit']);
    for (const old of ['ki_event_docs', 'ki_event_refs', 'ki_event_set_stage']) {
      assert.equal(tools()[old], undefined, `${old} 应已删除（旧客户端会收到 unknown tool）`);
    }
  });
});

describe('互斥：一次只做一类', () => {
  const CASES: Array<{ name: string; args: Record<string, unknown> }> = [
    {
      name: 'description 不接受 chain',
      args: { action: 'description', description: 'x', chain: [{ kind: 'root', text: 't' }] },
    },
    {
      name: 'analysis 必须带 candidates',
      args: { action: 'analysis', conclusion: '只有结论没有位置' },
    },
    {
      name: 'analysis 不接受 docRefs',
      args: {
        action: 'analysis',
        candidates: [{ file: 'a.ts', line: 1, why: 'w' }],
        docRefs: [{ group: 'g', name: 'n' }],
      },
    },
    {
      name: 'members 缺 docAction',
      args: { action: 'members', docRefs: [{ group: 'g', name: 'n' }] },
    },
    {
      name: 'stage 不接受 description',
      args: { action: 'stage', stage: 'st_1', description: 'x' },
    },
    {
      name: 'description 缺内容',
      args: { action: 'description' },
    },
  ];

  for (const c of CASES) {
    it(c.name, async () => {
      const res = await call({ scope: 'no-such-scope', event: 'evt_nope', ...c.args });
      const body = parse(res);
      assert.equal(body.ok, false, `必须在参数层拒绝，不能进业务：${JSON.stringify(body)}`);
      const text = String(body.error ?? body.message ?? '');
      assert.match(text, /action=|未知 action|必须|需要|不接受/, `错误文案要能指导纠正：${text}`);
    });
  }
});
