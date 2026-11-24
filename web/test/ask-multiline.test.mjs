/**
 * ask-multiline.test.mjs —— 追问输入框支持多行（2026-11-24 用户要求）
 *
 * 锁住四条容易回退的约定（无 jsdom，沿用仓库既有做法做源码契约断言）：
 *   1) 输入元素是 textarea（单行 `<input>` 装不下 Shift+Enter 的换行）；
 *   2) **Enter 发送 / Shift+Enter 换行** —— shift 必须放行浏览器默认行为，
 *      且中文输入法组合态一律放行（Enter 用来上屏候选，不能当发送）；
 *   3) 高度跟内容走：先归零再取 scrollHeight（删行才收得回去），上下限在 CSS；
 *   4) 发送键**贴底**（`align-items: flex-end`）—— 输入框长高时按钮停在右下，
 *      不能上下居中、也不能被 stretch 拉成竖条。
 *
 * 运行：cd web && npm run test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(webRoot, rel), 'utf-8');

const block = read('src/components/governance/event-detail/AskBlock.tsx');
const css = read('src/styles/governance.css');

describe('① 输入元素', () => {
  it('用 textarea 而不是单行 input', () => {
    assert.match(block, /<textarea\s+className="gov-input gov-ask__ta"/);
    assert.doesNotMatch(block, /<input\s+className="gov-input"/, '不应再退回单行 input');
    assert.match(block, /rows=\{1\}/, '单行起步，靠 JS 增高');
  });

  it('字数上限与禁用条件保持不变', () => {
    assert.match(block, /maxLength=\{4000\}/);
    assert.match(block, /disabled=\{!canAsk \|\| asking \|\| Boolean\(remote\)\}/);
  });
});

describe('② 回车语义', () => {
  it('Shift+Enter 放行浏览器默认行为（换行），不发送', () => {
    const keydown = block.slice(block.indexOf('onKeyDown={(e) => {'), block.indexOf('title={askTitle}', block.indexOf('onKeyDown={(e) => {')));
    assert.match(keydown, /if \(e\.shiftKey\) return;/);
    // preventDefault 必须在 shift 判断之后：放到前面会把换行也拦掉
    assert.ok(
      keydown.indexOf('e.shiftKey') < keydown.indexOf('e.preventDefault()'),
      'shift 判断必须在 preventDefault 之前',
    );
  });

  it('中文输入法组合态一律放行', () => {
    assert.match(block, /if \(e\.key !== 'Enter' \|\| e\.nativeEvent\.isComposing\) return;/);
  });

  it('placeholder 说明 Shift+Enter 换行', () => {
    assert.match(block, /Enter 发送，Shift\+Enter 换行/);
  });
});

describe('③ 高度跟随内容', () => {
  it('先归零再取 scrollHeight（删行能收回去）', () => {
    assert.match(block, /ta\.style\.height = 'auto';/);
    assert.match(block, /ta\.style\.height = `\$\{ta\.scrollHeight\}px`;/);
  });

  it('内容变化（含发送后清空）都重算高度', () => {
    assert.match(block, /useEffect\(\(\) => \{ syncTaHeight\(\); \}, \[question, syncTaHeight\]\);/);
  });

  it('上下限在 CSS，不写死在 JS', () => {
    assert.match(css, /\.gov-ask__ta\s*\{[^}]*min-height: 30px;[^}]*max-height: 134px;/s);
    assert.match(css, /\.gov-ask__ta\s*\{[^}]*resize: none;/s);
  });
});

describe('④ 发送键贴底', () => {
  it('输入行 align-items: flex-end（不居中、不拉伸）', () => {
    assert.match(css, /\.gov-ask__input\s*\{[^}]*align-items: flex-end;/s);
  });
});
