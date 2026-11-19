/**
 * `PromptConfig.recall` 域单测（REQ-20261118-004 · S-03）
 *
 * 覆盖五件事：
 *   ① 默认值：提示词非空、工具全开、锁定项在、轮次与字符上限取默认；
 *   ② 老配置兼容：完全没有 `recall` 域时读取**不报 issue**，补齐默认；
 *   ③ 读取软通道：域内非法字段只忽略该项，**不整份回退默认**（否则会连带打回对话配置）；
 *   ④ 锁定工具：提交 `false` 也被强制为 `true`（否则「必须先读正文」无法执行）；
 *   ⑤ 保存语义：越界 → PromptConfigError 且不落盘；未提交 recall 时沿用磁盘既有值。
 *
 * 运行：npx jiti test/chat/recall-config.test.ts
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  RECALL_LOCKED_TOOL_NAMES,
  RECALL_TOOL_NAMES,
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-recall-config-'));
  cfg = { dataDir: path.join(root, 'kb'), chatDir: path.join(root, 'chat') } as KiConfig;
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeRaw(raw: unknown): void {
  const file = promptConfigPath(cfg);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw));
}

describe('① 默认值', () => {
  it('提示词非空、工具全开、锁定项在、轮次 5 / 字符 8000', () => {
    const d = defaultPromptConfig().recall;
    assert.ok(d, '默认配置必须带 recall 域（否则设置页不会出现第四项）');
    assert.ok(d.prompt.content.length > 0, '内置提示词不能为空');
    for (const name of RECALL_TOOL_NAMES) {
      assert.equal(d.tools[name], true, `默认应开启 ${name}`);
    }
    for (const name of RECALL_LOCKED_TOOL_NAMES) {
      assert.equal(d.tools[name], true, `锁定工具 ${name} 默认必须为 true`);
    }
    assert.equal(d.maxRounds, 5);
    assert.equal(d.toolResponseChars, 8000);
    assert.deepEqual(d.skills, [], '预取没有内置 skill');
  });

  it('没有 ranges（范围由调用方 scope 决定，服务端不设默认库）', () => {
    const d = defaultPromptConfig().recall as unknown as Record<string, unknown>;
    assert.equal('ranges' in d, false, 'recall 域不得有 ranges —— 否则范围出现第二个来源');
  });
});

describe('② 老配置兼容', () => {
  it('完全没有 recall 域时读取不报 issue', () => {
    writeRaw({ version: 1, prompt: { content: 'x' } });
    const r = readPromptConfig(cfg);
    assert.equal(r.issue, null, `不应产生 issue，实际：${r.issue}`);
    assert.ok(r.config.recall, '缺域时用默认补齐');
  });
});

describe('③ 读取软通道', () => {
  it('域内字段非法 → 只忽略该项，其余配置照常读取', () => {
    writeRaw({
      version: 1,
      prompt: { content: '我的对话提示词' },
      recall: { maxRounds: '不是数字', prompt: { content: '我的预取提示词' } },
    });
    const r = readPromptConfig(cfg);
    // 软通道：issue 里是「已忽略该项」的说明，**不是**「已回退默认」
    assert.ok(r.issue?.includes('已忽略该项'), `应为软提示，实际：${r.issue}`);
    assert.equal(r.issue?.includes('已回退默认'), false, '不得整份回退');
    assert.equal(r.config.prompt.content, '我的对话提示词', '对话提示词不能被连累');
    assert.equal(r.config.recall?.prompt.content, '我的预取提示词', '合法字段照常生效');
    assert.equal(r.config.recall?.maxRounds, 5, '非法项回落默认');
  });
});

describe('④ 锁定工具', () => {
  it('提交 false 也被强制为 true', () => {
    writeRaw({
      version: 1,
      prompt: { content: 'x' },
      recall: { tools: { ki_get_module_info: false, ki_search: false } },
    });
    const r = readPromptConfig(cfg);
    assert.equal(r.config.recall?.tools.ki_get_module_info, true, '锁定项不可关闭');
    assert.equal(r.config.recall?.tools.ki_search, false, '非锁定项尊重用户设置');
  });
});

describe('⑤ 保存语义', () => {
  it('maxRounds 越界 → PromptConfigError 且不落盘', () => {
    writeRaw({ version: 1, prompt: { content: 'x' } });
    const before = fs.readFileSync(promptConfigPath(cfg), 'utf8');
    assert.throws(
      () => savePromptConfig(cfg, { version: 1, prompt: { content: 'x' }, recall: { maxRounds: 99 } }),
      (err: unknown) => err instanceof PromptConfigError,
    );
    assert.equal(fs.readFileSync(promptConfigPath(cfg), 'utf8'), before, '失败不得落盘');
  });

  it('未提交 recall 时沿用磁盘既有值（防旧前端把配置重置为默认）', () => {
    savePromptConfig(cfg, {
      version: 1,
      prompt: { content: 'x' },
      recall: { prompt: { content: '用户改过的预取提示词' }, maxRounds: 9 },
    });
    // 模拟旧前端：整份替换但不认识 recall 域
    const next = savePromptConfig(cfg, { version: 1, prompt: { content: 'y' } });
    assert.equal(next.recall?.prompt.content, '用户改过的预取提示词', '旧前端保存不得冲掉预取配置');
    assert.equal(next.recall?.maxRounds, 9);
  });
});
