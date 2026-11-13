/**
 * DocDeleteDialog.tsx —— 删除文档的二次确认（2026-11-13）
 *
 * 三个刻意的设计：
 * - **打开即预检**（`POST /api/doc/delete` + dryRun）：删除不可恢复，弹窗必须在用户按下确认**之前**
 *   说清「源文件会不会一起没」「有没有未结束的草稿会挡住」。预检只读，导入进行中也不会排队。
 * - **源文件给勾选框**：默认勾上（与 CLI 语义一致），可取消 = 只从知识库移除、仓库里的 .md 原地不动。
 *   勾选框只在**源文件真的存在**时出现 —— 摆出来却什么都不删比不显示更糟。
 * - **数据源文档放行但预告**：与「移动」刻意不同（移动会产生副本所以阻断）。删除不产生副本，
 *   下次同步只是把这篇重新导回来；阻断等于「这篇永远删不掉」。
 *
 * ⚠️ Esc 必须在**捕获阶段**接住：阅读器的 Esc 链在 window 冒泡阶段，弹窗不自带 Esc 的话，
 * 按 Esc 会「毫无反应」——弹窗不动、阅读器也不退（同 DocMoveDialog 的坑）。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import {
  deleteDocument,
  precheckDocumentDelete,
  type DeleteDocumentResponse,
  type DocDeletePrecheckResponse,
} from '@/api/httpApi';
// 当前路径用 groupPathSegment（根不贡献路径段）—— 见 root-group-display 守卫
import { groupPathSegment } from '@/lib/groupTree';

export interface DocDeleteDialogProps {
  scope: string;
  group: string;
  relation: string;
  onClose: () => void;
  onDeleted: (result: DeleteDocumentResponse) => void;
}

/** 把后端的 code 翻成用户能照着做的动作，服务端文案只作兜底 */
function describeDeleteError(error: unknown): string {
  const status = (error as { status?: number }).status;
  const body = (error as { body?: { code?: string; error?: string } }).body;
  const fallback = body?.error ?? (error as Error)?.message ?? '删除失败';
  switch (body?.code) {
    case 'DOC_NOT_FOUND':
      return '这篇文档已经不存在了（可能已被其他窗口删掉），关闭后刷新目录即可';
    case 'DOC_EDIT_IN_PROGRESS':
      return '该文档有未结束的编辑草稿，请先在编辑器里保存或取消后再删除';
    case 'SCOPE_READONLY':
      return '当前知识库为只读，无法删除文档';
    case 'DOC_DELETE_FAILED':
      return fallback;
    default:
      // 403 不等于只读：Token 无写权限、账号角色不足同样落到这里。
      // 把服务端原因原样给出，比统一写成「知识库为只读」诚实（那会把人引去解除只读）。
      if (status === 403) return fallback;
      if (status === 404) return '这篇文档已经不存在了（可能已被其他窗口删掉），关闭后刷新目录即可';
      return fallback;
  }
}

/** 源文件「不会删」的原因 → 一句人话 */
function wikiSkipHint(reason: DocDeletePrecheckResponse['wikiSkipReason']): string {
  switch (reason) {
    case 'source-mismatch':
      return '该文件与文档记录的来源不是同一个文件，出于安全不会删除';
    case 'file-not-found':
      return '约定位置没有对应的源文件';
    case 'not-configured':
      return '该知识库未配置 wiki 源目录';
    default:
      return '';
  }
}

export function DocDeleteDialog({
  scope, group, relation, onClose, onDeleted,
}: DocDeleteDialogProps): JSX.Element {
  const [precheck, setPrecheck] = useState<DocDeletePrecheckResponse | null>(null);
  const [precheckError, setPrecheckError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** 默认连源文件一起删（= CLI / 既有 HTTP 语义）；取消勾选则只从知识库移除 */
  const [wikiDelete, setWikiDelete] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);

  const docPath = [groupPathSegment(group), relation].filter(Boolean).join(' / ');
  const wikiRelPath = [groupPathSegment(group), `${relation}.md`].filter(Boolean).join('/');

  useEffect(() => {
    let alive = true;
    setLoading(true);
    precheckDocumentDelete({ scope, group, relation })
      .then((res) => { if (alive) { setPrecheck(res); setPrecheckError(null); } })
      .catch((err) => { if (alive) setPrecheckError(describeDeleteError(err)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [group, relation, scope]);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      if (!busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onClose]);

  /** 有草稿 / 文档已不存在 / 预检没跑通时一律不许提交：宁可少一个可点按钮，也不要删到不该删的 */
  const blocked = busy
    || loading
    || Boolean(precheckError)
    || !precheck
    || !precheck.exists
    || precheck.pendingDrafts > 0;

  const submit = useCallback(async (): Promise<void> => {
    if (blocked) return;
    setBusy(true);
    setError(null);
    try {
      const result = await deleteDocument({ scope, group, relation, wikiDelete });
      onDeleted(result);
      onClose();
    } catch (err) {
      setError(describeDeleteError(err));
    } finally {
      setBusy(false);
    }
  }, [blocked, group, onClose, onDeleted, relation, scope, wikiDelete]);

  const visibleWiki = precheck?.wikiPath !== undefined;

  return createPortal(
    <div
      className="ki-overlay ki-overlay--show ki-overlay--front"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="ki-dialog ki-dialog--form ki-doc-del"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ki-doc-del-title"
        tabIndex={-1}
      >
        <header className="ki-dialog__head">
          <div>
            <h3 className="ki-dialog__title" id="ki-doc-del-title">删除文档</h3>
            <p className="ki-doc-del__sub">删除后无法恢复，请确认</p>
          </div>
          <button type="button" className="ki-dialog__close" aria-label="关闭删除弹窗" disabled={busy} onClick={onClose}>✕</button>
        </header>

        <div className="ki-dialog__body ki-doc-del__body">
          <div className="ki-doc-del__ident">
            <span className="ki-doc-del__ident-label">文档</span>
            <span className="ki-doc-del__ident-path" title={`${scope} / ${docPath}`}>{docPath}</span>
          </div>

          {loading ? (
            <p className="ki-doc-del__hint">正在检查这篇文档的落点…</p>
          ) : precheckError ? (
            <p className="ki-write-error" role="alert">{precheckError}</p>
          ) : null}

          {precheck && !loading ? (
            <>
              <ul className="ki-doc-del__notes">
                <li>知识库里的正文、元数据，以及这篇文档的向量与全文索引会一并删除。</li>
                <li>正文里指向它的链接、AI 对话里的引用会失效。</li>
                {/* 勾选框只在「真的删得掉」时出现：删不掉却摆一个勾选框，
                    勾着却什么都不做，与"安全不会删除"的说明互相矛盾（用户会以为它还是会删） */}
                {visibleWiki && precheck.wikiWillDelete ? (
                  <li className="ki-doc-del__wiki">
                    <label>
                      <input
                        type="checkbox"
                        checked={wikiDelete}
                        disabled={busy}
                        onChange={(event) => setWikiDelete(event.target.checked)}
                      />
                      <span>
                        同时删除 wiki 源文件
                        <code className="ki-doc-del__path">{wikiRelPath}</code>
                      </span>
                    </label>
                  </li>
                ) : null}
                {visibleWiki && !precheck.wikiWillDelete ? (
                  <li>wiki 源文件：{wikiSkipHint(precheck.wikiSkipReason)}</li>
                ) : null}
              </ul>

              {precheck.datasourceSource ? (
                <p className="ki-doc-del__warn" role="alert">
                  这篇文档由「数据源」同步维护：删掉后下次同步仍会把它导回来。
                  要彻底去掉，请到「数据源」页停用对应来源。
                </p>
              ) : null}

              {precheck.pendingDrafts > 0 ? (
                <p className="ki-doc-del__warn" role="alert">
                  该文档有 {precheck.pendingDrafts} 条未结束的编辑草稿，请先在编辑器里保存或取消后再删除。
                </p>
              ) : null}

              {!precheck.exists ? (
                <p className="ki-doc-del__warn" role="alert">
                  这篇文档已经不存在了（可能已被其他窗口删掉），关闭后刷新目录即可。
                </p>
              ) : null}
            </>
          ) : null}

          {error ? <p className="ki-write-error" role="alert">{error}</p> : null}
        </div>

        <footer className="ki-dialog__foot">
          <button type="button" className="ki-btn ki-btn--secondary" disabled={busy} onClick={onClose}>取消</button>
          <button type="button" className="ki-btn ki-btn--danger" disabled={blocked} onClick={() => void submit()}>
            {busy ? '删除中…' : '删除'}
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
