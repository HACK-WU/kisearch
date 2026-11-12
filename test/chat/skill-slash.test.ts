/**
 * `/` 斜杠点名 skill（2026-11-12）
 *
 * ═══ 本文件存在的理由 ═══
 * 这个特性的**全部风险**都在"注入到哪、注入几次、会不会残留"上 —— 光看代码判断不了，
 * 只有真实的请求体 + 事件流能证明：
 *   ① 点了名 ⇒ 该 skill 正文**真的**进了本轮 system 组（不是只弹了个面板）；
 *   ② 下一轮**没有**点名 ⇒ 正文不再出现（`/` 是单轮语义，绝不能变成会话级常驻）；
 *   ③ 会话级已加载过 ⇒ 不重复注入（同一份规则出现两遍会费 token 且让模型误判来源）；
 *   ④ `conv.loadedSkillIds` **一个字节都不许动**（护栏 #1：那里写着就永久生效、无移除 API）；
 *   ⑤ 形状校验 fail-loud（超上限 / 非字符串 → 400，不静默截断）。
 *
 * 运行：`env -u NODE_OPTIONS -u BASH_ENV npx jiti test/chat/skill-slash.test.ts`
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSkillIds } from '../../src/lib/chat/chat-routes.js';
import { runToolLoop } from '../../src/lib/chat/retrieval/tool-loop.js';
import {
  appendMessage,
  createConversation,
  readConversation,
  truncateAfterAndEdit,
} from '../../src/lib/chat/chat-store.js';
import { defaultPromptConfig } from '../../src/lib/chat/prompt-config.js';
import { resetConfigCache } from '../../src/lib/config.js';
import { CHAT_SKILLS_MAX, type ChatEvent, type ConversationFile } from '../../src/lib/chat/chat-contract.js';

/** 上层捕获的真实请求体（每轮一条） */
interface CapturedBody {
  messages: Array<{ role: string; content: string }>;
}
const captured: CapturedBody[] = [];

const sysText = (body: CapturedBody | undefined): string =>
  (body?.messages ?? []).filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');

const baseConv = (): ConversationFile => ({
  version: 1,
  id: 'c-slash',
  scope: 'default',
  title: 't',
  systemPrompt: '',
  archived: false,
  archivedAt: null,
  createdAt: '2026-11-12T00:00:00.000Z',
  updatedAt: '2026-11-12T00:00:00.000Z',
  seq: 1,
  messageCount: 1,
  lastMessagePreview: 'hi',
  messages: [{ id: 'm1', role: 'user', content: 'hi', at: '2026-11-12T00:00:00.000Z' }],
});

describe('parseSkillIds（形状校验：缺省不报错，非法 fail-loud）', () => {
  it('缺省 / null / 空数组 → undefined（与 refs 同口径，不写字段也不报错）', () => {
    assert.equal(parseSkillIds({}), undefined);
    assert.equal(parseSkillIds({ skills: null }), undefined);
    assert.equal(parseSkillIds({ skills: [] }), undefined);
  });

  it('非数组 / 元素非字符串 / 空白 → 400 MESSAGE_INVALID', () => {
    assert.throws(() => parseSkillIds({ skills: 'a' }), /skills 必须是字符串数组/);
    assert.throws(() => parseSkillIds({ skills: [1] }), /每项必须是非空字符串/);
    assert.throws(() => parseSkillIds({ skills: ['  '] }), /每项必须是非空字符串/);
  });

  it('超过上限 → 400（不静默截断）', () => {
    const many = Array.from({ length: CHAT_SKILLS_MAX + 1 }, (_, i) => `s${i}`);
    assert.throws(() => parseSkillIds({ skills: many }), /最多点名/);
    assert.equal(parseSkillIds({ skills: many.slice(0, CHAT_SKILLS_MAX) })?.length, CHAT_SKILLS_MAX);
  });

  it('去重保序（同一点两次没有额外语义）', () => {
    assert.deepEqual(parseSkillIds({ skills: ['b', 'a', 'b'] }), ['b', 'a']);
  });

  it('两侧空白被裁掉', () => {
    assert.deepEqual(parseSkillIds({ skills: [' a '] }), ['a']);
  });
});

describe('runToolLoop · forcedSkillIds（本轮注入，不污染会话）', () => {
  let root = '';
  let release: () => Promise<void> = async () => {};
  /** 默认配置里那条内置 skill 的 id / 名称（名称在 2026-11-11 被强制改成英文，故不写死） */
  let skillId = '';
  let skillName = '';

  before(async () => {
    const cfg = defaultPromptConfig();
    const builtin = cfg.skills.find((s) => s.enabled);
    assert.ok(builtin, '默认配置必须有启用中的 skill，否则本文件的断言无意义');
    skillId = builtin.id;
    skillName = builtin.name;

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-skill-slash-'));
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      captured.push(JSON.parse(raw) as CapturedBody);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // 确定性回答：不调工具（本用例只关心 system 组里的注入）
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '确定性本地回答' }, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, [
      `dataDir: ${path.join(root, 'data')}`,
      `chatDir: ${path.join(root, 'chat')}`,
      `vectorDir: ${path.join(root, 'vectors')}`,
      'embedding:',
      '  provider: mock',
      '  baseURL: http://127.0.0.1:1/v1',
      '  model: mock',
      '  apiKey: mock-key',
      'llm:',
      `  baseURL: http://127.0.0.1:${port}/v1`,
      '  apiKey: mock-key',
      '  model: mock-model',
      '  kbDisclosureAck: true',
    ].join('\n'));
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();
    release = async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    };
  });

  after(async () => {
    await release();
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const collect = async (input: Parameters<typeof runToolLoop>[0]): Promise<ChatEvent[]> => {
    const out: ChatEvent[] = [];
    for await (const ev of runToolLoop(input)) out.push(ev);
    return out;
  };

  it('点名 ⇒ 正文进本轮 system 组，并发出 skill 事件', async () => {
    captured.length = 0;
    const conv = baseConv();
    const events = await collect({
      scope: 'default',
      conv,
      userText: `/${skillName} 帮我处理一下`,
      convSystemPrompt: '',
      forcedSkillIds: [skillId],
    });

    const sys = sysText(captured.at(-1));
    assert.ok(sys.includes('【本轮点名 skill】'), '缺少说明行：模型会以为"目录里有但没加载"');
    assert.ok(sys.includes(`【skill：${skillName}（${skillId}）】`), '正文未注入 —— 点名等于没生效');

    const ev = events.find((e) => e.type === 'skill');
    assert.ok(ev && ev.type === 'skill', '必须发 skill 事件（时间线要能看见"已按点名加载"）');
    assert.equal(ev!.id, skillId);
    assert.equal(ev!.alreadyLoaded, undefined);

    // 护栏 #1：会话级清单一个字节都不许动
    assert.equal(conv.loadedSkillIds, undefined, 'forced 绝不能写进 loadedSkillIds（会永久占用后续轮次）');
  });

  it('下一轮不点名 ⇒ 正文不再出现（单轮语义）', async () => {
    captured.length = 0;
    const conv = baseConv();
    // 第一轮点名
    await collect({ scope: 'default', conv, userText: '第一轮', convSystemPrompt: '', forcedSkillIds: [skillId] });
    assert.ok(sysText(captured.at(-1)).includes('【本轮点名 skill】'));

    // 第二轮（同一个 conv，不传 forced）
    const events = await collect({ scope: 'default', conv, userText: '第二轮', convSystemPrompt: '' });
    const sys = sysText(captured.at(-1));
    assert.ok(!sys.includes('【本轮点名 skill】'), '第二轮不该还带点名说明');
    assert.ok(!sys.includes(`【skill：${skillName}（${skillId}）】`), '第二轮不该还注入正文');
    assert.equal(events.find((e) => e.type === 'skill'), undefined, '第二轮不该再发 skill 事件');
  });

  it('会话级已加载过 ⇒ 不重复注入（正文只出现一次，且不再发事件）', async () => {
    captured.length = 0;
    const conv: ConversationFile = { ...baseConv(), loadedSkillIds: [skillId] };
    const events = await collect({
      scope: 'default',
      conv,
      userText: '又来一次',
      convSystemPrompt: '',
      forcedSkillIds: [skillId],
    });
    const sys = sysText(captured.at(-1));
    const hits = sys.split(`【skill：${skillName}（${skillId}）】`).length - 1;
    assert.equal(hits, 1, `同一份正文出现 ${hits} 次（应为 1 次，重复注入既费 token 又让模型误判来源）`);
    assert.ok(!sys.includes('【本轮点名 skill】'), '已加载条目本次没注入正文，不该出现在点名说明里');
    assert.equal(events.find((e) => e.type === 'skill'), undefined, '没有新注入就不该报"加载"');
  });

  it('未知 / 已停用 id ⇒ 静默跳过（路由层已 400，这里是配置被改后的窄窗口兜底）', async () => {
    captured.length = 0;
    const conv = baseConv();
    const events = await collect({
      scope: 'default',
      conv,
      userText: 'x',
      convSystemPrompt: '',
      forcedSkillIds: ['no-such-skill'],
    });
    const sys = sysText(captured.at(-1));
    assert.ok(!sys.includes('【本轮点名 skill】'));
    assert.equal(events.find((e) => e.type === 'skill'), undefined);
  });
});

describe('落盘：skills 随 user 消息走（append / 编辑覆盖 / 保留 / 清空）', () => {
  let root = '';
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-skill-slash-store-'));
    const configPath = path.join(root, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${path.join(root, 'data')}\nchatDir: ${path.join(root, 'chat')}\n`);
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();
  });
  after(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const lastUser = (conv: ConversationFile) => conv.messages.at(-1)!;

  it('append 带 skills → 落盘可读回（刷新 / 切会话后仍能看出这轮点了名）', async () => {
    const conv = await createConversation('default', {});
    await appendMessage('default', conv.id, {
      id: '', role: 'user', content: '/knowledge-retrieval hi', at: new Date().toISOString(), skills: ['builtin-retrieval'],
    });
    const after = await readConversation('default', conv.id);
    assert.deepEqual(lastUser(after!).skills, ['builtin-retrieval']);
  });

  it('编辑传 undefined ⇒ 保留原点名（旧客户端兼容路径）', async () => {
    const conv = await createConversation('default', {});
    const appended = await appendMessage('default', conv.id, {
      id: '', role: 'user', content: '/knowledge-retrieval hi', at: new Date().toISOString(), skills: ['builtin-retrieval'],
    });
    const msgId = lastUser(appended).id;
    const r = await truncateAfterAndEdit('default', conv.id, msgId, '改过的问题');
    assert.deepEqual(lastUser(r.conv).skills, ['builtin-retrieval'], '不传 skills 时不得丢原值');
  });

  it('编辑传 [] ⇒ **真清掉**字段（用户把 `/名称` 删掉了，不能"看不见却仍生效"）', async () => {
    const conv = await createConversation('default', {});
    const appended = await appendMessage('default', conv.id, {
      id: '', role: 'user', content: '/knowledge-retrieval hi', at: new Date().toISOString(), skills: ['builtin-retrieval'],
    });
    const msgId = lastUser(appended).id;
    const r = await truncateAfterAndEdit('default', conv.id, msgId, '改过的问题', []);
    assert.equal(lastUser(r.conv).skills, undefined);
    const reread = await readConversation('default', conv.id);
    assert.equal(lastUser(reread!).skills, undefined, '落盘后也不得残留');
  });

  it('编辑传新数组 ⇒ 覆盖（换成另一个 skill）', async () => {
    const conv = await createConversation('default', {});
    const appended = await appendMessage('default', conv.id, {
      id: '', role: 'user', content: '/knowledge-retrieval hi', at: new Date().toISOString(), skills: ['builtin-retrieval'],
    });
    const msgId = lastUser(appended).id;
    const r = await truncateAfterAndEdit('default', conv.id, msgId, '/doc-editing hi', ['builtin-doc-editing']);
    assert.deepEqual(lastUser(r.conv).skills, ['builtin-doc-editing']);
  });
});
