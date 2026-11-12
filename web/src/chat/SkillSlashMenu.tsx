/**
 * SkillSlashMenu —— 输入框 `/` 触发的 skill 候选浮层（2026-11-12）。
 *
 * ═══ 三个设计取舍（改动前先读）═══
 * 1. **向上弹 + `position: fixed` 现算落点**：输入框在面板最底部，向下弹会顶出视口；
 *    而对话面板链路上有多层 `overflow`（`.ki-chat-panel` / composer / foot），
 *    `absolute` 会被裁掉 —— 与 `ScopeMultiPicker` 踩过的坑同源（那边实测被裁 117px）。
 *    因此这里按锚点 `getBoundingClientRect()` 算 `left/width/bottom`，再用 portal 挂到 body。
 * 2. **候选不进 Tab 序（`tabIndex={-1}`）+ 键盘由输入框接管**：焦点始终留在 textarea，
 *    否则一按 Tab 焦点就跑进浮层、中文输入与光标位置都会丢。`aria-activedescendant` 由
 *    输入框指向高亮项，屏幕阅读器照样能感知（无障碍不是靠 Tab 可达换来的）。
 * 3. **点击用 `onMouseDown` 阻止默认**：不阻止的话 textarea 先失焦、caret 丢失，
 *    父组件的插入位置就错了（且"点外关闭"会先一步关掉浮层，点击落空）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import type { PromptSkill } from '@/api/chatContract';

/** 浮层与输入框之间的间距 */
const GAP_PX = 8;
/** 浮层最大高度（条目约 40px，约 8 条） */
const MAX_HEIGHT = 320;
/** 上方空间再小也保留这么高（宁可盖住一点输入框，也不显示一条都看不到的浮层） */
const MIN_HEIGHT = 120;

export interface SkillSlashMenuProps {
  /**
   * 条目 id 前缀（由调用方 `useId()` 生成）：输入框的 `aria-activedescendant` 要用同一套 id，
   * 所以前缀必须由外部给，不能在本组件内部生成。
   */
  idPrefix: string;
  /** 已启用 skill（过滤**前**的全量，用于「还有 N 个」与空态文案） */
  skills: readonly PromptSkill[];
  /** 过滤后的展示项 */
  rows: readonly PromptSkill[];
  loading: boolean;
  error: string | null;
  /** 当前键盘高亮下标（由输入框的 `onKeyDown` 维护） */
  active: number;
  /** 锚点：输入框元素（定位 + 点外判定） */
  anchor: HTMLElement | null;
  /** 当前过滤词（空态文案用） */
  query: string;
  onPick: (skill: PromptSkill) => void;
  onHover: (index: number) => void;
  onClose: () => void;
}

interface BoxRect {
  left: number;
  width: number;
  bottom: number;
  maxHeight: number;
}

export function SkillSlashMenu({
  idPrefix,
  skills,
  rows,
  loading,
  error,
  active,
  anchor,
  query,
  onPick,
  onHover,
  onClose,
}: SkillSlashMenuProps): JSX.Element | null {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<BoxRect | null>(null);

  /** 现算落点：`bottom` 用「视口高 - 输入框顶」表达，浮层就永远贴着输入框上沿 */
  const place = useCallback(() => {
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    if (r.width < 1) return;
    const maxHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, window.innerHeight - r.top - GAP_PX - 12));
    const next: BoxRect = {
      left: Math.round(r.left),
      width: Math.round(r.width),
      bottom: Math.round(window.innerHeight - r.top + GAP_PX),
      maxHeight: Math.round(maxHeight),
    };
    // 位置去抖：滚动事件密集，位置没变就返回旧对象，避免每帧 setState
    setRect((prev) => (prev
      && prev.left === next.left
      && prev.width === next.width
      && prev.bottom === next.bottom
      && prev.maxHeight === next.maxHeight
      ? prev
      : next));
  }, [anchor]);

  // 首帧在 paint 前定位（否则会先闪一下在左上角）
  useLayoutEffect(() => {
    place();
  }, [place, rows.length]);

  useEffect(() => {
    const onScrollOrResize = (): void => place();
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize);
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true);
      window.removeEventListener('resize', onScrollOrResize);
    };
  }, [place]);

  // 点外关闭：浮层自身与输入框都不算"外"（点输入框只是回到打字）
  useEffect(() => {
    const onDown = (ev: MouseEvent): void => {
      const t = ev.target as Node | null;
      if (!t) return;
      if (boxRef.current?.contains(t)) return;
      if (anchor?.contains(t)) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [anchor, onClose]);

  // 键盘上下移动时把高亮项滚进可视区（不滚动页面）
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const el = box.querySelector<HTMLElement>(`#${CSS.escape(`${idPrefix}-${active}`)}`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, idPrefix]);

  if (!rect) return null;

  const style: CSSProperties = {
    left: rect.left,
    width: rect.width,
    bottom: rect.bottom,
    maxHeight: rect.maxHeight,
  };
  const hiddenCount = skills.length - rows.length;

  return createPortal(
    <div
      ref={boxRef}
      id={`${idPrefix}-list`}
      className="ki-chat-slash"
      style={style}
      role="listbox"
      aria-label="可用 skill"
      data-open="true"
    >
      <div className="ki-chat-slash__head">
        <span>Skills</span>
        <em>已启用 {skills.length} 个</em>
      </div>
      <div className="ki-chat-slash__body">
        {loading ? <p className="ki-chat-slash__empty">正在读取 skill…</p> : null}
        {error ? <p className="ki-chat-slash__empty ki-chat-slash__empty--err">{error}</p> : null}
        {!loading && !error && rows.length === 0 ? (
          <p className="ki-chat-slash__empty">
            {skills.length === 0
              ? '没有启用的 skill：可在「对话配置 → Skill」里开启'
              : `没有匹配「${query}」的 skill`}
          </p>
        ) : null}
        {rows.map((s, i) => (
          <button
            key={s.id}
            id={`${idPrefix}-${i}`}
            type="button"
            role="option"
            // 候选不进 Tab 序：键盘走 ↑↓ + Enter（Tab 留给"离开输入框"）
            tabIndex={-1}
            aria-selected={i === active}
            className={`ki-chat-slash__item${i === active ? ' ki-chat-slash__item--active' : ''}`}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => onPick(s)}
          >
            <span className="ki-chat-slash__name">/{s.name}</span>
            <span className="ki-chat-slash__desc">{s.description || '（未填写描述）'}</span>
          </button>
        ))}
      </div>
      {hiddenCount > 0 ? (
        <div className="ki-chat-slash__more">
          还有 {hiddenCount} 个已启用的 skill，继续输入可缩小范围
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
