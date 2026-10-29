/**
 * CodeLangSelect.tsx —— 首选代码语言选择器（多语言代码块的默认展开项）。
 *
 * 口径：偏好是**读者的属性**，跨 scope / 跨文档生效，存 localStorage（见 lib/codeLangPreference）；
 * 只在「组内确实含这门语言」时生效，其余组照旧展示第一个；手动切换标签不写回偏好。
 *
 * 🔴 浮层必须 **Portal 到 body + fixed 定位**：它挂在侧边栏 footer，而 `.ki-sidebar` 带
 * `overflow-x: hidden`（ki.css:161）——就地渲染时 272px 的浮层会被 196px 的侧栏裁掉右侧大半。
 * 位置按锚点矩形计算（浮层**向上**弹：footer 在页面底部，向下弹会被视口裁掉）；
 * 展开时算一次，之后只在 **resize / 滚动** 时重新测量 —— 滚动**不关闭**浮层（见下方 useEffect 注释）。
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/components/icons';
import {
  CODE_LANG_OPTIONS,
  canonicalLang,
  usePreferredLang,
  writePreferredLang,
} from '@/lib/codeLangPreference';

/** 浮层与锚点按钮的间距（px） */
const PANEL_GAP = 6;
/** 浮层宽度：与 ki.css 的 `.ki-code-lang__panel` 保持一致，用于视口内的左右夹取 */
const PANEL_WIDTH = 272;

export function CodeLangSelect(): JSX.Element {
  const preferred = usePreferredLang();
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(null);
  /** 自定义语言输入（预置列表覆盖不到的语言，如 haskell） */
  const [custom, setCustom] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  /** 测量锚点（视口右侧不够就左移，但不越过左边界）；锚点已完全滚出视口时返回 null */
  const measureAnchor = useCallback((): { left: number; bottom: number } | null => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return null;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) return null;
    return {
      left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
      bottom: window.innerHeight - rect.top + PANEL_GAP,
    };
  }, []);

  // 展开时测量锚点
  useLayoutEffect(() => {
    if (!open) return;
    const next = measureAnchor();
    if (!next) {
      setOpen(false);
      return;
    }
    setAnchor(next);
  }, [open, measureAnchor]);

  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (event: MouseEvent): void => {
      const target = event.target as Node;
      // 浮层已 Portal 出去，不在 rootRef 子树里，必须单独判一次，否则点选项会被当成「点外面」
      if (rootRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    // 🔴 滚动时「重新测量」而不是「一滚就关」（旧实现 `window.addEventListener('scroll', close, true)`）：
    // ① 浮层是 fixed，页面内容（`.ki-content`）滚动时侧栏按钮并不动 ⇒ 关掉纯属惩罚用户；
    // ② 捕获阶段的 scroll 连浮层内部也收（`.ki-code-lang__grid` 自带 `max-height: 264px` 滚动）
    //    ⇒ 在浮层里滚轮翻语言列表，浮层自己把自己关了。
    // 现在：锚点位置没变就什么都不做，变了就跟随；只有锚点滚出视口才关闭。
    let frame: number | null = null;
    const sync = (): void => {
      frame = null;
      const next = measureAnchor();
      if (!next) {
        setOpen(false);
        return;
      }
      setAnchor((prev) => (prev && prev.left === next.left && prev.bottom === next.bottom ? prev : next));
    };
    const scheduleSync = (): void => {
      // `null` 判据而不是 `0`：rAF 句柄的起始值规范没保证，别拿它当「没有排程」
      if (frame !== null) return;
      frame = window.requestAnimationFrame(sync);
    };
    const onScroll = (event: Event): void => {
      const target = event.target;
      // 浮层自身内部的滚动与定位无关，直接忽略
      if (panelRef.current && target instanceof Node && panelRef.current.contains(target)) return;
      scheduleSync();
    };
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', scheduleSync);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', scheduleSync);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open, measureAnchor]);

  // ⚠️ 选中**不关闭**浮层（用户 2026-10-19：「点击任意一个语义后，也会自动关闭」）：
  // 这是设置面板而非一次性下拉 —— 用户要连续试几门语言看代码块效果，关一次就得重新
  // 打开一次。关闭只留给 Escape / 点浮层外部（trigger 按钮再点一次也关）。
  const pick = (value: string): void => {
    const next = value.trim();
    if (!next) return;
    writePreferredLang(next);
  };

  const activeLang = canonicalLang(preferred);
  const label = preferred ? `首选代码语言：${preferred}` : '首选代码语言：不指定';

  return (
    <div className="ki-code-lang" ref={rootRef}>
      <button
        type="button"
        className={`ki-icon-link${preferred ? ' ki-code-lang__trigger--on' : ''}`}
        onClick={() => setOpen((value) => !value)}
        title={label}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="code" />
      </button>
      {open && anchor
        ? createPortal(
          <div
            className="ki-code-lang__panel"
            style={{ left: anchor.left, bottom: anchor.bottom }}
            ref={panelRef}
            role="dialog"
            aria-label="首选代码语言"
          >
            <p className="ki-code-lang__hint">
              多语言代码块默认展开这一门；不含该语言的组仍展示第一个。
            </p>
            {/* 「当前首选」独立成状态条（PM M4 走查 2026-10-19）：原实现是 11px + opacity .8 的
                灰字，实测是全浮层**权重最低**的信息（比说明还弱），而它恰是用户打开面板最想确认的。
                点选不再自动关闭后，自定义语言（haskell 等）在网格里连高亮都没有，只能靠这条回显。 */}
            <div
              className={`ki-code-lang__current${preferred ? '' : ' ki-code-lang__current--none'}`}
              aria-live="polite"
            >
              <span className="ki-code-lang__current-label">当前首选</span>
              <span className="ki-code-lang__current-value" title={preferred || '不指定'}>
                {preferred || '不指定'}
              </span>
            </div>
            <div className="ki-code-lang__grid">
              {CODE_LANG_OPTIONS.map((lang) => (
                <button
                  type="button"
                  key={lang}
                  className={`ki-code-lang__option${activeLang === lang ? ' ki-code-lang__option--active' : ''}`}
                  aria-pressed={activeLang === lang}
                  onClick={() => pick(lang)}
                >
                  {lang}
                </button>
              ))}
            </div>
            {/* 预置列表覆盖不到的语言（haskell / lua / scala…）走这里；回车或点「确定」即生效 */}
            <form
              className="ki-code-lang__custom"
              onSubmit={(event) => {
                event.preventDefault();
                pick(custom);
                setCustom('');
              }}
            >
              <input
                className="ki-form-input ki-code-lang__custom-input"
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="其他语言（如 haskell）"
                aria-label="自定义首选语言"
              />
              <button type="submit" className="ki-code-lang__custom-go" disabled={!custom.trim()}>确定</button>
            </form>
            <button
              type="button"
              className="ki-code-lang__clear"
              onClick={() => writePreferredLang('')}
              disabled={!preferred}
            >
              不指定（展示每组第一个）
            </button>
            {/* 关闭提示压在动作区之后：它是「怎么结束」的说明，不该跟状态、说明抢顶部视线 */}
            <p className="ki-code-lang__foot">点空白处或按 Esc 关闭</p>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
