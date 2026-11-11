/**
 * 工具注册表单测（批次 2）
 *
 * 守护四条结构性约束：
 * 1. 注册表与配置层白名单（`MCP_TOOL_GROUPS`）的**工具名集合一致**（漂移 = 开关配了不存在的工具）
 * 2. 任何 ToolDef 的 parameters **不暴露 scope**（N23 / §5.1 schema 剥离）
 * 3. 参数解析白名单取键 + 钳制 + 必填校验
 * 4. 开关过滤语义（默认只读 6 个；写/删显式开启才进暴露面）
 *
 * 运行：`npx jiti test/chat/mcp-tool-registry.test.ts`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CHAT_MCP_TOOLS,
  enabledChatToolEntries,
  getChatTool,
  parseToolArgs,
} from '../../src/lib/chat/mcp-tool-registry.js';
import { MCP_TOOL_NAMES, defaultPromptConfig } from '../../src/lib/chat/prompt-config.js';

const registryNames = CHAT_MCP_TOOLS.map((t) => t.name).sort();
const whitelistNames = [...MCP_TOOL_NAMES].sort();

describe('工具注册表 · 与配置层白名单对齐', () => {
  it('注册表工具名集合 === MCP_TOOL_NAMES（13 个，三组口径）', () => {
    assert.equal(registryNames.length, 13);
    assert.deepEqual(registryNames, whitelistNames);
  });

  it('每个工具都能被 getChatTool 按名查到', () => {
    for (const name of registryNames) assert.ok(getChatTool(name), `getChatTool(${name}) 应命中`);
    assert.equal(getChatTool('kb_search'), undefined, '退役的 kb_search 不得再命中');
    assert.equal(getChatTool('not_a_tool'), undefined);
  });
});

describe('工具注册表 · scope 结构性剥离（N23）', () => {
  it('所有 ToolDef 的 parameters 均不含 scope 键', () => {
    for (const entry of CHAT_MCP_TOOLS) {
      const params = entry.def.function.parameters as { properties?: Record<string, unknown> };
      const props = Object.keys(params.properties ?? {});
      assert.ok(!props.includes('scope'), `${entry.name} 不得暴露 scope`);
      assert.equal(entry.def.type, 'function');
      assert.ok(entry.def.function.description.length > 0, `${entry.name} 需有描述`);
      assert.equal(entry.def.function.name, entry.name);
    }
  });

  it('ki_search 的暴露面为 query/mode/limit（阈值/标签等不暴露）', () => {
    const ki = getChatTool('ki_search')!;
    const props = Object.keys((ki.def.function.parameters as { properties: Record<string, unknown> }).properties);
    assert.deepEqual(props.sort(), ['limit', 'mode', 'query']);
  });
});

describe('工具注册表 · 参数解析', () => {
  const ki = getChatTool('ki_search')!;

  it('越界参数（模型幻觉的 scope/threshold）被静默丢弃，必填缺失抛错', () => {
    const parsed = ki.parse('{"query":"acks","scope":"other-project","threshold":0.9}');
    // ★ REQ-20261015-001：limit 未传时**不写入**（改由 tool-loop 在执行必经点补运行时配置的默认值）
    assert.deepEqual(Object.keys(parsed).sort(), ['mode', 'query']);
    assert.equal((parsed as Record<string, unknown>).query, 'acks');
    assert.throws(() => ki.parse('{}'), /query/);
    assert.throws(() => ki.parse('not json'), /JSON/);
  });

  it('非法枚举回落默认、limit 越界钳制到 [1,50]（硬上界），区间内显式值原样保留', () => {
    const parsed = ki.parse('{"query":"x","mode":"semantic","limit":99}') as Record<string, unknown>;
    assert.equal(parsed.mode, 'hybrid');
    assert.equal(parsed.limit, 50); // REQ-20261015-001：上限由 5 放开到硬上界 50
    const parsed2 = ki.parse('{"query":"x","limit":0}') as Record<string, unknown>;
    assert.equal(parsed2.limit, 1);
    // AI 自主控制条数的前提：区间内的显式值必须原样保留
    const parsed3 = ki.parse('{"query":"x","limit":10}') as Record<string, unknown>;
    assert.equal(parsed3.limit, 10);
  });

  it('ki_bulk_sync_relation：items 超上限（>50）抛错、条目缺必填键抛错', () => {
    const bulk = getChatTool('ki_bulk_sync_relation')!;
    const items = Array.from({ length: 51 }, () => ({ group: 'g', relation: 'r', module_info: 'm' }));
    assert.throws(() => bulk.parse(JSON.stringify({ items })), /最多 50 条/);
    assert.throws(() => bulk.parse('{"items":[{"group":"g"}]}'), /条目缺少/);
    const ok = bulk.parse('{"items":[{"group":"g","relation":"r","module_info":"m","extra":1}]}') as { items: unknown[] };
    assert.equal(ok.items.length, 1);
  });

  it('ki_edit_relation：edits 条目按行区间三键保留', () => {
    const edit = getChatTool('ki_edit_relation')!;
    const parsed = edit.parse('{"action":"edit","edits":[{"start_line":1,"end_line":3,"new_text":"x","junk":true}]}') as {
      action: string; edits: Array<Record<string, unknown>>;
    };
    assert.equal(parsed.action, 'edit');
    assert.deepEqual(Object.keys(parsed.edits[0]).sort(), ['end_line', 'new_text', 'start_line']);
    assert.throws(() => edit.parse('{"edits":[]}'), /action/);
  });

  it('必填枚举无默认（ki_edit_relation.action）非法值 → 抛错而非静默丢键', () => {
    const edit = getChatTool('ki_edit_relation')!;
    // ★ challenger 质疑修复：非法 action 原会被静默丢弃 → undefined 直达 executeEditRelation
    assert.throws(() => edit.parse('{"action":"bogus"}'), /应为以下值之一/);
    const ok = edit.parse('{"action":"view"}') as { action: string };
    assert.equal(ok.action, 'view');
  });

  it('parseToolArgs：空串与非对象直接拒绝', () => {
    assert.throws(() => parseToolArgs('', 't', []), /为空/);
    assert.throws(() => parseToolArgs('[1,2]', 't', []), /JSON 对象/);
  });
});

describe('工具注册表 · 开关过滤（PromptConfig.tools 首次消费）', () => {
  it('默认配置（只读全开、写/删全关）→ 恰好 5 个只读入口', () => {
    const enabled = enabledChatToolEntries(defaultPromptConfig().tools);
    assert.deepEqual(enabled.map((e) => e.name).sort(), [
      'ki_get_module_info', 'ki_group_list', 'ki_scope_list', 'ki_search', 'ki_tag_list',
    ]);
    assert.ok(enabled.every((e) => e.readOnly));
  });

  it('显式开启写工具 → 进入暴露面；关闭只读 → 移出', () => {
    const tools = { ...defaultPromptConfig().tools, ki_store: true, ki_search: false };
    const enabled = enabledChatToolEntries(tools).map((e) => e.name);
    assert.ok(enabled.includes('ki_store'));
    assert.ok(!enabled.includes('ki_search'));
  });

  it('全关 → 空暴露面（tool-loop 将不带 tools，纯聊天）', () => {
    const tools = Object.fromEntries(MCP_TOOL_NAMES.map((n) => [n, false]));
    assert.equal(enabledChatToolEntries(tools).length, 0);
  });
});

describe('工具注册表 · 展示摘要与 sources 标记', () => {
  it('producesSources 仅 ki_search（R7 来源引用不退化）', () => {
    const producing = CHAT_MCP_TOOLS.filter((t) => t.producesSources === true).map((t) => t.name);
    assert.deepEqual(producing, ['ki_search']);
  });

  it('ki_search 摘要给 query/mode；ki_sync_relation 摘要不含 module_info 正文', () => {
    const ki = getChatTool('ki_search')!;
    const desc = ki.describe(ki.parse('{"query":"q","mode":"fulltext"}'));
    assert.equal(desc.query, 'q');
    assert.equal(desc.mode, 'fulltext');

    const sync = getChatTool('ki_sync_relation')!;
    const syncDesc = sync.describe(sync.parse('{"group":"g","relation":"r","module_info":"很长很长的正文…"}'));
    assert.ok(!JSON.stringify(syncDesc).includes('很长很长的正文'), 'module_info 不得进摘要');
    // 2026-11-11：args 由 `k=v` 拼接串改为**结构化对象**（前端统一按 JSON 渲染，不再横排）
    assert.equal(typeof syncDesc.args, 'object');
    assert.equal(syncDesc.args?.group, 'g');
    assert.equal(syncDesc.args?.relation, 'r');
    assert.ok(!Object.prototype.hasOwnProperty.call(syncDesc.args, 'module_info'), 'module_info 键必须整体缺席');
  });

  it('ki_bulk_sync_relation 摘要给条数而非内容', () => {
    const bulk = getChatTool('ki_bulk_sync_relation')!;
    const desc = bulk.describe(bulk.parse('{"items":[{"group":"g","relation":"r","module_info":"m"}]}'));
    assert.equal(desc.args?.items, 1);
    assert.equal(typeof desc.args?.items, 'number', '条数保留 number 类型（前端按 JSON 类型渲染）');
    assert.ok(!JSON.stringify(desc).includes('"module_info"'), '批量条目正文不得进摘要');
  });

  it('defaultDescribe 产结构化对象：字符串值截断 ≤60 字符，number/boolean 保留原类型', () => {
    const info = getChatTool('ki_get_module_info')!;
    const longGroup = 'g'.repeat(100);
    const desc = info.describe(info.parse(JSON.stringify({ group: longGroup, relation: 'r' })));
    assert.equal(typeof desc.args, 'object');
    assert.ok((desc.args?.group as string).length <= 61, `长值必须截断（实际 ${(desc.args?.group as string).length}）`);
    assert.ok((desc.args?.group as string).endsWith('…'), '截断后带省略号');
    // 同一份摘要喂给前端 JSON 渲染器必须可序列化且不含 undefined
    assert.equal(JSON.stringify(desc.args).includes('undefined'), false);
  });

  it('空摘要不产出 args 键（前端据此整块不渲染入参区）', () => {
    const list = getChatTool('ki_scope_list')!;
    const desc = list.describe({});
    assert.equal(Object.prototype.hasOwnProperty.call(desc, 'args'), false);
  });
});
