/**
 * CodeLangSelect.tsx —— 首选代码语言选择器（多语言代码块的默认展开项）。
 *
 * 口径：偏好是**读者的属性**，跨 scope / 跨文档生效，存 localStorage（见 lib/codeLangPreference）；
 * 只在「组内确实含这门语言」时生效，其余组照旧展示第一个；手动切换标签不写回偏好。
 *
 * 🔴 浮层必须 **Portal 到 body + fixed 定位**：它挂在侧边栏 footer，而 `.ki-sidebar` 带
 * `overflow-x: hidden`（ki.css:161）——就地渲染时 272px 的浮层会被 196px 的侧栏裁掉右侧大半。
 * 位置在展开时测量锚点算一次（浮层**向上**弹：footer 在页面底部，向下弹会被视口裁掉）。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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

  // 展开时测量锚点（视口右侧不够就左移，但不越过左边界）
  useLayoutEffect(() => {
    if (!open) return;
    const rect = rootRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAnchor({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - PANEL_WIDTH - 8)),
      bottom: window.innerHeight - rect.top + PANEL_GAP,
    });
  }, [open]);

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
    // 位置按展开那一刻测量 ⇒ 窗口尺寸变化、或承载锚点的容器滚动（侧栏 `overflow-y: auto`）
    // 都会让浮层与按钮分离，直接关掉最省事，也不会让浮层停在错误位置。
    // 用捕获阶段挂 scroll：滚动可能发生在任意可滚动祖先上，冒泡阶段收不全。
    const close = (): void => setOpen(false);
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  const pick = (value: string): void => {
    const next = value.trim();
    if (!next) return;
    writePreferredLang(next);
    setOpen(false);
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
              多语言代码块默认展开这一门；不含该语言的组仍展示第一个，手动切换不受影响。
            </p>
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
              onClick={() => {
                writePreferredLang('');
                setOpen(false);
              }}
              disabled={!preferred}
            >
              不指定（展示每组第一个）
            </button>
          </div>,
          document.body,
        )
        : null}
    </div>
  );
}
