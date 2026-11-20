/**
 * 「选中文档内容 → AI 引用」判定与守卫单测（chat/refSelection.ts）
 *
 * 锁住三条不变量（2026-10-15）：
 *   1) 守卫顺序与文案：条数 → 单条截断 → 合计 → 重复（后端 `CHAT_REF_TOTAL_MAX` 是硬闸门，
 *      前端漏拦 = 操作看似合法但发送必 400）；
 *   2) 划选入口与 Ctrl+L 入口共用**同一份**判定 —— 本文件锁的就是那份唯一实现；
 *   3) 候选构造只在「有文本 + 有查看器 + 有文档名」时成立，其余为静默忽略。
 *
 * 运行：cd web && npm run test
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
const { CHAT_REF_MAX_COUNT, CHAT_REF_TEXT_MAX, CHAT_REF_TOTAL_MAX } = await vite.ssrLoadModule('/src/api/chatContract.ts');
const { buildRefCandidate, checkRefAdd, refDocBudget } = await vite.ssrLoadModule('/src/chat/refSelection.ts');
after(async () => vite.close());

/** 假 drawer：本模块只用到 `getAttribute`（真实类型是 Element） */
const fakeDrawer = (doc, group) => ({
  getAttribute: (k) => (k === 'data-ki-doc-name' ? doc : k === 'data-ki-doc-group' ? group : null),
});
const candidate = (text, doc = 'doc-a', group = 'g/a') => ({ group, doc, text });
const refOf = (text, doc = 'doc-a', group = 'g/a') => ({ group, doc, text });

describe('buildRefCandidate', () => {
  it('正常：取文档身份 + trim 选区文本', () => {
    assert.deepEqual(buildRefCandidate('  hello  ', fakeDrawer('doc-a', 'g/a')), {
      group: 'g/a',
      doc: 'doc-a',
      text: 'hello',
    });
  });

  it('空 / 纯空白选区 → null（静默忽略）', () => {
    assert.equal(buildRefCandidate('', fakeDrawer('doc-a', 'g/a')), null);
    assert.equal(buildRefCandidate('   \n ', fakeDrawer('doc-a', 'g/a')), null);
  });

  it('无查看器 / 查看器没有文档名 → null', () => {
    assert.equal(buildRefCandidate('hi', null), null);
    assert.equal(buildRefCandidate('hi', fakeDrawer('', 'g/a')), null);
  });

  it('group 缺失时降级为空串（doc 仍是身份主键）', () => {
    assert.deepEqual(buildRefCandidate('hi', fakeDrawer('doc-a', null)), {
      group: '',
      doc: 'doc-a',
      text: 'hi',
    });
  });
});

describe('checkRefAdd 守卫', () => {
  it('正常加入：返回 ref + 成功文案（含文档名与字数）', () => {
    const r = checkRefAdd([], candidate('hello'));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ref, refOf('hello'));
    assert.equal(r.message, '已加入引用：doc-a（5 字）');
  });

  it('单条超长：截断到 CHAT_REF_TEXT_MAX 并在文案里说明', () => {
    const long = 'x'.repeat(CHAT_REF_TEXT_MAX + 100);
    const r = checkRefAdd([], candidate(long));
    assert.equal(r.ok, true);
    assert.equal(r.ref.text.length, CHAT_REF_TEXT_MAX);
    assert.equal(r.message, `已加入引用（超长已截断至 ${CHAT_REF_TEXT_MAX} 字）：doc-a`);
  });

  it('条数达上限：拒绝并提示（先于长度判定）', () => {
    const refs = Array.from({ length: CHAT_REF_MAX_COUNT }, (_, i) => refOf(`t${i}`));
    const r = checkRefAdd(refs, candidate('new'));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'max-count');
    assert.equal(r.message, `一次提问最多引用 ${CHAT_REF_MAX_COUNT} 段内容，请先移除一条`);
  });

  it('合计超 CHAT_REF_TOTAL_MAX：拒绝并回显当前用量', () => {
    const refs = [refOf('a'.repeat(4000)), refOf('b'.repeat(1500))];
    const r = checkRefAdd(refs, candidate('c'.repeat(1000)));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'total-max');
    assert.match(r.message, new RegExp(String(CHAT_REF_TOTAL_MAX)));
  });

  it('合计恰好等于上限：放行（边界用「严格大于」判定）', () => {
    const refs = [refOf('a'.repeat(CHAT_REF_TOTAL_MAX - 10))];
    const r = checkRefAdd(refs, candidate('b'.repeat(10)));
    assert.equal(r.ok, true);
  });

  it('重复（同 group/doc/text）：拒绝并提示', () => {
    const r = checkRefAdd([refOf('hello')], candidate('hello'));
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'duplicate');
    assert.equal(r.message, '这段内容已在引用中：doc-a');
  });

  it('同 doc 不同文本 / 同文本不同 doc 都不算重复', () => {
    assert.equal(checkRefAdd([refOf('hello')], candidate('world')).ok, true);
    assert.equal(checkRefAdd([refOf('hello', 'doc-b')], candidate('hello', 'doc-a')).ok, true);
  });
});

/**
 * 整篇引用（kind='doc'，2026-11-20）。
 *
 * 锁住三条与片段**不同**的口径：
 *   1) 去重按文档身份（group + doc），不按正文 —— 整篇正文随剩余预算变化，文本比对会漏拦；
 *   2) 成功文案必须交代「原文 M 字 / 截断至 N 字」，不能让用户以为点了就引用了全文；
 *   3) 整篇与片段可共存（同一文档「整篇打底 + 某段强调」是合理诉求）。
 */
describe('checkRefAdd 整篇引用（kind=doc）', () => {
  const docCandidate = (text, doc = 'doc-a', group = 'g/a', totalChars) => ({
    group, doc, text, kind: 'doc',
    ...(totalChars !== undefined ? { totalChars } : {}),
  });

  it('长文档：ref 带 kind 与原文总字数，文案交代原文规模与截断结果', () => {
    const long = 'x'.repeat(CHAT_REF_TEXT_MAX + 500);
    const r = checkRefAdd([], docCandidate(long, 'doc-a', 'g/a', long.length));
    assert.equal(r.ok, true);
    assert.equal(r.ref.kind, 'doc');
    assert.equal(r.ref.text.length, CHAT_REF_TEXT_MAX);
    assert.equal(r.ref.totalChars, long.length);
    assert.equal(r.message, `已引用整篇：doc-a（原文 ${long.length} 字，截断至 ${CHAT_REF_TEXT_MAX} 字）`);
  });

  it('短文档：未截断不写 totalChars（不制造「原文 N 字」噪音）', () => {
    const r = checkRefAdd([], docCandidate('短正文', 'doc-a', 'g/a', 3));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ref, { group: 'g/a', doc: 'doc-a', text: '短正文', kind: 'doc' });
    assert.equal(r.message, '已引用整篇：doc-a（3 字）');
  });

  it('整篇按文档身份去重：同文档不同正文仍拒绝', () => {
    const first = checkRefAdd([], docCandidate('第一段正文', 'doc-a', 'g/a', 5));
    assert.equal(first.ok, true);
    const again = checkRefAdd([first.ref], docCandidate('完全不同的正文', 'doc-a', 'g/a', 99));
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'duplicate');
    assert.equal(again.message, '该文档的整篇已在引用中：doc-a');
  });

  it('整篇与片段可并存（同文档）', () => {
    const docRef = { group: 'g/a', doc: 'doc-a', text: '整篇正文', kind: 'doc' };
    assert.equal(checkRefAdd([docRef], candidate('highlight')).ok, true);
  });

  it('整篇同样受条数与合计上限约束', () => {
    const full = Array.from({ length: CHAT_REF_MAX_COUNT }, (_, i) => refOf(`t${i}`));
    assert.equal(checkRefAdd(full, docCandidate('x')).reason, 'max-count');
    const big = [refOf('a'.repeat(CHAT_REF_TOTAL_MAX - 5))];
    assert.equal(checkRefAdd(big, docCandidate('x'.repeat(10))).reason, 'total-max');
  });
});

/**
 * 整篇正文预算（2026-11-20）。
 *
 * 两个入口（弹窗底部按钮 / 面板「+ 整篇」）都靠它决定截断长度：
 * 只看单条 2000 不看合计剩余，会在"已有 5900 字引用"时直接撞后端 `CHAT_REF_TOTAL_MAX`。
 */
describe('refDocBudget 整篇正文预算', () => {
  it('无引用 → 取单条上限', () => {
    assert.equal(refDocBudget([]), CHAT_REF_TEXT_MAX);
  });

  it('已用不多 → 仍是单条上限（合计空间足够）', () => {
    assert.equal(refDocBudget([refOf('a'.repeat(1000))]), CHAT_REF_TEXT_MAX);
  });

  it('合计临近上限 → 收缩到剩余空间', () => {
    assert.equal(refDocBudget([refOf('a'.repeat(CHAT_REF_TOTAL_MAX - 100))]), 100);
  });

  it('合计已满 / 超出 → 0（调用方据此禁用按钮并说明原因）', () => {
    assert.equal(refDocBudget([refOf('a'.repeat(CHAT_REF_TOTAL_MAX))]), 0);
    assert.equal(refDocBudget([refOf('a'.repeat(CHAT_REF_TOTAL_MAX + 10))]), 0);
  });
});
