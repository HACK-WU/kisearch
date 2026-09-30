/**
 * prompt-config 单测（对话配置层 · 批次 1）
 *
 * ★ 本文件最重要的用例是「兼容性」组：拿**新注入路径**（promptConfigSystemBlocks）
 *   与**既有实现**（retrieval-skill.buildSystemMessages）做逐字比对 ——
 *   未配置时二者必须完全一致，否则就是在"加功能"的同时静默改了线上行为。
 *
 * 其余覆盖：默认值 / 读写往返 / 校验（超长·未知名·内置不可删·重复）/
 *          服务端强制 builtin / 损坏文件回退 / 原子写保留权限 / 注入顺序。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_SKILLS,
  MCP_TOOL_NAMES,
  PROMPT_MAX_CHARS,
  PromptConfigError,
  defaultPromptConfig,
  normalizePromptConfig,
  promptConfigPath,
  promptConfigSystemBlocks,
  readPromptConfig,
  savePromptConfig,
} from '../../src/lib/chat/prompt-config.js';
import { RETRIEVAL_SKILL_PROMPT, buildSystemMessages } from '../../src/lib/chat/retrieval/retrieval-skill.js';
import type { KiConfig } from '../../src/lib/config.js';

let root = '';
let cfg: KiConfig;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-prompt-config-'));
  // 只用到 dataDir / chatDir 两个字段，其余链路本文件不触碰
  cfg = { dataDir: path.join(root, 'kb'), chatDir: path.join(root, 'chat') } as KiConfig;
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────

describe('兼容性（★ 未配置时行为逐字一致）', () => {
  it('默认配置的注入块 === 既有 buildSystemMessages 的 system 内容（逐字）', () => {
    const legacy = buildSystemMessages('').map((m) => m.content);
    assert.deepEqual(
      promptConfigSystemBlocks(defaultPromptConfig()),
      legacy,
      '未配置时注入块必须与既有实现逐字一致',
    );
    assert.deepEqual(legacy, [RETRIEVAL_SKILL_PROMPT], '前置：既有实现只发内置检索 skill 一段');
  });

  it('会话 prompt 非空时：新路径 = 注入块 + 会话 prompt（顺序不变）', () => {
    const convPrompt = '我的自定义系统提示';
    const legacy = buildSystemMessages(convPrompt).map((m) => m.content);
    const next = [...promptConfigSystemBlocks(defaultPromptConfig()), convPrompt];
    assert.deepEqual(next, legacy, '会话 prompt 必须仍在最后一段（skill 在前，反幻觉规则不被覆盖）');
  });

  it('文件不存在 → 默认配置且 issue 为 null（未配置是可预期状态，不是错误）', () => {
    const r = readPromptConfig(cfg);
    assert.equal(r.issue, null);
    assert.deepEqual(r.config, defaultPromptConfig());
  });
});

describe('默认值', () => {
  it('工具默认：只读全开、写入与删除全关', () => {
    const t = defaultPromptConfig().tools;
    assert.equal(t.ki_search, true);
    assert.equal(t.ki_scope_list, true);
    assert.equal(t.ki_store, false);
    assert.equal(t.ki_delete_relation, false);
    assert.equal(t.ki_manage_index_delete, false);
  });

  it('工具白名单为 mcp-tools 的 14 个真实注册名（读 6 / 写 6 / 删 2）', () => {
    assert.equal(MCP_TOOL_NAMES.length, 14);
    assert.ok(MCP_TOOL_NAMES.includes('ki_search'));
    assert.ok(MCP_TOOL_NAMES.includes('ki_manage_index_list'));
    assert.ok(MCP_TOOL_NAMES.includes('ki_bulk_sync_relation'));
  });

  it('默认基础提示词为空（现在没有这条配置，默认也不该多注入一段）', () => {
    assert.equal(defaultPromptConfig().prompt.content, '');
  });
});

describe('读写往返', () => {
  it('save → read 内容一致；落盘路径为 {chatDir}/prompt-config.json', () => {
    const input = {
      prompt: { content: '你是 kisearch 的知识库助手。' },
      skills: [
        { id: 'builtin-retrieval', name: '知识库检索', content: RETRIEVAL_SKILL_PROMPT, enabled: true },
        { id: 'my-style', name: '回答风格', content: '先给结论，再给依据。', enabled: true },
      ],
      tools: { ki_search: true, ki_store: true },
    };
    const saved = savePromptConfig(cfg, input);
    assert.equal(saved.prompt.content, '你是 kisearch 的知识库助手。');
    assert.equal(saved.skills.length, 2);
    assert.equal(saved.tools.ki_store, true, '显式开启写入工具应被保存');

    assert.equal(promptConfigPath(cfg), path.join(root, 'chat', 'prompt-config.json'));
    assert.ok(fs.existsSync(promptConfigPath(cfg)), '配置文件应已落盘');

    const back = readPromptConfig(cfg);
    assert.equal(back.issue, null);
    assert.deepEqual(back.config, saved, '读回应与保存结果一致');
  });

  it('未显式给出的工具沿用默认值（不会被整体重置为空）', () => {
    const saved = savePromptConfig(cfg, { tools: { ki_store: true } });
    assert.equal(saved.tools.ki_store, true);
    assert.equal(saved.tools.ki_search, true, '未提及的只读工具应保持默认 true');
    assert.equal(saved.tools.ki_delete_relation, false);
  });
});

describe('校验（服务端强制）', () => {
  it('基础提示词超长 → 抛 PromptConfigError 且不落盘', () => {
    const before = fs.readFileSync(promptConfigPath(cfg), 'utf-8');
    let caught: unknown = null;
    try {
      savePromptConfig(cfg, { prompt: { content: 'x'.repeat(PROMPT_MAX_CHARS + 1) } });
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof PromptConfigError, `应抛 PromptConfigError，实际：${String(caught)}`);
    const err = caught as PromptConfigError;
    assert.equal(err.code, 'PROMPT_CONFIG_INVALID');
    assert.ok(err.issues.some((i) => i.path === 'prompt.content'));
    assert.equal(fs.readFileSync(promptConfigPath(cfg), 'utf-8'), before, '校验失败不得改动已有文件');
  });

  it('未知工具名 → 报错（不静默丢弃，否则拼错的名字会让人以为生效了）', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    normalizePromptConfig({ tools: { ki_searh: true } }, issues);
    assert.ok(issues.some((i) => i.path === 'tools.ki_searh' && i.message.includes('未知工具名')));
  });

  it('内置 skill 不可删除（缺失即报错）', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    normalizePromptConfig({ skills: [{ id: 'my-style', name: 'n', content: '' }] }, issues);
    assert.ok(issues.some((i) => i.message.includes('不可删除')));
  });

  it('内置 skill 可禁用（enabled:false 合法）', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    const out = normalizePromptConfig(
      { skills: [{ id: 'builtin-retrieval', name: '知识库检索', content: RETRIEVAL_SKILL_PROMPT, enabled: false }] },
      issues,
    );
    assert.deepEqual(issues, []);
    assert.equal(out.skills[0]!.enabled, false);
  });

  it('skill id / 名称非法或重复 → 报错', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    normalizePromptConfig(
      {
        skills: [
          { id: 'Bad_Id', name: 'A', content: '' },
          { id: 'ok', name: '', content: '' },
          { id: 'dup', name: 'D', content: '' },
          { id: 'dup', name: 'D', content: '' },
        ],
      },
      issues,
    );
    const paths = issues.map((i) => i.path);
    assert.ok(paths.includes('skills[0].id'));
    assert.ok(paths.includes('skills[1].name'));
    assert.ok(issues.some((i) => i.message.includes('id 重复')));
  });

  it(`skill 条数上限 ${MAX_SKILLS}`, () => {
    const skills = Array.from({ length: MAX_SKILLS + 1 }, (_, i) => ({ id: `s-${i}`, name: `s${i}`, content: '' }));
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    normalizePromptConfig({ skills }, issues);
    assert.ok(issues.some((i) => i.path === 'skills'));
  });

  it('builtin 由服务端按 id 强制（客户端传 false 也会被覆盖为 true）', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    const out = normalizePromptConfig(
      { skills: [{ id: 'builtin-retrieval', name: '知识库检索', content: 'x', builtin: false }] },
      issues,
    );
    assert.deepEqual(issues, []);
    assert.equal(out.skills[0]!.builtin, true);
  });
});

describe('损坏配置的回退', () => {
  it('非法 JSON → 回退默认 + issue 非空（生成链路不因此不可用）', () => {
    const file = promptConfigPath(cfg);
    fs.writeFileSync(file, '{ 这不是 JSON', 'utf-8');
    const r = readPromptConfig(cfg);
    assert.deepEqual(r.config, defaultPromptConfig());
    assert.ok(r.issue && r.issue.includes('不是合法 JSON'), `issue 应说明原因，实际：${r.issue}`);
  });

  it('JSON 合法但字段非法 → 回退默认 + issue 非空', () => {
    fs.writeFileSync(promptConfigPath(cfg), JSON.stringify({ skills: [{ id: 'BAD', name: '', content: '' }] }), 'utf-8');
    const r = readPromptConfig(cfg);
    assert.deepEqual(r.config, defaultPromptConfig());
    assert.ok(r.issue && r.issue.includes('已回退默认'));
  });
});

describe('写入的原子性与权限', () => {
  it('保留原文件权限（0600 不被降级为 0644）', () => {
    savePromptConfig(cfg, { prompt: { content: 'a' } });
    const file = promptConfigPath(cfg);
    fs.chmodSync(file, 0o600);
    savePromptConfig(cfg, { prompt: { content: 'b' } });
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, `权限应保持 0600，实际 ${mode.toString(8)}`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf-8')).prompt.content, 'b');
  });
});

describe('注入顺序', () => {
  it('内置 skill → 基础提示词 → 用户 skill；空块不发', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    const cfg2 = normalizePromptConfig(
      {
        prompt: { content: '基础提示词' },
        skills: [
          { id: 'builtin-retrieval', name: '知识库检索', content: RETRIEVAL_SKILL_PROMPT, enabled: true },
          { id: 'empty-one', name: '空的', content: '   ', enabled: true },
          { id: 'style', name: '风格', content: '先给结论', enabled: true },
          { id: 'off', name: '停用的', content: '不该出现', enabled: false },
        ],
      },
      issues,
    );
    assert.deepEqual(issues, []);
    assert.deepEqual(promptConfigSystemBlocks(cfg2), [RETRIEVAL_SKILL_PROMPT, '基础提示词', '先给结论']);
  });
});

// ─────────────────────────────────────────────────────────────

describe('接入后：buildSystemMessages 使用配置产出的注入块（工作项 3）', () => {
  it('未配置（默认配置）→ 与既有单参调用**逐字一致**（护栏 #3）', () => {
    const legacy = buildSystemMessages('会话提示');
    const wired = buildSystemMessages('会话提示', promptConfigSystemBlocks(defaultPromptConfig()));
    assert.deepEqual(wired, legacy, '接入配置层后，未配置时的上游 messages 必须一字不差');
  });

  it('注入顺序：内置 skill → 基础提示词 → 用户 skill → 会话 prompt', () => {
    const cfg = defaultPromptConfig();
    cfg.prompt.content = '基础提示词内容';
    cfg.skills.push({
      id: 'user-a', name: 'A', content: '用户 skill A', builtin: false, enabled: true, at: cfg.prompt.at,
    });
    const msgs = buildSystemMessages('会话提示', promptConfigSystemBlocks(cfg));
    assert.deepEqual(
      msgs.map((m) => m.content),
      [RETRIEVAL_SKILL_PROMPT, '基础提示词内容', '用户 skill A', '会话提示'],
      '反幻觉规则（内置 skill）必须仍在最前，会话 prompt 仍在最后',
    );
    assert.ok(msgs.every((m) => m.role === 'system' && m.content.trim().length > 0), '不留空 system 消息');
  });

  it('停用的 skill 与纯空白块都不出现在注入结果里', () => {
    const cfg = defaultPromptConfig();
    cfg.skills.push(
      { id: 'off', name: '停用', content: '不该出现', builtin: false, enabled: false, at: cfg.prompt.at },
      { id: 'blank', name: '空白', content: '   ', builtin: false, enabled: true, at: cfg.prompt.at },
    );
    assert.deepEqual(buildSystemMessages('', promptConfigSystemBlocks(cfg)).map((m) => m.content), [RETRIEVAL_SKILL_PROMPT]);
  });

  it('显式传空块数组 → 只剩会话 prompt（调用方保留"清空注入"的能力）', () => {
    assert.deepEqual(buildSystemMessages('仅会话提示', []).map((m) => m.content), ['仅会话提示']);
  });
});
