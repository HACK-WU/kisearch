/**
 * 编辑重发态输入框的焦点环（2026-11-11 用户反馈「边框会发光」）。
 *
 * 结论：
 *  1. `.ki-chat-edit__ta` 只写 `outline: none` 不够 —— 本文件下方那条**无作用域前缀**的全局
 *     `:focus-visible { outline: 2px solid primary; outline-offset: 2px; border-radius: 6px }`
 *     特异性同为 (0,1,0) 却定义更晚 ⇒ 后者胜出，`autoFocus` 打开编辑态时内层 textarea
 *     长出 2px 主色描边，与外层 `.ki-chat-edit` 的 1px 主色边框叠成「发光双框」。
 *  2. 因此必须补一条 `.ki-chat-edit__ta:focus-visible { outline: none }`（可参照
 *     `.ki-chat-composer__ta:focus-visible` 的既有口径）。
 *  3. 焦点指示不因此丢失：`.ki-chat-edit` 容器本身常驻主色边框。
 *
 * 为什么守这些：这是「组件写 outline:none、全局焦点环后置覆盖」的层叠陷阱，
 * 单看组件那条规则完全看不出问题；一旦有人觉得 `:focus-visible { outline: none }` 冗余而删掉，
 * 双框会原样回来（真机已验证：删掉后 computed outline 立刻回到 `2px solid`）。
 *
 * 源码守卫：纯 CSS 契约，按字符串断言。
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const css = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');

/** 取某选择器（含其后最少一段声明）在文件中的原文片段 */
function ruleOf(selector) {
  const i = css.indexOf(`${selector} {`);
  assert.ok(i > 0, `未找到规则 ${selector}`);
  const end = css.indexOf('}', i);
  assert.ok(end > i, `规则 ${selector} 未闭合`);
  return { at: i, body: css.slice(i, end + 1) };
}

describe('编辑重发态焦点环', () => {
  it('textarea 显式压制 :focus-visible 焦点环', () => {
    const { body } = ruleOf('.ki-chat-edit__ta:focus-visible');
    // `outline: 0` 与 `none` 等价，别让等价写法被判红
    assert.match(body, /outline:\s*(none|0)/, '必须写 outline: none（或等价的 0），否则被全局 :focus-visible 覆盖');
  });

  it('全局 :focus-visible 仍是「无作用域前缀」的通配规则（压制它的前提）', () => {
    const i = css.indexOf('\n:focus-visible {');
    assert.ok(i > 0, '未找到全局 :focus-visible 规则 —— 若该规则已删除或已加作用域前缀，本条守卫可放宽');
    const body = css.slice(i, css.indexOf('}', i));
    assert.match(body, /outline:\s*2px solid/, '全局规则应为主色 2px 描边（组件需据此显式压制）');
  });

  it('焦点指示不丢失：编辑态容器常驻主色边框', () => {
    const { body } = ruleOf('.ki-chat-edit');
    assert.match(body, /border:\s*1px solid var\(--ki-color-primary\)/,
      '容器边框是去掉 textarea 描边后唯一的焦点/编辑态指示，不得删除');
  });

  it('与对话输入区口径一致（同一处陷阱的既有解法）', () => {
    const { body } = ruleOf('.ki-chat-composer__ta:focus-visible');
    assert.match(body, /outline:\s*(none|0)/, '输入区同样依赖显式压制，两处口径应一致');
  });
});
