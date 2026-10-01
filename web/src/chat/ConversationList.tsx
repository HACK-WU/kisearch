/**
 * ConversationList —— 会话切换器浮层（最近 / 已归档）
 *
 * ═══ 为什么是浮层而不是折叠条 ═══
 * 上一版把会话列表做成面板头部的 `<details>` 折叠栏，与来源引用、思考块叠在一起，
 * 走查结论是「折叠感重、不像聊天应用」。现改为**受控浮层**：
 * 触发器（当前会话胶囊）由 `ChatPanel` 的头部渲染并持有开合态，本组件只负责浮层内容。
 *
 * ═══ 契约 ═══
 * · 纯视图：列表数据与选中态由 `ChatPanel` 持有；所有变更走回调（内部只有瞬时 UI 态）
 * · 空值：无会话 → 只留「新建会话」；读取中 → 骨架行（形状与真实行一致）
 * · `corrupted: true`：仍列出，但**不可打开**，且只给删除入口（S03 §5「损坏 → 可删除」）
 * · 重命名 / 归档 / 删除分别对应 API-05 / API-06 / API-07，由上层发起请求
 * · 删除必须**就地二次确认**（误删即丢整段会话），不用 `window.confirm`
 *
 * ⚠️ 行元素**不能用 `<button>`**：行内含操作按钮，`<button>` 嵌 `<button>` 是非法嵌套，
 *    HTML 解析器会把内层按钮拆到行外（React 侧同样会产出无效 DOM）。故用
 *    `div[role="menuitem"] + tabIndex`，并以 Enter/Space 承接选中。
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9 · api/conversations.md
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConversationSummary } from '@/api/chatContract';

export interface ConversationListProps {
  open: boolean;
  items: ConversationSummary[];
  activeId: string | null;
  loading: boolean;
  error: string | null;
  /** 切换会话（上层负责「先 abort 进行中的流，再切」） */
  onSelect: (id: string) => void;
  /** 新建会话并切换过去 */
  onCreate: () => void;
  /** 重新拉取列表 */
  onRefresh: () => void;
  /** 重命名（API-05） */
  onRename: (id: string, title: string) => void;
  /** 归档 / 恢复（API-06） */
  onArchive: (id: string, archived: boolean) => void;
  /** 删除（API-07，级联删本地图片） */
  onDelete: (id: string) => void;
  /** 关闭浮层（Esc / 点击外部由上层处理，此处只发事件） */
  onClose: () => void;
}

/** 列表项标题：标题为空时用末条预览兜底 */
function itemTitle(c: ConversationSummary): string {
  if (c.title && c.title.trim()) return c.title;
  if (c.lastMessagePreview && c.lastMessagePreview.trim()) return c.lastMessagePreview;
  return '（空会话）';
}

/** `updatedAt` → 紧凑时间：今天显示 HH:MM，本年显示 M-D，跨年补年份 */
function formatConvTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return hm;
  const yesterday = new Date(now.getTime() - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

const IconRename = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M11.2 2.8 13.2 4.8 5.4 12.6H3.4v-2z" />
  </svg>
);
const IconArchive = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2.4" y="3.4" width="11.2" height="3" rx="1" />
    <path d="M3.6 6.6v5a1.2 1.2 0 0 0 1.2 1.2h6.4a1.2 1.2 0 0 0 1.2-1.2v-5M6.4 9.4h3.2" />
  </svg>
);
const IconUnarchive = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <rect x="2.4" y="3.4" width="11.2" height="3" rx="1" />
    <path d="M3.6 6.6v5a1.2 1.2 0 0 0 1.2 1.2h6.4a1.2 1.2 0 0 0 1.2-1.2v-5M8 12V8.6M6.4 10.2 8 8.6l1.6 1.6" />
  </svg>
);
const IconTrash = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M3.4 5h9.2M6.4 5V3.6h3.2V5M4.6 5l.7 8h5.4l.7-8" />
  </svg>
);

export function ConversationList(props: ConversationListProps): JSX.Element | null {
  const { open, items, activeId, loading, error } = props;
  const [keyword, setKeyword] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const { recent, archived } = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    const hit = (c: ConversationSummary) => !kw || itemTitle(c).toLowerCase().includes(kw);
    return {
      recent: items.filter((c) => !c.archived && hit(c)),
      archived: items.filter((c) => c.archived && hit(c)),
    };
  }, [items, keyword]);

  // 每次重新打开都回到「未编辑 / 未确认」态，避免上次的瞬时态残留
  useEffect(() => {
    if (open) { setRenamingId(null); setConfirmingId(null); }
  }, [open]);

  if (!open) return null;

  const rowsOf = (list: ConversationSummary[]) => list.map((c) => {
    const active = c.id === activeId;
    const title = itemTitle(c);
    return (
      <div
        key={c.id}
        className={`ki-chat-conv${confirmingId === c.id ? ' ki-chat-conv--row' : ''}`}
        role="menuitem"
        tabIndex={0}
        aria-current={active ? 'true' : undefined}
        aria-disabled={c.corrupted ? 'true' : undefined}
        aria-label={`${title}，${c.messageCount} 条${c.archived ? '，已归档' : ''}`}
        title={c.corrupted ? '该会话文件已损坏，无法打开' : title}
        onClick={() => {
          if (c.corrupted || renamingId === c.id || confirmingId === c.id) return;
          props.onSelect(c.id);
        }}
        onKeyDown={(e) => {
          if (c.corrupted) return;
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onSelect(c.id); }
        }}
      >
        {renamingId === c.id ? (
          <input
            className="ki-chat-conv__input"
            // ★ 用真实 title 而非"标题或预览"兜底值：否则改名会把末条预览写成标题，
            //   且预览可能长于 TITLE_MAX_LEN(48) → API-05 直接 400
            defaultValue={c.title}
            maxLength={48}
            aria-label="会话名称"
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => {
              const next = e.target.value.trim();
              setRenamingId(null);
              if (next && next !== c.title) props.onRename(c.id, next);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.currentTarget.blur(); }
              else if (e.key === 'Escape') { e.currentTarget.value = c.title; e.currentTarget.blur(); }
            }}
          />
        ) : (
          <span className="ki-chat-conv__main">
            <span className="ki-chat-conv__name">{title}</span>
            <span className="ki-chat-conv__time">
              {c.corrupted ? '文件损坏' : formatConvTime(c.updatedAt)}
            </span>
          </span>
        )}

        <span className="ki-chat-conv__count">{c.messageCount} 条</span>

        <span className="ki-chat-conv__acts" onClick={(e) => e.stopPropagation()}>
          {c.corrupted ? null : (
            <>
              <button
                type="button"
                className="ki-chat-conv__act"
                title="重命名"
                aria-label="重命名会话"
                onClick={() => setRenamingId(c.id)}
              ><IconRename /></button>
              <button
                type="button"
                className="ki-chat-conv__act"
                title={c.archived ? '恢复会话' : '归档会话'}
                aria-label={c.archived ? '恢复会话' : '归档会话'}
                onClick={() => props.onArchive(c.id, !c.archived)}
              >{c.archived ? <IconUnarchive /> : <IconArchive />}</button>
            </>
          )}
          <button
            type="button"
            className="ki-chat-conv__act ki-chat-conv__act--del"
            title="删除会话"
            aria-label="删除会话"
            onClick={() => setConfirmingId(c.id)}
          ><IconTrash /></button>
        </span>

        {confirmingId === c.id ? (
          <span className="ki-chat-conv__confirm">
            删除后不可恢复
            <b>{title}</b>
            <button
              type="button"
              className="ki-chat-btn ki-chat-btn--danger"
              onClick={() => { setConfirmingId(null); props.onDelete(c.id); }}
            >确认删除</button>
            <button
              type="button"
              className="ki-chat-btn ki-chat-btn--ghost"
              onClick={() => setConfirmingId(null)}
            >取消</button>
          </span>
        ) : null}
      </div>
    );
  });

  return (
    <div
      ref={rootRef}
      className="ki-chat-convpop"
      role="dialog"
      aria-label="会话列表"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { props.onClose(); return; }
        // 重命名进行中不抢焦点：方向键会让输入框 blur，从而静默提交一次改名
        if (renamingId) return;
        if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
        const rows = Array.from(
          rootRef.current?.querySelectorAll<HTMLElement>('.ki-chat-conv:not([aria-disabled="true"])') ?? []
        );
        if (rows.length === 0) return;
        e.preventDefault();
        const at = rows.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? rows[at + 1] ?? rows[0] : rows[at - 1] ?? rows[rows.length - 1];
        next.focus();
      }}
    >
      <div className="ki-chat-convpop__search">
        <input
          type="search"
          placeholder="搜索当前列表（最近 50 条）"
          aria-label="搜索会话"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>

      <div className="ki-chat-convpop__body" role="menu">
        {error ? <p className="ki-chat-convpop__err">{error}</p> : null}

        {loading ? (
          <div className="ki-chat-convpop__skel"><i /><i /><i /></div>
        ) : (
          <>
            {recent.length > 0 ? <p className="ki-chat-convpop__group">最近</p> : null}
            {rowsOf(recent)}
            {archived.length > 0 ? (
              <p className="ki-chat-convpop__group">已归档（{archived.length}）</p>
            ) : null}
            {rowsOf(archived)}
            {recent.length + archived.length === 0 ? (
              <p className="ki-chat-convpop__empty">
                {keyword ? '没有匹配的会话' : '还没有会话，发送第一条消息即可开始'}
              </p>
            ) : null}
          </>
        )}
      </div>

      <div className="ki-chat-convpop__foot">
        <button type="button" className="ki-chat-btn" onClick={props.onCreate}>新建会话</button>
        <button
          type="button"
          className="ki-chat-btn ki-chat-btn--ghost"
          onClick={props.onRefresh}
          disabled={loading}
        >刷新</button>
        <span className="ki-chat-convpop__hint">按 (updatedAt, id) 倒序</span>
      </div>
    </div>
  );
}
