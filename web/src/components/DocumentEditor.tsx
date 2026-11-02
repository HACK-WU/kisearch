import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEditableDocument, saveEditableDocument, type EditableDocument, type SaveDocumentResponse } from '@/api/httpApi';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { editorVectorizeHint, useVectorAvailability } from '@/lib/hooks';

interface Props {
  scope: string;
  group: string;
  relation: string;
  readerSelection?: string;
  onSaved: (content: string, result: SaveDocumentResponse) => void;
  onClose: () => void;
}

export function DocumentEditor({ scope, group, relation, readerSelection, onSaved, onClose }: Props): JSX.Element {
  const [loaded, setLoaded] = useState<EditableDocument | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState('');
  const [tab, setTab] = useState<'source' | 'preview'>('source');
  const [vectorize, setVectorize] = useState(false);
  const [vectorizeTouched, setVectorizeTouched] = useState(false);
  const [editId, setEditId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [indexError, setIndexError] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  /**
   * 向量可用性（2026-11-02）：判据与顶栏徽标 / 导入 / 检索 / 写入共用 `useVectorAvailability`
   * （两路既有 query 的薄封装，不产生额外请求），不在此自判一套。
   *
   * ★ `effectiveVectorize` 用**派生**而非 effect 覆盖 state：探测恢复后自动回到用户原来的
   *   选择（同 ImportPage 的 effectiveVector 口径）；所有提交点只读派生值，避免"勾着但写不了"
   *   的状态被真的提交出去 —— 向量不可用时 dense 发布必然失败（DOC_INDEX_INCOMPLETE）。
   */
  const vectorAvailability = useVectorAvailability();
  const vectorAvailable = vectorAvailability.status === 'available';
  const effectiveVectorize = vectorize && vectorAvailable;
  const dirty = loaded !== null && draft !== loaded.content;
  const modeChange = loaded !== null && (dirty || vectorizeTouched)
    && (effectiveVectorize ? loaded.indexMode !== 'dense' : loaded.indexMode !== 'fts');
  const hasUnsavedChanges = dirty || modeChange || Boolean(editId);
  const canSave = hasUnsavedChanges;

  useEffect(() => {
    let active = true;
    void getEditableDocument(scope, group, relation).then((document) => {
      if (!active) return;
      setLoaded(document);
      setDraft(document.content);
    }).catch((error: Error) => { if (active) { setMessage(`加载失败：${error.message}`); setLoadError(true); } });
    return () => { active = false; };
  }, [scope, group, relation]);

  useEffect(() => {
    if (!loaded || !readerSelection || readerSelection.includes('\n')) return;
    const index = loaded.content.indexOf(readerSelection);
    if (index < 0 || loaded.content.indexOf(readerSelection, index + 1) >= 0) return;
    textareaRef.current?.setSelectionRange(index, index + readerSelection.length);
    textareaRef.current?.focus();
  }, [loaded, readerSelection]);

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const warn = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasUnsavedChanges]);

  const close = (): void => {
    if (busy) return;
    if (hasUnsavedChanges && !window.confirm('有未保存的正文、索引设置或待重试操作，确定关闭编辑器吗？')) return;
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!loaded || !canSave || loaded.sourceError) return;
    setBusy(true);
    setMessage('');
    setIndexError('');
    try {
      const result = await saveEditableDocument({
        scope, group, relation, content: draft,
        expectedRevision: loaded.revision,
        expectedSourceRevision: loaded.sourceRevision,
        vectorize: effectiveVectorize,
        editId,
      });
      onSaved(draft, result);
      onClose();
    } catch (error) {
      const failure = error as Error & { status?: number; body?: { code?: string; details?: { editId?: string; source?: string; kb?: string; index?: string; retryable?: boolean; sourcePath?: string } } };
      if (failure.body?.details?.editId) setEditId(failure.body.details.editId);
      const code = failure.body?.code;
      const detail = failure.body?.details;
      const versionConflict = code === 'DOC_EDIT_CONFLICT' || code === 'DOC_EDIT_RETRY_CONFLICT' || code === 'SOURCE_CONFLICT';
      const sourceConfigError = code === 'SOURCE_DISABLED' || code === 'SOURCE_MISMATCH' || code === 'SOURCE_UNAVAILABLE';
      const nextStep = versionConflict
        ? '当前输入已保留；请重新加载并处理版本冲突后再保存。'
        : sourceConfigError
          ? '当前输入已保留；请修正源文件配置后再保存。'
          : code === 'DOC_EDIT_INVALID'
            ? '请修正正文内容后再试。'
            : code === 'DOC_EDIT_RETRY_MISMATCH'
              ? '当前重试草稿与文档状态不一致；请重新加载文档后再保存。'
              : code === 'DOC_EDIT_NOT_RETRYABLE' || detail?.retryable === false
                ? '当前草稿不能原样重试；请修改正文或切换保存模式后再保存。'
                : '草稿仍在编辑器中，可重试。';
      setMessage(`保存失败：${failure.message}。${detail ? `源文件 ${detail.source ?? '未知'} / KB ${detail.kb ?? '未知'} / 索引 ${detail.index ?? '未知'}。` : ''}${nextStep}`);
      if (detail?.index === 'incomplete') {
        const modeLabel = effectiveVectorize ? '向量化' : 'FTS 全文';
        setIndexError(`${modeLabel}索引未完成，请查看上方错误详情和处理建议。`);
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="ki-editor-overlay" role="presentation">
      <section className="ki-editor" role="dialog" aria-modal="true" aria-label={`编辑 ${relation}`}>
        <header className="ki-editor__head">
          <div><strong>编辑 {relation}</strong><small>{group}</small></div>
          <button className="ki-btn ki-btn--secondary" type="button" onClick={close} disabled={busy}>关闭</button>
        </header>
        {loaded?.warning && <div className="ki-editor__notice" role="status">{loaded.warning}</div>}
        {loaded?.sourceError && <div className="ki-editor__error" role="alert">源文件校验失败：{loaded.sourceError}</div>}
        {message && <div className="ki-editor__notice" role="status">{message}</div>}
        <div className="ki-editor__layout">
          <div className="ki-editor__main">
            <div className="ki-editor__tabs">
              <button type="button" className={tab === 'source' ? 'is-active' : ''} onClick={() => setTab('source')}>Markdown 源码</button>
              <button type="button" className={tab === 'preview' ? 'is-active' : ''} onClick={() => setTab('preview')}>预览</button>
            </div>
            {!loaded ? <p>{loadError ? '文档加载失败，请关闭后重试' : '正在加载文档…'}</p> : tab === 'source' ? (
              <textarea ref={textareaRef} className="ki-editor__textarea" value={draft} disabled={busy}
                onChange={(event) => { setMessage(''); setIndexError(''); setDraft(event.target.value); }}
                spellCheck={false} aria-label="Markdown 正文" />
            ) : (
              <div className="ki-editor__preview ki-markdown"><MarkdownPreview text={draft} assetBase={{ scope, group }} /></div>
            )}
          </div>
        </div>
        <footer className="ki-editor__foot">
          <span className="ki-editor__status">{dirty ? '有未保存修改' : modeChange ? `保存将切换为${effectiveVectorize ? 'dense 向量' : 'FTS 全文'}` : '无未保存修改'}</span>
          <div className="ki-editor__actions">
            <div className="ki-editor__vector-control">
              <div className="ki-editor__vector-row">
                {/*
                  * 拨杆用 <button role="switch">（不是 div）：导入页/写入页那两处是 div + onClick，
                  * 无 tabIndex ⇒ 键盘用户切不了。原生 button 自带可达性与 disabled 语义，
                  * 视觉完全由 .ki-switch 决定，与那两处同款。
                  */}
                <button
                  type="button"
                  className={`ki-switch${effectiveVectorize ? ' ki-switch--on' : ''}${vectorAvailable ? '' : ' ki-switch--disabled'}`}
                  role="switch"
                  aria-checked={effectiveVectorize}
                  aria-label="保存时向量化"
                  aria-describedby="ki-editor-vector-desc"
                  disabled={busy || !vectorAvailable}
                  onClick={() => { setMessage(''); setIndexError(''); setVectorize((prev) => !prev); setVectorizeTouched(true); }}
                >
                  <span className="ki-switch__knob" />
                </button>
                <span className="ki-editor__vector-title">保存时向量化</span>
                {/*
                  * 说明**跟在开关右边同一行**（2026-11-02 用户定稿，此前是开关下方独立一行）：
                  * 行内一句短语即可，别把后端 reason 拼进来 —— 那句会拖成三行、把 footer 顶高，
                  * 而完整原因在顶栏徽标点开后的健康明细里已有，不在此重复。
                  * 窄屏放不下时整段折到第二行并缩进对齐标题（样式见 ki.css 的 800px 媒体查询）。
                  */}
                <span
                  id="ki-editor-vector-desc"
                  className={`ki-editor__vector-note${vectorAvailable ? '' : ' ki-editor__vector-note--blocked'}`}
                  role={vectorAvailable ? undefined : 'status'}
                >
                  {editorVectorizeHint(vectorAvailability)}
                </span>
              </div>
              {indexError && <div className="ki-editor__vector-error" role="alert">
                <span className="ki-editor__vector-error-icon" aria-hidden="true">!</span>
                <span>{indexError}</span>
              </div>}
            </div>
            <button type="button" className="ki-btn ki-btn--primary" onClick={() => void save()} disabled={!canSave || busy || Boolean(loaded?.sourceError)}>{busy ? '保存中…' : '保存'}</button>
          </div>
        </footer>
      </section>
    </div>, document.body,
  );
}
