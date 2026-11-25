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
    prompt: { content: '找文档', at: 'b' },
    skills: [{ id: 'builtin-refs-locate', name: 'refs-locate', description: 'd', content: 'c2', builtin: true, enabled: true, at: 'b' }],
    tools: { ki_search: true, ki_get_module_info: false, ki_group_list: true, ki_tag_list: true },
    maxRounds: 4,
    maxCandidates: 12,
    timeoutMs: 45000,
    reasoningEffort: 'high',
    maxToolCalls: 12,
  },
});

describe('① 草稿拷贝必须搬运 find（整份替换语义）', () => {
  it('子块全部保留，已取消的预算字段不再搬运', () => {
    const out = clonePromptConfig(base());
    assert.ok(out.find, 'find 域不得丢失');
    assert.equal(out.find.prompt.content, '找文档');
    assert.equal(out.find.skills.length, 1);
    assert.equal(out.find.tools.ki_get_module_info, false);
    assert.equal(out.find.reasoningEffort, 'high');
    // 2026-11-19：工具调用次数上限必须搬（漏搬 = 改别的配置一保存就被静默清空）
    assert.equal(out.find.maxToolCalls, 12, 'maxToolCalls 必须被搬运');
    // 2026-11-18：轮次 / 候选 / 超时预算整体取消 —— 草稿即使带着旧值也不再搬运
    assert.equal('maxRounds' in out.find, false, 'maxRounds 已取消');
    assert.equal('maxCandidates' in out.find, false, 'maxCandidates 已取消');
    // 2026-11-25：超时重新启用（默认 60s），必须搬运（漏搬 = 改别的配置一保存就被清空）
    assert.equal(out.find.timeoutMs, 45000, 'timeoutMs 必须被搬运');
  });

  it('深拷：改草稿不影响原对象（否则"没保存也生效了"）', () => {
    const src = base();
    const out = clonePromptConfig(src);
    out.find.tools.ki_search = false;
    out.find.prompt.content = 'changed';
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

  it('find 分组含：范围多选、工具开关、提示词卡（不再有「待生效」横幅）', () => {
    assert.match(layerSrc, /capability === 'find'/, '要有 find 专属分支');
    // 2026-11-25（批 3）：检索范围白名单已删除 —— 模型按问题自选 scope
    assert.equal(/检索范围/.test(layerSrc), false, '范围块必须移除');
    assert.equal(/findScopeOptions/.test(layerSrc), false, '范围选择器已随块删除');
    // REQ-20261118-004：取消 fast 后所有块都生效，「待生效」横幅必须消失
    assert.equal(/深度查找上线后生效/.test(layerSrc), false, '不得再出现「待生效」横幅');
    assert.match(layerSrc, /findToolGroups/, '工具清单由服务端下发，前端不硬编码');
    assert.match(layerSrc, /检索定位提示词/, '提示词卡名称已改口径');
  });

  it('find 分组含「工具调用上限」：边界与默认值都读服务端 limits，且没有"不限制"档', () => {
    assert.match(layerSrc, /工具调用上限/, '新增块必须渲染');
    assert.match(layerSrc, /findMinToolCalls[\s\S]{0,80}findMaxToolCalls/s, '取值边界由服务端下发，前端不硬编码');
    assert.match(layerSrc, /findToolCallsDefault/, '默认值也由服务端下发（「恢复默认」的目标值）');
    assert.match(layerSrc, /maxToolCalls/, '要写进 find 配置域');
    // 2026-11-19 用户拍板：默认 10 次，不允许"不限制"
    assert.equal(/留空\s*=\s*不限制/.test(layerSrc), false, '不得再有「留空 = 不限制」的口径');
    // 旧版 daemon 不返回上下界 → 必须锁住并说明，不能让人改完以为生效了
    assert.match(layerSrc, /findCallsSupported/, '缺字段时要有降级判断');
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

describe('④ 查找面板：只有模型通道（REQ-20261118-004 取消 fast）', () => {
  const read = (rel) => fs.readFileSync(path.join(webRoot, 'src', rel), 'utf-8');

  it('面板不再有「快速 / 深度」切换，保留停止与 partial / parsed 透传', () => {
    const s = read('components/governance/FindRefPanel.tsx');
    assert.equal(/useState<'fast' \| 'deep'>/.test(s), false, '模式切换必须删除');
    assert.equal(s.includes('深度查找（AI）'), false, '模式入口按钮必须删除');
    assert.equal(s.includes('改用快速查找'), false, '兜底按钮无目标，必须删除');
    assert.ok(s.includes("const mode = 'deep' as const"), '通道固定为模型');
    assert.ok(s.includes('onClick={stop}'), '模型查找必须有停止');
    assert.ok(s.includes('partial: result.partial'), '结果不完整必须如实透给面板');
    assert.ok(s.includes('parsed: result.parsed'), '模型未给出可解析结果要与"没有相关文档"分开');
    // 客户端超时必须覆盖「排队 20s + 执行 60s」两端，否则后端还在等、前端先报超时
    assert.ok(s.includes('95_000'), '模型通道客户端超时要覆盖排队 + 执行');
  });

  it('过程面板为 tools / verify 两步给出人话文案，且提示不完整', () => {
    const s = read('components/governance/AiProcessPanel.tsx');
    assert.ok(s.includes("case 'tools'"));
    assert.ok(s.includes("case 'verify'"));
    assert.ok(s.includes('partial.usedRounds'));
    assert.ok(s.includes('unconfirmedCount'));
    assert.ok(s.includes('gov-ai-proc__unconfirmed'), '被剔除的明细要可折叠展示（供排障）');
    assert.ok(s.includes('queuedMs'), '排队耗时要说出来，别让用户误以为检索慢');
  });

  it('查找 skill 卡片可点进正文编辑（一期遗留偏差已补）', () => {
    const s = read('chat/PromptConfigLayer.tsx');
    assert.ok(s.includes("{ kind: 'find-skill', id: s.id }"), '卡片要能打开编辑弹窗');
    assert.ok(s.includes("if (modal.kind === 'find-skill')"), '保存 / 恢复默认要处理该类型');
  });
});
