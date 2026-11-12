/**
 * skill 名称必须是英文（2026-11-11 用户拍板）。
 *
 * 三条口径（改动前先读，缺一条就会破老配置）：
 *  1. **名称正则**：以英文字母开头，只能含英文字母 / 数字 / 下划线 / 连字符，**不允许空格**
 *     （名称与 id 在 AI 的恒注入目录里同一行展示，空格会让两者边界含糊）。
 *  2. **内置 skill 的名称由服务端强制**（`BUILTIN_SKILL_NAMES`）：内置条目在界面上不可改名，
 *     不强制等于永远改不掉；顺带让老配置里的历史中文名在**读取时**完成迁移。
 *  3. **读取路径不校验英文**（`skillNameSoft`）、**保存路径放行既有名**（`existingSkillNames`）：
 *     否则读到老中文名会触发「任一字段非法 → 整份回退默认」，连提示词与工具开关一起消失。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = path.join(webRoot, '..');
const server = fs.readFileSync(path.join(repoRoot, 'src/lib/chat/prompt-config.ts'), 'utf8');
const modal = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigModal.tsx'), 'utf8');
const layer = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');

/** 名称正则的核心片段（前后端必须逐字一致 —— 手工同源的锚点） */
const NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_-]{0,63}$';

describe('skill 名称必须英文（前后端同源）', () => {
  it('后端有独立的名称正则，且不允许空格', () => {
    assert.ok(server.includes('export const SKILL_NAME_RE'), '名称规则应是一个可引用的常量，不是散落的字面量');
    assert.ok(server.includes(NAME_PATTERN), `SKILL_NAME_RE 应为 ${NAME_PATTERN}`);
    assert.ok(server.includes('SKILL_NAME_RULE_HINT'), '错误文案应同源，避免多处措辞漂移');
    assert.match(server, /不允许空格/, '提示必须写明"不允许空格"（这是用户明确裁决的一条）');
  });

  it('前端校验与后端逐字同源（不是各写一套）', () => {
    assert.ok(layer.includes(NAME_PATTERN), 'PromptConfigLayer 的 checkName 必须用同一份正则（服务端仍是最终闸门）');
    const occurrences = layer.split(NAME_PATTERN).length - 1;
    assert.equal(occurrences, 1, '正则只应出现在 checkName 一处，避免前端出现第二套规则');
  });

  it('内置 skill 名称由服务端常量强制，历史中文名不再作为默认值', () => {
    assert.match(server, /BUILTIN_SKILL_NAMES[^=]*=\s*\{\s*'builtin-retrieval':\s*'knowledge-retrieval'/, '内置名应为 knowledge-retrieval');
    assert.ok(!server.includes("name: '知识库检索'"), '默认值里不得再留中文名（老配置靠迁移，不靠默认值）');
    // 强制点：name 的取值必须优先来自内置表，否则改默认值不会影响已保存配置
    assert.match(server, /const name = builtinName \?\?/, '内置名必须优先于客户端传值（与 builtin 字段同一模式）');
  });

  it('★ 内置 skill 名称不得与任何 MCP 工具名重叠（首版取名 ki_search 就撞了）', () => {
    const namesBlock = server.slice(server.indexOf('BUILTIN_SKILL_NAMES'), server.indexOf('SKILL_REQUIRED_TOOLS'));
    const builtinNames = [...namesBlock.matchAll(/:\s*'([A-Za-z][A-Za-z0-9_-]*)'/g)].map((m) => m[1]);
    assert.ok(builtinNames.length >= 2, `内置名解析失败（得到 ${builtinNames.length} 条：${builtinNames.join(',')}）`);
    const groupsBlock = server.slice(server.indexOf('export const MCP_TOOL_GROUPS'), server.indexOf('export const MCP_TOOL_NAMES'));
    const toolNames = [...groupsBlock.matchAll(/names:\s*\[([^\]]+)\]/g)]
      .flatMap((m) => [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
    assert.ok(toolNames.length >= 13, `工具名解析失败（得到 ${toolNames.length} 个）`);
    for (const name of builtinNames) {
      assert.ok(
        !toolNames.includes(name),
        `skill 名「${name}」与 MCP 工具同名 —— 模型会把「能力」和「工具」当成一回事`,
      );
    }
  });

  it('读取路径宽松 / 保存路径放行既有名（老配置不得被拖进"回退默认"）', () => {
    assert.ok(server.includes('skillNameSoft: true'), 'readPromptConfig 必须传 skillNameSoft —— 否则老中文名会让整份配置回退默认');
    assert.ok(server.includes('existingSkillNames'), '保存路径必须传入磁盘既有名集合，否则老配置改任何字段都会被 400 卡死');
    assert.match(server, /existingSkillNames:\s*new Set\(/, '既有名集合应来自磁盘上读到的 skills');
  });

  it('名称查重按小写比对（Foo / foo 对 AI 是同一个名字）', () => {
    assert.ok(server.includes('seenNames.has(name.toLowerCase())'), '后端查重应大小写不敏感');
    assert.ok(layer.includes('s.name.toLowerCase() === name.toLowerCase()'), '前端查重应与后端同口径');
  });

  it('模态：提示英文规则 + 输入即提示 + 非法时禁用保存', () => {
    assert.match(modal, /英文名称，例：knowledge-retrieval/, 'placeholder 应直接示范英文名');
    assert.match(modal, /以字母开头，只能含字母、数字、下划线、连字符（不能有空格）/, '规则说明应常驻可见');
    assert.ok(modal.includes('nameEditableSkill'), '只对"名称可改的 skill"提示与拦截（提示词条目不受影响）');
    assert.match(modal, /setNameErr\(nameEditableSkill/, '输入时就应计算错误，不等保存才提示');
    assert.match(modal, /disabled=\{over \|\| \(nameEditableSkill/, '名称非法时保存应置灰（原因已在字段下方写明）');
  });
});
