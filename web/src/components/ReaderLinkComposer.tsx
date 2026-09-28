import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { getDocList, getEditableDocument, saveEditableDocument, type DocItem, type SaveDocumentResponse } from '@/api/httpApi';
import { kiGetModuleInfo } from '@/api/mcpClient';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { anchorBlock, findAnchorBlocks, type KiLinkTarget } from '@/lib/kiLinks';
import { externalTarget, insertReaderLink } from '@/lib/readerLinks';

export interface ReaderLinkSelection {
  text: string;
  rect: { left: number; top: number; bottom: number };
}

interface Props {
  scope: string;
  group: string;
  relation: string;
  currentContent: string;
  selection: ReaderLinkSelection;
  onSaved: (content: string, result: SaveDocumentResponse) => void;
  onPartialSaved: (content: string, warning: string) => void;
  onClose: () => void;
}

interface TargetPosition {
  anchor: string;
  quote: string;
  kind: '标题' | '段落' | '列表项' | '表格单元格';
}

type SaveArgs = Parameters<typeof saveEditableDocument>[0];
type PendingSave = { target: KiLinkTarget; token: string; args: SaveArgs; content: string };

/** 落点块的中文名，用于对话框底部提示。 */
function blockLabel(element: HTMLElement): TargetPosition['kind'] {
  const tag = element.tagName.toLowerCase();
  if (tag === 'p') return '段落';
  if (tag === 'li') return '列表项';
  if (tag === 'td' || tag === 'th') return '表格单元格';
  return '标题';
}

export function ReaderLinkComposer({ scope, group, relation, currentContent, selection, onSaved, onPartialSaved, onClose }: Props): JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [externalUrl, setExternalUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveLocked, setSaveLocked] = useState(false);
  const [retryReady, setRetryReady] = useState(false);
  const [query, setQuery] = useState('');
  const [docs, setDocs] = useState<DocItem[]>([]);
  const [docsLoading, setDocsLoading] = useState(false);
  const [docsTruncated, setDocsTruncated] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocItem>({ group, name: relation });
  const [targetContent, setTargetContent] = useState<string | null>(currentContent);
  const [targetLoading, setTargetLoading] = useState(false);
  const [position, setPosition] = useState<TargetPosition | null>(null);
  const [outline, setOutline] = useState<{ label: string; level: number; index: number }[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ left: 12, top: 12, visibility: 'hidden' });
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);

  useLayoutEffect(() => {
    if (pickerOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(12, Math.min(selection.rect.left, window.innerWidth - width - 12));
    const below = selection.rect.bottom + 10;
    const top = below + height <= window.innerHeight - 12
      ? below : Math.max(12, selection.rect.top - height - 10);
    setPanelStyle({ left, top, visibility: 'visible' });
  }, [pickerOpen, selection.rect]);

  useEffect(() => {
    if (!pickerOpen) return;
    searchRef.current?.focus();
  }, [pickerOpen]);

  useEffect(() => {
    if (!pickerOpen) return;
    let active = true;
    const timer = window.setTimeout(() => {
      setDocsLoading(true);
      void getDocList(scope, query.trim() ? { q: query.trim() } : {}).then((result) => {
        if (!active) return;
        setDocs(result.docs);
        setDocsTruncated(Boolean(result.truncated));
      }).catch((error: Error) => {
        if (active) setMessage(`查找文档失败：${error.message}`);
      }).finally(() => { if (active) setDocsLoading(false); });
    }, query.trim() ? 300 : 0);
    return () => { active = false; window.clearTimeout(timer); };
  }, [pickerOpen, query, scope]);

  useEffect(() => {
    if (!pickerOpen) return;
    setPosition(null);
    setOutline([]);
    setOutlineOpen(false);
    if (selectedDoc.group === group && selectedDoc.name === relation) {
      setTargetContent(currentContent);
      setTargetLoading(false);
      return;
    }
    let active = true;
    setTargetContent(null);
    setTargetLoading(true);
    void kiGetModuleInfo(scope, selectedDoc.group, selectedDoc.name).then((result) => {
      if (!active) return;
      if (!result.content) throw new Error(result.error || result.hint || '无法读取目标文档正文');
      setTargetContent(result.content);
    }).catch((error: Error) => { if (active) setMessage(`读取目标文档失败：${error.message}`); })
      .finally(() => { if (active) setTargetLoading(false); });
    return () => { active = false; };
  }, [pickerOpen, scope, group, relation, selectedDoc.group, selectedDoc.name, currentContent]);

  useEffect(() => {
    if (!pickerOpen || !targetContent) return;
    const frame = window.requestAnimationFrame(() => {
      const root = previewRef.current;
      if (!root) return;
      setOutline(Array.from(root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'))
        .map((heading, index) => ({ label: heading.textContent?.trim() ?? '', level: Number(heading.tagName.slice(1)), index }))
        .filter((heading) => heading.label.length > 0));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pickerOpen, targetContent]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || busy) return;
      event.stopPropagation();
      if (pickerOpen) setPickerOpen(false);
      else onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [busy, pickerOpen, onClose]);

  const captureTargetSelection = (): void => {
    const root = previewRef.current;
    const selected = window.getSelection();
    if (!root || !selected?.rangeCount || !selected.toString().trim()) return;
    const range = selected.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return;
    const startBlock = anchorBlock(range.startContainer);
    const endBlock = anchorBlock(range.endContainer);
    const clearHighlight = (): void => root.querySelectorAll('.ki-reader-link-target')
      .forEach((element) => element.classList.remove('ki-reader-link-target'));
    if (!startBlock || startBlock !== endBlock || !root.contains(startBlock)) {
      setPosition(null);
      clearHighlight();
      setMessage('请只选中同一标题、段落、列表项或表格单元格中的文字');
      return;
    }
    const blocks = findAnchorBlocks(root);
    const block = blocks.find((entry) => entry.element === startBlock);
    const duplicates = block ? blocks.filter((entry) => entry.anchor === block.anchor).length : 0;
    if (!block || duplicates !== 1) {
      setPosition(null);
      clearHighlight();
      setMessage(duplicates > 1
        ? `这段文字在文档中出现 ${duplicates} 次，无法确定要跳向哪一处；请改选其他位置`
        : '这个位置无法唯一定位；请改选其他位置');
      return;
    }
    clearHighlight();
    startBlock.classList.add('ki-reader-link-target');
    setPosition({ anchor: block.anchor, quote: selected.toString().trim(), kind: blockLabel(startBlock) });
    setMessage('');
  };

  useEffect(() => {
    if (!pickerOpen) return;
    let timer: number | undefined;
    const handler = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(captureTargetSelection, 100);
    };
    document.addEventListener('selectionchange', handler);
    return () => { window.clearTimeout(timer); document.removeEventListener('selectionchange', handler); };
  });

  const commitTarget = async (target: KiLinkTarget): Promise<void> => {
    if (busy || saveLocked) return;
    setBusy(true);
    setMessage('');
    const token = JSON.stringify(target);
    let request: PendingSave | null = null;
    try {
      if (pendingSaveRef.current) {
        if (pendingSaveRef.current.token !== token) throw new Error('请先重试当前保存，或关闭面板后重新选择');
        request = pendingSaveRef.current;
      } else {
        const loaded = await getEditableDocument(scope, group, relation);
        if (loaded.sourceError) throw new Error(`源文件校验失败：${loaded.sourceError}`);
        const content = insertReaderLink(loaded.content, selection.text, target);
        request = {
          target,
          token,
          content,
          args: {
            scope, group, relation, content,
            expectedRevision: loaded.revision,
            expectedSourceRevision: loaded.sourceRevision,
            vectorize: loaded.indexMode === 'dense',
          },
        };
      }
      const result = await saveEditableDocument(request.args);
      pendingSaveRef.current = null;
      onSaved(request.content, result);
      onClose();
    } catch (error) {
      const failure = error as Error & { body?: { details?: { editId?: string; retryable?: boolean; kb?: string; source?: string } } };
      const details = failure.body?.details;
      if (request && details?.editId && details.retryable !== false) {
        pendingSaveRef.current = { ...request, args: { ...request.args, editId: details.editId } };
        setRetryReady(true);
      } else {
        pendingSaveRef.current = null;
        setRetryReady(false);
      }
      if (request && details?.kb === 'written') {
        onPartialSaved(request.content, `KB 正文已更新，但源文件状态为${details.source ?? '未知'}；请处理保存提示`);
        if (details.retryable === false) setSaveLocked(true);
      }
      setMessage(`保存失败：${failure.message}${details?.retryable && details.editId ? '；可重试当前保存' : ''}`);
    } finally {
      setBusy(false);
    }
  };

  const addExternal = (): void => {
    try { void commitTarget(externalTarget(externalUrl)); }
    catch (error) { setMessage((error as Error).message); }
  };

  const retrySave = (): void => {
    if (pendingSaveRef.current) void commitTarget(pendingSaveRef.current.target);
  };

  const currentDoc: DocItem = { group, name: relation };
  const list = [currentDoc, ...docs.filter((doc) => doc.group !== group || doc.name !== relation)];
  const visibleList = query.trim()
    ? list.filter((doc) => `${doc.group} ${doc.name}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
    : list;

  return createPortal(<>
    {!pickerOpen && <section ref={panelRef} className="ki-reader-link-panel" style={panelStyle} aria-label="为选中文字添加跳转">
      <div className="ki-reader-link-panel__head"><strong>为选中文字添加跳转</strong><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      <p className="ki-reader-link-panel__quote" title={selection.text}>“{selection.text}”</p>
      <label htmlFor="ki-reader-external-url">外部网址</label>
      <input id="ki-reader-external-url" type="url" value={externalUrl} onChange={(event) => { setExternalUrl(event.target.value); setMessage(''); }} placeholder="https://example.com" disabled={busy || retryReady || saveLocked} />
      <button className="ki-btn ki-btn--primary" type="button" onClick={addExternal} disabled={busy || saveLocked}>{busy ? '保存中…' : retryReady ? '重试保存' : '添加外部链接'}</button>
      <div className="ki-reader-link-panel__or">或</div>
      <button className="ki-btn ki-btn--secondary" type="button" onClick={() => { setPickerOpen(true); setMessage(''); }} disabled={busy || retryReady || saveLocked}>选择知识库文档或段落</button>
      {message && <p className="ki-reader-link__error" role="status">{message}</p>}
    </section>}
    {pickerOpen && <div className="ki-reader-link-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setPickerOpen(false); }}>
      <section className="ki-reader-link-dialog" role="dialog" aria-modal="true" aria-label="选择跳转位置">
        <header className="ki-reader-link-dialog__head">
          <div><small>知识库内跳转</small><h2>选择跳转位置</h2><p>在文档正文里划选要跳到的文字，确认后跳到所在位置；右上角大纲可快速定位。</p></div>
          <button type="button" onClick={() => setPickerOpen(false)} disabled={busy} aria-label="关闭选择器">×</button>
        </header>
        <div className="ki-reader-link-dialog__body">
          <aside className="ki-reader-link-dialog__docs" aria-label="知识库文档">
            <label htmlFor="ki-reader-doc-search">查找文档</label>
            <input ref={searchRef} id="ki-reader-doc-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文档名称或路径" disabled={busy || retryReady || saveLocked} />
            <div className="ki-reader-link-dialog__doc-list">
              {docsLoading && <p className="ki-reader-link-dialog__hint">正在查找文档…</p>}
              {!docsLoading && !visibleList.length && <p className="ki-reader-link-dialog__hint">没有匹配的文档</p>}
              {visibleList.map((doc) => <button key={`${doc.group}/${doc.name}`} type="button"
                className={selectedDoc.group === doc.group && selectedDoc.name === doc.name ? 'is-active' : ''}
                onClick={() => { setSelectedDoc(doc); setPosition(null); setMessage(''); }} disabled={busy || retryReady || saveLocked}>
                <strong>{doc.name}{doc.group === group && doc.name === relation ? ' · 当前文档' : ''}</strong><small>{doc.group}</small>
              </button>)}
              {docsTruncated && <p className="ki-reader-link-dialog__hint">文档较多，可输入关键词继续查找。</p>}
            </div>
          </aside>
          <div className="ki-reader-link-dialog__target">
            <div className="ki-reader-link-dialog__target-head">
              <div><small>{selectedDoc.group}</small><h3>{selectedDoc.name}</h3></div>
              <div className="ki-reader-link-dialog__outline-wrap">
                <button type="button" className="ki-reader-link-dialog__outline-button" onClick={() => setOutlineOpen(!outlineOpen)} aria-expanded={outlineOpen}>☷ 大纲 ▾</button>
                {outlineOpen && <div className="ki-reader-link-dialog__outline" aria-label="目标文档大纲">
                  {outline.length ? outline.map((heading) => <button key={heading.index} type="button"
                    style={{ paddingLeft: 10 + Math.max(0, heading.level - 1) * 8 }}
                    onClick={() => {
                      previewRef.current?.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[heading.index]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      setOutlineOpen(false);
                    }}>{heading.label}</button>) : <p>此文档没有标题</p>}
                </div>}
              </div>
            </div>
            <div ref={previewScrollRef} className="ki-reader-link-dialog__scroll">
              <div className="ki-reader-link-dialog__guide"><span>划选标题或段落里的文字；段落内任意选区都会定位到整段</span><button type="button" onClick={() => void commitTarget({ v: 1, type: 'document', scope, group: selectedDoc.group, relation: selectedDoc.name })} disabled={busy || targetLoading || !targetContent || retryReady || saveLocked}>跳到文档开头 ↗</button></div>
              {targetLoading ? <p className="ki-reader-link-dialog__hint">正在加载文档正文…</p> : targetContent ? (
                <div ref={previewRef} className="ki-markdown ki-reader-link-dialog__preview" onMouseUp={captureTargetSelection} onKeyUp={captureTargetSelection} onClickCapture={(event) => { if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault(); }}>
                  <MarkdownPreview text={targetContent} assetBase={{ scope, group: selectedDoc.group }} />
                </div>
              ) : <p className="ki-reader-link-dialog__hint">无法显示目标文档正文，请选择其他文档。</p>}
            </div>
            <footer className="ki-reader-link-dialog__selection">
              <div><strong>{position ? `已选中${position.kind}中的位置` : '尚未选择位置'}</strong><small>{position ? `“${position.quote}”` : '请在正文中划选要跳到的文字'}</small></div>
              <button type="button" className="ki-btn ki-btn--primary" onClick={() => position && void commitTarget({ v: 1, type: 'document', scope, group: selectedDoc.group, relation: selectedDoc.name, anchor: position.anchor })} disabled={!position || busy || retryReady || saveLocked}>{busy ? '保存中…' : '跳转到此处'}</button>
            </footer>
          </div>
        </div>
        <footer className="ki-reader-link-dialog__foot"><span>{message || '标题、段落、列表项、表格单元格都能作为落点；重复出现的文字不可选，以免跳错。'}</span>{retryReady ? <button type="button" className="ki-btn ki-btn--primary" onClick={retrySave} disabled={busy}>{busy ? '保存中…' : '重试保存'}</button> : <span>Esc 关闭</span>}</footer>
      </section>
    </div>}
  </>, document.body);
}
