/**
 * 分类页（REQ-20261113-004 · S-07）
 *
 * 功能面（以 demo 的交互为准，布局与配色沿用 ki 既有卡片/表格）：
 *   · 展示三档分类 + 期限选项 + 分类预设 + 该 group 的有效默认分类；
 *   · 对单篇文档改分类（改 wiki / 改临时 + 天数 / 绑事件）。
 *
 * 已知差距（后续补，不在本批伪装完成）：
 *   · 文档列表与批量勾选条尚未接入（需要 `/api/doc/list` 联表分类字段）；
 *   · 行内倒计时配色（≤2 天红 / 3~5 天琥珀）随列表一起补。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  applyLifecycle, listLifecycle, GovernanceApiError,
  type LifecycleKind, type LifecycleListResponse,
} from '@/api/governanceApi';

export function LifecyclePage(): JSX.Element {
  const [scope, setScope] = useState('default');
  const [group, setGroup] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<LifecycleKind>('wiki');
  const [ttlDays, setTtlDays] = useState(30);
  const [eventId, setEventId] = useState('');
  const [meta, setMeta] = useState<LifecycleListResponse | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setMeta(await listLifecycle(scope, group || undefined));
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, group]);

  useEffect(() => { void load(); }, [load]);

  const submit = async (): Promise<void> => {
    if (!group.trim() || !name.trim()) {
      setMessage({ tone: 'err', text: '需要填 Group 与文档名' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await applyLifecycle(scope, {
        group: group.trim(),
        name: name.trim(),
        lifecycle: kind,
        ...(kind === 'temp' ? { ttlDays } : {}),
        ...(kind === 'event' && eventId.trim() ? { eventId: eventId.trim() } : {}),
      });
      const expires = result.expiresAt ? `，到期 ${new Date(result.expiresAt).toLocaleString()}` : '';
      setMessage({ tone: 'ok', text: `已改为「${result.lifecycle}」（来源：${result.source}）${expires}` });
    } catch (err) {
      const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
      setMessage({ tone: 'err', text: `${code}${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ki-page">
      <h1 className="ki-page__title">知识治理 · 分类</h1>
      <p className="ki-muted">
        分类决定文档「何时消失」：长期保留不自动清理；临时到期进回收站；事件跟随阶段，收口时按类型设定的动作处理。
      </p>

      <div className="ki-card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <div className="ki-muted">知识库</div>
          <input value={scope} onChange={(e) => setScope(e.target.value.trim())} placeholder="default" />
        </label>
        <label>
          <div className="ki-muted">Group（用于回显该组默认分类）</div>
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="错误库/Web前端界面" />
        </label>
        <button className="ki-btn" onClick={() => void load()}>刷新</button>
        {meta?.effectiveDefault ? (
          <span className="ki-muted">
            该组有效默认：<strong>{meta.effectiveDefault.kind}</strong>
            {meta.effectiveDefault.ttlDays ? ` · ${meta.effectiveDefault.ttlDays} 天` : ''}
            {meta.effectiveDefault.source ? `（${meta.effectiveDefault.source}）` : ''}
          </span>
        ) : null}
      </div>

      <div className="ki-card">
        <h2>改分类</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            <div className="ki-muted">文档名（Relation）</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="登录页白屏排查记录" />
          </label>
          <label>
            <div className="ki-muted">分类</div>
            <select value={kind} onChange={(e) => setKind(e.target.value as LifecycleKind)}>
              <option value="wiki">长期保留</option>
              <option value="temp">临时</option>
              <option value="event">事件</option>
            </select>
          </label>
          {kind === 'temp' ? (
            <label>
              <div className="ki-muted">期限（天）</div>
              <select value={ttlDays} onChange={(e) => setTtlDays(Number(e.target.value))}>
                {[7, 30, 90].map((d) => <option key={d} value={d}>{d} 天</option>)}
              </select>
            </label>
          ) : null}
          {kind === 'event' ? (
            <label>
              <div className="ki-muted">事件（evt_… 或 #3）</div>
              <input value={eventId} onChange={(e) => setEventId(e.target.value)} placeholder="#3" />
            </label>
          ) : null}
          <button className="ki-btn ki-btn--primary" disabled={busy} onClick={() => void submit()}>
            {busy ? '提交中…' : '应用'}
          </button>
        </div>
        {message ? (
          <p style={{ color: message.tone === 'ok' ? 'inherit' : '#b42318' }}>{message.text}</p>
        ) : null}
      </div>

      <div className="ki-card">
        <h2>分类预设</h2>
        <p className="ki-muted">预设只是「分类 + 期限」的命名壳，改预设不影响已标记的文档。</p>
        <table className="ki-table">
          <thead><tr><th>名称</th><th>分类</th><th>期限</th></tr></thead>
          <tbody>
            {(meta?.presets ?? []).map((preset) => (
              <tr key={preset.id}>
                <td>{preset.name}</td>
                <td>{preset.kind}</td>
                <td>{preset.ttlDays ? `${preset.ttlDays} 天` : '—'}</td>
              </tr>
            ))}
            {(meta?.presets.length ?? 0) === 0 ? <tr><td colSpan={3} className="ki-muted">暂无预设</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
