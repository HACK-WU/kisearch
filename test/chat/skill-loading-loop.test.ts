/**
 * skill 按需加载 · 端到端（mock 上游捕获真实请求体）
 *
 * ═══ 本文件存在的理由 ═══
 * 本轮把注入模型从「每轮全量注入所有 skill 正文」改为「恒定注入目录 + AI 按需 use_skill 加载」。
 * 三条最容易做错的接线，必须由**真实请求体**证明（不是读代码判断）：
 *   ① **未加载时正文不得出现**在上游 messages（否则"按需"名存实亡，等于没改）；
 *   ② 加载后正文必须**真的**进上下文（loading 有事件但不能只是"显示了"）；
 *   ③ 会话级已加载的 skill 在**后续轮次**仍生效（无状态上游不重放 = 模型会忘）。
 * 另覆盖：会话快照优先级（提示词只注入一次）、未知/重复 id、禁用即不暴露 use_skill、
 *        注入状态落盘的幂等与"不碰 seq"。
 *
 * 求解方式沿用既有做法：本地 mock 上游**捕获真实请求体**。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  USE_SKILL_TOOL_NAME,
  renderSkillLoadedBlock,
  resolveUseSkill,
  runToolLoop,
} from '../../src/lib/chat/retrieval/tool-loop.js';
import { RETRIEVAL_SKILL_PROMPT, HARD_RULES_BLOCK } from '../../src/lib/chat/retrieval/retrieval-skill.js';
import { defaultPromptConfig, promptConfigPath, savePromptConfig } from '../../src/lib/chat/prompt-config.js';
import { resetConfigCache } from '../../src/lib/config.js';
import type { ChatEvent, ConversationFile, PromptInjectionSnapshot } from '../../src/lib/chat/chat-contract.js';

// ─── 端到端（mock 上游捕获真实请求体）──────────────────────────

interface Captured {
  messages: { role: string; content: string }[];
  tools?: { function?: { name?: string } }[];
}

let captured: Captured[] = [];
let server: ReturnType<typeof createServer>;
let tmpRoot = '';
let cfgPath = '';
/** 每轮 mock 的第一条响应：由用例设置（默认直接作答） */
let firstResponse: 'answer' | 'use_skill' | 'use_unknown';

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try {
        const j = JSON.parse(body) as Captured;
        captured.push({ messages: j.messages ?? [], tools: j.tools });
      } catch { /* 忽略非 JSON */ }
      const round = captured.length; // 本轮第几次请求
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const toolCall = (name: string, args: unknown): string => `data: ${JSON.stringify({
        choices: [{
          delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
          finish_reason: 'tool_calls',
        }],
      })}\n\n`;
      if (round === 1 && firstResponse === 'use_skill') {
        res.write(toolCall(USE_SKILL_TOOL_NAME, { skill_id: 'builtin-retrieval' }));
      } else if (round === 1 && firstResponse === 'use_unknown') {
        res.write(toolCall(USE_SKILL_TOOL_NAME, { skill_id: 'does-not-exist' }));
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '收到' } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;

  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-skill-loop-'));
  cfgPath = path.join(tmpRoot, 'config.yaml');
  fs.writeFileSync(cfgPath, [
    `dataDir: ${path.join(tmpRoot, 'kb')}`,
    `vectorDir: ${path.join(tmpRoot, 'vector')}`,
    `chatDir: ${path.join(tmpRoot, 'chat')}`,
    'scopeMode: default',
    'scopes:',
    '  default: {}',
    'llm:',
    `  baseURL: http://127.0.0.1:${port}/v1`,
    '  model: mock-model',
    '  apiKey: mock-key',
    '  kbDisclosureAck: true',
  ].join('\n'), 'utf8');
  process.env.KI_CONFIG_PATH = cfgPath;
  resetConfigCache();
});

after(() => {
  // keep-alive 连接会让 close() 一直等下去（表现是"测试跑完但进程不退出"）→ 主动断连
  server?.closeAllConnections?.();
  server?.close();
  if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.KI_CONFIG_PATH;
});

function convOf(messages: { id: string; role: 'user' | 'assistant'; content: string }[], extra: Partial<ConversationFile> = {}): ConversationFile {
  return {
    version: 1, id: 'c-skill', scope: 'default', title: 't', systemPrompt: '',
    archived: false, archivedAt: null,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    seq: 0, messageCount: messages.length, lastMessagePreview: '',
    messages: messages.map((m) => ({ ...m, at: '2026-01-01T00:00:00Z' })),
    ...extra,
  };
}

async function runTurn(conv: ConversationFile, userText: string): Promise<ChatEvent[]> {
  captured = [];
  const events: ChatEvent[] = [];
  for await (const ev of runToolLoop({
    scope: 'default', conv, userText, convSystemPrompt: conv.systemPrompt,
    signal: new AbortController().signal,
  })) events.push(ev);
  return events;
}

const allContent = (cap: Captured) => cap.messages.map((m) => m.content).join('\n');
const toolNames = (cap: Captured) => (cap.tools ?? []).map((t) => t.function?.name ?? '');

describe('端到端：skill 正文按需进出上下文', () => {
  it('★ 未加载时正文不在上游；模型调用后（下一轮请求）正文真的进了上下文', async () => {
    firstResponse = 'use_skill';
    const events = await runTurn(convOf([{ id: 'm1', role: 'user', content: 'Q1' }]), 'Q1');
    firstResponse = 'answer';

    assert.equal(captured.length, 2, `应发生两次上游请求（工具轮 + 收尾轮），实际 ${captured.length}`);
    assert.ok(
      !allContent(captured[0]!).includes('## 指令'),
      '首轮请求不得含 skill 正文 —— 这正是"按需"要证明的事',
    );
    assert.ok(toolNames(captured[0]!).includes(USE_SKILL_TOOL_NAME), '有可调用 skill 时必须暴露 use_skill');

    const skillEvent = events.find((e) => e.type === 'skill');
    assert.ok(skillEvent && skillEvent.type === 'skill', '必须发出 skill 事件（可见性通道）');
    assert.equal(skillEvent.id, 'builtin-retrieval');
    assert.equal(skillEvent.chars, RETRIEVAL_SKILL_PROMPT.length);
    assert.equal(skillEvent.error, undefined);

    const toolMsg = captured[1]!.messages.find((m) => m.role === 'tool');
    assert.ok(toolMsg, '第二轮请求必须带 tool 返回（模型就是从这条消息看到正文的）');
    assert.ok(toolMsg!.content.includes('## 指令'), '加载后的正文必须真的进入上下文');
    assert.equal(toolMsg!.content, renderSkillLoadedBlock({ id: 'builtin-retrieval', name: '知识库检索', content: RETRIEVAL_SKILL_PROMPT }));
  });

  it('★ 未知 id → 事件带 error，模型看到可用清单并可改道（不中断生成）', async () => {
    firstResponse = 'use_unknown';
    const events = await runTurn(convOf([{ id: 'm1', role: 'user', content: 'Q1' }]), 'Q1');
    firstResponse = 'answer';

    const skillEvent = events.find((e) => e.type === 'skill');
    assert.ok(skillEvent && skillEvent.type === 'skill' && skillEvent.error, '失败也必须发事件（不得静默）');
    assert.ok(skillEvent.error!.includes('未知或不可用'));
    assert.ok(!allContent(captured[1]!).includes('## 指令'), '失败的调用不得注入任何正文');
    assert.equal(events.at(-1)?.type, 'done', '失败不中断生成');
  });

  it('★ 会话已加载过 → 每轮以 system 块重放（模型不会"忘"，也不重复注入）', async () => {
    firstResponse = 'answer';
    const conv = convOf([{ id: 'm1', role: 'user', content: 'Q1' }], { loadedSkillIds: ['builtin-retrieval'] });
    await runTurn(conv, 'Q1');

    const first = captured[0]!;
    const sysSkill = first.messages.find((m) => m.role === 'system' && m.content.includes('【skill：知识库检索'));
    assert.ok(sysSkill, '已加载的 skill 必须以 system 块重放（无状态上游不会自动重现）');
    assert.ok(sysSkill!.content.includes('## 指令'));
  });

  it('★ 会话快照优先：有 injected 时不再读配置（提示词只注入一次）', async () => {
    firstResponse = 'answer';
    // 磁盘配置改成另一份提示词；会话里带着旧快照 → 必须用快照
    savePromptConfig({ dataDir: '', chatDir: path.join(tmpRoot, 'chat') } as never, { prompt: { content: '磁盘上的新提示词' } });
    const conv = convOf([{ id: 'm1', role: 'user', content: 'Q1' }], {
      injected: { version: 1, at: 'T1', blocks: ['【可用 skill】\n- A（a）：旧快照里的目录', '旧快照里的基础提示词', HARD_RULES_BLOCK], skillIds: ['builtin-retrieval'] },
    });
    await runTurn(conv, 'Q1');

    const contents = allContent(captured[0]!);
    assert.ok(contents.includes('旧快照里的基础提示词'), '应使用会话快照');
    assert.ok(!contents.includes('磁盘上的新提示词'), '有快照就不得再读配置（否则"只注入一次"失效）');
    assert.ok(contents.includes(HARD_RULES_BLOCK), '硬性规则在快照里，必须仍在');
    assert.ok(!contents.includes('## 指令'), '快照不含正文，且本轮未调用 use_skill');
    // 清理：避免影响后续用例
    fs.rmSync(promptConfigPath({ dataDir: '', chatDir: path.join(tmpRoot, 'chat') } as never), { force: true });
    resetConfigCache();
  });

  it('★ 已加载的 skill 被停用 ⇒ 正文从上下文移除（停用即失效，不留"看不见的规则"）', async () => {
    firstResponse = 'answer';
    const cfg = defaultPromptConfig();
    cfg.skills[0]!.enabled = false;
    savePromptConfig({ dataDir: '', chatDir: path.join(tmpRoot, 'chat') } as never, cfg);
    resetConfigCache();
    try {
      const conv = convOf([{ id: 'm1', role: 'user', content: 'Q1' }], { loadedSkillIds: ['builtin-retrieval'] });
      await runTurn(conv, 'Q1');
      assert.ok(
        !allContent(captured[0]!).includes('【skill：知识库检索'),
        '停用后不得再重放正文（否则"目录里没有、调不到，但正文还在生效"）',
      );
    } finally {
      fs.rmSync(promptConfigPath({ dataDir: '', chatDir: path.join(tmpRoot, 'chat') } as never), { force: true });
      resetConfigCache();
    }
  });

  it('★ 全部停用 → 不暴露 use_skill，目录也不注入（停用即调不到）', async () => {
    firstResponse = 'answer';
    const cfg = defaultPromptConfig();
    cfg.skills[0]!.enabled = false;
    savePromptConfig({ dataDir: '', chatDir: path.join(tmpRoot, 'chat') } as never, cfg);
    resetConfigCache();
    try {
      await runTurn(convOf([{ id: 'm1', role: 'user', content: 'Q1' }]), 'Q1');
      const first = captured[0]!;
      assert.ok(!toolNames(first).includes(USE_SKILL_TOOL_NAME), '无可用 skill 时不应暴露 use_skill（减少无谓调用面）');
      assert.ok(!allContent(first).includes('【可用 skill】'), '停用的 skill 不进目录');
      assert.ok(allContent(first).includes('【硬性规则｜始终生效】'), '硬性规则与 skill 开关无关，必须恒在');
    } finally {
      fs.rmSync(promptConfigPath({ dataDir: '', chatDir: path.join(tmpRoot, 'chat') } as never), { force: true });
      resetConfigCache();
    }
  });
});
