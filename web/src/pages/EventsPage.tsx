/**
 * 事件页（REQ-20261113-004 · S-07）
 *
 * 功能面：事件列表（按状态筛选）+ 新建 + 流转 + 收口 + 删除（必带文档去向）+ 重开。
 *
 * 与 demo 的差异（有意，不是漏做）：
 *   · **终态动作在类型层**而不是阶段列：`terminalAction` 挂在阶段上时，追加一个阶段
 *     就会让原终态动作静默失效（demo 现状，见 DESIGN.md 缺口②）；
 *   · 阶段线按所选事件的类型渲染，不用写死的 4 段。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  createEvent, deleteEvent, listEventTypes, listEvents, reopenEvent, setEventStage,
  GovernanceApiError,
  type EventTypeView, type EventView,
} from '@/api/governanceApi';

type Status = 'open' | 'closed' | 'all';

export function EventsPage(): JSX.Element {
  const [scope, setScope] = useState('default');
  const [status, setStatus] = useState<Status>('open');
  const [events, setEvents] = useState<EventView[]>([]);
  const [types, setTypes] = useState<EventTypeView[]>([]);
  const [title, setTitle] = useState('');
  const [typeId, setTypeId] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, typeList] = await Promise.all([listEvents(scope, { status }), listEventTypes(scope)]);
      setEvents(list.events);
      setTypes(typeList.types);
      if (!typeId && typeList.types.length > 0) setTypeId(typeList.types[0].id);
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, status, typeId]);

  useEffect(() => { void load(); }, [load]);

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

  const typeOf = (event: EventView): EventTypeView | undefined => types.find((t) => t.id === event.typeId);

  return (
    <div className="ki-page">
      <h1 className="ki-page__title">知识治理 · 事件</h1>
      <p className="ki-muted">
        事件阶段决定文档「何时可检索」：隐藏阶段语义与全文都查不到，仅全文阶段只能按关键词命中。
        收口时按类型设定的动作处理关联文档。
      </p>

      <div className="ki-card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <div className="ki-muted">知识库</div>
          <input value={scope} onChange={(e) => setScope(e.target.value.trim())} placeholder="default" />
        </label>
        <label>
          <div className="ki-muted">状态</div>
          <select value={status} onChange={(e) => setStatus(e.target.value as Status)}>
            <option value="open">未收口</option>
            <option value="closed">已收口</option>
            <option value="all">全部</option>
          </select>
        </label>
        <label>
          <div className="ki-muted">新建事件标题</div>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="登录页白屏" />
        </label>
        <label>
          <div className="ki-muted">类型</div>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        <button
          className="ki-btn ki-btn--primary"
          disabled={busy || !title.trim() || !typeId}
          onClick={() => void run(async () => {
            const created = await createEvent(scope, { title: title.trim(), typeId });
            setTitle('');
            return `已创建 #${created.event.shortId} ${created.event.title}`;
          })}
        >
          新建
        </button>
        <button className="ki-btn" onClick={() => void load()}>刷新</button>
      </div>

      {message ? <p style={{ color: message.tone === 'ok' ? 'inherit' : '#b42318' }}>{message.text}</p> : null}

      <div className="ki-card">
        <table className="ki-table">
          <thead>
            <tr>
              <th>事件</th><th>类型</th><th>阶段</th><th>可见性</th><th>文档</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            {events.map((event) => {
              const type = typeOf(event);
              const stages = type?.stages ?? [];
              const closed = event.closedAt !== null;
              return (
                <tr key={event.id}>
                  <td>#{event.shortId} {event.title}</td>
                  <td>{type?.name ?? event.typeId}</td>
                  <td>
                    {closed ? '已收口' : (
                      <select
                        value={event.stageKey}
                        disabled={busy}
                        onChange={(e) => void run(async () => {
                          const r = await setEventStage(scope, event.id, e.target.value);
                          const pending = r.pending.length > 0 ? `；索引重建中（${r.pending.join('/')}）` : '';
                          return `已流转到「${r.to.name}」${r.closed ? '（已收口）' : ''}${pending}`;
                        })}
                      >
                        {stages.map((s) => (
                          <option key={s.key} value={s.key} disabled={s.disabled}>
                            {s.name}{s.disabled ? '（停用）' : ''}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                  <td>{event.stage?.visibility ?? '—'}</td>
                  <td>{event.memberTotal ?? 0}</td>
                  <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {closed ? (
                      <>
                        <button className="ki-btn" disabled={busy} onClick={() => void run(async () => {
                          const r = await reopenEvent(scope, event.id);
                          return r.hint;
                        })}>重新打开</button>
                        <button className="ki-btn" disabled={busy} onClick={() => void run(async () => {
                          const r = await deleteEvent(scope, event.id, 'wiki');
                          return `已删除事件；${r.affected.docs} 篇文档改为长期保留`;
                        })}>删除（文档留库）</button>
                        <button className="ki-btn" disabled={busy} onClick={() => void run(async () => {
                          const r = await deleteEvent(scope, event.id, 'trash');
                          return `已删除事件；${r.affected.docs} 篇文档移入回收站`;
                        })}>删除（文档入回收站）</button>
                      </>
                    ) : (
                      <span className="ki-muted">流转到末位阶段即收口</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {events.length === 0 ? <tr><td colSpan={6} className="ki-muted">暂无事件</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="ki-card">
        <h2>事件类型</h2>
        <p className="ki-muted">阶段只能追加不能删；末位阶段是终态，不可停用。收口动作是类型级字段，不受追加阶段影响。</p>
        <table className="ki-table">
          <thead><tr><th>类型</th><th>阶段线</th><th>收口动作</th><th>兜底期限</th></tr></thead>
          <tbody>
            {types.map((type) => (
              <tr key={type.id}>
                <td>{type.name}{type.builtin ? '（内置）' : ''}</td>
                <td>{type.stages.map((s) => `${s.name}[${s.visibility}]`).join(' → ')}</td>
                <td>{type.terminalAction === 'trash' ? '移入回收站' : '保留在库'}</td>
                <td>{type.fallbackDays ? `${type.fallbackDays} 天` : '不兜底'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
