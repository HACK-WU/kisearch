/**
 * 条目编辑模态（对话配置层 · 批次 1）
 *
 * 承载三类编辑：新增 skill / 编辑 skill / 编辑基础提示词 —— 与 demo 同构，避免三套表单。
 *
 * 差异点（有意为之）：
 * · 用 `createPortal` 挂到 `document.body`：与既有 `DocumentEditor` 一致，
 *   也避免被面板的 `overflow` / 层叠上下文裁剪（demo 里正是为此把模态移出了配置层）。
 * · 上限（`maxChars` / `nameMaxChars`）由调用方从服务端 `limits` 传入，**不在此硬编码**。
 * · 名称是否可改、能否删除、能否恢复默认都由调用方按条目类型决定，本组件只渲染。
 */

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface PromptEditDraft {
  id: string;
  name: string;
  content: string;
  builtin: boolean;
}

export interface PromptConfigModalProps {
  mode: 'new' | 'edit';
  group: 'prompt' | 'skill';
  item: PromptEditDraft;
  /** 服务端下发的字数上限 */
  maxChars: number;
  nameMaxChars: number;
  canRename: boolean;
  /** 恢复默认（内置条目才有默认内容可恢复） */
  canReset: boolean;
  canDelete: boolean;
  /** 名称查重：返回错误文案表示不合法（仅 skill 用） */
  checkName?: (name: string) => string | null;
  onCancel: () => void;
  onSubmit: (patch: { name: string; content: string }) => void;
  onDelete?: () => void;
  onReset?: () => void;
}

const TITLE: Record<'new' | 'edit', string> = { new: '新增 skill', edit: '编辑' };

export function PromptConfigModal(props: PromptConfigModalProps) {
  const { mode, group, item, maxChars, nameMaxChars, canRename, canReset, canDelete } = props;

  const [name, setName] = useState(item.name);
  const [content, setContent] = useState(item.content);
  const [view, setView] = useState<'preview' | 'edit'>(mode === 'new' ? 'edit' : 'preview');
  const [err, setErr] = useState('');
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const nameRef = useRef<HTMLInputElement>(null);
  const title = mode === 'new' ? TITLE.new : group === 'prompt' ? '编辑提示词' : '编辑 skill';
  // 副标题与 demo 同口径：组别 · 内置/自定义（走查 #3：原固定文案看不出改的是哪类条目）
  const subText = mode === 'new'
    ? '新建 skill · 保存后写入当前作用域'
    : `${group === 'prompt' ? '系统提示词' : '对话 skill'} · ${item.builtin ? '内置 · 可恢复默认内容' : '自定义'}`;
  const chars = content.length;
  const over = chars > maxChars;
  const dirty = content !== item.content || (canRename && name !== item.name);

  useEffect(() => {
    if (view !== 'edit') return;
    const el = mode === 'new' ? nameRef.current : null;
    if (el) {
      el.focus();
      // 光标置末尾而不是全选：全选反显会让"未命名 skill"看起来像一团高亮（demo 第四轮修正）
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, [view, mode]);

  /** 取消 / Esc / 点遮罩：有未保存修改先问一句（新增无内容改动则直接退） */
  const requestClose = () => {
    if (dirty) setConfirmDiscard(true);
    else props.onCancel();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 确认卡自己处理 Esc，避免"一次 Esc 连关两层"
      if (confirmDiscard) {
        setConfirmDiscard(false);
        return;
      }
      requestClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const submit = () => {
    const nextName = canRename ? name.trim() : item.name;
    if (canRename && !nextName) {
      setErr('名称不能为空');
      nameRef.current?.focus();
      return;
    }
    if (canRename && props.checkName) {
      const dup = props.checkName(nextName);
      if (dup) {
        setErr(dup);
        nameRef.current?.focus();
        return;
      }
    }
    if (over) {
      setErr(`超出 ${maxChars} 字，请先删减`);
      return;
    }
    props.onSubmit({ name: nextName, content });
  };

  const modal = (
    <>
      <div className="ki-chat-cfg__mask" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose(); }}>
        <div className="ki-chat-cfg__card ki-chat-cfg__modal" role="dialog" aria-modal="true" aria-label={title}>
          <div className="ki-chat-cfg__modal-head">
            <div>
              <h4>{title}</h4>
              <p className="ki-chat-cfg__modal-sub">{subText}</p>
            </div>
            <button type="button" className="ki-chat-iconbtn" aria-label="关闭编辑" onClick={requestClose}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
              </svg>
            </button>
          </div>

          <div className="ki-chat-cfg__modal-body">
            {/* 走查 #3：名称字段常驻——内置条目 readonly 展示（demo 同构），
                否则编辑"基础提示词"时看不出在改哪条 */}
            <div className="ki-chat-cfg__field">
              <label className="ki-chat-cfg__label" htmlFor="ki-cfg-name">名称</label>
              <input
                id="ki-cfg-name"
                ref={nameRef}
                className="ki-chat-cfg__ta ki-chat-cfg__ta--name"
                type="text"
                maxLength={nameMaxChars}
                placeholder="给这个 skill 起个名字"
                value={canRename ? name : item.name}
                readOnly={!canRename}
                aria-readonly={!canRename}
                onChange={(e) => { setName(e.target.value); setErr(''); }}
              />
            </div>

            <div className="ki-chat-cfg__seg" role="tablist" aria-label="查看方式">
              {(['preview', 'edit'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="tab"
                  data-view={v}
                  className="ki-chat-cfg__segb"
                  aria-selected={view === v}
                  onClick={() => setView(v)}
                >
                  {v === 'preview' ? '预览' : '编辑'}
                </button>
              ))}
            </div>

            {view === 'preview' ? (
              <pre className="ki-chat-cfg__view">{content || '（还没有内容 —— 切到「编辑」写点什么）'}</pre>
            ) : (
              <div className="ki-chat-cfg__editwrap">
                <textarea
                  className="ki-chat-cfg__ta"
                  spellCheck={false}
                  placeholder="写清这个 skill 什么时候用、按什么顺序调用哪些工具。例：先 ki_search 找片段，命中不足时再看结构；每次回答都要附来源。"
                  value={content}
                  onChange={(e) => { setContent(e.target.value); setErr(''); }}
                  aria-invalid={over}
                />
                <div className="ki-chat-cfg__foot">
                  <span>{chars} / {maxChars} 字</span>
                  <span className="ki-chat-cfg__err">{err || (over ? `超出 ${chars - maxChars} 字` : '')}</span>
                </div>
              </div>
            )}
          </div>

          <div className="ki-chat-cfg__card-acts">
            {canReset && (
              <button type="button" className="ki-chat-btn ki-chat-btn--ghost ki-chat-cfg__reset" onClick={props.onReset}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 11a9 9 0 1 1 2.6 7.4M3 4v7h7" />
                </svg>
                恢复默认
              </button>
            )}
            {canDelete && (
              <button type="button" className="ki-chat-cfg__del" onClick={props.onDelete}>删除</button>
            )}
            <span className="ki-chat-cfg__spacer" />
            <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={requestClose}>取消</button>
            <button type="button" className="ki-chat-btn" onClick={submit} disabled={over}>保存</button>
          </div>
        </div>
      </div>

      {confirmDiscard && (
        <div className="ki-chat-cfg__mask" role="presentation">
          <div className="ki-chat-cfg__card" role="alertdialog" aria-modal="true">
            <h4>未保存的修改</h4>
            <p>关闭将丢弃这次编辑。</p>
            <div className="ki-chat-cfg__card-acts">
              <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={() => setConfirmDiscard(false)}>继续编辑</button>
              <button type="button" className="ki-chat-btn ki-chat-btn--danger" onClick={props.onCancel}>丢弃</button>
            </div>
          </div>
        </div>
      )}
    </>
  );

  return createPortal(modal, document.body);
}
