/**
 * ModuleDrawer.tsx —— 原文查看抽屉（右侧滑出 + scrim + 复制）
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react';
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
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const fullscreen = controlledFullscreen ?? internalFullscreen;

  const updateFullscreen = useCallback((next: boolean): void => {
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
  }, [scope, module, group, content, fetcher]);

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

  const body = (
    <div className="ki-drawer__body">
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
      <aside className={`ki-drawer${fullscreen ? ' ki-drawer--fullscreen' : ''}`} aria-label="原文查看">
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
      </aside>
    </>
  );
}
