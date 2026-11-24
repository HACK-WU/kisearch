/**
 * mcp-event-tools.test.ts —— 4 个事件类 MCP 工具（REQ-20261116-004 · S-03）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-event-tools.test.ts
 *
 * 覆盖：注册面 / 名称解析（type 传中文名）/ 类型不存在附可选 /
 *       create 带 docs+refs 回显 binding / docs add+remove / refs 交集记为 skipped /
 *       delete 未收口被拒、收口后成功
 *
 * 说明：直接调用 `_registeredTools[name].handler`（与 `edit-relation.test.ts` 同一手法），
 * 不经 InMemoryTransport —— 工具本身不依赖 sampling / elicitation，走传输只会引入额外不确定性。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { listTypes } from '../src/lib/events/type-service.js';
import { transitionEvent } from '../src/lib/events/event-service.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEventCreateTool } from '../src/lib/mcp-tools/event-create.js';
import { registerEventDeleteTool } from '../src/lib/mcp-tools/event-delete.js';
import { registerEventEditTool } from '../src/lib/mcp-tools/event-edit.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `mcp-event-tools-${Date.now()}`;
const GROUP = '专题记忆/MCP工具测试';

function seedDoc(name: string): Relation {
  const rel: Relation = {
    id: `rel_${name.replace(/\W/g, '')}`,
    text: name,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: false,
  };
  const doc = loadGroupCache(scope, GROUP) ?? { version: 1, scope, hot_relations: [], keywords: [], updatedAt: null };
  doc.hot_relations = doc.hot_relations.filter((r) => r.text !== name);
  doc.hot_relations.push(rel);
  writeGroupCache(scope, GROUP, doc);

  const kbPath = getLocalKbDir(scope, GROUP);
  fs.mkdirSync(path.dirname(kbPath), { recursive: true });
  const kb = readJson<Record<string, string>>(kbPath) ?? {};
  kb[name] = `# ${name}\n正文`;
  writeJson(kbPath, kb);
  return rel;
}

interface ToolResult { isError?: boolean; content: Array<{ type: string; text: string }> }

const server = new McpServer({ name: 'ki-event-tools-test', version: '0.0.0' });
registerEventCreateTool(server);
registerEventDeleteTool(server);
registerEventEditTool(server);

function tools(): Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }> {
  return (server as unknown as { _registeredTools: Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }> })
    ._registeredTools;
}

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const tool = tools()[name];
  if (!tool) throw new Error(`工具未注册：${name}`);
  return tool.handler(args, { signal: new AbortController().signal });
}

function parse(res: ToolResult): Record<string, any> {
  return JSON.parse(res.content[0]!.text) as Record<string, any>;
}

before(() => {
  // 工具会触发后台补索引；单测进程不等引擎句柄，这里统一关掉（见 visibility-queue 的说明）
  process.env.KI_DISABLE_AUTO_CONSUME = '1';
  registerTestScope(scope);
  initScope(scope);
});

after(async () => {
  // 工具会触发一次后台补索引（scheduleConsume）：先等它结束（最多 3s）再关引擎，
  // 否则原生句柄会让进程跑完用例后不退出。
  const { waitForConsume } = await import('../src/lib/visibility-queue.js');
  await Promise.race([
    waitForConsume(scope).catch(() => null),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  const { closeEngine } = await import('../src/lib/vector-client.js');
  await closeEngine().catch(() => undefined);
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
  cleanupTestConfig();
  await server.close();
});

describe('① 工具面', () => {
  it('3 个工具都注册出来了（docs/refs/set_stage 已并入 ki_event_edit），且都不在只读白名单', async () => {
    const { isReadOnlyTool } = await import('../src/lib/mcp-tools/tool-access.js');
    const names = Object.keys(tools()).sort();
    assert.deepEqual(names, ['ki_event_create', 'ki_event_delete', 'ki_event_edit']);
    for (const name of names) {
      assert.equal(isReadOnlyTool(name), false, `${name} 不得进只读白名单`);
    }
  });
});

describe('② ki_event_create', () => {
  it('type 传中文名称可解析；带 docs/refs 回显 binding 与 visibility', async () => {
    const a = seedDoc('创建A');
    const ref = seedDoc('创建引用');
    const res = await call('ki_event_create', {
      scope,
      title: 'MCP 创建',
      type: 'bug 排查',
      stage: '排查中',
      docs: [{ group: GROUP, name: a.text }],
      refs: [{ group: GROUP, name: ref.text }],
    });
    assert.equal(res.isError, undefined);
    const body = parse(res);
    assert.equal(body.ok, true);
    assert.match(body.event.shortId, /^#\d+$/);
    assert.equal(body.event.stage.name, '排查中');
    assert.equal(body.binding.docs.bound.length, 1);
    assert.equal(body.binding.refs.added, 1);
    assert.equal(body.visibility.mode, 'hidden');
    assert.match(body.hint, /不可检索/);
  });

  it('type 不存在 → isError + TYPE_NOT_FOUND + available', async () => {
    const res = await call('ki_event_create', { scope, title: '坏类型', type: '不存在的类型' });
    assert.equal(res.isError, true);
    const body = parse(res);
    assert.equal(body.code, 'TYPE_NOT_FOUND');
    assert.equal(body.details?.available?.length, 4, '内置 4 条（含技术债）');
  });
});

describe('③ ki_event_edit members', () => {
  it('add → bound；remove → removed；解绑后再 remove → failed', async () => {
    const doc = seedDoc('MCP成员文档');
    const created = parse(await call('ki_event_create', { scope, title: '成员工具', type: 'et_1' }));
    const event = created.event.id as string;

    const added = parse(await call('ki_event_edit', {
      scope, event, action: 'members', docAction: 'add', docRefs: [{ group: GROUP, name: doc.text }],
    }));
    assert.equal(added.bound.length, 1);

    const removed = parse(await call('ki_event_edit', {
      scope, event, action: 'members', docAction: 'remove', docRefs: [{ group: GROUP, name: doc.text }],
    }));
    assert.equal(removed.removed.length, 1);
    assert.equal(removed.failed.length, 0);

    const again = parse(await call('ki_event_edit', {
      scope, event, action: 'members', docAction: 'remove', docRefs: [{ group: GROUP, name: doc.text }],
    }));
    assert.equal(again.removed.length, 0);
    assert.equal(again.failed[0]?.code, 'DOC_NOT_FOUND');
  });
});

describe('④ ki_event_edit references', () => {
  it('add 与关联文档冲突 → skipped(already-associated)；add/remove 正常', async () => {
    const doc = seedDoc('引用冲突文档');
    const created = parse(await call('ki_event_create', {
      scope, title: '引用工具', type: 'et_1', docs: [{ group: GROUP, name: doc.text }],
    }));
    const event = created.event.id as string;

    const conflicted = parse(await call('ki_event_edit', {
      scope, event, action: 'references', docAction: 'add', docRefs: [{ group: GROUP, name: doc.text }],
    }));
    assert.equal(conflicted.added, 0);
    assert.equal(conflicted.skipped[0]?.reason, 'already-associated');

    const ref = seedDoc('正常引用');
    const ok = parse(await call('ki_event_edit', {
      scope, event, action: 'references', docAction: 'add', docRefs: [{ group: GROUP, name: ref.text }],
    }));
    assert.equal(ok.added, 1, `参考文档应加入成功：${JSON.stringify(ok)}`);

    const removed = parse(await call('ki_event_edit', {
      scope, event, action: 'references', docAction: 'remove', docRefs: [{ group: GROUP, name: ref.text }],
    }));
    assert.equal(removed.removed.length, 1);
  });
});

describe('⑤ ki_event_delete', () => {
  it('未收口 → EVENT_NOT_CLOSED；收口后 doc_action=wiki 成功', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '待删', type: 'et_1' }));
    const event = created.event.id as string;

    const rejected = await call('ki_event_delete', { scope, event, doc_action: 'wiki' });
    assert.equal(rejected.isError, true);
    assert.equal(parse(rejected).code, 'EVENT_NOT_CLOSED');

    const type = listTypes(scope).find((t) => t.id === 'et_1')!;
    await transitionEvent(scope, { event, stage: type.stages[type.stages.length - 1].key });

    const ok = await call('ki_event_delete', { scope, event, doc_action: 'wiki' });
    assert.equal(ok.isError, undefined);
    const body = parse(ok);
    assert.equal(body.ok, true);
    assert.equal(body.docAction, 'wiki');
    assert.equal(body.forced, false);
  });

  it('force 未带 confirm_title → EVENT_FORCE_CONFIRM_REQUIRED（附实际标题）', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '强制删缺少确认', type: 'et_1' }));
    const event = created.event.id as string;

    const res = await call('ki_event_delete', { scope, event, doc_action: 'wiki', force: true });
    assert.equal(res.isError, true);
    const body = parse(res);
    assert.equal(body.code, 'EVENT_FORCE_CONFIRM_REQUIRED');
    assert.match(body.error, /强制删缺少确认/);
  });

  it('confirm_title 与标题不一致 → EVENT_FORCE_CONFIRM_MISMATCH，且一条数据都没删', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '标题要对得上', type: 'et_1' }));
    const event = created.event.id as string;

    const res = await call('ki_event_delete', {
      scope, event, doc_action: 'wiki', force: true, confirm_title: '手滑写错',
    });
    assert.equal(parse(res).code, 'EVENT_FORCE_CONFIRM_MISMATCH');

    // 事件仍在：换成正确标题再删一次能成功，说明上一次确实什么也没做
    const ok = await call('ki_event_delete', {
      scope, event, doc_action: 'wiki', force: true, confirm_title: '标题要对得上',
    });
    assert.equal(ok.isError, undefined);
    assert.equal(parse(ok).forced, true);
  });

  it('空事件 + 正确标题 → 强制删除成功（forced=true，未动任何文档）', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '测试用的空事件', type: 'et_3' }));
    const event = created.event.id as string;

    const res = await call('ki_event_delete', {
      scope, event, doc_action: 'wiki', force: true, confirm_title: '测试用的空事件',
    });
    assert.equal(res.isError, undefined);
    const body = parse(res);
    assert.equal(body.forced, true);
    assert.equal(body.affected.docs, 0);
    assert.match(body.hint, /强制删除/);
  });

  it('带关联文档 → EVENT_FORCE_NOT_EMPTY（给出路：先解绑或先收口）', async () => {
    const a = seedDoc('强制删带成员');
    const created = parse(await call('ki_event_create', {
      scope,
      title: '带成员不能强删',
      type: 'et_1',
      docs: [{ group: GROUP, name: a.text }],
    }));
    const event = created.event.id as string;

    const res = await call('ki_event_delete', {
      scope, event, doc_action: 'wiki', force: true, confirm_title: '带成员不能强删',
    });
    assert.equal(res.isError, true);
    const body = parse(res);
    assert.equal(body.code, 'EVENT_FORCE_NOT_EMPTY');
    assert.match(body.error, /ki_event_edit members remove/);
    assert.equal(body.details.members, 1);
  });

  it('confirm_title 首尾带空格仍可删（输入侧 trim，不因空格卡死）', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '空格宽容测试', type: 'et_3' }));
    const event = created.event.id as string;

    const res = await call('ki_event_delete', {
      scope, event, doc_action: 'wiki', force: true, confirm_title: '  空格宽容测试  ',
    });
    assert.equal(res.isError, undefined);
    assert.equal(parse(res).forced, true);
  });
});
