/**
 * 对话配置「危险开关」二次确认 = **行内浮层、无遮罩**（2026-11-11 用户拍板 A 方案）。
 *
 * 结论：
 *  1. 确认卡**不再使用 `.ki-chat-cfg__mask`**：那张遮罩就地渲染在 `.ki-chat-cfg`
 *     （position:absolute + z-index:20）里，z-index 被困在层叠上下文 ⇒ 全屏 / 浮动阅读器
 *     （`.ki-drawer` z-index:1000）把卡片整块盖住，用户只看到"整屏变黑、确认框不弹"。
 *     现场证据：`.debug/chat-cfg-danger-confirm-blank-20261111/`（elementFromPoint = ki-drawer__body）。
 *  2. 定位必须是 `absolute` + 相对配置层现算（**不能改回 fixed**）：窄屏浮层
 *     `.ki-chat-panel--overlay` 的入场动画带 `both`，动画结束后 `transform` 仍在，
 *     `fixed` 的参照系会变成那块面板，坐标全体错位。
 *  3. 开关把自身作为锚点传进来（贴行弹出）；无锚点（删除 skill）退化到层头部下方。
 *  4. 三条关闭路径（取消 / Esc / 点外部）都走 `closeConfirm`：取消 = 不写草稿，焦点还给开关。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const layer = fs.readFileSync(path.join(webRoot, 'src/chat/PromptConfigLayer.tsx'), 'utf8');
const css = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');

/** 确认卡的渲染分支（从 `{confirm && (` 到该分支结束） */
function confirmBlock() {
  const start = layer.indexOf('{confirm && (');
  assert.ok(start > 0, '未找到确认卡渲染分支');
  const end = layer.indexOf(')}', layer.indexOf('ki-chat-cfg__confirm', start));
  return layer.slice(start, end > start ? end : start + 1200);
}

describe('对话配置 · 危险开关二次确认（行内浮层、无遮罩）', () => {
  it('确认卡不再使用遮罩，也不再自称模态', () => {
    const block = confirmBlock();
    assert.doesNotMatch(block, /ki-chat-cfg__mask/, '危险确认卡不得再用页面级遮罩（层叠上下文陷阱）');
    assert.doesNotMatch(block, /aria-modal/, '行内浮层不是模态，不得再声明 aria-modal');
    assert.match(block, /className="ki-chat-cfg__card ki-chat-cfg__confirm"/, '确认卡应落在 .ki-chat-cfg__confirm 上');
    assert.match(block, /role="dialog"/, '应为非模态 dialog');
  });

  it('定位用 absolute（fixed 会被窄屏浮层的 transform 带偏）', () => {
    const rule = css.slice(css.indexOf('.ki-chat-cfg__confirm {'));
    const body = rule.slice(0, rule.indexOf('}'));
    assert.match(body, /position:\s*absolute/, '.ki-chat-cfg__confirm 必须是 absolute');
    assert.doesNotMatch(body, /position:\s*fixed/, '不得改回 fixed');
  });

  it('开关把自己当锚点传进来', () => {
    assert.match(layer, /anchor:\s*e\.currentTarget/, '危险开关应把自身作为定位锚点');
  });

  it('三条关闭路径都走 closeConfirm（取消不写草稿、焦点归还）', () => {
    assert.match(layer, /const closeConfirm = useCallback/, '应有统一的 closeConfirm');
    assert.match(layer, /if \(confirm\) \{\s*closeConfirm\(\);/, 'Esc 应走 closeConfirm');
    assert.match(layer, /onClick=\{closeConfirm\}>取消/, '「取消」按钮应走 closeConfirm');
    assert.match(layer, /document\.addEventListener\('mousedown', onDown, true\)/, '点浮层外部应视为取消');
  });

  it('落点未算出前先藏起来，避免闪一下在左上角', () => {
    assert.match(layer, /style=\{confirmRect \?/);
    assert.match(layer, /\{ visibility: 'hidden' \}/);
  });
});

/**
 * 2026-11-12 真机事故：点 doc-editing（依赖 ki_edit_relation 未启用）弹出的确认卡
 * 只有 **36px 宽**（= 开关按钮宽度），正文可用宽度 2px ⇒ 中文逐字竖排、卡片 892px 高。
 * 证据：`.debug/cfg-confirm-vertical-20261112/`（w:36 / h4 2×136 / p 2×979 = 51 行）。
 *
 * 两个约束缺一不可：
 *  ① 锚行要认 skill 卡片 `.ki-chat-cfg__item`，否则宽度退化成开关；
 *  ② 宽度下限兜底，防以后新增的锚点又是窄元素。
 */
describe('对话配置 · 确认卡宽度（锚行 + 下限）', () => {
  it('锚行同时认工具行与 skill 卡片', () => {
    assert.match(
      layer,
      /anchor\.closest\('\.ki-chat-cfg__tool, \.ki-chat-cfg__item'\)/,
      'skill 开关在卡片里，只认 __tool 会让确认卡退化成开关宽度（36px → 正文逐字竖排）',
    );
  });

  it('宽度有下限，且仍夹在配置层内', () => {
    assert.match(layer, /const CONFIRM_MIN_WIDTH = \d+/, '缺少最小宽度常量');
    assert.match(
      layer,
      /Math\.min\(Math\.max\(a\.width, CONFIRM_MIN_WIDTH\), h\.width - 8\)/,
      '宽度应取 max(锚行宽, 下限) 后再与面板宽取 min —— 只加下限会顶出面板右边缘',
    );
  });
});

/** 用户 2026-11-12：「提示内容太多了，简洁一点，说明需要先开启 mcp 就可以了」 */
describe('对话配置 · skill 依赖确认文案保持简短', () => {
  it('文案一句话，且点明要开的是 MCP 工具', () => {
    const start = layer.indexOf('const toggleSkill');
    const end = layer.indexOf('const patchSkill', start);
    assert.ok(start > 0 && end > start, '未找到 toggleSkill');
    const body = layer.slice(start, end);
    const m = body.match(/text: `([^`]*)`/);
    assert.ok(m, 'toggleSkill 的确认卡应有 text');
    const text = m[1].replace(/\$\{need\}/g, 'ki_edit_relation');
    assert.match(text, /MCP/, '要点明"需要先开启的 MCP 工具"');
    assert.ok(text.length <= 40, `文案要短（当前 ${text.length} 字：${text}）`);
  });
});
