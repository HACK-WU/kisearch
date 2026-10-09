import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { getEditableDocument, saveEditableDocument, type DocItem, type SaveDocumentResponse } from '@/api/httpApi';
import { kiGetModuleInfo } from '@/api/mcpClient';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { GroupTreePanel } from '@/components/GroupTreePanel';
import { Icon } from '@/components/icons';
import { useDocList } from '@/lib/hooks';
import { CHAT_REF_MAX_COUNT, CHAT_REF_TEXT_MAX, CHAT_REF_TOTAL_MAX, type ChatRef } from '@/api/chatContract';
import { anchorBlock, findAnchorBlocks, type KiLinkTarget } from '@/lib/kiLinks';
import { externalTarget, insertReaderLink } from '@/lib/readerLinks';

export interface ReaderLinkSelection {
  text: string;
  rect: { left: number; top: number; bottom: number };
}

/**
 * 双模式文档选择器（用户拍板「直接全部复用」——引用选择不另起炉灶，共用本模态）：
 *
 * · mode 'link'（默认）：为编辑器选中文字添加跳转，产出落点锚（同一块内 + 全文唯一），
 *   走保存事务（冲突重试 / 部分失败锁定）。既有调用方不传 mode 即可，行为不变。
 * · mode 'ref'：选择知识库文档**段落文本**加入 AI 提问上下文（REQ-20261009-002）。
 *   划选可跨块（选的是内容不是位置）、按文本去重/限长、无保存事务（onAddRef 即完成）。
 *
 * 复用项：目录搜索、目录树（GroupTreePanel）、正文预览（MarkdownPreview）、文档加载链、
 * 划选管线（selectionchange → captureTargetSelection）、大纲浮层、模态壳与 Esc/遮罩关闭。
 * ref 模式不可达：insertReaderLink 正文写入、commitTarget 保存事务（冲突重试 / 部分失败锁定）。
 */
interface Props {
  scope: string;
  onClose: () => void;
  /** 默认 'link' */
  mode?: 'link' | 'ref';
  /* ── link 模式专属 ── */
  group?: string;
  relation?: string;
  currentContent?: string;
  selection?: ReaderLinkSelection;
  onSaved?: (content: string, result: SaveDocumentResponse) => void;
  onPartialSaved?: (content: string, warning: string) => void;
  /* ── ref 模式专属 ── */
  /** 打开时默认选中的文档（通常是当前正在读的那篇）；不传则从「请选择文档」空态开始 */
  initialDoc?: { group: string; doc: string };
  /** 已加入的引用：去重与上限校验依据 */
  currentRefs?: readonly ChatRef[];
  /** 确认加入一段引用（加入即完成，无保存事务） */
  onAddRef?: (ref: ChatRef) => void;
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

const EMPTY_REFS: readonly ChatRef[] = [];

export function ReaderLinkComposer(props: Props): JSX.Element {
  const {
    scope, onClose,
    mode = 'link',
    group = '', relation = '', currentContent = '',
    selection, onSaved, onPartialSaved,
    initialDoc, currentRefs = EMPTY_REFS, onAddRef,
  } = props;
  const isRef = mode === 'ref';
  // link 专属 props 的运行时兜底（ref 模式不传；link 模式由调用方必传，类型层面为全可选妥协）：
  // 提供空实现/空值保证 ref 路径安全，link 路径行为与合并前完全一致
  const linkSelection: ReaderLinkSelection = selection ?? { text: '', rect: { left: 0, top: 0, bottom: 0 } };
  const linkSaved = onSaved ?? (() => {});
  const linkPartialSaved = onPartialSaved ?? (() => {});
  // ref 模式没有外层小面板步骤：打开即进选择器
  const [pickerOpen, setPickerOpen] = useState(isRef);
  const [externalUrl, setExternalUrl] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveLocked, setSaveLocked] = useState(false);
  const [retryReady, setRetryReady] = useState(false);
  const [selectedDoc, setSelectedDoc] = useState<DocItem>(
    initialDoc ? { group: initialDoc.group, name: initialDoc.doc } : { group, name: relation },
  );
  const [targetContent, setTargetContent] = useState<string | null>(currentContent);
  const [targetLoading, setTargetLoading] = useState(false);
  const [position, setPosition] = useState<TargetPosition | null>(null);
  const [outline, setOutline] = useState<{ label: string; level: number; index: number }[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** ref 模式：当前划选的段落文本（选的是内容而非位置，可跨块） */
  const [refText, setRefText] = useState('');
  /** ref 模式：左栏目录搜索词（有词时结果列表替代树） */
  const [query, setQuery] = useState('');
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({ left: 12, top: 12, visibility: 'hidden' });
  const panelRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const pendingSaveRef = useRef<PendingSave | null>(null);

  useLayoutEffect(() => {
    if (pickerOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const width = panel.offsetWidth;
    const height = panel.offsetHeight;
    const left = Math.max(12, Math.min(linkSelection.rect.left, window.innerWidth - width - 12));
    const below = linkSelection.rect.bottom + 10;
    const top = below + height <= window.innerHeight - 12
      ? below : Math.max(12, linkSelection.rect.top - height - 10);
    setPanelStyle({ left, top, visibility: 'visible' });
  }, [pickerOpen, linkSelection.rect]);

  // ref 模式：左栏搜索（有词时用内存过滤的结果列表替代树，与浏览页同口径）
  const { data: docListData } = useDocList(scope);
  const matches = useMemo(() => {
    const kw = query.trim().toLowerCase();
    if (!kw) return [];
    return (docListData?.docs ?? []).filter((d) =>
      d.name.toLowerCase().includes(kw) || (d.group ?? '').toLowerCase().includes(kw));
  }, [docListData, query]);

  useEffect(() => {
    if (!pickerOpen) return;
    setPosition(null);
    setOutline([]);
    setOutlineOpen(false);
    if (isRef) setRefText(''); // 切文档即清选区，避免把 A 文档的划选加到 B 文档上
    // ref 模式未选文档（打开时无 initialDoc）：不请求，展示「从左侧选择」空态
    if (isRef && !selectedDoc.name) { setTargetContent(null); setTargetLoading(false); return; }
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
      if (pickerOpen && !isRef) setPickerOpen(false); // link：先收选择器回小面板；ref：直接关
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
    if (isRef) {
      // 引用模式选的是**内容**而非位置：可跨块、无唯一性约束；去重/限长在确认时校验
      setRefText(selected.toString().trim());
      setMessage('');
      return;
    }
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

  // ── ref 模式校验与提交（自原独立 ChatRefPicker 合并）：去重 / 单条上限 / 条数上限 / 总量守卫 ──
  const refDuplicated = currentRefs.some((r) => r.group === selectedDoc.group && r.doc === selectedDoc.name && r.text === refText);
  const refTooLong = refText.length > CHAT_REF_TEXT_MAX;
  const refFull = currentRefs.length >= CHAT_REF_MAX_COUNT;
  const refUsedChars = currentRefs.reduce((n, r) => n + r.text.length, 0);
  const refOverTotal = refUsedChars + refText.length > CHAT_REF_TOTAL_MAX;
  const refDisabled = refText.length === 0 || refTooLong || refDuplicated || refFull || refOverTotal;
  const refActionLabel = refText.length === 0
    ? '请先选中文档内容'
    : refTooLong
      ? `选区过长（${refText.length} 字，上限 ${CHAT_REF_TEXT_MAX}）`
      : refDuplicated
        ? '这段内容已在引用中'
        : refFull
          ? `已达上限 ${CHAT_REF_MAX_COUNT} 段`
          : refOverTotal
            ? `引用合计将超过 ${CHAT_REF_TOTAL_MAX} 字`
            : '加入对话';
  const commitRef = (): void => {
    if (refDisabled || !onAddRef) return;
    onAddRef({ group: selectedDoc.group, doc: selectedDoc.name, text: refText });
    onClose();
  };

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
        const content = insertReaderLink(loaded.content, linkSelection.text, target);
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
      linkSaved(request.content, result);
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
        linkPartialSaved(request.content, `KB 正文已更新，但源文件状态为${details.source ?? '未知'}；请处理保存提示`);
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

  return createPortal(<>
    {!pickerOpen && <section ref={panelRef} className="ki-reader-link-panel" style={panelStyle} aria-label="为选中文字添加跳转">
      <div className="ki-reader-link-panel__head"><strong>为选中文字添加跳转</strong><button type="button" onClick={onClose} aria-label="关闭">×</button></div>
      <p className="ki-reader-link-panel__quote" title={linkSelection.text}>“{linkSelection.text}”</p>
      <label htmlFor="ki-reader-external-url">外部网址</label>
      <input id="ki-reader-external-url" type="url" value={externalUrl} onChange={(event) => { setExternalUrl(event.target.value); setMessage(''); }} placeholder="https://example.com" disabled={busy || retryReady || saveLocked} />
      <button className="ki-btn ki-btn--primary" type="button" onClick={addExternal} disabled={busy || saveLocked}>{busy ? '保存中…' : retryReady ? '重试保存' : '添加外部链接'}</button>
      <div className="ki-reader-link-panel__or">或</div>
      <button className="ki-btn ki-btn--secondary" type="button" onClick={() => { setPickerOpen(true); setMessage(''); }} disabled={busy || retryReady || saveLocked}>选择知识库文档或段落</button>
      {message && <p className="ki-reader-link__error" role="status">{message}</p>}
    </section>}
    {pickerOpen && <div className="ki-reader-link-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) (isRef ? onClose() : setPickerOpen(false)); }}>
      <section className="ki-reader-link-dialog" role="dialog" aria-modal="true" aria-label={isRef ? '选择要加入提问的文档内容' : '选择跳转位置'}>
        {isRef ? (
          /* ref 头部与「添加链接」模态**完全同一结构**（eyebrow · 大标题 · 说明 · 关闭），
             两个选择器打开时视觉一致；搜索框移到左栏顶部（见 aside）。 */
          <header className="ki-reader-link-dialog__head">
            <div>
              <small>加入引用 · 已引用 {currentRefs.length} / {CHAT_REF_MAX_COUNT} 段</small>
              <h2>选择要加入提问的文档内容</h2>
              <p>左侧选文档（可搜索），右侧在正文里划选要引用的文字；加入后可在输入框标签上移除。</p>
            </div>
            <button type="button" onClick={onClose} aria-label="关闭选择器">×</button>
          </header>
        ) : (
        <header className="ki-reader-link-dialog__head">
          <div><small>知识库内跳转</small><h2>选择跳转位置</h2><p>在文档正文里划选要跳到的文字，确认后跳到所在位置；右上角大纲可快速定位。</p></div>
          <button type="button" onClick={() => setPickerOpen(false)} disabled={busy} aria-label="关闭选择器">×</button>
        </header>
        )}
        <div className="ki-reader-link-dialog__body">
          {/* 目录选择复用全屏阅读器的「知识目录」树：同样的层级、展开/折叠与当前文档高亮 */}
          <aside className="ki-reader-link-dialog__docs" aria-label="知识库文档">
            {/* 目录搜索条：横跨左栏顶部一行，link / ref 两个模式共用
               （用户：「给添加链接的弹框那也加上搜索框」）；复用 `.ki-reader-search` 同款样式 */}
            <label className="ki-reader-search ki-chat-refpicker__tree-search">
              <Icon name="search" className="ki-icon ki-icon--sm ki-reader-search__icon" />
              <input className="ki-form-input" placeholder="搜索文档名或路径…" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索文档" />
              {query ? <button type="button" className="ki-reader-search__clear" onMouseDown={(event) => event.preventDefault()} onClick={() => setQuery('')} title="清空检索词" aria-label="清空检索词"><Icon name="x" className="ki-icon ki-icon--sm" /></button> : null}
            </label>
            {query.trim() ? (
              /* 有搜索词时用结果列表替代树：命中常散落多个 Group，树形展开不便于定位 */
              <ul className="ki-chat-refpicker__results">
                {matches.length === 0 ? (
                  <li className="ki-chat-refpicker__hint">未找到匹配「{query.trim()}」的文档</li>
                ) : (
                  <>
                    <li className="ki-chat-refpicker__result-count" role="status">命中 {matches.length} 篇</li>
                    {matches.map((d) => (
                      <li key={`${d.group}/${d.name}`}>
                        <button
                          type="button"
                          className={`ki-chat-refpicker__result${d.group === selectedDoc.group && d.name === selectedDoc.name ? ' ki-chat-refpicker__result--active' : ''}`}
                          onClick={() => { setSelectedDoc({ group: d.group, name: d.name }); setRefText(''); setMessage(''); }}
                        >
                          <span className="ki-chat-refpicker__result-name">{d.name}</span>
                          <span className="ki-chat-refpicker__result-group">{d.group}</span>
                        </button>
                      </li>
                    ))}
                  </>
                )}
              </ul>
            ) : (
              <GroupTreePanel
                scope={scope}
                activeGroup={isRef ? selectedDoc.group : group}
                activeDocName={isRef ? selectedDoc.name : relation}
                onOpenDoc={(doc) => {
                  setSelectedDoc({ group: doc.group, name: doc.name, path: doc.path });
                  if (isRef) setRefText(''); else setPosition(null);
                  setMessage('');
                }}
              />
            )}
          </aside>
          <div className="ki-reader-link-dialog__target">
            <div className="ki-reader-link-dialog__target-head">
              <div><small>{selectedDoc.group}</small><h3>{selectedDoc.name || (isRef ? '请选择文档' : '')}</h3></div>
              {/* 大纲：长文档快速定位到章节再划选/跳转——link 与 ref 同需（用户反馈「大纲呢，怎么没加」） */}
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
              {!isRef && <div className="ki-reader-link-dialog__guide"><span>划选标题或段落里的文字；段落内任意选区都会定位到整段</span><button type="button" onClick={() => void commitTarget({ v: 1, type: 'document', scope, group: selectedDoc.group, relation: selectedDoc.name })} disabled={busy || targetLoading || !targetContent || retryReady || saveLocked}>跳到文档开头 ↗</button></div>}
              {targetLoading ? <p className="ki-reader-link-dialog__hint">正在加载文档正文…</p> : targetContent ? (
                <div ref={previewRef} className="ki-markdown ki-reader-link-dialog__preview" onMouseUp={captureTargetSelection} onKeyUp={captureTargetSelection} onClickCapture={(event) => { if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault(); }}>
                  <MarkdownPreview text={targetContent} assetBase={{ scope, group: selectedDoc.group }} />
                </div>
              ) : <p className="ki-reader-link-dialog__hint">{isRef && !selectedDoc.name ? '从左侧选择一篇文档，然后在正文里划选要引用的内容。' : '无法显示目标文档正文，请选择其他文档。'}</p>}
            </div>
            <footer className="ki-reader-link-dialog__selection">
              {isRef ? (
                <>
                  <div><strong>{refText ? `已选中 ${refText.length} 字` : '尚未选中内容'}</strong><small title={refText}>{refText ? `“${refText.slice(0, 60)}${refText.length > 60 ? '…' : ''}”` : '在右侧正文里划选一段文字'}</small></div>
                  <button type="button" className="ki-btn ki-btn--primary" onClick={commitRef} disabled={refDisabled}>{refActionLabel}</button>
                </>
              ) : (
                <>
                  <div><strong>{position ? `已选中${position.kind}中的位置` : '尚未选择位置'}</strong><small>{position ? `“${position.quote}”` : '请在正文中划选要跳到的文字'}</small></div>
                  <button type="button" className="ki-btn ki-btn--primary" onClick={() => position && void commitTarget({ v: 1, type: 'document', scope, group: selectedDoc.group, relation: selectedDoc.name, anchor: position.anchor })} disabled={!position || busy || retryReady || saveLocked}>{busy ? '保存中…' : '跳转到此处'}</button>
                </>
              )}
            </footer>
          </div>
        </div>
        <footer className="ki-reader-link-dialog__foot"><span>{message || (isRef ? '划选的段落文本会原样加入提问上下文；重复加入会被去重，标签上的 × 可移除。' : '标题、段落、列表项、表格单元格都能作为落点；重复出现的文字不可选，以免跳错。')}</span>{!isRef && retryReady ? <button type="button" className="ki-btn ki-btn--primary" onClick={retrySave} disabled={busy}>{busy ? '保存中…' : '重试保存'}</button> : <span>Esc 关闭</span>}</footer>
      </section>
    </div>}
  </>, document.body);
}
