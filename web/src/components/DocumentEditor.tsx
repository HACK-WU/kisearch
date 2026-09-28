import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getDocList, getEditableDocument, saveEditableDocument, type DocItem, type EditableDocument, type SaveDocumentResponse } from '@/api/httpApi';
import { MarkdownPreview, renderMarkdownHtml } from '@/components/MarkdownPreview';
import { encodeKiLink, findAnchorBlocks, HEAD_PARA_SELECTOR, type KiLinkTarget } from '@/lib/kiLinks';

interface Props {
  scope: string;
  group: string;
  relation: string;
  readerSelection?: string;
  onSaved: (content: string, result: SaveDocumentResponse) => void;
  onClose: () => void;
}

function selectedJumpLabel(markdown: string): string | null {
  const match = /^\[((?:\\.|[^\]])+)\]\(ki-link:[^)]*\)$/.exec(markdown);
  return match ? match[1].replace(/\\([\\\[\]])/g, '$1') : null;
}

function escapeLinkLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
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
  const [linkType, setLinkType] = useState<'external' | 'self' | 'other'>('external');
  const [label, setLabel] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [docQuery, setDocQuery] = useState('');
  const [matches, setMatches] = useState<DocItem[]>([]);
  const [targetDoc, setTargetDoc] = useState<DocItem | null>(null);
  const [anchors, setAnchors] = useState<{ anchor: string; label: string }[]>([]);
  const [anchor, setAnchor] = useState('');
  const [selection, setSelection] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
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
    if (index < 0 || loaded.content.indexOf(readerSelection, index + 1) >= 0) {
      setMessage('所选文字在源码中不唯一或无法直接对应；请在源码中手动选择后添加跳转');
      return;
    }
    setSelection({ start: index, end: index + readerSelection.length });
    setLabel(readerSelection);
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
    if (hasUnsavedChanges && !window.confirm('有未保存的正文、索引设置或待重试操作，确定关闭编辑器吗？')) return;
    onClose();
  };

  const save = async (): Promise<void> => {
    if (!loaded || !canSave || loaded.sourceError) return;
    setBusy(true);
    setMessage('');
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
      const failure = error as Error & { status?: number; body?: { details?: { editId?: string; source?: string; kb?: string; index?: string; retryable?: boolean; sourcePath?: string } } };
      if (failure.body?.details?.editId) setEditId(failure.body.details.editId);
      const detail = failure.body?.details;
      const nextStep = failure.status === 409 || detail?.retryable === false
        ? '当前输入已保留；请先重新加载并处理版本冲突后再保存。'
        : '草稿仍在编辑器中，可重试。';
      setMessage(`保存失败：${failure.message}。${detail ? `源文件 ${detail.source ?? '未知'} / KB ${detail.kb ?? '未知'} / 索引 ${detail.index ?? '未知'}。` : ''}${nextStep}`);
    } finally {
      setBusy(false);
    }
  };

  const searchDocs = async (): Promise<void> => {
    if (!docQuery.trim()) { setMessage('请输入目标文档名称'); return; }
    setBusy(true);
    setMessage('');
    setTargetDoc(null);
    setAnchors([]);
    setAnchor('');
    try {
      const result = await getDocList(scope, { q: docQuery.trim() });
      setMatches(result.docs);
      if (result.truncated) setMessage('结果较多，请继续缩小关键词');
      else if (!result.docs.length) setMessage('没有匹配的目标文档');
    } catch (error) {
      setMessage(`查找目标失败：${(error as Error).message}`);
    } finally { setBusy(false); }
  };

  const loadAnchors = async (): Promise<void> => {
    setBusy(true);
    setMessage('');
    try {
      const targetContent = linkType === 'self'
        ? draft
        : targetDoc ? (await getEditableDocument(scope, targetDoc.group, targetDoc.name)).content : '';
      if (!targetContent) { setMessage('请先选择目标文档'); return; }
      const parsed = new DOMParser().parseFromString(renderMarkdownHtml(targetContent), 'text/html');
      const blocks = findAnchorBlocks(parsed.body, HEAD_PARA_SELECTOR);
      const counts = new Map<string, number>();
      blocks.forEach(({ anchor: id }) => counts.set(id, (counts.get(id) ?? 0) + 1));
      setAnchors(blocks.filter(({ anchor: id }) => counts.get(id) === 1).map(({ anchor: id, label: text }) => ({ anchor: id, label: text })));
      setAnchor('');
      if (blocks.length && counts.size !== blocks.length) setMessage('重复段落已排除，避免跳到错误位置');
    } catch (error) {
      setMessage(`读取目标段落失败：${(error as Error).message}`);
    } finally { setBusy(false); }
  };

  const captureSelection = (): void => {
    const input = textareaRef.current;
    if (!input) return;
    const next = { start: input.selectionStart, end: input.selectionEnd };
    setSelection(next);
    const selected = draft.slice(next.start, next.end);
    if (selected && !selected.includes('\n')) {
      setLabel(selectedJumpLabel(selected) ?? selected);
    }
  };

  const insertLink = (): void => {
    const title = label.trim();
    if (!title || /[\r\n]/.test(title)) { setMessage('显示文案不能为空，且不能包含换行'); return; }
    let target: KiLinkTarget;
    if (linkType === 'external') {
      try {
        const url = new URL(externalUrl.trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error();
        target = { v: 1, type: 'external', url: url.href };
      } catch { setMessage('外部网址必须是 HTTP(S) 地址'); return; }
    } else {
      const doc = linkType === 'self' ? { group, name: relation } : targetDoc;
      if (!doc) { setMessage('请先选择目标文档'); return; }
      target = { v: 1, type: 'document', scope, group: doc.group, relation: doc.name, ...(anchor ? { anchor } : {}) };
    }
    const replacement = `[${escapeLinkLabel(title)}](${encodeKiLink(target)})`;
    const current = draft.slice(selection.start, selection.end);
    const next = draft.slice(0, selection.start) + replacement + draft.slice(selection.end);
    setDraft(next);
    setSelection({ start: selection.start + replacement.length, end: selection.start + replacement.length });
    setMessage(current ? '已替换选中内容为跳转链接，保存后生效' : '已在光标位置插入跳转链接，保存后生效');
    setTab('source');
  };

  const removeLink = (): void => {
    const selected = draft.slice(selection.start, selection.end);
    const existing = selectedJumpLabel(selected);
    if (existing === null) { setMessage('请在源码中选中一整条新增跳转链接后删除'); return; }
    setDraft(draft.slice(0, selection.start) + existing + draft.slice(selection.end));
    setMessage('已移除跳转，保存后生效');
  };

  return createPortal(
    <div className="ki-editor-overlay" role="presentation">
      <section className="ki-editor" role="dialog" aria-modal="true" aria-label={`编辑 ${relation}`}>
        <header className="ki-editor__head">
          <div><strong>编辑 {relation}</strong><small>{group}</small></div>
          <button className="ki-btn ki-btn--secondary" type="button" onClick={close}>关闭</button>
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
              <textarea ref={textareaRef} className="ki-editor__textarea" value={draft}
                onChange={(event) => setDraft(event.target.value)} onSelect={captureSelection}
                spellCheck={false} aria-label="Markdown 正文" />
            ) : (
              <div className="ki-editor__preview ki-markdown"><MarkdownPreview text={draft} assetBase={{ scope, group }} /></div>
            )}
          </div>
          <aside className="ki-editor__links" aria-label="添加跳转链接">
            <h3>跳转链接</h3>
            <p>在源码中选中文字，或把光标放在插入处。</p>
            <label>显示文案<input value={label} onChange={(event) => setLabel(event.target.value)} /></label>
            <label>目标类型<select value={linkType} onChange={(event) => { setLinkType(event.target.value as typeof linkType); setAnchor(''); setAnchors([]); }}>
              <option value="external">外部网页</option><option value="self">本文位置</option><option value="other">其他文档或位置</option>
            </select></label>
            {linkType === 'external' ? <label>HTTP(S) 地址<input value={externalUrl} onChange={(event) => setExternalUrl(event.target.value)} placeholder="https://…" /></label> : (
              <>
                {linkType === 'other' && <>
                  <label>查找目标文档<input value={docQuery} onChange={(event) => { setDocQuery(event.target.value); setTargetDoc(null); setMatches([]); setAnchors([]); setAnchor(''); }} /></label>
                  <button type="button" className="ki-btn ki-btn--secondary" onClick={() => void searchDocs()} disabled={busy}>查找</button>
                  <div className="ki-editor__results">{matches.map((doc) => <button type="button" key={`${doc.group}/${doc.name}`}
                    className={targetDoc?.group === doc.group && targetDoc.name === doc.name ? 'is-active' : ''}
                    onClick={() => { setTargetDoc(doc); setAnchors([]); setAnchor(''); }}>
                    {doc.group} / {doc.name}
                  </button>)}</div>
                  {targetDoc && <p>目标：{targetDoc.group} / {targetDoc.name}</p>}
                </>}
                <button type="button" className="ki-btn ki-btn--secondary" onClick={() => void loadAnchors()} disabled={busy || (linkType === 'other' && !targetDoc)}>读取标题/段落</button>
                <label>目标位置<select value={anchor} onChange={(event) => setAnchor(event.target.value)}>
                  <option value="">文档开头</option>
                  {anchors.map((item) => <option key={item.anchor} value={item.anchor}>{item.label.slice(0, 80)}</option>)}
                </select></label>
              </>
            )}
            <button type="button" className="ki-btn ki-btn--primary" onClick={insertLink} disabled={!loaded}>插入或替换跳转</button>
            <button type="button" className="ki-btn ki-btn--secondary" onClick={removeLink} disabled={!loaded}>移除选中跳转</button>
          </aside>
        </div>
        <footer className="ki-editor__foot">
          <label className="ki-editor__vector"><input type="checkbox" checked={vectorize} onChange={(event) => { setVectorize(event.target.checked); setVectorizeTouched(true); }} />保存时向量化（默认关闭；关闭时普通编辑写入 FTS）</label>
          <span>{dirty ? '有未保存修改' : modeChange ? `保存将切换为${vectorize ? 'dense 向量' : 'FTS 全文'}` : '无未保存修改'}</span>
          <button type="button" className="ki-btn ki-btn--primary" onClick={() => void save()} disabled={!canSave || busy || Boolean(loaded?.sourceError)}>保存</button>
        </footer>
      </section>
    </div>, document.body,
  );
}
