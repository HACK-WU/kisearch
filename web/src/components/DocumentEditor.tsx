import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getEditableDocument, saveEditableDocument, type EditableDocument, type SaveDocumentResponse } from '@/api/httpApi';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { editorVectorizeHint, useVectorAvailability } from '@/lib/hooks';
// 根散文件的 group 是保留键（`__root__`）：编辑器头部路径段整段省略
import { groupPathSegment } from '@/lib/groupTree';

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
  /** 「以 KB 覆盖 wiki 回写目标」的二次确认弹窗 */
  const [forceOpen, setForceOpen] = useState(false);
  const forceCancelRef = useRef<HTMLButtonElement>(null);
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
  /**
   * 2026-11-12 用户定稿 B 口径：**未手动切换时跟随文档当前索引模式**（dense 默认开、fts 默认关）。
   *
   * 为什么不做成 `useState(true)`：本开关决定的是 `saveDocumentEdit` 的 `mode`（dense / fts），
   * 而 fts 一旦保存成 dense 就**不可逆**。把初值写死 true 会让 `--no-vector` 导入的 fts-only
   * 文档在第一次在线编辑时被隐式升级、开始调 embedding —— 用户并没有做过这个决定。
   *
   * ★ 跟随值必须在 `loaded` 之后派生：文档加载是异步的，写进 useState 初值拿不到 indexMode。
   */
  const vectorizeChoice = vectorizeTouched ? vectorize : loaded?.indexMode === 'dense';
  const effectiveVectorize = vectorizeChoice && vectorAvailable;
  const dirty = loaded !== null && draft !== loaded.content;
  const modeChange = loaded !== null && (dirty || vectorizeTouched)
    && (effectiveVectorize ? loaded.indexMode !== 'dense' : loaded.indexMode !== 'fts');
  const hasUnsavedChanges = dirty || modeChange || Boolean(editId);
  const canSave = hasUnsavedChanges;
  /**
   * 强制覆盖入口只对「内容分叉」开放（REQ：以 KB 覆盖 wiki 回写目标）。
   *
   * `SOURCE_MISMATCH` / `SOURCE_UNAVAILABLE` / `SOURCE_DISABLED` 是**定位或权限**问题，
   * 强制保存也写不进去（或会写错文件），给了按钮只会让用户白点一次。
   */
  const forceEligible = loaded?.sourceErrorCode === 'CONTENT_DIVERGED';

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

  /**
   * 强制覆盖确认弹窗：焦点默认落「取消」（破坏性操作不吃回车），Esc 只关弹窗。
   *
   * ★ Esc 用 capture + stopPropagation：编辑器/抽屉在 window 上也有 Esc 行为，
   *   不加这一步会「关弹窗顺手把编辑器也关了」，用户丢掉正在写的内容。
   */
  useEffect(() => {
    if (!forceOpen) return;
    forceCancelRef.current?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setForceOpen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [forceOpen]);

  const close = (): void => {
    if (busy) return;
    if (hasUnsavedChanges && !window.confirm('有未保存的正文、索引设置或待重试操作，确定关闭编辑器吗？')) return;
    onClose();
  };

  /**
   * 保存。`force` = 用户已在确认弹窗里同意「以 KB 覆盖 wiki 回写目标」。
   *
   * 强制路径刻意**不要求** `canSave`：源文件分叉时最常见的诉求恰恰是「我一个字都没想改，
   * 只想让源文件跟 KB 对齐」。此时 `dirty=false`，若还卡 `canSave` 就永远点不了。
   */
  const save = async (force = false): Promise<void> => {
    if (!loaded || busy) return;
    if (!force && (!canSave || loaded.sourceError)) return;
    if (force) setForceOpen(false);
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
        ...(force ? { force: true } : {}),
      });
      if (result.forced) {
        // 破坏性操作**不静默关窗**：把编辑器就地翻回「已一致」状态，用户看到回执后自行关闭。
        setMessage(result.sourceWritten ? '已用 KB 正文覆盖 wiki 回写目标' : 'wiki 回写目标与 KB 正文已一致，无需覆盖');
        setEditId(undefined);
        setLoaded({
          ...loaded,
          content: draft,
          revision: result.revision,
          sourceRevision: result.revision,
          sourceError: undefined,
          sourceErrorCode: undefined,
          sourceFile: undefined,
          indexMode: result.indexedAs === 'unchanged' ? loaded.indexMode : result.indexedAs,
        });
        onSaved(draft, result);
        return;
      }
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
          ? '当前输入已保留；请修正 wiki 回写配置后再保存。'
          : code === 'DOC_EDIT_INVALID'
            ? '请修正正文内容后再试。'
            : code === 'DOC_EDIT_RETRY_MISMATCH'
              ? '当前重试草稿与文档状态不一致；请重新加载文档后再保存。'
              : code === 'DOC_EDIT_NOT_RETRYABLE' || detail?.retryable === false
                ? '当前草稿不能原样重试；请修改正文或切换保存模式后再保存。'
                : '草稿仍在编辑器中，可重试。';
      setMessage(`保存失败：${failure.message}。${detail ? `回写目标 ${detail.source ?? '未知'} / KB ${detail.kb ?? '未知'} / 索引 ${detail.index ?? '未知'}。` : ''}${nextStep}`);
      if (detail?.index === 'incomplete') {
        const modeLabel = effectiveVectorize ? '向量化' : 'FTS 全文';
        setIndexError(`${modeLabel}索引未完成，请查看上方错误详情和处理建议。`);
      }
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
    <div className="ki-editor-overlay" role="presentation">
      <section className="ki-editor" role="dialog" aria-modal="true" aria-label={`编辑 ${relation}`}>
        <header className="ki-editor__head">
          <div>
            <strong>编辑 {relation}</strong>
            {groupPathSegment(group) ? <small>{groupPathSegment(group)}</small> : null}
          </div>
          <button className="ki-btn ki-btn--secondary" type="button" onClick={close} disabled={busy}>关闭</button>
        </header>
        {loaded?.warning && <div className="ki-editor__notice" role="status">{loaded.warning}</div>}
        {loaded?.sourceError && (
          <div className="ki-editor__error" role="alert">
            <div className="ki-editor__error-body">
              <span>{loaded.sourceError}</span>
              {loaded.sourceFile && <code className="ki-editor__error-path">{loaded.sourceFile}</code>}
              {/*
                * 「以源为准」只做提示、不做按钮（2026-11-12 用户定稿）：
                * 同步是长任务且方向与「覆盖该文档」相反，做成按钮容易点错方向。
                */}
              {loaded.dataSource && (
                <span className="ki-editor__error-hint">
                  该知识库已登记数据源（{loaded.dataSource.type === 'git' ? 'Git' : '目录'}：{loaded.dataSource.target}）。
                  也可先更新源数据、再到「数据源」页触发同步，让 KB 与源保持一致（推荐）。
                </span>
              )}
            </div>
            {forceEligible && (
              <button type="button" className="ki-btn ki-btn--secondary ki-editor__force" onClick={() => setForceOpen(true)} disabled={busy}>
                用 KB 覆盖该文档
              </button>
            )}
          </div>
        )}
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
                  onClick={() => {
                    setMessage(''); setIndexError('');
                    // ★ 不能用 `prev => !prev`：未 touched 时 state 恒为 false，而显示值可能已由
                    //   `loaded.indexMode` 派生为 true（dense 文档）⇒ 第一下点击会「看着亮却没关掉」。
                    //   按当前显示值取反，才能保证点一下 = 切一次。
                    setVectorize(!effectiveVectorize);
                    setVectorizeTouched(true);
                  }}
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
                  {editorVectorizeHint(vectorAvailability, loaded?.indexMode)}
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
    </div>
    {/*
      * 弹窗渲染在 overlay **之外**（同一 portal 子树）：overlay 自带 `z-index: 1200`，
      放它内部要跟子元素的层叠上下文打架；作为兄弟节点给 1300 即可稳定压住。
      */}
    {forceOpen && loaded ? (
      <div className="ki-editor-confirm" role="presentation">
        <section className="ki-dialog ki-editor-confirm__panel" role="dialog" aria-modal="true" aria-label="用 KB 覆盖 wiki 回写目标文档">
          <header className="ki-dialog__head">
            <span className="ki-dialog__title">用 KB 覆盖该文档？</span>
            <button type="button" className="ki-dialog__close" onClick={() => setForceOpen(false)} disabled={busy} aria-label="关闭">✕</button>
          </header>
          <div className="ki-dialog__body">
            <p className="ki-editor-confirm__label">wiki 回写目标文档</p>
            <p className="ki-editor-confirm__path">{loaded.sourceFile ?? loaded.relation}</p>
            <p className="ki-editor-confirm__warn">KB 正文将写入该文件；目标文档中与 KB 不一致的内容会被丢弃，无法撤销。</p>
          </div>
          <footer className="ki-dialog__foot">
            <button ref={forceCancelRef} type="button" className="ki-btn ki-btn--secondary" onClick={() => setForceOpen(false)} disabled={busy}>取消</button>
            <button type="button" className="ki-btn ki-btn--danger" onClick={() => void save(true)} disabled={busy}>
              {busy ? '覆盖中…' : '覆盖并保存'}
            </button>
          </footer>
        </section>
      </div>
    ) : null}
    </>, document.body,
  );
}
