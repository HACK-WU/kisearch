/**
 * AgentAskGroups —— `/chat` 左栏的「agent 问答」来源分组（REQ-20261116-003 · B0）
 *
 * ═══ 它是什么 ═══
 * `ki_ask`（MCP 问答工具）产生的问答按来源分组展示：`本地连接` + 每个 MCP Token 一组。
 * 与 `ConversationList`（人工会话的「最近 / 已归档」）**并列**，不是它的子分组。
 *
 * ═══ 只读契约 ═══
 * agent 问答没有改名 / 归档 / 删除（`ka-*.json` 无这些字段），所以行内**不渲染任何写操作**。
 * 这不是"隐藏了按钮"，而是根本没有对应入口 —— 与需求 N1 一致。
 *
 * ═══ 与 ConversationList 的刻意差异 ═══
 * 1. 分组头是 `<button>`（要可折叠、可键盘操作）；`ConversationList` 的分组标题是 `<p>`（纯标签）。
 * 2. 行内没有操作按钮，所以行可以是 `<button>`；`ConversationList` 因「按钮不能嵌按钮」只能用
 *    `div[role=menuitem]`。这里仍沿用 div 方案，保持两处键盘行为一致。
 * 3. 折叠态存 `sessionStorage`（浏览态），不写用户配置。
 *
 * ═══ 数据来源 ═══
 * `GET /api/chat/agent-asks`（REQ-20261116-003 · S-02）。本组件是纯视图：
 * 数据、加载态、错误态全部由 `ChatPanel` 持有并注入。
 *
 * @see design/S04_前端分组与详情_DESIGN.md §3.1
 */

import { useEffect, useMemo, useState } from 'react';
import type { AgentAskGroup, AgentAskSummary } from '@/api/chatContract';
import { formatConvTime } from './format';

export interface AgentAskGroupsProps {
  groups: AgentAskGroup[];
  /** 受控搜索词（与人工会话共用同一个关键词；匹配标题即可） */
  keyword?: string;
  activeId?: string | null;
  onSelect: (id: string) => void;
  /**
   * 「还有 N 条…」：由上层按该组的 `nextCursor` 拉下一页并合并。
   *
   * ★ 必须传游标：只把 limit 提到 50 而不推进游标，会在组内条数 > 50 时
   *   「点了没变化」（拿回来的还是第一页），按钮看起来永远可点。
   */
  onShowMore?: (groupId: string, cursor: string) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

/** 折叠态：只存"被折叠的组"，默认全部展开（新增一组不该突然是收起的） */
const COLLAPSED_KEY = 'ki.chat.agentGroups.collapsed';

function readCollapsed(): Set<string> {
  try {
    const raw = sessionStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter((x): x is string => typeof x === 'string')) : new Set();
  } catch {
    return new Set();
  }
}

function writeCollapsed(next: Set<string>): void {
  try {
    sessionStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
  } catch {
    // 隐私模式 / 配额满：折叠态不持久化也不影响使用
  }
}

const CaretIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <path d="m4 6 4 4 4-4" />
  </svg>
);
/** 本地连接：本机图标（与 Token 的钥匙图标区分来源类型） */
const LocalIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <path d="M8 2.4 13 6v7.2H3V6l5-3.6Z" />
  </svg>
);
/** Token 分组：钥匙图标 */
const TokenIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
    <circle cx="5.4" cy="8" r="2.4" />
    <path d="M7.8 8h6M11.8 8v2.2M10 8v1.5" />
  </svg>
);

function matchKeyword(item: AgentAskSummary, kw: string): boolean {
  return !kw || item.title.toLowerCase().includes(kw);
}

function AskRow(props: {
  item: AgentAskSummary;
  source: AgentAskGroup['kind'];
  active: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { item, source, active, onSelect } = props;
  if (item.corrupted) {
    return (
      <div className="ki-chat-conv" role="menuitem" aria-disabled="true" data-src={source} title="该问答文件已损坏，无法打开">
        <span className="ki-chat-conv__main">
          <span className="ki-chat-conv__name">（损坏）</span>
          <span className="ki-chat-conv__time">文件损坏</span>
        </span>
      </div>
    );
  }
  // 临期提示：<=1 天时给「仅剩 N 天」。**不展示续接 TTL 状态** —— 10 分钟就过期，
  // 几乎所有历史条目都满足，恒亮等于没有信息（design-review #4）。
  const soon = item.retainDaysLeft <= 1 && item.retainDaysLeft >= 0
    ? <span className="ki-chat-conv__soon">仅剩 {Math.max(1, item.retainDaysLeft)} 天</span>
    : null;
  return (
    <div
      className="ki-chat-conv"
      role="menuitem"
      tabIndex={0}
      data-src={source}
      aria-current={active ? 'true' : undefined}
      aria-label={`${item.title}，${item.messageCount} 条`}
      title={item.title}
      onClick={() => onSelect(item.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSelect(item.id);
        }
      }}
    >
      <span className="ki-chat-conv__main">
        <span className="ki-chat-conv__name">{item.title}</span>
        <span className="ki-chat-conv__time">{formatConvTime(item.lastActiveAt)}</span>
      </span>
      <span className="ki-chat-conv__count">{soon}{item.messageCount} 条</span>
    </div>
  );
}

export function AgentAskGroups(props: AgentAskGroupsProps): JSX.Element | null {
  const { groups, keyword = '', activeId, onSelect, onShowMore, loading, error, onRetry } = props;
  const [collapsed, setCollapsed] = useState<Set<string>>(() => readCollapsed());

  // 折叠态只在本次会话内有效；持久化失败不影响功能
  useEffect(() => {
    writeCollapsed(collapsed);
  }, [collapsed]);

  const kw = keyword.trim().toLowerCase();
  const filtered = useMemo(
    () => groups
      .map((g) => ({ ...g, items: g.items.filter((i) => matchKeyword(i, kw)) }))
      .filter((g) => g.items.length > 0),
    [groups, kw],
  );

  if (error) {
    return (
      <div className="ki-ask-groups">
        <p className="ki-chat-convpop__err">
          Agent 问答加载失败{onRetry ? <button type="button" className="ki-chat-act" onClick={onRetry}>重试</button> : null}
        </p>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="ki-ask-groups">
        <div className="ki-chat-convpop__skel"><i /><i /><i /></div>
      </div>
    );
  }
  // 空态：不渲染任何占位（左栏只剩人工会话，与改造前视觉一致）
  if (filtered.length === 0) return null;

  return (
    <div className="ki-ask-groups">
      {filtered.map((g) => {
        // 搜索时强制展开：否则"搜到了但看不见"
        const open = kw.length > 0 || !collapsed.has(g.id);
        const toggle = (): void => {
          setCollapsed((prev) => {
            const next = new Set(prev);
            if (next.has(g.id)) next.delete(g.id); else next.add(g.id);
            return next;
          });
        };
        return (
          <div className="ki-ask-groups__one" key={g.id}>
            <button
              type="button"
              className={`ki-ask-grp ki-ask-grp--${g.kind}`}
              aria-expanded={open}
              onClick={toggle}
            >
              <span className="ki-ask-grp__caret"><CaretIcon /></span>
              <span className="ki-ask-grp__ic" aria-hidden="true">
                {g.kind === 'local' ? <LocalIcon /> : <TokenIcon />}
              </span>
              <span className="ki-ask-grp__name">{g.label}</span>
              <span className="ki-ask-grp__badge">{g.kind === 'local' ? '本机' : 'Token'}</span>
              {g.tokenDeleted ? <span className="ki-ask-grp__badge ki-ask-grp__badge--del">已删除</span> : null}
              <span className="ki-ask-grp__count">{g.count}</span>
            </button>
            {open ? g.items.map((item) => (
              <AskRow
                key={item.id}
                item={item}
                source={g.kind}
                active={item.id === activeId}
                onSelect={onSelect}
              />
            )) : null}
            {/* 搜索态不给「还有 N 条」：过滤后剩余条数不可知，点开也未必有命中，语义会误导 */}
            {open && !kw && g.hasMore && g.count > g.items.length ? (
              <button
                type="button"
                className="ki-chat-convpop__group ki-ask-more"
                onClick={() => { if (g.nextCursor) onShowMore?.(g.id, g.nextCursor); }}
              >
                还有 {g.count - g.items.length} 条…
              </button>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
