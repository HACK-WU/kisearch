/**
 * 引用 chip 的悬停预览（2026-11-11 用户要求）
 *
 * 用户口径：「鼠标放到引用上的显示效果，和鼠标放在来源上的一样，样式保持一致」。
 * 锁住五条不变量：
 *   1. 两处引用（草稿态 chip / 已发送回显）都渲染同一个 `RefPreview`，视觉取值与
 *      `.ki-chat-src__pop` **逐项一致**（描边 / 圆角 / 阴影 / 内距 / 宽度 / 层级 / 位移）；
 *   2. 浮层锚在**整行**（`.ki-chat-refs` 与 composer），不锚 chip —— chip 换行到右侧时，
 *      以它为基准的 300px 浮层会溢出面板被 overflow 裁掉（来源卡已踩过这个坑）；
 *   3. 原生 `title` 必须移除，否则与卡片叠成两套提示；
 *   4. 窄屏（≤760）与来源卡同口径隐藏（触屏无 hover）；
 *   5. 片段按 200 字截断（`ChatRef.text` 上限 2000 字符）。
 *
 * 运行：cd web && npm test
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const webRoot = fileURLToPath(new URL('..', import.meta.url));
const panel = fs.readFileSync(path.join(webRoot, 'src/chat/ChatPanel.tsx'), 'utf8');
const css = fs.readFileSync(path.join(webRoot, 'src/styles/ki.css'), 'utf8');

/** 取一条 CSS 规则块的内容（选择器需整行匹配，避免命中选择器列表里的子串） */
function ruleBody(selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`));
  assert.ok(m, `未找到 CSS 规则：${selector}`);
  return m[1];
}

/** 取块内某个声明的值（`null` 表示未声明） */
function prop(body, name) {
  const m = body.match(new RegExp(`(?:^|[\\s;])${name}\\s*:\\s*([^;]+);`));
  return m ? m[1].trim() : null;
}

describe('引用 chip · 悬停预览卡', () => {
  it('两处引用都渲染 RefPreview，且草稿态带「点击移除该引用」、已发送不带动作行', () => {
    assert.match(panel, /<RefPreview item=\{r\} hint="点击移除该引用" \/>/, '草稿态 chip 必须带动作提示');
    assert.match(panel, /<RefPreview item=\{r\} \/>/, '已发送的引用是只读回显，不带动词提示');
    assert.equal(
      [...panel.matchAll(/<RefPreview item=\{r\}/g)].length,
      2,
      '引用入口只有两处，多一处/少一处都说明漏改',
    );
  });

  it('原生 title 必须移除（否则与卡片叠成两套提示）', () => {
    assert.doesNotMatch(panel, /className="ki-chat-refs__item" title=\{r\.text\}/);
    assert.doesNotMatch(panel, /title=\{`移除引用：/);
    // 可访问名称不能跟着一起丢：草稿态 chip 补 aria-label
    assert.match(panel, /aria-label=\{`移除引用 \$\{i \+ 1\}：\$\{r\.doc\}`\}/);
  });

  it('视觉取值与来源卡逐项一致（改一处必须同步另一处）', () => {
    const src = ruleBody('.ki-chat-src__pop');
    const ref = ruleBody('.ki-chat-ref-pop');
    // `width` / `left` 是**刻意的合理差异**（见下方两条），其余逐项必须一致
    for (const name of ['bottom', 'z-index', 'padding', 'border', 'border-radius', 'background', 'box-shadow', 'text-align', 'white-space', 'transition']) {
      assert.equal(prop(ref, name), prop(src, name), `.ki-chat-ref-pop 的 ${name} 必须与 .ki-chat-src__pop 相同`);
    }
    // 宽度上限同（300px），但**不能**沿用来源卡的 `100%`：用户气泡收缩到内容宽（实测 142px）
    assert.match(prop(src, 'width'), /min\(300px/, '来源卡宽度上限应为 300px');
    assert.match(prop(ref, 'width'), /min\(300px/, '引用卡宽度上限应同为 300px');
    assert.doesNotMatch(prop(ref, 'width'), /100%\)/, '不得用 100%（会被窄气泡压扁）');
    // 内容元素的四条排版规则也要对齐
    for (const tag of ['b', 'em', 'q', 'u']) {
      const a = ruleBody(`.ki-chat-src__pop ${tag}`);
      const b = ruleBody(`.ki-chat-ref-pop ${tag}`);
      for (const name of ['display', 'font-size', 'color', 'line-height', 'margin-bottom', 'margin-top']) {
        assert.equal(prop(b, name), prop(a, name), `.ki-chat-ref-pop ${tag} 的 ${name} 必须与来源卡相同`);
      }
    }
  });

  it('浮层锚在整行而非 chip（chip 换行到右侧时 300px 浮层会被面板裁掉）', () => {
    // `.ki-chat-refs` 有两条规则（原 display 一条、本次补 position 一条），逐块扫
    assert.ok(
      /(?:^|\n)\.ki-chat-refs \{[^}]*position:\s*relative/.test(css),
      '.ki-chat-refs 必须提供 positioning context',
    );
    assert.doesNotMatch(ruleBody('.ki-chat-refs__item'), /position:\s*relative/, '不得给单个 chip 加定位，否则 300px 浮层跟 chip 漂移');
    assert.doesNotMatch(ruleBody('.ki-chat-refbar__chip'), /position:\s*relative/);
    // 草稿态与「+ 加入引用」说明卡同坐标
    assert.equal(
      prop(ruleBody('.ki-chat-refbar .ki-chat-ref-pop'), 'left'),
      prop(ruleBody('.ki-chat-refbar__pop'), 'left'),
      '草稿态浮层必须与 .ki-chat-refbar__pop 左对齐',
    );
    // 已发送的引用在右对齐气泡里 → 必须向左展开，否则 300px 卡片顶出视口右侧
    const inBubble = ruleBody('.ki-chat-refs .ki-chat-ref-pop');
    assert.equal(prop(inBubble, 'left'), 'auto');
    assert.equal(prop(inBubble, 'right'), '0');
  });

  it('hover / 键盘聚焦都触发，且窄屏与来源卡同口径隐藏', () => {
    assert.match(css, /\.ki-chat-refs__item:hover \.ki-chat-ref-pop/);
    assert.match(css, /\.ki-chat-refbar__chip:hover \.ki-chat-ref-pop/);
    // 片段原文只存在于浮层里：只给 hover 等于对键盘用户隐藏，两处都必须有焦点触发
    assert.match(css, /\.ki-chat-refs__item:focus-visible \.ki-chat-ref-pop/, '已发送引用必须支持键盘触发');
    assert.match(css, /\.ki-chat-refbar__chip:focus-visible \.ki-chat-ref-pop/, '草稿态 chip 必须支持键盘触发');
    assert.match(panel, /className="ki-chat-refs__item" tabIndex=\{0\}/, '只读 li 必须给焦点位才可能被 focus');
    assert.match(
      css,
      /@media \(max-width: 760px\) \{[\s\S]*?!important;[\s\S]*?\.ki-chat-panel \.ki-chat-ref-pop \{ display: none !important; \}/,
      '窄屏必须隐藏引用浮层（与 .ki-chat-src__pop 同口径）',
    );
  });

  it('片段按 200 字截断（ChatRef.text 上限 2000，整段塞进浮层会撑爆）', () => {
    assert.match(panel, /const REF_POP_SNIPPET_MAX = 200;/);
    assert.match(panel, /trimmed\.length > REF_POP_SNIPPET_MAX \? `\$\{trimmed\.slice\(0, REF_POP_SNIPPET_MAX\)\}…`/);
  });
});
