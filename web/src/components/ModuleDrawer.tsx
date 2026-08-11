/**
 * ModuleDrawer.tsx —— 原文查看抽屉（右侧滑出 + scrim + 复制）
 */

import { useCallback, useEffect, useState } from 'react';
import { MarkdownPreview } from '@/components/MarkdownPreview';

interface ModuleDrawerProps {
  scope: string;
  module: string;
  /** Group 路径（fetcher 需要时传入） */
  group?: string;
  initialContent?: string;
  onClose: () => void;
  fetcher?: (scope: string, group: string, relation: string) => Promise<{ content?: string }>;
}

export function ModuleDrawer({
  scope,
  module,
  group,
  initialContent,
  onClose,
  fetcher,
}: ModuleDrawerProps): JSX.Element {
  const [content, setContent] = useState<string | null>(initialContent ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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

  /** ESC 关闭 + body 滚动锁定 */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handler = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  return (
    <>
      <div className="ki-drawer__scrim ki-drawer__scrim--show" onClick={onClose} />
      <aside className={`ki-drawer${fullscreen ? ' ki-drawer--fullscreen' : ''}`} aria-label="原文查看">
        {/* 头部 */}
        <header className="ki-drawer__head">
          <button
            className="ki-drawer__close"
            onClick={onClose}
            title="关闭 (ESC)"
            type="button"
            aria-label="关闭"
          >
            →<span className="ki-drawer__close-label">收起</span>
          </button>
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
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? '退出全屏' : '全屏查看'}
              type="button"
            >
              {fullscreen ? '⤢ 还原' : '⤢ 全屏'}
            </button>
          </div>
        </header>

        {/* 内容区 */}
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
              <MarkdownPreview text={content} />
            </article>
          )}
        </div>

        {/* 底部状态栏 */}
        {content && (
          <footer className="ki-drawer__foot">
            <span className="ki-cell-sub">{(content.length / 1024).toFixed(1)} KB · Markdown</span>
          </footer>
        )}
      </aside>
    </>
  );
}
