/**
 * 对话配置草稿拷贝（白名单）· 回归锁
 *
 * 背景：`PUT /api/chat/prompt-config` 是**整份替换**，草稿落一个字段 = 保存时把它清空。
 * 该坑在项目里已出现 4 次（contextChars / toolResponseChars / searchHitsPerCall / reasoningEffort），
 * 2026-11-15 新增 analysisPrompt / findPrompt 是第 5、6 个字段 —— 本文件把"必须搬运"变成可执行断言。
 *
 * 运行：cd web && node --test test/prompt-config-clone.test.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
  configFile: path.join(webRoot, 'vite.config.ts'),
  root: webRoot,
  server: { middlewareMode: true },
  appType: 'custom',
  logLevel: 'silent',
});

const { clonePromptConfig } = await vite.ssrLoadModule('/src/chat/promptConfigClone.ts');

after(async () => { await vite.close(); });

/** 最小合法配置（技能 / 工具各一条，便于发现"整体被换掉"） */
const base = () => ({
  version: 1,
  prompt: { content: '基础提示词', at: '2026-01-01T00:00:00.000Z' },
  skills: [{ id: 'my-skill', name: 'my-skill', description: 'd', content: 'c', builtin: false, enabled: true, at: 't' }],
  tools: { ki_search: true },
});

describe('clonePromptConfig · 白名单字段搬运', () => {
  it('能力级提示词（analysisPrompt / findPrompt）必须被搬运', () => {
    const src = {
      ...base(),
      analysisPrompt: { content: '分析', at: 'a' },
      findPrompt: { content: '查找', at: 'f' },
    };
    const draft = clonePromptConfig(src);
    assert.deepEqual(draft.analysisPrompt, { content: '分析', at: 'a' });
    assert.deepEqual(draft.findPrompt, { content: '查找', at: 'f' });
  });

  it('能力级提示词是**深拷**：改草稿不得改到基线（否则"没保存也生效了"）', () => {
    const src = { ...base(), analysisPrompt: { content: '原值', at: 'a' } };
    const draft = clonePromptConfig(src);
    draft.analysisPrompt.content = '改动后';
    assert.equal(src.analysisPrompt.content, '原值', '基线被草稿污染');
  });

  it('全部已知可选字段同时存在时一个都不丢', () => {
    const src = {
      ...base(),
      contextChars: 500000,
      toolResponseChars: 20000,
      searchHitsPerCall: 8,
      reasoningEffort: 'high',
      analysisPrompt: { content: '分析', at: 'a' },
      findPrompt: { content: '查找', at: 'f' },
    };
    const draft = clonePromptConfig(src);
    assert.equal(draft.contextChars, 500000);
    assert.equal(draft.toolResponseChars, 20000);
    assert.equal(draft.searchHitsPerCall, 8);
    assert.equal(draft.reasoningEffort, 'high');
    assert.equal(draft.analysisPrompt.content, '分析');
    assert.equal(draft.findPrompt.content, '查找');
  });

  it('未覆盖的可选字段保持缺失（不得凭空造出空对象）', () => {
    const draft = clonePromptConfig(base());
    assert.ok(!('analysisPrompt' in draft), '缺省 ≠ 空对象：空对象会被当成"用户清空"落盘');
    assert.ok(!('findPrompt' in draft));
    assert.ok(!('contextChars' in draft));
  });

  it('skills / tools 是独立副本（改草稿不污染基线）', () => {
    const src = base();
    const draft = clonePromptConfig(src);
    draft.skills[0].name = 'renamed';
    draft.tools.ki_search = false;
    assert.equal(src.skills[0].name, 'my-skill');
    assert.equal(src.tools.ki_search, true);
  });

  it('analysis 独立配置域（targetDirs / prompt / skills / tools）深拷且不污染基线；已取消的预算字段丢弃', () => {
    const src = {
      ...base(),
      analysis: {
        targetDirs: { defaultDir: '/root/ws', byScope: { mem: '/root/knowledge-indexer' } },
        prompt: { content: 'p', at: 't' },
        skills: [{ id: 'builtin-code-locate', name: 'code-locate', description: 'd', content: 'c', builtin: true, enabled: true, at: 't' }],
        tools: { fs_read: true, fs_grep: true },
        maxRounds: 8,
        maxFiles: 10,
        reasoningEffort: 'medium',
      },
    };
    const draft = clonePromptConfig(src);
    draft.analysis.targetDirs.byScope.mem = '/changed';
    draft.analysis.prompt.content = 'changed';
    draft.analysis.skills[0].enabled = false;
    draft.analysis.tools.fs_read = false;
    assert.equal(src.analysis.targetDirs.byScope.mem, '/root/knowledge-indexer');
    assert.equal(src.analysis.prompt.content, 'p');
    assert.equal(src.analysis.skills[0].enabled, true);
    assert.equal(src.analysis.tools.fs_read, true);
    // 2026-11-18：预算取消，旧值不再搬运（否则会被整份替换原样提交回去）
    assert.equal('maxRounds' in draft.analysis, false, 'maxRounds 已取消');
    assert.equal('maxFiles' in draft.analysis, false, 'maxFiles 已取消');
    assert.equal(draft.analysis.reasoningEffort, 'medium');
  });
});
