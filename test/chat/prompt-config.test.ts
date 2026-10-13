/**
 * prompt-config 单测（对话配置层 · 批次 1）
 *
 * 验证页面默认值与模型 system 注入同源，并保留已保存的用户内容与空值。
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
  SKILL_DESC_MAX_CHARS,
  SKILL_MAX_CHARS,
  PromptConfigError,
  buildInjectionSnapshot,
  builtinSkillDefaultDescription,
  defaultPromptConfig,
  enabledSkillIds,
  findEnabledSkill,
  normalizePromptConfig,
  promptConfigPath,
  promptSnapshotBlocks,
  readPromptConfig,
  savePromptConfig,
} from '../../src/lib/chat/prompt-config.js';
import {
  DEFAULT_CHAT_PROMPT,
  HARD_RULES_BLOCK,
  RETRIEVAL_SKILL_DESCRIPTION,
  RETRIEVAL_SKILL_PROMPT,
  buildSystemMessages,
  deriveSkillSummary,
  renderSkillCatalog,
} from '../../src/lib/chat/retrieval/retrieval-skill.js';
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

describe('默认内容同源', () => {
  it('2026-10-13 起：恒定注入块 = 目录 → 基础提示词 → 硬性规则（**不含 skill 正文**）', () => {
    const blocks = promptSnapshotBlocks(defaultPromptConfig());
    assert.equal(blocks.length, 3);
    assert.ok(blocks[0]!.startsWith('【可用 skill】'), '目录在最前：AI 先要知道"有哪些 skill 可用"');
    assert.equal(blocks[1], DEFAULT_CHAT_PROMPT);
    assert.equal(blocks[2], HARD_RULES_BLOCK);
    assert.ok(
      !blocks.some((b) => b.includes('## 指令')),
      'skill 正文（按需加载）绝不能出现在恒定注入块里 —— 否则"按需"名存实亡',
    );
    assert.ok(blocks[2]!.includes('知识库中未找到'), '硬性反幻觉规则必须恒注入（N17 依赖）');
  });

  it('会话 prompt 非空时：注入块在前、会话 prompt 在最后（硬性规则不被用户文案覆盖）', () => {
    const convPrompt = '我的自定义系统提示';
    const msgs = buildSystemMessages(convPrompt, promptSnapshotBlocks(defaultPromptConfig()));
    assert.deepEqual(
      msgs.map((m) => m.content),
      [...promptSnapshotBlocks(defaultPromptConfig()), convPrompt],
    );
    assert.equal(msgs.at(-1)!.content, convPrompt, '会话 prompt 必须仍在最后一段');
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

  it('基础规则和场景 skill 均非空，且可在配置编辑器中保存', () => {
    const defaults = defaultPromptConfig();
    assert.equal(defaults.prompt.content, DEFAULT_CHAT_PROMPT);
    assert.ok(DEFAULT_CHAT_PROMPT.trim().length > 0 && DEFAULT_CHAT_PROMPT.length <= PROMPT_MAX_CHARS);
    assert.ok(RETRIEVAL_SKILL_PROMPT.length <= SKILL_MAX_CHARS);
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    normalizePromptConfig(defaults, issues);
    assert.deepEqual(issues, []);
  });
});

describe('读写往返', () => {
  it('已有配置：有意清空基础提示词、自定义内置 skill、禁用状态与其他 skill 不被新默认覆盖', () => {
    const input = defaultPromptConfig();
    input.prompt.content = '';
    input.skills[0]!.content = '用户自己写的检索策略';
    input.skills[0]!.enabled = false;
    input.skills.push({ id: 'custom', name: '自定义', description: '自定义 skill 的描述', content: '保留我的风格', builtin: false, enabled: true, at: input.prompt.at });
    const saved = savePromptConfig(cfg, input);
    const read = readPromptConfig(cfg).config;
    assert.deepEqual(read, saved);
    // 清空的基础提示词不发；停用的内置 skill 不进目录；启用的自定义 skill 只以"目录"形态出现
    assert.deepEqual(promptSnapshotBlocks(read), [
      renderSkillCatalog(read.skills)!,
      HARD_RULES_BLOCK,
    ]);
    assert.ok(promptSnapshotBlocks(read)[0]!.includes('保留我的风格') === false, '目录里只放描述，不放正文');
  });

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

describe('注入顺序（恒注入块 · 2026-10-13 改口径）', () => {
  it('目录 → 基础提示词 → 硬性规则；停用项不进目录、空块不发', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    const cfg2 = normalizePromptConfig(
      {
        prompt: { content: '基础提示词' },
        skills: [
          { id: 'builtin-retrieval', name: '知识库检索', description: '检索知识库', content: RETRIEVAL_SKILL_PROMPT, enabled: true },
          { id: 'empty-one', name: '空的', content: '   ', enabled: true },
          { id: 'style', name: '风格', description: '按我的风格回答', content: '先给结论', enabled: true },
          { id: 'off', name: '停用的', description: '不该出现', content: '不该出现', enabled: false },
        ],
      },
      issues,
    );
    assert.deepEqual(issues, []);
    const blocks = promptSnapshotBlocks(cfg2);
    assert.equal(blocks.length, 3);
    const catalog = blocks[0]!;
    assert.ok(catalog.includes('知识库检索（builtin-retrieval）：检索知识库'));
    assert.ok(catalog.includes('风格（style）：按我的风格回答'));
    assert.ok(catalog.includes('（未填写描述）'), '空描述的条目仍进目录（否则 AI 永远不知道它存在）');
    assert.ok(!catalog.includes('停用的'), '停用的 skill 不进目录 = 调不到');
    assert.equal(blocks[1], '基础提示词');
    assert.equal(blocks[2], HARD_RULES_BLOCK);
  });
});

describe('skill 描述（SKILL.md 规范，2026-10-13 新增）', () => {
  it('默认内置 skill 带描述；描述与正文是两份内容（描述进目录，正文按需加载）', () => {
    const s = defaultPromptConfig().skills[0]!;
    assert.equal(s.description, RETRIEVAL_SKILL_DESCRIPTION);
    assert.equal(builtinSkillDefaultDescription('builtin-retrieval'), RETRIEVAL_SKILL_DESCRIPTION);
    assert.equal(builtinSkillDefaultDescription('other'), null);
    assert.ok(s.description.length <= 120, '描述应落在建议长度内（1-2 句，避免清单里被截断）');
    assert.notEqual(s.description, s.content);
  });

  it('缺失描述 → 归一化为空串且不报错（旧配置兼容）', () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    const out = normalizePromptConfig(
      { skills: [{ id: 'builtin-retrieval', name: '知识库检索', content: RETRIEVAL_SKILL_PROMPT }] },
      issues,
    );
    assert.deepEqual(issues, []);
    assert.equal(out.skills[0]!.description, '');
  });

  it(`描述超 ${SKILL_DESC_MAX_CHARS} 字 → 报错（不静默截断）`, () => {
    const issues: Parameters<typeof normalizePromptConfig>[1] = [];
    normalizePromptConfig(
      { skills: [{ id: 'builtin-retrieval', name: 'n', description: 'x'.repeat(SKILL_DESC_MAX_CHARS + 1), content: '' }] },
      issues,
    );
    assert.ok(issues.some((i) => i.path === 'skills[0].description' && i.message.includes('描述不得超过')));
  });

  it('描述落盘 → 读回一致', () => {
    const saved = savePromptConfig(cfg, {
      skills: [{ id: 'builtin-retrieval', name: '知识库检索', description: '库内事实与排障。触发："查知识库"。', content: 'x' }],
    });
    assert.equal(saved.skills[0]!.description, '库内事实与排障。触发："查知识库"。');
    assert.equal(readPromptConfig(cfg).config.skills[0]!.description, saved.skills[0]!.description);
  });
});

describe('目录与快照（恒注入的内容与形状）', () => {
  it('目录带 id（调用键）+ 名称 + 描述，并写明"未加载的正文不可见"', () => {
    const catalog = renderSkillCatalog(defaultPromptConfig().skills)!;
    assert.ok(catalog.includes('builtin-retrieval'), 'id 是 use_skill 的调用键，必须出现');
    assert.ok(catalog.includes('知识库检索'));
    assert.ok(catalog.includes(RETRIEVAL_SKILL_DESCRIPTION));
    assert.ok(catalog.includes('use_skill'));
    assert.ok(catalog.includes('未加载的 skill 正文不在本次上下文中'), '必须防止模型凭名称编造规则');
  });

  it('全部停用 → null（调用方据此不注入空块）', () => {
    const skills = defaultPromptConfig().skills.map((s) => ({ ...s, enabled: false }));
    assert.equal(renderSkillCatalog(skills), null);
  });

  it('描述缺失时回退正文摘要（取「用途：」/「**目的**：」首句，≤120 字）', () => {
    const summary = deriveSkillSummary(RETRIEVAL_SKILL_PROMPT);
    assert.ok(summary.startsWith('用当前知识库中的可核对片段'), `实际：${summary}`);
    assert.ok(summary.length <= 121);
    assert.equal(deriveSkillSummary('# 标题\n\n**目的**：干这件事。细节略。'), '干这件事。');
    assert.equal(deriveSkillSummary('用途：查东西。补充说明。'), '查东西。');
  });

  it('快照：目录 + 提示词 + 硬规则 + 启用 id 列表，**绝不含 skill 正文**', () => {
    const snap = buildInjectionSnapshot(defaultPromptConfig(), '2026-10-13T00:00:00.000Z');
    assert.equal(snap.version, 1);
    assert.equal(snap.at, '2026-10-13T00:00:00.000Z');
    assert.deepEqual(snap.skillIds, ['builtin-retrieval']);
    assert.equal(snap.blocks.length, 3);
    assert.ok(!JSON.stringify(snap).includes('## 指令'), '快照含正文会把会话文件撑爆（护栏 #4）');
  });

  it('enabledSkillIds / findEnabledSkill：停用即不可调用', () => {
    const cfg2 = defaultPromptConfig();
    cfg2.skills[0]!.enabled = false;
    assert.deepEqual(enabledSkillIds(cfg2), []);
    assert.equal(findEnabledSkill(cfg2, 'builtin-retrieval'), null);
    cfg2.skills[0]!.enabled = true;
    assert.equal(findEnabledSkill(cfg2, 'builtin-retrieval')?.name, '知识库检索');
    assert.equal(findEnabledSkill(cfg2, 'nope'), null);
  });
});

// ─────────────────────────────────────────────────────────────

describe('接入后：buildSystemMessages 渲染注入块（2026-10-13 改口径）', () => {
  it('不带块参数（兜底形态）：基础提示词 + 硬性规则，**没有 skill 正文**', () => {
    assert.deepEqual(
      buildSystemMessages('会话提示').map((m) => m.content),
      [DEFAULT_CHAT_PROMPT, HARD_RULES_BLOCK, '会话提示'],
    );
  });

  it('注入顺序：目录 → 基础提示词 → 硬性规则 → 会话 prompt', () => {
    const cfg = defaultPromptConfig();
    cfg.prompt.content = '基础提示词内容';
    cfg.skills.push({
      id: 'user-a', name: 'A', description: '用户 skill A 的描述', content: '用户 skill A 正文', builtin: false, enabled: true, at: cfg.prompt.at,
    });
    const msgs = buildSystemMessages('会话提示', promptSnapshotBlocks(cfg));
    const contents = msgs.map((m) => m.content);
    assert.equal(contents.length, 4);
    assert.ok(contents[0]!.includes('用户 skill A 的描述'));
    assert.ok(!contents[0]!.includes('用户 skill A 正文'), '目录里不得出现正文');
    assert.equal(contents[1], '基础提示词内容');
    assert.equal(contents[2], HARD_RULES_BLOCK, '硬性规则必须在会话 prompt 之前');
    assert.equal(contents[3], '会话提示');
    assert.ok(msgs.every((m) => m.role === 'system' && m.content.trim().length > 0), '不留空 system 消息');
  });

  it('停用的 skill 不进目录；纯空白块不发', () => {
    const cfg = defaultPromptConfig();
    cfg.skills.push(
      { id: 'off', name: '停用', description: '不该出现', content: '不该出现', builtin: false, enabled: false, at: cfg.prompt.at },
    );
    const contents = buildSystemMessages('', promptSnapshotBlocks(cfg)).map((m) => m.content);
    assert.equal(contents.length, 3);
    assert.ok(!contents.join('\n').includes('不该出现'));
  });

  it('显式传空块数组 → 只剩会话 prompt（调用方保留"清空注入"的能力）', () => {
    assert.deepEqual(buildSystemMessages('仅会话提示', []).map((m) => m.content), ['仅会话提示']);
  });
});
