/**
 * mcp-event-get.test.ts —— `ki_event_get` 单事件详情（2026-11-18）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/mcp-event-get.test.ts
 *
 * 覆盖：结构完整性（文档引用必须带 scope+group+name 三元组）/ 事件不存在 /
 *       无草稿为 null / 有草稿只给结论与未确认点（不回过程与候选正文）/
 *       各 limit=0 的裁剪与 note / 只读白名单登记
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { initScope, readJson, writeJson } from '../src/lib/store.js';
import { getKbDir, getLocalKbDir } from '../src/lib/scope.js';
import { loadGroupCache, writeGroupCache } from '../src/lib/group-cache.js';
import { getAnalysisPath } from '../src/lib/events/analysis-store.js';
import { isReadOnlyTool } from '../src/lib/mcp-tools/tool-access.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerEventCreateTool } from '../src/lib/mcp-tools/event-create.js';
import { registerEventDocsTool } from '../src/lib/mcp-tools/event-docs.js';
import { registerEventGetTool } from '../src/lib/mcp-tools/event-get.js';
import { registerEventRefsTool } from '../src/lib/mcp-tools/event-refs.js';
import type { Relation } from '../src/lib/scoring.js';

const scope = `mcp-event-get-${Date.now()}`;
const GROUP = '专题记忆/事件详情测试';

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

const server = new McpServer({ name: 'ki-event-get-test', version: '0.0.0' });
registerEventCreateTool(server);
registerEventGetTool(server);
registerEventDocsTool(server);
registerEventRefsTool(server);

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
  process.env.KI_DISABLE_AUTO_CONSUME = '1';
  registerTestScope(scope);
  initScope(scope);
});

after(async () => {
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
  it('已注册，且进只读白名单（只读会话要能看见）', () => {
    assert.ok(tools()['ki_event_get']);
    assert.equal(isReadOnlyTool('ki_event_get'), true);
  });
});

describe('② 结构完整性', () => {
  it('返回描述全文 / 阶段链 / 文档三元组 / 日志，未分析时 draft 为 null', async () => {
    const doc = seedDoc('详情成员');
    const ref = seedDoc('详情引用');
    const created = parse(await call('ki_event_create', {
      scope,
      title: '详情结构',
      type: 'et_1',
      description: '这是一段足够长的描述，用来确认返回体没有被截断',
      docs: [{ group: GROUP, name: doc.text }],
      refs: [{ group: GROUP, name: ref.text }],
    }));
    const event = created.event.id as string;

    const body = parse(await call('ki_event_get', { scope, event }));

    assert.equal(body.ok, true);
    assert.equal(body.scope, scope);
    assert.match(body.event.shortId, /^#\d+$/);
    assert.equal(body.event.description, '这是一段足够长的描述，用来确认返回体没有被截断');
    assert.equal(body.event.closed, false);

    assert.equal(body.type.id, 'et_1');
    assert.equal(body.type.terminalAction, 'keep');
    assert.equal(body.type.stages.filter((s: any) => s.current).length, 1);
    assert.equal(body.stage.visibility, 'hidden');
    assert.match(body.stage.legend, /不可检索/);

    // 文档引用必须带三元组：缺 group 就取不到正文
    assert.equal(body.members.total, 1);
    assert.equal(body.members.items[0].scope, scope);
    assert.equal(body.members.items[0].group, GROUP);
    assert.equal(body.members.items[0].name, doc.text);

    assert.equal(body.refs.total, 1);
    assert.equal(body.refs.items[0].scope, scope);
    assert.equal(body.refs.items[0].group, GROUP);
    assert.equal(body.refs.items[0].stale, false);
    assert.equal(body.refs.items[0].addedBy, 'ai');

    // 创建会写一条 fromKey=null 的阶段日志
    assert.ok(body.logs.total >= 1);
    assert.equal(body.logs.items.at(-1).fromKey, null);

    assert.equal(body.analysis.draft, null);
    assert.equal(body.analysis.candidateTotal, 0);
    assert.equal('candidateNote' in body.analysis, false);
    assert.equal(body.analysis.confirmed.total, 0);
    assert.match(body.hint, /ki_get_module_info/);
  });

  it('事件不存在 → EVENT_NOT_FOUND', async () => {
    const res = await call('ki_event_get', { scope, event: '#999' });
    assert.equal(res.isError, true);
    const body = parse(res);
    assert.equal(body.code, 'EVENT_NOT_FOUND');
    assert.match(body.error, /ki_event_list/);
  });
});

describe('③ 分析结果的裁剪', () => {
  it('只返回结论 / 未确认点 / 已确认位置；过程与候选正文不出现', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '带分析的详情', type: 'et_1' }));
    const event = created.event.id as string;

    writeJson(getAnalysisPath(scope, event), {
      version: 1,
      eventId: event,
      draft: {
        runId: 'run-1',
        status: 'ready',
        targetDir: '/tmp/project',
        commit: 'abc1234',
        conclusion: '这是结论全文，长度超过一百二十字也不会被截断，因为 get 返回的是全文而不是 preview。'.repeat(3),
        unconfirmed: ['未确认点一', '未确认点二'],
        candidates: [
          { id: 'c1', file: 'src/a.ts', line: 10, snippet: 'candidate snippet', why: '候选理由', confidence: 0.8 },
          { id: 'c2', file: 'src/b.ts', line: 20, snippet: 'candidate snippet 2', why: '候选理由二', confidence: 0.7 },
        ],
        steps: [{ title: '第 1 轮', thinking: '很长很长的思考内容'.repeat(20), tools: [], status: 'ok' }],
        liveThinking: '运行中的实时思考',
        stats: { files: 2 },
        startedAt: 1000,
        updatedAt: 2000,
      },
      confirmed: [{
        id: 'l1',
        file: 'src/visibility-index.ts',
        line: 403,
        endLine: 415,
        snippet: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
        why: '这里是判断依据',
        confidence: 0.95,
        targetDir: '/tmp/project',
        commit: 'abc1234',
        confirmedAt: 3000,
      }],
      updatedAt: 3000,
    } as unknown as Record<string, unknown>);

    const body = parse(await call('ki_event_get', { scope, event, location_snippet_limit: 10 }));

    assert.equal(body.analysis.draft.status, 'ready');
    assert.ok(body.analysis.draft.conclusion.length > 120, '结论必须是全文，不是 preview');
    assert.deepEqual(body.analysis.draft.unconfirmed, ['未确认点一', '未确认点二']);
    assert.equal(body.analysis.candidateTotal, 2);
    assert.equal(body.analysis.targetDir, '/tmp/project');
    // 候选 2 个、确认 1 个 → 必须点明"还有 1 个没确认"
    assert.match(body.analysis.candidateNote, /2 个分析候选中 1 个尚未确认/);

    // 过程与候选正文一律不返回
    assert.equal('steps' in body.analysis, false);
    assert.equal('candidates' in body.analysis, false);
    assert.equal('runId' in body.analysis.draft, false);
    assert.equal('liveThinking' in body.analysis.draft, false);

    // 已确认位置：snippet 按 limit 截断，file 与 targetDir 一起才是完整路径
    assert.equal(body.analysis.confirmed.total, 1);
    const loc = body.analysis.confirmed.items[0];
    assert.equal(loc.file, 'src/visibility-index.ts');
    assert.equal(loc.endLine, 415);
    assert.equal(loc.snippet, '0123456789…');
  });

  it('候选数与已确认数相等 → 不出现 candidateNote（避免被读成"还有候选待处理"）', async () => {
    const created = parse(await call('ki_event_create', { scope, title: '候选全确认', type: 'et_1' }));
    const event = created.event.id as string;

    writeJson(getAnalysisPath(scope, event), {
      version: 1,
      eventId: event,
      draft: {
        runId: 'run-2',
        status: 'ready',
        targetDir: '/tmp/p',
        commit: 'c0ffee1',
        conclusion: '全部候选都已确认',
        unconfirmed: [],
        candidates: [{ id: 'c1', file: 'a.ts', line: 1, snippet: 's', why: 'w', confidence: 0.9 }],
        steps: [],
        stats: {},
        startedAt: 1,
        updatedAt: 2,
      },
      confirmed: [{
        id: 'l1', file: 'a.ts', line: 1, why: 'w', confidence: 0.9,
        targetDir: '/tmp/p', commit: 'c0ffee1', confirmedAt: 3, snippet: 's',
      }],
      updatedAt: 3,
    } as unknown as Record<string, unknown>);

    const body = parse(await call('ki_event_get', { scope, event }));
    assert.equal(body.analysis.candidateTotal, 1);
    assert.equal(body.analysis.confirmed.total, 1);
    assert.equal('candidateNote' in body.analysis, false);
  });
});

describe('④ 裁剪参数', () => {
  it('limit=0 → 该块不返回 items 但给 total 与 note', async () => {
    const doc = seedDoc('裁剪成员');
    const created = parse(await call('ki_event_create', {
      scope,
      title: '裁剪测试',
      type: 'et_1',
      docs: [{ group: GROUP, name: doc.text }],
    }));
    const event = created.event.id as string;

    const body = parse(await call('ki_event_get', {
      scope, event, members_limit: 0, logs_limit: 0, refs_limit: 0, locations_limit: 0,
    }));

    assert.equal(body.members.total, 1);
    assert.deepEqual(body.members.items, []);
    assert.match(body.members.note, /members_limit=0/);

    assert.deepEqual(body.logs.items, []);
    assert.ok(body.logs.total >= 1);
    assert.match(body.logs.note, /logs_limit=0/);

    assert.equal(body.refs.total, 0);
    assert.equal(body.analysis.confirmed.total, 0);
  });
});
