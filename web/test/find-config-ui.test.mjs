/**
 * AI 查找配置 UI（REQ-20261116-005 · S-01 前端）· 回归锁
 *
 * 三类断言：
 *   ① 草稿白名单必须搬运 `find`（漏一个子字段 = 保存时被静默清空，项目已踩过 4 次）；
 *   ② find 分组的渲染标记存在（范围多选、一期横幅、工具开关）；
 *   ③ 左栏不再出现"未接入"（检索范围已真实生效）。
 *
 * 运行：cd web && node --test test/find-config-ui.test.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

const base = () => ({
  version: 1,
  prompt: { content: 'chat', at: 'a' },
  skills: [{ id: 'builtin-retrieval', name: 'knowledge-retrieval', description: '', content: 'c', builtin: true, enabled: true, at: 'a' }],
  tools: { ki_search: true },
  find: {
    ranges: { extraScopes: ['kisearch-docs'], byScope: { other: ['x'] } },
    prompt: { content: '找文档', at: 'b' },
    skills: [{ id: 'builtin-refs-locate', name: 'refs-locate', description: 'd', content: 'c2', builtin: true, enabled: true, at: 'b' }],
    tools: { ki_search: true, ki_get_module_info: false, ki_group_list: true, ki_tag_list: true },
    maxRounds: 4,
    maxCandidates: 12,
    timeoutMs: 45000,
    reasoningEffort: 'high',
  },
});

describe('① 草稿拷贝必须搬运 find（整份替换语义）', () => {
  it('六个子块全部保留', () => {
    const out = clonePromptConfig(base());
    assert.ok(out.find, 'find 域不得丢失');
    assert.deepEqual(out.find.ranges.extraScopes, ['kisearch-docs']);
    assert.deepEqual(out.find.ranges.byScope, { other: ['x'] }, '预留字段也要搬，否则手工配置被清掉');
    assert.equal(out.find.prompt.content, '找文档');
    assert.equal(out.find.skills.length, 1);
    assert.equal(out.find.tools.ki_get_module_info, false);
    assert.equal(out.find.maxRounds, 4);
    assert.equal(out.find.maxCandidates, 12);
    assert.equal(out.find.timeoutMs, 45000);
    assert.equal(out.find.reasoningEffort, 'high');
  });

  it('深拷：改草稿不影响原对象（否则"没保存也生效了"）', () => {
    const src = base();
    const out = clonePromptConfig(src);
    out.find.ranges.extraScopes.push('leak');
    out.find.tools.ki_search = false;
    out.find.prompt.content = 'changed';
    assert.deepEqual(src.find.ranges.extraScopes, ['kisearch-docs']);
    assert.equal(src.find.tools.ki_search, true);
    assert.equal(src.find.prompt.content, '找文档');
  });

  it('find 缺省时不动其它字段', () => {
    const noFind = base();
    delete noFind.find;
    const out = clonePromptConfig(noFind);
    assert.equal(out.find, undefined);
    assert.equal(out.prompt.content, 'chat');
  });
});

describe('② 渲染标记', () => {
  const layerSrc = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');

  it('find 分组含：范围多选、一期横幅、工具开关、提示词卡', () => {
    assert.match(layerSrc, /capability === 'find'/, '要有 find 专属分支');
    assert.match(layerSrc, /检索范围/, '范围块标题');
    assert.match(layerSrc, /ScopeMultiPicker[\s\S]{0,400}findScopeOptions/s, '范围选择复用 ScopeMultiPicker');
    assert.match(layerSrc, /深度查找上线后生效/, '一期必须如实标注哪些块不生效');
    assert.match(layerSrc, /findToolGroups/, '工具清单由服务端下发，前端不硬编码');
    assert.match(layerSrc, /检索定位提示词/, '提示词卡名称已改口径');
  });

  it('find 分支不再沿用「未接入」文案', () => {
    const findBlock = layerSrc.slice(layerSrc.indexOf("capability === 'find'"));
    const head = findBlock.slice(0, 4000);
    assert.equal(head.includes('未接入'), false, '检索范围已生效，不得再显示未接入');
  });

  it('左栏分组说明不含「未接入」', () => {
    const pageSrc = fs.readFileSync(path.join(webRoot, 'src/pages/AiSettingsPage.tsx'), 'utf8');
    assert.equal(pageSrc.includes('确定性检索 · 未接入'), false);
  });
});

describe('④ 二期双通道 UI 标记（REQ-20261116-005 · B8）', () => {
  const read = (rel) => fs.readFileSync(path.join(webRoot, 'src', rel), 'utf-8');

  it('查找弹窗有「快速 / 深度」切换、停止按钮，并把 partial / unconfirmed / parsed 透给过程面板', () => {
    const s = read('components/governance/FindRefModal.tsx');
    assert.ok(s.includes("useState<'fast' | 'deep'>('fast')"), '默认走快速查找（深度成本可见才选）');
    assert.ok(s.includes('深度查找（AI）'), '模式入口必须可见');
    assert.ok(s.includes('onClick={stop}'), '深度查找必须有停止');
    assert.ok(s.includes('partial: result.partial'), '结果不完整必须如实透给面板');
    assert.ok(s.includes('parsed: result.parsed'), '模型未给出可解析结果要与"没有相关文档"分开');
    assert.ok(s.includes("mode === 'deep' ? 75_000 : 15_000"), '深度通道客户端超时要比后端硬超时更长');
  });

  it('过程面板为 tools / verify 两步给出人话文案，且提示不完整', () => {
    const s = read('components/governance/AiProcessPanel.tsx');
    assert.ok(s.includes("case 'tools'"));
    assert.ok(s.includes("case 'verify'"));
    assert.ok(s.includes('partial.usedRounds'));
    assert.ok(s.includes('unconfirmedCount'));
  });

  it('查找 skill 卡片可点进正文编辑（一期遗留偏差已补）', () => {
    const s = read('chat/PromptConfigLayer.tsx');
    assert.ok(s.includes("{ kind: 'find-skill', id: s.id }"), '卡片要能打开编辑弹窗');
    assert.ok(s.includes("if (modal.kind === 'find-skill')"), '保存 / 恢复默认要处理该类型');
  });
});
