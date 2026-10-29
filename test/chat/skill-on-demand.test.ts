/**
 * skill 按需加载单测（2026-10-13）
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
import {
  ConversationNotFoundError,
  applyInjectionState,
  createConversation,
  readConversation,
} from '../../src/lib/chat/chat-store.js';
import { RETRIEVAL_SKILL_PROMPT, HARD_RULES_BLOCK } from '../../src/lib/chat/retrieval/retrieval-skill.js';
import { defaultPromptConfig, promptConfigPath, savePromptConfig } from '../../src/lib/chat/prompt-config.js';
import { resetConfigCache } from '../../src/lib/config.js';
import type { ChatEvent, ConversationFile, PromptInjectionSnapshot } from '../../src/lib/chat/chat-contract.js';

// ─── 纯函数：resolveUseSkill ─────────────────────────────────

const SKILL = {
  id: 'builtin-retrieval',
  name: '知识库检索',
  description: '用知识库片段回答事实问题。触发："查知识库"。',
  content: RETRIEVAL_SKILL_PROMPT,
};

describe('resolveUseSkill（纯逻辑：四类结果都不中断生成）', () => {
  it('正常加载：事件带正文字符数，工具返回即正文块（与每轮重放同源）', () => {
    const out = resolveUseSkill(
      JSON.stringify({ skill_id: 'builtin-retrieval' }),
      { callableIds: [SKILL.id], skills: [SKILL], alreadyLoaded: [] },
    );
    assert.equal(out.event.error, undefined);
    assert.equal(out.event.alreadyLoaded, undefined);
    assert.equal(out.event.chars, RETRIEVAL_SKILL_PROMPT.length);
    assert.equal(out.event.name, '知识库检索');
    assert.equal(out.toolContent, renderSkillLoadedBlock(SKILL), '两处必须逐字节一致（换一处就会行为漂移）');
    assert.ok(out.toolContent.includes('## 指令'));
  });

  it('重复加载：返回 alreadyLoaded 且不重复注入正文', () => {
    const out = resolveUseSkill(
      JSON.stringify({ skill_id: 'builtin-retrieval' }),
      { callableIds: [SKILL.id], skills: [SKILL], alreadyLoaded: [SKILL.id] },
    );
    assert.equal(out.event.alreadyLoaded, true);
    assert.equal(out.event.chars, 0);
    assert.ok(!out.toolContent.includes('## 指令'), '重复加载不得再把正文塞进上下文');
    assert.ok(out.toolContent.includes('已在本会话加载过'));
  });

  it('未知 / 已禁用 id → 可见错误 + 可用清单（不抛错）', () => {
    const out = resolveUseSkill(
      JSON.stringify({ skill_id: 'nope' }),
      { callableIds: [SKILL.id], skills: [SKILL], alreadyLoaded: [] },
    );
    assert.ok(out.event.error?.includes('未知或不可用'));
    assert.ok(out.event.error?.includes(SKILL.id), '错误里要给出本会话可用清单，模型才能改道');
    assert.equal(out.event.chars, 0);
  });

  it('skill_id 缺失 / 参数非法 JSON → 各自给出人话错误', () => {
    const noId = resolveUseSkill('{}', { callableIds: [SKILL.id], skills: [SKILL], alreadyLoaded: [] });
    assert.ok(noId.event.error?.includes('skill_id 不能为空'));
    const bad = resolveUseSkill('{不是JSON', { callableIds: [SKILL.id], skills: [SKILL], alreadyLoaded: [] });
    assert.ok(bad.event.error?.includes('不是合法 JSON'));
  });
});

// ─── store：注入状态落盘 ──────────────────────────────────────

describe('applyInjectionState（快照幂等 + 已加载集合合并）', () => {
  let root = '';
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-skill-state-'));
    process.env.KI_CONFIG_PATH = path.join(root, 'config.yaml');
    fs.writeFileSync(process.env.KI_CONFIG_PATH, `dataDir: ${root}/data\nchatDir: ${root}/chat\n`);
    resetConfigCache();
  });
  after(() => {
    delete process.env.KI_CONFIG_PATH;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const snap = (at: string, skills: string[]): PromptInjectionSnapshot => ({
    version: 1, at, blocks: ['【可用 skill】…', 'P', 'H'], skillIds: skills,
  });

  it('快照只写一次：第二次传入不同快照不覆盖（"提示词只注入一次"）', async () => {
    const conv = await createConversation('default', {});
    await applyInjectionState('default', conv.id, { snapshot: snap('T1', ['builtin-retrieval']) });
    const after1 = await readConversation('default', conv.id);
    assert.equal(after1!.injected!.at, 'T1');

    await applyInjectionState('default', conv.id, { snapshot: snap('T2', ['other']) });
    const after2 = await readConversation('default', conv.id);
    assert.equal(after2!.injected!.at, 'T1', '已有快照不得被覆盖');
    assert.deepEqual(after2!.injected!.skillIds, ['builtin-retrieval']);
  });

  it('已加载集合：追加去重且保序（顺序 = 加载顺序）', async () => {
    const conv = await createConversation('default', {});
    await applyInjectionState('default', conv.id, { addLoadedSkillIds: ['a', 'b'] });
    await applyInjectionState('default', conv.id, { addLoadedSkillIds: ['a', 'c', 'b'] });
    const after = await readConversation('default', conv.id);
    assert.deepEqual(after!.loadedSkillIds, ['a', 'b', 'c']);
  });

  it('不碰 seq（注入状态不是消息，不得制造 id 空洞/跳号）', async () => {
    const conv = await createConversation('default', {});
    const before = await readConversation('default', conv.id);
    await applyInjectionState('default', conv.id, { snapshot: snap('T1', []), addLoadedSkillIds: ['x'] });
    const after = await readConversation('default', conv.id);
    assert.equal(after!.seq, before!.seq);
    assert.deepEqual(after!.injected, snap('T1', []), '快照确实写进去了（否则上面的断言是"没写也算过"）');
    /**
     * ⚠️ 不断言 `updatedAt`：底层 `writeJson` 对**每次**会话写入统一打戳（store 层约定，
     * 本函数不例外）。曾按"不碰 updatedAt"写断言 → 与 `createConversation` 同毫秒时通过、
     * 跨毫秒时失败（偶发红灯，真机复现 30 次里 5 次）。要断言的是**seq**（消息 id 的来源）。
     */
  });

  it('无改动不写盘；会话不存在 → 抛（不静默）', async () => {
    const conv = await createConversation('default', {});
    const before = fs.statSync(path.join(root, 'chat', 'default', `${conv.id}.json`)).mtimeMs;
    await applyInjectionState('default', conv.id, {});
    const after = fs.statSync(path.join(root, 'chat', 'default', `${conv.id}.json`)).mtimeMs;
    assert.equal(after, before, '空 patch 不应产生写盘');
    await assert.rejects(() => applyInjectionState('default', 'c-not-exist', { addLoadedSkillIds: ['a'] }), ConversationNotFoundError);
  });
});
