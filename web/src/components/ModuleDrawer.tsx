/**
 * ModuleDrawer.tsx —— 原文查看抽屉（右侧滑出 + scrim + 复制）
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownPreview } from '@/components/MarkdownPreview';

/** 头部导航箭头（描边 SVG，替代此前易显粗糙的文本箭头 → / ←） */
const ICON_DRAWER_COLLAPSE = (
  <svg className="ki-drawer__close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 6.5 15 12l-5.5 5.5" />
  </svg>
);

const ICON_NAV_PREV = (
  <svg className="ki-drawer__nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 6.5 9 12l5.5 5.5" />
  </svg>
);

const ICON_NAV_NEXT = (
  <svg className="ki-drawer__nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 6.5 15 12l-5.5 5.5" />
  </svg>
);

/** 正文快速滚动按钮图标 */
const ICON_SCROLL_TOP = (
  <svg className="ki-scroll-nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 14.5 12 8.5l6 6" />
  </svg>
);

const ICON_SCROLL_BOTTOM = (
  <svg className="ki-scroll-nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9.5 12 15.5l6-6" />
  </svg>
);

interface ModuleDrawerProps {
  scope: string;
  module: string;
  /** Group 路径（fetcher 需要时传入） */
  group?: string;
  initialContent?: string;
  onClose: () => void;
  fetcher?: (scope: string, group: string, relation: string) => Promise<{ content?: string }>;
  onLocalLink?: (href: string) => boolean;
  canGoBack?: boolean;
  onBack?: () => void;
  canGoForward?: boolean;
  onForward?: () => void;
  /** 受控全屏状态；传入后由外层 BrowsePage 保留状态，切换文档不会丢失。 */
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** 全屏时显示在阅读正文左侧的导航工作区（Group 树 + 文档列表）。 */
  fullscreenNavigation?: ReactNode;
}

export function ModuleDrawer({
  scope,
  module,
  group,
  initialContent,
  onClose,
  fetcher,
  onLocalLink,
  canGoBack = false,
  onBack,
  canGoForward = false,
  onForward,
  fullscreen: controlledFullscreen,
  onFullscreenChange,
  fullscreenNavigation,
}: ModuleDrawerProps): JSX.Element {
  const [content, setContent] = useState<string | null>(initialContent ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const fullscreen = controlledFullscreen ?? internalFullscreen;
  /** 正文滚动容器 */
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 全屏切换前记下的阅读位置（正文容器会换父节点被重建，切换后按此恢复） */
  const savedScrollRef = useRef<number | null>(null);

  const updateFullscreen = useCallback((next: boolean): void => {
    // 必须在切换前记录：重建后 ref 已指向新节点，读不到旧位置
    savedScrollRef.current = bodyRef.current?.scrollTop ?? null;
    if (controlledFullscreen === undefined) setInternalFullscreen(next);
    onFullscreenChange?.(next);
  }, [controlledFullscreen, onFullscreenChange]);

  useEffect(() => {
    if (content !== null || !fetcher || !group) return;
    setLoading(true);
    setError(null);
    fetcher(scope, group, module)
      .then((res) => {
        if (res.content) setContent(res.content);
        else setError('未找到原文内容');
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [scope, module, group, content, fetcher, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setContent(null);
    setError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    // 优先用 Clipboard API（需 HTTPS 或 localhost）；失败回退到 execCommand
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(content);
      } else {
        // fallback：旧版 textarea + execCommand（兼容非安全上下文）
        const ta = document.createElement('textarea');
        ta.value = content;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 失败：独立提示条（不污染加载错误状态，正文保留）
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2500);
    }
  }, [content]);

  /** ESC 先退出全屏，再次按下才关闭文档；同时锁定底层页面滚动。 */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (fullscreen) updateFullscreen(false);
      else onClose();
    };
    window.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', handler);
    };
  }, [fullscreen, onClose, updateFullscreen]);

  /** 正文滚动状态：驱动「回到顶部 / 滑到底部」按钮的可用态与显隐 */
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const syncScrollState = useCallback((): void => {
    const el = bodyRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setAtTop(el.scrollTop <= 2);
    // 内容不足一屏时 max<=0：视为同时处于顶与底，按钮组据此整体隐藏
    setAtBottom(max <= 2 || el.scrollTop >= max - 2);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    syncScrollState();
    el.addEventListener('scroll', syncScrollState, { passive: true });
    // 文档加载完成后（含图片 / Mermaid 撑高内容）与窗口尺寸变化时重新同步
    window.addEventListener('resize', syncScrollState);
    return () => {
      el.removeEventListener('scroll', syncScrollState);
      window.removeEventListener('resize', syncScrollState);
    };
    // fullscreen 切换会让正文容器换父节点并被重建，必须重新绑定到新元素
  }, [syncScrollState, content, loading, fullscreen]);

  /** 全屏切换后正文容器被重建，恢复到切换前的阅读位置（布局阶段同步执行，不闪回顶部） */
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || savedScrollRef.current === null) return;
    el.scrollTop = savedScrollRef.current;
    savedScrollRef.current = null;
    syncScrollState();
  }, [fullscreen, syncScrollState]);

  const scrollToTop = useCallback((): void => {
    bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  /** 内容不足一屏时不渲染按钮，避免无意义的悬浮控件 */
  const scrollable = !(atTop && atBottom);

  const body = (
    <div className="ki-drawer__body" ref={bodyRef}>
      {copyFailed && (
        <div className="ki-drawer__copy-failed" role="status">复制失败，请手动选择文本后复制</div>
      )}
      {loading ? (
        <div className="ki-drawer__status">
          <div className="ki-skeleton" style={{ width: '60%', height: 20, marginBottom: 10 }} />
          <div className="ki-skeleton" style={{ width: '100%', height: 14, marginBottom: 8 }} />
          <div className="ki-skeleton" style={{ width: '90%', height: 14, marginBottom: 8 }} />
          <div className="ki-skeleton" style={{ width: '75%', height: 14 }} />
        </div>
      ) : error ? (
        <div className="ki-drawer__status">
          <div className="ki-drawer__status-icon">⚠</div>
          <h3>加载失败</h3>
          <p>{error}</p>
          <button className="ki-btn ki-btn--secondary ki-btn--small" type="button" onClick={retryLoad}>
            重试
          </button>
        </div>
      ) : content === null ? (
        <div className="ki-drawer__status">
          <div className="ki-drawer__status-icon">📄</div>
          <h3>无原文内容</h3>
          <p>该文档暂无可预览的原文</p>
        </div>
      ) : (
        <article className="ki-markdown ki-markdown--drawer">
          <MarkdownPreview
            text={content}
            assetBase={group ? { scope, group } : undefined}
            onLocalLink={onLocalLink}
          />
        </article>
      )}
    </div>
  );

  const foot = content ? (
    <footer className="ki-drawer__foot">
      <span className="ki-cell-sub">{(content.length / 1024).toFixed(1)} KB · Markdown</span>
    </footer>
  ) : null;

  return (
    <>
      <div className="ki-drawer__scrim ki-drawer__scrim--show" onClick={onClose} />
      <aside className={`ki-drawer${fullscreen ? ' ki-drawer--fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label="原文查看">
        {/* 头部 */}
        <header className="ki-drawer__head">
          <button
            className="ki-drawer__close"
            onClick={onClose}
            title="收起 (ESC)"
            type="button"
            aria-label="收起"
          >
            {ICON_DRAWER_COLLAPSE}
          </button>
          {canGoBack && onBack && (
            <button
              className="ki-drawer__back"
              onClick={onBack}
              title="返回上一级文档"
              type="button"
              aria-label="返回上一级文档"
            >
              {ICON_NAV_PREV}<span className="ki-drawer__back-label">上一级</span>
            </button>
          )}
          {canGoForward && onForward && (
            <button
              className="ki-drawer__forward"
              onClick={onForward}
              title="前进到下一级文档"
              type="button"
              aria-label="前进到下一级文档"
            >
              {ICON_NAV_NEXT}<span className="ki-drawer__forward-label">下一级</span>
            </button>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="ki-drawer__title">{module}</div>
            <div className="ki-drawer__meta">
              <span className="ki-badge ki-badge--kb" style={{ fontSize: 11 }}>{scope}</span>
              {group && (
                <>
                  <span className="ki-drawer__sep">·</span>
                  <span className="ki-drawer__path">{group}</span>
                </>
              )}
            </div>
          </div>
          <div className="ki-drawer__actions">
            {content && (
              <button
                className={`ki-drawer__copy${copied ? ' ki-drawer__copy--done' : ''}`}
                onClick={handleCopy}
                title="复制原文"
                type="button"
              >
                {copied ? '已复制' : '复制'}
              </button>
            )}
            <button
              className="ki-drawer__fullscreen"
              onClick={() => updateFullscreen(!fullscreen)}
              title={fullscreen ? '退出全屏' : '全屏查看'}
              type="button"
            >
              {fullscreen ? '⤢ 还原' : '⤢ 全屏'}
            </button>
          </div>
        </header>

        {fullscreen && fullscreenNavigation ? (
          <div className="ki-reader-workspace">
            {fullscreenNavigation}
            <div className="ki-reader-workspace__main">
              {body}
              {foot}
            </div>
          </div>
        ) : (
          <>
            {body}
            {foot}
          </>
        )}

        {/* 正文快速滚动：仅在正文超出一屏时出现，已在顶/底的一侧置灰 */}
        {content !== null && scrollable && (
          <div className="ki-scroll-nav" role="group" aria-label="正文快速滚动">
            <button
              type="button"
              className="ki-scroll-nav__btn"
              onClick={scrollToTop}
              disabled={atTop}
              title="回到顶部"
              aria-label="回到顶部"
            >
              {ICON_SCROLL_TOP}
            </button>
            <button
              type="button"
              className="ki-scroll-nav__btn"
              onClick={scrollToBottom}
              disabled={atBottom}
              title="滑到底部"
              aria-label="滑到底部"
            >
              {ICON_SCROLL_BOTTOM}
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
