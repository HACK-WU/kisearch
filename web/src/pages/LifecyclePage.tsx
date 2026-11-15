/**
 * 文档分类页（REQ-20261113-004 · S-07）
 *
 * 界面以 `demo/index.html` 的分类页为基线：页头面包屑、分段筛选（带各档计数）、
 * 搜索、按剩余天数排序、含「期限 / 事件」与「最后活跃」列的表格、底部虚线说明块。
 *
 * 数据来自 `GET /governance/docs`（分片现算，一次带回分类 / 剩余天数 / 事件与阶段），
 * 不用 `/api/doc/list` —— 那个接口不含分类，逐篇再查会变成 N+1。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/styles/governance.css';
import { useScopeValue } from '@/lib/scopeContext';
import { useAuth } from '@/lib/authContext';
import {
  applyLifecycle, applyLifecycleBatch, listEventTypes, listGovernanceDocs,
  GovernanceApiError,
  type EventTypeView, type GovernanceDocItem, type LifecycleKind,
} from '@/api/governanceApi';

type Filter = 'all' | LifecycleKind;

const KIND_TEXT: Record<LifecycleKind, string> = { wiki: 'wiki', temp: '临时', event: '事件' };
const BADGE_CLASS: Record<LifecycleKind, string> = {
  wiki: 'gov-badge gov-badge--wiki',
  temp: 'gov-badge gov-badge--temp',
  event: 'gov-badge gov-badge--event',
};

function remainClass(days: number | null): string {
  if (days === null) return 'gov-days gov-days--none';
  if (days <= 2) return 'gov-days gov-days--hot';
  if (days <= 5) return 'gov-days gov-days--warm';
  return 'gov-days gov-days--calm';
}

function formatMonthDay(ms?: number | null): string {
  if (!ms) return '—';
  const d = new Date(ms);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seenText(ms?: number | null): string {
  if (!ms) return '—';
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

interface EditTarget {
  group: string;
  name: string;
  lifecycle: LifecycleKind;
  ttlDays?: number;
  eventId?: string;
  imported: boolean;
}

export function LifecyclePage(): JSX.Element {
  // scope 目前只读（页头展示）：真正的切换器在顶栏，治理页跟随顶栏 scope
  // 跟顶部 scope 选择器走（写死 'default' 会让页头徽标与实际查询的库不一致）
  const scope = useScopeValue();
  const [group] = useState('');
  const [keyword, setKeyword] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sortByRemain, setSortByRemain] = useState(false);
  const [docs, setDocs] = useState<GovernanceDocItem[]>([]);
  const [types, setTypes] = useState<EventTypeView[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);

  /**
   * 只读账号（R34 / S-07 §3.4）：**页面可进、数据可看，写入口一律禁用**。
   * 前端禁用只是体验层——后端 `knowledge.write` 权限点仍会 403 兜底，
   * 所以这里不做"藏起来"，而是禁用 + 说明原因，避免用户点了才发现没权限。
   */
  const { can, status: authStatus } = useAuth();
  const canWrite = can('knowledge.write');
  const readOnlyHint = canWrite ? undefined : '需要写权限';
  // 鉴权还在加载时 permissions 为空 → 按钮先禁用（保守），但**不弹"只读"横幅**，避免每次进页闪一下
  const showReadOnlyHint = !canWrite && authStatus !== 'loading';

  const keyOf = (doc: { group: string; name: string }): string => `${doc.group}\u0000${doc.name}`;

  const load = useCallback(async () => {
    try {
      const [list, typeList] = await Promise.all([
        listGovernanceDocs(scope, { ...(group ? { group } : {}), ...(keyword ? { q: keyword } : {}), limit: 200 }),
        listEventTypes(scope).catch(() => ({ ok: true as const, scope, types: [] })),
      ]);
      setDocs(list.items);
      setTypes(typeList.types);
      setSelected(new Set());
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, group, keyword]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const base = { all: docs.length, wiki: 0, temp: 0, event: 0 };
    for (const doc of docs) base[doc.lifecycle] += 1;
    return base;
  }, [docs]);

  const visible = useMemo(() => {
    const list = filter === 'all' ? docs : docs.filter((d) => d.lifecycle === filter);
    if (!sortByRemain) return list;
    return [...list].sort((a, b) => {
      const av = a.remainDays ?? Number.POSITIVE_INFINITY;
      const bv = b.remainDays ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
  }, [docs, filter, sortByRemain]);

  const toggle = (doc: GovernanceDocItem): void => {
    const key = keyOf(doc);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedDocs = docs.filter((d) => selected.has(keyOf(d)));

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
      await load();
    } catch (err) {
      const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
      setMessage({ tone: 'err', text: `${code}${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const submitEdit = (): void => {
    if (!editing) return;
    void run(async () => {
      const applied = await applyLifecycle(scope, {
        group: editing.group,
        name: editing.name,
        lifecycle: editing.lifecycle,
        ...(editing.lifecycle === 'temp' ? { ttlDays: editing.ttlDays ?? 7 } : {}),
        ...(editing.lifecycle === 'event' && editing.eventId ? { eventId: editing.eventId } : {}),
      });
      setEditing(null);
      return `「${editing.name}」已改为 ${KIND_TEXT[applied.lifecycle]}`;
    });
  };

  const submitBatch = (kind: LifecycleKind, ttlDays?: number): void => {
    if (selectedDocs.length === 0) return;
    void run(async () => {
      const result = await applyLifecycleBatch(scope, selectedDocs.map((d) => ({
        group: d.group,
        name: d.name,
        lifecycle: kind,
        ...(kind === 'temp' && ttlDays ? { ttlDays } : {}),
      })));
      const fail = result.failed.length > 0
        ? `，${result.failed.length} 篇失败（${result.failed[0].code ?? ''} ${result.failed[0].error}）`
        : '';
      return `已改为 ${KIND_TEXT[kind]}：成功 ${result.succeeded} 篇${fail}`;
    });
  };

  return (
    <div className="gov-page">
      <header className="gov-head">
        <p className="gov-head__path">
          <span className="gov-badge gov-badge--kb">{scope}</span>
          <span>文档分类</span>
          <span className="gov-head__sep">·</span>
          <span className="gov-cell-muted">{group || '全部 Group'}</span>
        </p>
        <div className="gov-head__actions">
          <button
            className="gov-btn gov-btn--sm"
            disabled={!canWrite}
            title={readOnlyHint}
            onClick={() => setPresetOpen(true)}
          >
            ＋ 新建分类
          </button>
        </div>
      </header>

      <div className="gov-toolbar">
        <div className="gov-seg" role="group" aria-label="按分类筛选">
          {([
            ['all', `全部 ${counts.all}`],
            ['event', `事件 ${counts.event}`],
            ['temp', `临时 ${counts.temp}`],
            ['wiki', `wiki ${counts.wiki}`],
          ] as Array<[Filter, string]>).map(([key, label]) => (
            <button key={key} type="button" aria-pressed={filter === key} onClick={() => setFilter(key)}>
              {label}
            </button>
          ))}
        </div>
        <input
          className="gov-input"
          type="search"
          placeholder="搜索文档名 / 路径…"
          style={{ width: 220 }}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span className="gov-toolbar__spacer" />
        <button className="gov-btn gov-btn--sm" onClick={() => setSortByRemain((v) => !v)}>
          {sortByRemain ? '按最近活跃排序' : '按剩余天数排序'}
        </button>
        <button className="gov-btn gov-btn--sm" onClick={() => void load()}>刷新</button>
      </div>

      {message ? <p className={message.tone === 'err' ? 'gov-error' : 'gov-hint'}>{message.text}</p> : null}
      {showReadOnlyHint ? (
        <p className="gov-hint">当前账号为只读：可以查看分类与期限，改分类 / 新建分类入口已禁用。</p>
      ) : null}

      {selectedDocs.length > 0 ? (
        <div className="gov-selbar">
          <strong>已选 {selectedDocs.length} 篇</strong>
          <button className="gov-btn gov-btn--sm" disabled={busy || !canWrite} title={readOnlyHint} onClick={() => submitBatch('wiki')}>改为 wiki</button>
          <button className="gov-btn gov-btn--sm" disabled={busy || !canWrite} title={readOnlyHint} onClick={() => submitBatch('temp', 7)}>改为临时 7 天</button>
          <button className="gov-btn gov-btn--sm" disabled={busy || !canWrite} title={readOnlyHint} onClick={() => submitBatch('temp', 30)}>改为临时 30 天</button>
          <span className="gov-selbar__spacer" />
          {/* 取消选择不改数据，只读账号照常可用 */}
          <button className="gov-btn gov-btn--sm gov-btn--ghost" disabled={busy} onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      ) : null}

      <div className="gov-card">
        <table className="gov-tbl">
          <colgroup>
            <col className="gov-col-check" />
            <col />
            <col className="gov-col-group" />
            <col className="gov-col-cat" />
            <col className="gov-col-term" />
            <col className="gov-col-seen" />
            <col className="gov-col-act" />
          </colgroup>
          <thead>
            <tr>
              <th><input type="checkbox" aria-label="全选" checked={visible.length > 0 && selectedDocs.length === visible.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(visible.map(keyOf)) : new Set())} /></th>
              <th>文档名</th>
              <th>Group</th>
              <th>分类</th>
              <th>期限 / 事件</th>
              <th>最后活跃</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((doc) => (
              <tr key={keyOf(doc)}>
                <td><input type="checkbox" aria-label={`选择 ${doc.name}`} checked={selected.has(keyOf(doc))} onChange={() => toggle(doc)} /></td>
                <td><div className="gov-cell-name">{doc.name}</div></td>
                <td><span className="gov-cell-muted">{doc.group}</span></td>
                <td><span className={BADGE_CLASS[doc.lifecycle]}>{KIND_TEXT[doc.lifecycle]}</span></td>
                <td>
                  {doc.lifecycle === 'temp' ? (
                    <span className="gov-term">
                      <span className={remainClass(doc.remainDays)}>剩 {doc.remainDays ?? 0} 天</span>
                      <span className="gov-days gov-days--calm">· {formatMonthDay(doc.expiresAt)} 到期</span>
                    </span>
                  ) : doc.lifecycle === 'event' ? (
                    <span className="gov-term">
                      <span className="gov-badge gov-badge--event">
                        {doc.event?.shortId ? `#${doc.event.shortId} ${doc.event.title}` : '事件（已删除）'}
                      </span>
                      <span className="gov-days gov-days--calm">· {doc.event?.stageName ?? '未知阶段'}</span>
                    </span>
                  ) : (
                    <span className="gov-days gov-days--none">永久保留</span>
                  )}
                </td>
                <td><span className="gov-days gov-days--calm">{seenText(doc.lastUsedTime)}</span></td>
                <td>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    disabled={doc.imported || !canWrite}
                    title={!canWrite ? readOnlyHint : doc.imported ? '数据源文档固定长期保留' : '改分类'}
                    onClick={() => setEditing({
                      group: doc.group,
                      name: doc.name,
                      lifecycle: doc.lifecycle,
                      ...(doc.ttlDays ? { ttlDays: doc.ttlDays } : {}),
                      ...(doc.eventId ? { eventId: doc.eventId } : {}),
                      imported: doc.imported,
                    })}
                  >
                    {doc.imported ? '固定' : '改'}
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr><td colSpan={7} className="gov-cell-muted" style={{ textAlign: 'center', padding: 24 }}>没有匹配的文档</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="gov-notice">
        分类决定「什么时候消失」：<strong>wiki</strong> 永不删、<strong>临时</strong> 到期 → 回收站（剩 ≤3 天转红）、
        <strong>事件</strong> 由事件阶段决定去留。缺省是 wiki —— 判错两个方向代价不对称：
        临时标成 wiki 只是脏一点，wiki 标成临时会把有用知识删掉。
        当前 scope 共 <strong>{counts.all}</strong> 篇（临时 {counts.temp} / 事件 {counts.event} / wiki {counts.wiki}）。
      </div>

      {editing ? (
        <div className="gov-modal-mask" onClick={() => setEditing(null)}>
          <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gov-modal__head">
              <span>改分类 · {editing.name}</span>
              <button className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => setEditing(null)}>✕</button>
            </div>
            <div className="gov-modal__body">
              <label className="gov-field">
                <span>分类</span>
                <select
                  className="gov-select"
                  value={editing.lifecycle}
                  onChange={(e) => setEditing({ ...editing, lifecycle: e.target.value as LifecycleKind })}
                >
                  <option value="wiki">wiki（永久保留）</option>
                  <option value="temp">临时（到期进回收站）</option>
                  <option value="event">事件（跟随阶段）</option>
                </select>
              </label>
              {editing.lifecycle === 'temp' ? (
                <label className="gov-field">
                  <span>期限</span>
                  <select
                    className="gov-select"
                    value={editing.ttlDays ?? 7}
                    onChange={(e) => setEditing({ ...editing, ttlDays: Number(e.target.value) })}
                  >
                    {[7, 30, 90].map((d) => <option key={d} value={d}>{d} 天</option>)}
                  </select>
                </label>
              ) : null}
              {editing.lifecycle === 'event' ? (
                <label className="gov-field">
                  <span>绑定事件（#shortId 或 id）</span>
                  <input
                    className="gov-input"
                    value={editing.eventId ?? ''}
                    placeholder={types[0] ? `如 #3` : '#3'}
                    onChange={(e) => setEditing({ ...editing, eventId: e.target.value })}
                  />
                  <span className="gov-hint">绑定后文档可见性由该事件当前阶段决定（隐藏阶段会立刻搜不到）</span>
                </label>
              ) : null}
              {editing.imported ? <span className="gov-error">数据源文档固定 wiki，不允许改分类</span> : null}
            </div>
            <div className="gov-modal__foot">
              <button className="gov-btn gov-btn--sm" onClick={() => setEditing(null)}>取消</button>
              <button
                className="gov-btn gov-btn--sm gov-btn--primary"
                disabled={busy || editing.imported || !canWrite}
                title={readOnlyHint}
                onClick={submitEdit}
              >
                应用
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {presetOpen ? (
        <PresetModal scope={scope} onClose={() => setPresetOpen(false)} onSaved={(text) => {
          setPresetOpen(false);
          setMessage({ tone: 'ok', text });
        }} />
      ) : null}
    </div>
  );
}

/**
 * 新建分类（demo 的「＋ 新建分类」）
 *
 * 与 demo 的两点差异：
 *   · 「删除时机」只给**两档**（永久保留 / 到期删除）——`跟随事件` 必须落到具体事件，
 *     预设表达不了，服务端也会以 `PRESET_KIND_INVALID` 拒绝，因此改用文案引导；
 *   · 「有效期」只在「到期删除」时出现。
 *
 * 页面底部另有灰底说明：预设只影响档位与期限，不影响已有文档的分类。
 */
function PresetModal(args: { scope: string; onClose: () => void; onSaved: (text: string) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'wiki' | 'temp'>('temp');
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 弹窗虽只从禁用入口进不来，仍按「写按钮一律禁用」的口径兜住（将来换入口不会漏）
  const { can } = useAuth();
  const canWrite = can('knowledge.write');

  const save = async (): Promise<void> => {
    if (!name.trim()) {
      setError('分类名不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/governance/lifecycle/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scope: args.scope,
          name: name.trim(),
          kind,
          ...(kind === 'temp' ? { ttlDays: days } : {}),
        }),
      });
      const payload = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${res.status}`);
      args.onSaved(`已新建分类「${name.trim()}」`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>新建分类</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>
            把常用的「组别+档位」存成预设，写入文档时直接选
          </div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>分类名称</span>
            <input
              className="gov-input"
              value={name}
              placeholder="如：「周报临时」「性能报告」"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="gov-field">
            <span>删除时机</span>
            <div className="gov-seg" role="group" aria-label="删除时机" style={{ width: 'fit-content' }}>
              {([
                ['wiki', '永久保留'],
                ['temp', '到期删除'],
              ] as Array<['wiki' | 'temp', string]>).map(([value, label]) => (
                <button key={value} aria-pressed={kind === value} onClick={() => setKind(value)}>{label}</button>
              ))}
            </div>
            {/* 「跟随事件」不能做预设：它必须绑到具体事件上，预设表达不了 → 服务端也会拒绝 kind=event */}
            <span className="gov-hint">
              需要跟随事件时，请在文档行内「改」里直接选具体事件 —— 预设只保存长期保留 / 到期删除两档。
            </span>
          </div>

          {kind === 'temp' ? (
            <label className="gov-field">
              <span>有效期</span>
              <select className="gov-select" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {[7, 30, 90].map((d) => <option key={d} value={d}>{d} 天</option>)}
              </select>
            </label>
          ) : null}

          <div className="gov-rowbox">
            <span className="gov-hint">
              预设只影响 wiki / 临时 / 事件 三档，这里是把它们连同期限一起存成预设；
              预设本身不会影响已有文档的分类。
            </span>
          </div>

          {error ? <span className="gov-error">{error}</span> : null}
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={busy || !canWrite}
            title={canWrite ? undefined : '需要写权限'}
            onClick={() => void save()}
          >
            新建分类
          </button>
        </div>
      </div>
    </div>
  );
}
