/**
 * event-desc-edit-grow.test.mjs —— 「事件描述」编辑框高度不塌陷（2026-11-24）
 *
 * 用户反馈：读态把描述整段展开（`.gov-desc-text` 无高度上限），点「编辑」后 textarea
 * 只有 `rows={4}` + `min-height:76px`，长描述缩成一条缝，根本没法改。
 *
 * 锁住四条容易回退的约定（无 jsdom，沿用仓库既有做法做源码契约断言）：
 *   1) 编辑框高度由内容驱动：先归零再按 `scrollHeight` 设高（可增可减，删行能收回去）；
 *   2) 补齐边框差：全局 border-box 下 `scrollHeight` 不含上下边框，不补会裁掉最后一行；
 *   3) 挂载即校准 + 宽度变化兜底 —— 条件渲染重挂载、窗口缩放换行数都要重新量；
 *   4) 只作用于描述内联编辑，共用 `.gov-textarea`（新建事件弹窗）不被牵连。
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

const card = read('src/components/governance/event-detail/EventSummaryCard.tsx');
const eventsPage = read('src/pages/EventsPage.tsx');
const css = read('src/styles/governance.css');

describe('① 高度由内容驱动', () => {
  it('先归零再按 scrollHeight 设高（不归零则删行后高度收不回去）', () => {
    assert.match(card, /ta\.style\.height = 'auto';/);
    // 只看「二次赋值用 scrollHeight」，不锁整行格式，避免改个空格就误报
    assert.match(card, /ta\.style\.height = `\$\{ta\.scrollHeight/);
  });

  it('补边框差，避免 border-box 下最后一行被裁', () => {
    // 2px 之差肉眼像「少一行」，故用 offsetHeight-clientHeight（此刻只剩边框）补齐
    assert.match(card, /offsetHeight - ta\.clientHeight/);
  });

  it('输入内容变化即重算（含取消后再进编辑的初值回填）', () => {
    assert.match(card, /useLayoutEffect\(\(\) => \{\s*if \(descEdit\.open\) syncDescHeight\(\);\s*\}, \[descEdit\.open, descEdit\.draft, syncDescHeight\]\);/);
  });
});

describe('② 重挂载与宽度变化', () => {
  it('textarea 挂载即校准（编辑态是条件渲染，rows=4 会先生效）', () => {
    assert.match(card, /ref=\{bindDesc\}/);
    assert.match(card, /syncDescHeight\(\);\s*if \(typeof ResizeObserver === 'undefined'\) return;/);
  });

  it('ResizeObserver 回调只比较宽度，避免改高度自激循环', () => {
    assert.match(card, /if \(el\.clientWidth === lastWidth\) return;/);
  });

  it('卸载时断开观察器，避免观察已移除的节点', () => {
    assert.match(card, /descRoRef\.current\?\.disconnect\(\);/);
  });
});

describe('③ 作用域只在描述内联编辑', () => {
  it('描述编辑框带 --fit 修饰类', () => {
    assert.match(card, /className="gov-textarea gov-textarea--fit"/);
  });

  it('CSS 关掉手动拖拽并对齐读态行高', () => {
    const fit = css.match(/\.gov-textarea--fit \{([^}]*)\}/);
    assert.ok(fit, '.gov-textarea--fit 必须存在');
    assert.match(fit[1], /resize: none;/);
    assert.match(fit[1], /line-height: 1\.6;/);
    // 读态行高：进出编辑态时逐行位置不跳
    assert.match(css, /\.gov-desc-text \{[\s\S]*?line-height: 1\.6;/);
  });

  it('新建事件弹窗继续用未修饰的 .gov-textarea（rows=3 不受影响）', () => {
    assert.match(eventsPage, /className="gov-textarea"[\s\S]{0,80}rows=\{3\}/);
    assert.doesNotMatch(eventsPage, /gov-textarea--fit/);
  });
});
