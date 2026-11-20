/**
 * ConditionBuilder —— 浏览页的「+ 添加条件」筛选入口（时间 / 标签 / 事件）。
 *
 * 为什么把三个筛选维度并成一个入口：原来「全部标签」与（计划的）时间各占一个下拉，
 * 工具栏同一行还要塞搜索框 / 清空 / 宽度切换，维度一多就挤爆；合并后**入口固定一个**，
 * 已生效条件以 chips 常显（残留筛选可见，这是原来最容易翻车的点）。
 *
 * 两段式提交（用户 2026-11-20 定稿）：
 *   ① Enter 只确认「当前这一条」→ 写进面板内「已确认 N」，**面板不关、结果不刷新**；
 *   ② Ctrl/⌘+Enter 或「确定」才整体应用 → 关闭面板、结果刷新；
 *   ③ Esc / 取消 丢弃；有未应用修改时点面板外**不关闭**，改在页脚飘红提示。
 *
 * 键盘：↑↓ 在当前栏移动、←→ 换栏、空格只选不确认、Enter 打钩并确认本条；
 * 焦点常驻面板搜索框（可继续打字过滤），高亮用 `is-focused` 表达。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDocList } from '@/lib/hooks';
import { useEventOptions, type EventOption } from '@/lib/useEventOptions';
import {
  EMPTY_FILTERS,
  SINCE_OPTIONS,
  filterCount,
  isFilterEmpty,
  sinceLabel,
  type BrowseFilters,
  type SinceKey,
} from '@/lib/browseFilters';

type FieldKey = 'since' | 'tags' | 'event';

const FIELDS: Array<{ key: FieldKey; label: string; type: string }> = [
  { key: 'since', label: '时间', type: '单选' },
  { key: 'tags', label: '标签', type: '多选' },
  { key: 'event', label: '事件', type: '单选' },
];

export interface Draft {
  field: FieldKey;
  since?: SinceKey;
  tags: string[];
  event?: string;
}

export interface ConditionBarProps {
  scope: string;
  /** 视图的成员库；单库传空数组 */
  memberScopes?: string[];
  filters: BrowseFilters;
  onChange: (next: BrowseFilters) => void;
}

/** 条件行 / 徽标 + 面板入口（工具栏与阅读态头部共用） */
export function ConditionBar({ scope, memberScopes = [], filters, onChange }: ConditionBarProps): JSX.Element {
  const [open, setOpen] = useState(false);
  const count = filterCount(filters);
  /**
   * 只为把 chip 里的 `evt_xxx` 换成人看得懂的「#48 标题」。
   * 没选事件时 `enabled=false` ⇒ 不请求；面板打开后与面板共用同一 queryKey 缓存。
   */
  const eventsQuery = useEventOptions(scope, memberScopes, '', { enabled: Boolean(filters.event) });
  const eventLabel = (id: string): string => {
    if (id === 'none') return '未关联任何事件';
    for (const group of eventsQuery.data ?? []) {
      const hit = group.options.find((option) => option.id === id);
      if (hit) return `#${hit.shortId} ${hit.title}`;
    }
    // 候选未加载 / 事件已失效：回落到 id，不显示空白（用户能看出这是事件标识）
    return id;
  };

  return (
    <div className="ki-cond-bar">
      <button
        type="button"
        className="ki-btn ki-btn--secondary ki-btn--small ki-cond-bar__add"
        onClick={() => setOpen(true)}
        title="按时间 / 标签 / 事件筛选文档"
      >
        <span aria-hidden="true">+</span> 添加条件
      </button>
      {count > 0 && (
        <div className="ki-cond-chips">
          {filters.since && (
            <Chip label="时间" value={sinceLabel(filters.since)} onRemove={() => onChange({ ...filters, since: undefined })} />
          )}
          {filters.tags.length > 0 && (
            <Chip label="标签" value={filters.tags.join(' / ')} onRemove={() => onChange({ ...filters, tags: [] })} />
          )}
          {filters.event && (
            <Chip
              label="事件"
              value={eventLabel(filters.event)}
              onRemove={() => onChange({ ...filters, event: undefined })}
            />
          )}
        </div>
      )}
      {open && (
        <ConditionPanel
          scope={scope}
          memberScopes={memberScopes}
          applied={filters}
          onApply={(next) => {
            onChange(next);
            setOpen(false);
          }}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

/** 字段图标（与 demo 同一套线型：时钟 / 标签 / 列表），尺寸 13px、跟随 currentColor */
function fieldIcon(key: FieldKey): JSX.Element {
  const common = {
    width: 13,
    height: 13,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    'aria-hidden': true,
  };
  if (key === 'since') {
    return (
      <svg {...common}>
        <circle cx="8" cy="8" r="6" />
        <path d="M8 4.6V8l2.4 1.6" />
      </svg>
    );
  }
  if (key === 'tags') {
    return (
      <svg {...common}>
        <path d="M2.6 7.2V3.2a.6.6 0 0 1 .6-.6h4l6 6-4.4 4.4-6-6Z" />
        <circle cx="5.4" cy="5.4" r=".9" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M2.5 4.5h11M4.5 8h9M6.5 11.5h7" />
    </svg>
  );
}

function Chip({ label, value, onRemove }: { label: string; value: string; onRemove: () => void }): JSX.Element {
  return (
    <span className="cond-chip">
      <span className="cond-chip__field">{label}:</span>
      <span className="cond-chip__value" title={value}>{value}</span>
      <button type="button" className="cond-chip__x" aria-label={`移除 ${label} 条件`} onClick={onRemove}>✕</button>
    </span>
  );
}

interface ConditionPanelProps {
  scope: string;
  memberScopes: string[];
  applied: BrowseFilters;
  onApply: (next: BrowseFilters) => void;
  onClose: () => void;
}

function ConditionPanel({ scope, memberScopes, applied, onApply, onClose }: ConditionPanelProps): JSX.Element {
  const [pending, setPending] = useState<BrowseFilters>(applied);
  const [draft, setDraft] = useState<Draft>({ field: 'since', since: applied.since, tags: [...applied.tags], event: applied.event });
  const [keyword, setKeyword] = useState('');
  /**
   * 打开面板时高亮落在**当前已生效的值**上（与 demo 一致）：
   * 时间是"不限 + 4 档"的列表，所以已生效档位要 +1。
   */
  const initialVi = applied.since ? SINCE_OPTIONS.findIndex((o) => o.key === applied.since) + 1 : 0;
  const [focus, setFocus] = useState<{ col: 'field' | 'value'; fi: number; vi: number }>({
    col: 'value',
    fi: 0,
    vi: Math.max(initialVi, 0),
  });
  const [flash, setFlash] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const tagQuery = useDocList(scope);
  const tagOptions = tagQuery.data?.tags ?? [];
  const eventQuery = useEventOptions(scope, memberScopes, keyword);
  const eventGroups = eventQuery.data ?? [];

  /** 当前字段的取值条目（键盘导航与渲染共用一份） */
  const valueItems = useMemo<Array<{ key: string; label: string; note?: string; group?: string }>>(() => {
    if (draft.field === 'since') {
      return [
        { key: '__none__', label: '不限（移除该条件）' },
        ...SINCE_OPTIONS.map((o) => ({
          key: o.key,
          label: o.label,
          ...(applied.since === o.key ? { note: '已生效' } : {}),
        })),
      ];
    }
    if (draft.field === 'tags') {
      const kw = keyword.trim().toLowerCase();
      return tagOptions
        .filter((t) => !kw || t.toLowerCase().includes(kw))
        .map((t) => ({ key: t, label: t }));
    }
    const kw = keyword.trim().toLowerCase();
    const items: Array<{ key: string; label: string; note?: string; group?: string }> = [];
    for (const g of eventGroups) {
      if (g.error) {
        items.push({ key: `err:${g.scope}`, label: `${g.scope} · 事件加载失败`, note: g.error });
        continue;
      }
      for (const e of g.options) {
        const text = `#${e.shortId} ${e.title}`;
        if (kw && !text.toLowerCase().includes(kw)) continue;
        items.push({ key: e.id, label: text, note: e.stage, group: memberScopes.length > 0 ? g.scope : undefined });
      }
    }
    items.push({ key: '__none__', label: '未关联任何事件', note: '排除事件成员' });
    return items;
  }, [draft.field, tagOptions, keyword, eventGroups, applied.since, memberScopes.length]);

  const dirty = !sameFilters(pending, applied) || !sameDraft(draft, pending);

  const close = useCallback((): void => { onClose(); }, [onClose]);

  /** Esc / 点外部：有未应用修改时只提示不关闭 */
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        onApply(commitDraft(pending, draft));
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const d = e.key === 'ArrowDown' ? 1 : -1;
        setFocus((prev) => {
          if (prev.col === 'value') {
            const n = Math.max(valueItems.length, 1);
            return { ...prev, vi: (prev.vi + d + n) % n };
          }
          const fi = (prev.fi + d + FIELDS.length) % FIELDS.length;
          setDraft((cur) => ({ ...cur, field: FIELDS[fi].key }));
          return { ...prev, fi, vi: 0 };
        });
        return;
      }
      if (e.key === 'ArrowRight' && focus.col === 'field') {
        e.preventDefault();
        setFocus((prev) => ({ ...prev, col: 'value', vi: 0 }));
        return;
      }
      if (e.key === 'ArrowLeft' && focus.col === 'value') {
        e.preventDefault();
        setFocus((prev) => ({ ...prev, col: 'field', fi: FIELDS.findIndex((f) => f.key === draft.field) }));
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        toggleCurrent(false);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (focus.col === 'field') {
          setFocus((prev) => ({ ...prev, col: 'value', vi: 0 }));
          return;
        }
        toggleCurrent(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, onApply, focus, valueItems, pending, draft]);

  // 用函数声明（而非 const 箭头）以便上面的 keydown effect 引用时无 TDZ 疑虑
  function toggleCurrent(confirm: boolean): void {
    const item = valueItems[focus.vi];
    if (!item) return;
    if (item.key.startsWith('err:')) return;
    let nextDraft: Draft;
    if (draft.field === 'since') {
      nextDraft = { ...draft, since: item.key === '__none__' ? undefined : (item.key as SinceKey) };
    } else if (draft.field === 'tags') {
      const has = draft.tags.includes(item.key);
      nextDraft = { ...draft, tags: has ? draft.tags.filter((t) => t !== item.key) : [...draft.tags, item.key] };
    } else {
      nextDraft = { ...draft, event: item.key === '__none__' ? undefined : item.key };
    }
    setDraft(nextDraft);
    if (confirm) {
      setPending(commitDraft(pending, nextDraft));
      setFlash(`已确认本条`);
    } else if (draft.field !== 'tags') {
      // 单选字段空格=仅选中（不确认）
      setFlash('');
    }
  }

  useEffect(() => {
    if (!flash) return;
    const timer = setTimeout(() => setFlash(''), 1200);
    return () => clearTimeout(timer);
  }, [flash]);

  return (
    <div className="ki-cond-panel" ref={panelRef} role="dialog" aria-label="添加筛选条件">
      <div className="ki-cond-panel__search">
        <span aria-hidden="true">⌕</span>
        <input
          ref={searchRef}
          value={keyword}
          placeholder="请输入关键字（过滤字段与取值）"
          onChange={(e) => { setKeyword(e.target.value); setFocus((p) => ({ ...p, col: 'field', fi: 0, vi: 0 })); }}
          autoFocus
        />
      </div>
      <div className="ki-cond-panel__body">
        <div className="ki-cond-panel__fields" role="tablist">
          {FIELDS.map((f, i) => (
            <button
              key={f.key}
              type="button"
              role="tab"
              aria-selected={draft.field === f.key}
              className={`cf-field${focus.col === 'field' && focus.fi === i ? ' is-focused' : ''}`}
              onClick={() => { setDraft({ ...draft, field: f.key }); setFocus({ col: 'value', fi: i, vi: 0 }); }}
            >
              <span className={`cf-field__dot${isFieldSet(pending, f.key) ? '' : ' cf-field__dot--off'}`} aria-hidden="true" />
              {fieldIcon(f.key)}
              <span>{f.label}</span>
              <em>{f.type}</em>
            </button>
          ))}
        </div>
        <div className="ki-cond-panel__values">
          {valueItems.length === 0 ? (
            <div className="cf-none">
              {draft.field === 'event' ? '当前库暂无事件' : draft.field === 'tags' ? '当前库暂无自定义标签' : '没有匹配的取值'}
            </div>
          ) : valueItems.map((item, i) => {
            const checked = isItemChecked(draft, item.key);
            const disabled = item.key.startsWith('err:');
            return (
              <label
                key={item.key}
                className={`cf-opt${focus.col === 'value' && focus.vi === i ? ' is-focused' : ''}${disabled ? ' is-disabled' : ''}`}
              >
                <input
                  type={draft.field === 'tags' ? 'checkbox' : 'radio'}
                  name={draft.field}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => {
                    setFocus((p) => ({ ...p, col: 'value', vi: i }));
                    // 鼠标点选 = 直接确认本条（写进下面「已确认」条）：
                    // 鼠标用户的心智是"点了就算数"，不能要求他再按一次 Enter。
                    toggleCurrent(true);
                  }}
                />
                <span className="cf-opt__label">{item.label}</span>
                {item.note && <span className="cf-opt__note">{item.note}</span>}
                {item.group && <span className="cf-opt__note">{item.group}</span>}
              </label>
            );
          })}
        </div>
      </div>
      <ConfirmedBar pending={pending} onRemove={(key) => setPending(clearField(pending, key))} />
      <div className="ki-cond-panel__foot">
        <span className={`ki-cond-panel__hint${flash ? ' is-ok' : ''}`}>
          {flash || (dirty ? '有未应用的修改：Ctrl/⌘+Enter 应用，Esc 放弃' : 'Enter 确认本条　Ctrl/⌘+Enter 应用全部　Esc 取消')}
        </span>
        <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={close}>取消</button>
        <button type="button" className="ki-btn ki-btn--primary ki-btn--small" onClick={() => onApply(commitDraft(pending, draft))}>
          确定 <span className="ki-cond-panel__kbd">Ctrl ↵</span>
        </button>
      </div>
    </div>
  );
}

/** 已确认条件条：Enter 逐条累积，应用前只是草稿 */
function ConfirmedBar({ pending, onRemove }: { pending: BrowseFilters; onRemove: (key: FieldKey) => void }): JSX.Element {
  const count = filterCount(pending);
  return (
    <div className="ki-cond-panel__confirmed" aria-live="polite">
      <span className="ki-cond-panel__confirmed-label">已确认 {count || ''}</span>
      {count === 0 && <span className="ki-cond-panel__confirmed-empty">尚未确认任何条件 —— 选好值后按 Enter 确认本条</span>}
      {pending.since && <Chip label="时间" value={sinceLabel(pending.since)} onRemove={() => onRemove('since')} />}
      {pending.tags.length > 0 && <Chip label="标签" value={pending.tags.join(' / ')} onRemove={() => onRemove('tags')} />}
      {pending.event && (
        <Chip label="事件" value={pending.event === 'none' ? '未关联任何事件' : pending.event} onRemove={() => onRemove('event')} />
      )}
    </div>
  );
}

/* ── 纯函数（导出供单测） ── */

export function commitDraft(pending: BrowseFilters, draft: Draft): BrowseFilters {
  const next: BrowseFilters = { ...pending, tags: [...pending.tags] };
  if (draft.field === 'since') {
    if (draft.since) next.since = draft.since; else delete next.since;
  } else if (draft.field === 'tags') {
    next.tags = [...draft.tags];
  } else {
    if (draft.event) next.event = draft.event; else delete next.event;
  }
  return next;
}

export function clearField(filters: BrowseFilters, key: FieldKey): BrowseFilters {
  const next: BrowseFilters = { ...filters, tags: [...filters.tags] };
  if (key === 'since') delete next.since;
  if (key === 'tags') next.tags = [];
  if (key === 'event') delete next.event;
  return next;
}

export function isFieldSet(filters: BrowseFilters, key: FieldKey): boolean {
  if (key === 'since') return Boolean(filters.since);
  if (key === 'tags') return filters.tags.length > 0;
  return Boolean(filters.event);
}

function isItemChecked(draft: Draft, key: string): boolean {
  if (draft.field === 'since') return draft.since === key || (!draft.since && key === '__none__');
  if (draft.field === 'tags') return draft.tags.includes(key);
  if (draft.event === undefined) return key === '__none__';
  return draft.event === key;
}

function sameFilters(a: BrowseFilters, b: BrowseFilters): boolean {
  return a.since === b.since
    && a.event === b.event
    && a.tags.length === b.tags.length
    && a.tags.every((t) => b.tags.includes(t));
}

function sameDraft(draft: Draft, filters: BrowseFilters): boolean {
  if (draft.field === 'since') return draft.since === filters.since;
  if (draft.field === 'tags') {
    return draft.tags.length === filters.tags.length && draft.tags.every((t) => filters.tags.includes(t));
  }
  return draft.event === filters.event;
}

export { EMPTY_FILTERS, isFilterEmpty };
export type { EventOption };
