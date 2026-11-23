/**
 * analysis-ask-patch.test.ts —— 追问补丁的提取 / 模板校验 / 差异比对（S03 批 5）
 *
 * 运行：env -u NODE_OPTIONS -u BASH_ENV npx jiti test/events/analysis-ask-patch.test.ts
 *
 * 守三件事：
 *   ① **降级而不失败**：块坏 / 缺字段 → 只给 error，正文仍可用（N13）；
 *   ② **模板校验比人工编辑多一条**：槽位必须在该事件类型的骨架内（N20）；
 *   ③ **差异由程序判**：只差空白不算变化，增删节点要能指出来（R-20 / N16）。
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  diffProposal,
  extractProposal,
  validateProposal,
} from '../../src/lib/events/analysis-ask-patch.js';
import { CONCLUSION_MAX_CHARS } from '../../src/lib/events/analysis-edit.js';
import type { ConclusionNode } from '../../src/lib/events/types.js';

const fence = (json: string): string => '```ki-conclusion-patch\n' + json + '\n```';

const node = (text: string, kind: ConclusionNode['kind'] = 'symptom'): ConclusionNode => ({ kind, text });

describe('extractProposal：剥离与解析', () => {
  it('没有围栏块 → 原样返回，无 patch、无 error', () => {
    const r = extractProposal('这个问题的原因是路由没注册。');
    assert.equal(r.patch, undefined);
    assert.equal(r.error, undefined);
    assert.equal(r.answer, '这个问题的原因是路由没注册。');
  });

  it('正常块 → 解析出 patch，正文里不再有 JSON', () => {
    const raw = '补充一句：影响面还包含网关。\n\n' + fence(JSON.stringify({
      conclusion: '三处缺陷，含网关配置缺失',
      chain: [{ kind: 'root', text: '路由未注册' }, { kind: 'fix', text: '补路由注册', ref: 'src/a.ts:42' }],
      reason: '追问发现网关也缺配置',
    }));
    const r = extractProposal(raw);
    assert.deepEqual(r.patch?.chain.map((n) => n.kind), ['root', 'fix']);
    assert.equal(r.patch?.conclusion, '三处缺陷，含网关配置缺失');
    assert.equal(r.patch?.chain[1]!.ref, 'src/a.ts:42');
    assert.match(r.answer, /影响面还包含网关/);
    assert.ok(!r.answer.includes('ki-conclusion-patch'), '围栏块必须从正文剥离');
    assert.ok(!r.answer.includes('{'), '正文里不能残留 JSON');
  });

  it('多处围栏块 → 取第一个，且第二个不残留（改自"只认最后一个"）', () => {
    /*
     * 改判据的原因：模型常在块**之后**再提一句"以上为 ki-conclusion-patch 格式"，
     * 若取最后一个，那个提及就成了选中点，前面真补丁的 JSON 会整段漏进正文。
     * 取第一个真补丁 + 兜底擦除，任意组合下都不会泄漏。
     */
    const raw = fence(JSON.stringify({ conclusion: '旧的', chain: [] }))
      + '\n\n正文\n\n'
      + fence(JSON.stringify({ conclusion: '新的', chain: [] }));
    const r = extractProposal(raw);
    assert.equal(r.patch?.conclusion, '旧的', '取第一个真补丁');
    assert.ok(!r.answer.includes('"conclusion"'), '第二个块的 JSON 不得残留');
    assert.match(r.answer, /正文/);
  });

  it('坏 JSON → 有 error、无 patch，正文仍可用（N13 降级）', () => {
    const r = extractProposal('正文\n' + fence('{不是 JSON'));
    assert.equal(r.patch, undefined);
    assert.match(r.error ?? '', /不是合法 JSON/);
    assert.equal(r.answer, '正文');
  });

  it('缺 conclusion / 空 conclusion → 报错（不允许用补丁清空结论）', () => {
    assert.match(extractProposal(fence(JSON.stringify({ chain: [] }))).error ?? '', /缺少结论文本/);
    assert.match(extractProposal(fence(JSON.stringify({ conclusion: '   ', chain: [] }))).error ?? '', /缺少结论文本/);
  });

  it('chain 不是数组 → 报错', () => {
    assert.match(extractProposal(fence(JSON.stringify({ conclusion: 'x', chain: 'nope' }))).error ?? '', /必须是数组/);
  });
});

describe('validateProposal：视角骨架是补丁独有的那道闸', () => {
  const benign = { conclusion: '结论', chain: [node('现象')], reason: '' };

  it('fault 视角：5 槽合法 → 通过', () => {
    const chain = [
      node('a', 'symptom'), node('b', 'cause'), node('c', 'root'), node('d', 'impact'), node('e', 'fix'),
    ];
    assert.deepEqual(validateProposal({ ...benign, chain }, 'fault'), []);
  });

  it('change 视角：给 root → 判不合规并点名该类型没有这个槽（N20）', () => {
    const errs = validateProposal({ ...benign, chain: [node('a', 'root')] }, 'change');
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /不在该事件类型的模板里/);
    assert.match(errs[0]!, /可用槽位/);
  });

  it('节点数 / 文本长度 / ref 形状复用人工编辑口径', () => {
    const six = validateProposal({
      ...benign,
      chain: Array.from({ length: 6 }, (_, i) => node(`n${i}`)),
    }, 'fault');
    assert.match(six[0]!, /最多 5 个节点/);

    const longText = validateProposal({ ...benign, chain: [node('a'.repeat(201))] }, 'fault');
    assert.match(longText[0]!, /第 1 个节点/);

    const badRef = validateProposal({ ...benign, chain: [node('a', 'symptom'), { kind: 'cause', text: 'b', ref: 'x' }] }, 'fault');
    assert.match(badRef.join(' '), /路径:行号/);
  });

  it('conclusion 4000 通过、4001 被拒', () => {
    assert.deepEqual(validateProposal({ ...benign, conclusion: 'a'.repeat(CONCLUSION_MAX_CHARS) }, 'fault'), []);
    const errs = validateProposal({ ...benign, conclusion: 'a'.repeat(CONCLUSION_MAX_CHARS + 1) }, 'fault');
    assert.match(errs[0]!, /超过上限/);
  });
});

describe('diffProposal：由程序判定"是否真的不同"', () => {
  const cur = { conclusion: '旧结论', chain: [node('现象一'), node('根因一', 'root')] };

  it('完全一致 → changed=false（不弹框，N16）', () => {
    const d = diffProposal(cur, { conclusion: '旧结论', chain: cur.chain, reason: '' });
    assert.equal(d.changed, false);
    assert.deepEqual(d.blocks, []);
  });

  it('只差首尾空白 / 多空格 → 仍算一致（归一后比较）', () => {
    const d = diffProposal(cur, {
      conclusion: '  旧结论  ',
      chain: [{ kind: 'symptom', text: ' 现象一 ' }, { kind: 'root', text: '根因一' }],
      reason: '',
    });
    assert.equal(d.changed, false);
  });

  it('结论变化 → 一块「改」，带 before/after', () => {
    const d = diffProposal(cur, { conclusion: '新结论', chain: cur.chain, reason: '' });
    assert.equal(d.blocks.length, 1);
    assert.deepEqual(d.blocks[0], { block: 'conclusion', kind: '改', before: '旧结论', after: '新结论' });
  });

  it('新增节点 → 「增」；删除节点 → 「删」', () => {
    const added = diffProposal(cur, {
      conclusion: cur.conclusion,
      chain: [...cur.chain, node('建议一', 'fix')],
      reason: '',
    });
    assert.equal(added.blocks[0]!.kind, '增');
    assert.equal(added.blocks[0]!.after, '建议一');

    const removed = diffProposal(cur, { conclusion: cur.conclusion, chain: [cur.chain[0]!], reason: '' });
    assert.equal(removed.blocks[0]!.kind, '删');
    assert.equal(removed.blocks[0]!.before, '根因一');
  });

  it('当前没有结论（null）→ 补丁给出结论算「改」', () => {
    const d = diffProposal({ conclusion: null, chain: [] }, { conclusion: '首次给出', chain: [], reason: '' });
    assert.equal(d.blocks[0]!.block, 'conclusion');
    assert.equal(d.blocks[0]!.before, undefined);
  });
});

describe('extractProposal：真实输出形状（2026-11-23 真机踩坑）', () => {
  const payload = JSON.stringify({
    conclusion: '本项目不提供 PDF 导出',
    chain: [{ kind: 'root', text: '仓库无 PDF 生成依赖' }],
    reason: '纠正原结论',
  });

  it('标记与 JSON 同一行（带围栏）→ 必须解析出来', () => {
    const r = extractProposal('正文一句。\n\n```ki-conclusion-patch' + payload + '```');
    assert.equal(r.patch?.conclusion, '本项目不提供 PDF 导出');
    assert.equal(r.answer, '正文一句。');
  });

  it('完全没有围栏 → 也要解析并剥离', () => {
    const r = extractProposal('正文一句。\n\nki-conclusion-patch' + payload);
    assert.equal(r.patch?.conclusion, '本项目不提供 PDF 导出');
    assert.ok(!r.answer.includes('ki-conclusion-patch'), '正文不得残留标记');
    assert.ok(!r.answer.includes('{'), '正文不得残留 JSON');
  });

  it('闭合围栏被截断丢掉 → 仍能解析', () => {
    const r = extractProposal('正文\n```ki-conclusion-patch\n' + payload);
    assert.equal(r.patch?.conclusion, '本项目不提供 PDF 导出');
    assert.equal(r.answer, '正文');
  });

  it('围栏后面还有解释文字 → 解释要保留、补丁要删掉', () => {
    const r = extractProposal('正文\n```ki-conclusion-patch' + payload + '```\n以上是修正后的结论。');
    assert.equal(r.patch?.conclusion, '本项目不提供 PDF 导出');
    assert.match(r.answer, /以上是修正后的结论/);
    assert.ok(!r.answer.includes('"chain"'));
  });

  it('JSON 字符串里含花括号 → 不能被提前截断', () => {
    const tricky = JSON.stringify({
      conclusion: '结论里有 {占位符} 与 "引号"',
      chain: [{ kind: 'fix', text: '补 {x} 兜底' }],
      reason: '',
    });
    const r = extractProposal('正文\n```ki-conclusion-patch' + tricky + '```');
    assert.equal(r.patch?.conclusion, '结论里有 {占位符} 与 "引号"');
    assert.equal(r.patch?.chain[0]!.text, '补 {x} 兜底');
  });

  it('标记后没有 JSON → 至少把标记与残渣从正文删掉', () => {
    const r = extractProposal('正文\n```ki-conclusion-patch\n');
    assert.equal(r.patch, undefined);
    assert.match(r.error ?? '', /没有内容|缺少 JSON/);
    assert.equal(r.answer, '正文');
  });
  it('标记写成全大写 → 也要认（大小写不敏感）', () => {
    const r = extractProposal('正文\n```KI-CONCLUSION-PATCH' + payload + '```');
    assert.equal(r.patch?.conclusion, '本项目不提供 PDF 导出');
    assert.equal(r.answer, '正文');
  });
});

describe('JSON 永不泄漏（兜底擦除 & 多块/空正文）', () => {
  const payload = JSON.stringify({ conclusion: '新结论甲', chain: [], reason: '' });
  const payload2 = JSON.stringify({ conclusion: '新结论乙', chain: [], reason: '' });

  it('两个块 → 取第一个，后面的块也不残留', () => {
    const r = extractProposal('正文\n```ki-conclusion-patch' + payload + '```\n中间话\n```ki-conclusion-patch' + payload2 + '```');
    assert.equal(r.patch?.conclusion, '新结论甲', '应取第一个真补丁');
    assert.ok(!r.answer.includes('ki-conclusion-patch'), '标记不得残留');
    assert.ok(!r.answer.includes('"conclusion"'), 'JSON 不得残留');
    assert.match(r.answer, /中间话/);
  });

  it('块之后又提了一句格式 → 那句话里的标记也要擦掉', () => {
    const r = extractProposal('正文\n```ki-conclusion-patch' + payload + '```\n以上为 ki-conclusion-patch 格式。');
    assert.equal(r.patch?.conclusion, '新结论甲');
    assert.ok(!r.answer.includes('ki-conclusion-patch'), '末尾提到的标记词也不该留下');
  });

  it('只有补丁没有正文 → answer 为空串（由调用方给占位）', () => {
    const r = extractProposal('```ki-conclusion-patch' + payload + '```');
    assert.equal(r.patch?.conclusion, '新结论甲');
    assert.equal(r.answer, '');
  });

  it('正文里先提格式、后面才是真补丁 → 仍取真补丁', () => {
    const r = extractProposal('我会用 ki-conclusion-patch 格式给出：\n```ki-conclusion-patch' + payload + '```');
    assert.equal(r.patch?.conclusion, '新结论甲');
    assert.ok(!r.answer.includes('"conclusion"'));
  });
});



