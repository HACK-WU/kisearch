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
  }, [scope, module, content, fetcher]);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // fallback: 降级静默失败
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
      <aside className="ki-drawer" aria-label="原文查看">
        {/* 头部 */}
        <header className="ki-drawer__head">
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
            <button className="ki-dialog__close" onClick={onClose} title="关闭 (ESC)" type="button">✕</button>
          </div>
        </header>

        {/* 内容区 */}
        <div className="ki-drawer__body">
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
