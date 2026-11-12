/**
 * ComposerMirror —— 输入框的**只读高亮镜像**（2026-11-12）。
 *
 * ═══ 为什么需要这一层 ═══
 * `textarea` 无法只给一段文字加样式（没有内联标记能力）。要做到"`/名称` 显示成带标志的
 * 主色块"，只能把同一份文本**再画一遍**：`textarea` 文字设为透明（光标保留），
 * 镜像层在下面按分段渲染彩色文本与 token 块。
 *
 * ═══ 三条必须守住的约定 ═══
 * 1. **排版必须逐项同源**：镜像层的字体 / 行高 / 字距 / 内距 / 换行策略全部从 textarea 的
 *    `getComputedStyle` 现取（`MIRRORED` 清单）。写死一份 CSS 会与
 *    `.ki-chat-panel .ki-chat-composer__ta` 这类高特异性覆盖打架 —— 而且只在特定字号下错位。
 * 2. **左侧外扩 `BLEED_LEFT`**：行首 token 的色块与标志要画进输入框内边距里，否则会被
 *    `overflow: hidden` 裁掉。做法是镜像层整体左移 14px、`padding-left` 补 14px ——
 *    文本起点因此仍在原位（`-14 + padding+14`），只有可绘区域变大。
 * 3. **不接管任何交互**：`pointer-events: none` + `aria-hidden`，选区、光标、输入法候选框
 *    全部仍由 textarea 负责；镜像层只跟 `scrollTop`。
 *
 * ⚠️ 只在草稿里真的有生效 token 时才渲染（调用方加 `data-tokenized`）——
 *    没有 token 时输入框完全走原生渲染，不存在"为了一个特性改了全站输入框"的回归面。
 */
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import type { ComposerSegment } from './skillSlash';

/** 镜像层向左外扩的像素（容纳行首 token 的色块与标志） */
const BLEED_LEFT = 14;

/**
 * 需要与 textarea 保持逐项一致的排版属性。
 *
 * 少一个就会错位，且通常只在**多行 / 中文 / 长词**等特定内容下暴露；新增属性前先想清楚
 * 它是否影响字形位置或换行点。
 */
const MIRRORED = [
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'fontVariant',
  'fontFeatureSettings',
  'letterSpacing',
  'wordSpacing',
  'lineHeight',
  'textIndent',
  'textTransform',
  'textRendering',
  'whiteSpace',
  'overflowWrap',
  'wordBreak',
  'tabSize',
] as const;

const kebab = (prop: string): string => prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

export interface ComposerMirrorProps {
  /** 锚点：同一容器里的 textarea（排版、尺寸、滚动都从它取） */
  anchor: HTMLTextAreaElement | null;
  /** `splitSkillSegments` 产出的分段 */
  segments: readonly ComposerSegment[];
}

export function ComposerMirror({ anchor, segments }: ComposerMirrorProps): JSX.Element {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const text = segments.map((s) => s.text).join('');

  /** 把 textarea 的排版与几何搬到镜像层上（幂等，可重复调用） */
  const sync = useCallback(() => {
    const ta = anchor;
    const box = boxRef.current;
    if (!ta || !box) return;
    const cs = window.getComputedStyle(ta);
    for (const prop of MIRRORED) {
      const key = kebab(prop);
      box.style.setProperty(key, cs.getPropertyValue(key));
    }
    box.style.left = `-${BLEED_LEFT}px`;
    box.style.width = `${ta.clientWidth + BLEED_LEFT}px`;
    // ★ 高度用 `top:0 + bottom:0` 贴住容器，**不读 clientHeight**：
    //   子组件的 useLayoutEffect 先于父组件执行 ⇒ 这里读到的还是"上一轮"的高度
    //   （textarea 高度由父组件的 syncComposerHeight 在同一帧稍后才改），
    //   表现是刚变成多行时镜像层少一行、最后一行被裁掉。
    box.style.top = '0';
    box.style.bottom = '0';
    box.style.paddingTop = cs.paddingTop;
    box.style.paddingBottom = cs.paddingBottom;
    box.style.paddingRight = cs.paddingRight;
    // 左侧外扩多少就补多少，文本起点才不会跟着左移
    box.style.paddingLeft = `${(parseFloat(cs.paddingLeft) || 0) + BLEED_LEFT}px`;
    box.scrollTop = ta.scrollTop;
  }, [anchor]);

  // 每次渲染都同步一次（属性赋值成本极低，胜过维护一堆"什么时候会变"的判断）
  useLayoutEffect(() => {
    sync();
  });

  /**
   * 尺寸/字号变化兜底。
   *
   * 为什么需要：媒体查询或根字号变化会让 `.ki-chat-composer__ta` 的 `font-size` 变，
   * 但**不一定**触发 React 渲染 —— 镜像层会停在旧字号上错位。这里只在 ta 尺寸变化时补一次同步
   * （改的是 box 自己的样式，不会再改 ta ⇒ 不会自激循环）。
   */
  useEffect(() => {
    if (!anchor || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => sync());
    ro.observe(anchor);
    return () => ro.disconnect();
  }, [anchor, sync]);

  // 输入框内部滚动（超过 max-height 后出现）时镜像层跟随
  useEffect(() => {
    if (!anchor) return;
    const onScroll = (): void => {
      const box = boxRef.current;
      if (box) box.scrollTop = anchor.scrollTop;
    };
    anchor.addEventListener('scroll', onScroll);
    return () => anchor.removeEventListener('scroll', onScroll);
  }, [anchor]);

  return (
    <div ref={boxRef} className="ki-chat-hl" aria-hidden="true">
      {segments.map((seg, i) => (seg.kind === 'skill' ? (
        <span key={i} className="ki-chat-hl__token">
          {/* 形象的标志：与「对话配置 → Skill」卡片同族的星光。
              绝对定位在块**左外侧**（不占文字宽度）—— 块本身不左扩，才能与普通文本行左对齐。 */}
          <i className="ki-chat-hl__mark">✦</i>
          {seg.text}
        </span>
      ) : (
        <span key={i}>{seg.text}</span>
      )))}
      {/* 末尾换行：`pre-wrap` 下末尾的 `\n` 不产生新行，补零宽字符占位，
          否则最后一行的高度与光标位置会和 textarea 差一行 */}
      {text.endsWith('\n') ? <span>{'\u200b'}</span> : null}
    </div>
  );
}
