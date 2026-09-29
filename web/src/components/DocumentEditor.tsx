import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEditableDocument, saveEditableDocument, type EditableDocument, type SaveDocumentResponse } from '@/api/httpApi';
import { MarkdownPreview } from '@/components/MarkdownPreview';

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
  const dirty = loaded !== null && draft !== loaded.content;
  const modeChange = loaded !== null && (dirty || vectorizeTouched)
    && (vectorize ? loaded.indexMode !== 'dense' : loaded.indexMode !== 'fts');
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
        vectorize,
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
        const modeLabel = vectorize ? '向量化' : 'FTS 全文';
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
          <span className="ki-editor__status">{dirty ? '有未保存修改' : modeChange ? `保存将切换为${vectorize ? 'dense 向量' : 'FTS 全文'}` : '无未保存修改'}</span>
          <div className="ki-editor__actions">
            <div className="ki-editor__vector-control">
              <label className="ki-editor__vector"><input type="checkbox" checked={vectorize} disabled={busy} onChange={(event) => { setMessage(''); setIndexError(''); setVectorize(event.target.checked); setVectorizeTouched(true); }} />保存时向量化（默认关闭；关闭时普通编辑写入 FTS）</label>
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
