/**
 * `PromptConfig.find` 域单测（REQ-20261116-005 · S-01）
 *
 * 覆盖四件事：
 *   ① 默认值：六块齐备、工具全开且**不含 fs_\***、内置 skill 默认启用；
 *   ② 老配置兼容：只有 `findPrompt` 时承接为 `find.prompt` 且**不报 issue**；
 *   ③ 读取软通道：`find` 内非法字段只忽略该项，**不整份回退默认**；
 *   ④ 保存严格：非法值 → PromptConfigError 且不落盘；未提交 find 时沿用磁盘值。
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  FIND_TOOL_NAMES,
  PromptConfigError,
  defaultPromptConfig,
  promptConfigPath,
  readPromptConfig,
  savePromptConfig,
} from '../../src/lib/chat/prompt-config.js';
import type { KiConfig } from '../../src/lib/config.js';

let root = '';
let cfg: KiConfig;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-find-config-'));
  cfg = { dataDir: path.join(root, 'kb'), chatDir: path.join(root, 'chat') } as KiConfig;
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function clearFile(): void {
  fs.rmSync(promptConfigPath(cfg), { force: true });
}

function writeRaw(raw: unknown): void {
  const file = promptConfigPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw));
}

describe('① 默认值', () => {
  it('齐备：提示词非空、内置 skill 启用、只读工具全开且不含 fs_*', () => {
    const d = defaultPromptConfig().find;
    assert.ok(d, '默认配置必须带 find 域（否则设置页显示"未接入"）');
    // 2026-11-25（批 3）：检索范围白名单已删除 —— 模型按问题自己换库，不再有静态 ranges
    assert.equal('ranges' in d, false, 'ranges 已删除，不得再出现在默认配置里');
    assert.ok(d.prompt.content.length > 0);
    // 2026-11-25（Q6）：内置 skill 回到 1 个 —— 页面侧 refs-locate；MCP 预取不加载 skill
    assert.equal(d.skills.length, 1);
    assert.deepEqual(d.skills.map((s) => s.name), ['refs-locate'], '内置 skill 名由服务端常量强制');
    assert.ok(d.skills.every((s) => s.enabled), '只读 skill 默认启用（S-01 D-01-6）');
    // 2026-11-25（Q2）：ki_scope_list 并入查找工具集（换库前需要知道有哪些库可查）
    assert.deepEqual(
      Object.keys(d.tools).sort(),
      ['ki_get_module_info', 'ki_group_list', 'ki_scope_list', 'ki_search', 'ki_tag_list'],
    );
    assert.ok(Object.values(d.tools).every((v) => v === true), '只读工具默认全开');
    assert.equal(
      FIND_TOOL_NAMES.some((n) => n.startsWith('fs_')),
      false,
      '文件工具属 AI 分析专属，不得进入查找工具面',
    );
    // 预算三件套缺省 = 未覆盖
    assert.equal(d.maxRounds, undefined);
    assert.equal(d.maxCandidates, undefined);
    // 2026-11-25 用户拍板：超时重新启用，默认 60s
    assert.equal(d.timeoutMs, 60000);
    // 2026-11-19 用户拍板：工具调用上限**恒有值**（默认 15），没有"不限制"档
    assert.equal(d.maxToolCalls, 15, '默认 15 次');
  });
});

describe('② 老配置兼容（findPrompt → find.prompt）', () => {
  it('只有 findPrompt 时承接为 find.prompt，且只给软提示不报 issue', () => {
    clearFile();
    writeRaw({
      version: 1,
      prompt: { content: '对话提示词保持不动', at: '2026-01-01T00:00:00.000Z' },
      findPrompt: { content: '老版检索词改写提示词', at: '2026-01-01T00:00:00.000Z' },
    });
    const r = readPromptConfig(cfg);
    assert.equal(r.config.prompt.content, '对话提示词保持不动', '不得连累对话提示词');
    assert.equal(r.config.find?.prompt.content, '老版检索词改写提示词');
    assert.ok(r.issue?.includes('findPrompt 已迁移为 find.prompt'), `应给软提示，实际：${r.issue}`);
  });
});

describe('②b 域缺失时补齐（读取路径口径）', () => {
  it('磁盘既无 find 也无 findPrompt → config.find 等于默认配置，且不报 issue', () => {
    clearFile();
    writeRaw({ version: 1, prompt: { content: '对话提示词', at: '2026-01-01T00:00:00.000Z' } });
    const r = readPromptConfig(cfg);
    const def = defaultPromptConfig().find!;
    // 读取路径会按 2026-11-19 口径补 `edited` 标记（内容等于代码默认 ⇒ false），
    // 比裸默认值多这一个键 —— 比对时忽略它，其余逐字段仍须相等（本断言此前一直因此变红）。
    const stripEdited = (v: unknown): unknown =>
      JSON.parse(JSON.stringify(v, (k, val) => (k === 'edited' ? undefined : val)));
    assert.deepEqual(stripEdited(r.config.find), stripEdited(def), '归一化以默认配置为初值 ⇒ find 恒有值，前端不必自带兜底');
    assert.equal(r.issue, null, '缺域不是错误（报 issue 会整份回退默认）');
  });
});

describe('③ 读取软通道（不整份回退）', () => {
  it('find 内非法字段只忽略该项，其余照常读取并写 softNotes', () => {
    clearFile();
    writeRaw({
      version: 1,
      prompt: { content: '我的对话提示词', at: '2026-01-01T00:00:00.000Z' },
      find: {
        // 2026-11-25：ranges 已删除（静默忽略）→ 改用「工具开关类型非法」制造软通道
        tools: { ki_search: 'yes', ki_group_list: false },
        maxRounds: 999,
      },
    });
    const r = readPromptConfig(cfg);
    assert.ok(r.config.find, '不得因 find 非法而整份回退');
    assert.equal(r.config.prompt.content, '我的对话提示词', '对话提示词必须保住');
    assert.equal(r.config.find!.tools.ki_group_list, false, '合法字段照常生效');
    assert.equal(r.config.find!.tools.ki_search, true, '非法项回落默认（只读全开）');
    assert.ok(r.issue?.includes('find.tools.ki_search'), `应指出被忽略的字段，实际：${r.issue}`);
    // 2026-11-18：预算取消后 maxRounds 已是未知字段 —— 静默丢弃，不再报 issue
    assert.equal('maxRounds' in r.config.find!, false, '已取消的预算字段不得读回');
    assert.equal(r.issue?.includes('find.maxRounds'), false, '已取消字段不再报 issue');
    // 2026-11-25（批 3）：ranges 删除后老配置里带它也不得读回、不得报 issue
    assert.equal('ranges' in r.config.find!, false, '已删除的 ranges 不得读回');
    assert.equal(r.issue?.includes('ranges'), false, '已删除字段不得报 issue');
  });
});

describe('④ 保存严格（400 且不落盘）', () => {
  it('未知工具名抛 PromptConfigError；已删除 / 已取消字段静默丢弃', () => {
    clearFile();
    assert.throws(() => savePromptConfig(cfg, { find: { tools: { bad_tool: true } } }), PromptConfigError);
    // 2026-11-25（批 3）：ranges 已删除 → 带旧值提交不报错、也不写回
    const withRanges = savePromptConfig(cfg, { find: { ranges: { extraScopes: ['kb-x'] } } } as unknown as Parameters<typeof savePromptConfig>[1]);
    assert.equal('ranges' in (withRanges.find ?? {}), false, 'ranges 已删除，不得写回');
    clearFile();
    assert.equal(fs.existsSync(promptConfigPath(cfg)), false, '校验失败不得落盘');
    // 2026-11-18：timeoutMs / maxRounds 预算已取消 → 带旧值提交不报错、不落盘
    const legacy = { find: { maxRounds: 99 } } as unknown as Parameters<typeof savePromptConfig>[1];
    const saved = savePromptConfig(cfg, legacy);
    assert.equal('maxRounds' in (saved.find ?? {}), false, 'maxRounds 已取消，不得写回');
    // 2026-11-25：超时越界 fail-loud（不静默钳制），合法值正常落盘
    assert.throws(() => savePromptConfig(cfg, { find: { timeoutMs: 1 } }), PromptConfigError);
    assert.throws(() => savePromptConfig(cfg, { find: { timeoutMs: 999_999 } }), PromptConfigError);
    const withTimeout = savePromptConfig(cfg, { find: { timeoutMs: 60_000 } });
    assert.equal(withTimeout.find?.timeoutMs, 60_000);
  });

  it('工具调用次数上限：越界 / 非整数 fail-loud 不落盘；读取路径只忽略该项', () => {
    clearFile();
    // 1 = 只够检索不够读正文（必然 0 候选）；31 = 超上界；2.5/0/-3/'5'/true = 类型或范围不对
    for (const bad of [1, 31, 2.5, 0, -3, '5', true, null]) {
      assert.throws(
        () => savePromptConfig(cfg, { find: { maxToolCalls: bad } }),
        PromptConfigError,
        `maxToolCalls=${String(bad)} 必须被拒（不得静默钳制）`,
      );
    }
    assert.equal(fs.existsSync(promptConfigPath(cfg)), false, '校验失败不得落盘');

    const saved = savePromptConfig(cfg, { find: { maxToolCalls: 3 } });
    assert.equal(saved.find?.maxToolCalls, 3, '合法值必须写回');
    assert.equal(readPromptConfig(cfg).config.find?.maxToolCalls, 3, '读回同一份值');

    // 读取路径：手改文件写坏 → 只忽略该项，其余配置照常（否则整份回退默认）
    // 注意这里必须回落到**默认 15**而不是 undefined —— 查找不允许"不限制"
    writeRaw({ version: 1, find: { maxToolCalls: 999, tools: { ki_search: false } } });
    const r = readPromptConfig(cfg);
    assert.equal(r.config.find?.maxToolCalls, 15, '非法值不得读回，回落到默认 15');
    assert.equal(r.config.find?.tools.ki_search, false, '其余字段照常生效');
    assert.ok(r.issue?.includes('find.maxToolCalls'), `应指出被忽略的字段，实际：${r.issue}`);

    // 文件里根本没有这个键（老配置）→ 同样按默认 15 补齐
    writeRaw({ version: 1, find: { tools: { ki_search: true } } });
    assert.equal(readPromptConfig(cfg).config.find?.maxToolCalls, 15, '缺字段按默认 15 补齐');
  });

  it('未提交 find 时沿用磁盘既有值；提交 find 时镜像到 findPrompt', () => {
    clearFile();
    // 用 ki_tag_list 而非 ki_search：后者是 refs-locate 的依赖工具，关掉会被依赖守卫拦（那是正确行为）
    savePromptConfig(cfg, { find: { tools: { ki_tag_list: false } } });

    // 另一个标签页只改了对话工具开关
    const afterTools = savePromptConfig(cfg, { tools: { ki_search: false } });
    assert.equal(afterTools.find!.tools.ki_tag_list, false, '未提交 find 时不得把工具开关重置为默认全开');

    const afterPrompt = savePromptConfig(cfg, { find: { prompt: { content: '自定义查找提示词', at: 'x' } } });
    assert.equal(afterPrompt.find!.prompt.content, '自定义查找提示词');
    assert.equal(
      afterPrompt.findPrompt?.content,
      '自定义查找提示词',
      '旧字段只是镜像（老前端读 defaults.findPrompt 不炸）',
    );

    // 字段级增量：只提交 prompt 时，先前关掉的工具不得被默认值（全开）悄悄打开
    const afterPartial = savePromptConfig(cfg, { find: { prompt: { content: '只改提示词', at: 'y' } } });
    assert.equal(afterPartial.find!.tools.ki_tag_list, false, '未提交的工具开关必须沿用磁盘值');
  });
});
