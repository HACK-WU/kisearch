/**
 * 分类页（REQ-20261113-004 · S-07）
 *
 * 本页回答两个问题：**这批文档什么时候会消失**、**某篇文档能不能改**。
 * 列表数据来自 `/governance/docs`（分片现算，一次带回分类 + 可见性 + 剩余天数），
 * 不用 `/api/doc/list` —— 那个接口不含 lifecycle，逐篇再查会变成 N+1。
 *
 * 倒计时配色（DESIGN §4.3）：≤2 天红 / 3~5 天琥珀 / ≥6 天中性。
 * 8 天绝不能还是红的 —— demo 里 8 天已改中性，3 天仍标红是 demo 的遗留不一致。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  applyLifecycle, applyLifecycleBatch, listGovernanceDocs, listLifecycle,
  GovernanceApiError,
  type GovernanceDocItem, type LifecycleKind, type LifecycleListResponse,
} from '@/api/governanceApi';

const KIND_LABEL: Record<LifecycleKind, string> = { wiki: '长期', temp: '临时', event: '事件' };

/** 剩余天数 → 颜色：过期风险越高越靠红 */
function remainColor(days: number | null): string | undefined {
  if (days === null) return undefined;
  if (days <= 2) return '#b42318';
  if (days <= 5) return '#b54708';
  return undefined;
}

export function LifecyclePage(): JSX.Element {
  const [scope, setScope] = useState('default');
  const [group, setGroup] = useState('');
  const [keyword, setKeyword] = useState('');
  const [docs, setDocs] = useState<GovernanceDocItem[]>([]);
  const [meta, setMeta] = useState<LifecycleListResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const keyOf = (doc: GovernanceDocItem): string => `${doc.group}\u0000${doc.name}`;

  const load = useCallback(async () => {
    try {
      const [list, lifecycleMeta] = await Promise.all([
        listGovernanceDocs(scope, { ...(group ? { group } : {}), ...(keyword ? { q: keyword } : {}), limit: 200 }),
        listLifecycle(scope, group || undefined),
      ]);
      setDocs(list.items);
      setMeta(lifecycleMeta);
      setSelected(new Set());
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, group, keyword]);

  useEffect(() => { void load(); }, [load]);

  const toggle = (doc: GovernanceDocItem): void => {
    const key = keyOf(doc);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedDocs = useMemo(
    () => docs.filter((d) => selected.has(keyOf(d))),
    [docs, selected],
  );

  const applyOne = async (
    target: { group: string; name: string },
    kind: LifecycleKind,
    ttlDays?: number,
  ): Promise<string> => {
    const result = await applyLifecycle(scope, {
      group: target.group,
      name: target.name,
      lifecycle: kind,
      ...(kind === 'temp' && ttlDays ? { ttlDays } : {}),
    });
    return result.lifecycle;
  };

  const runSingle = async (doc: GovernanceDocItem, kind: LifecycleKind, ttlDays?: number): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      const applied = await applyOne(doc, kind, ttlDays);
      setMessage({ tone: 'ok', text: `「${doc.name}」已改为 ${applied}` });
      await load();
    } catch (err) {
      const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
      setMessage({ tone: 'err', text: `${code}${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  const runBatch = async (kind: LifecycleKind, ttlDays?: number): Promise<void> => {
    if (selectedDocs.length === 0) {
      setMessage({ tone: 'err', text: '请先勾选文档' });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const result = await applyLifecycleBatch(scope, selectedDocs.map((d) => ({
        group: d.group,
        name: d.name,
        lifecycle: kind,
        ...(kind === 'temp' && ttlDays ? { ttlDays } : {}),
      })));
      const failText = result.failed.length > 0
        ? `，${result.failed.length} 篇失败（${result.failed[0].code ?? ''} ${result.failed[0].error}）`
        : '';
      setMessage({
        tone: result.failed.length > 0 ? 'err' : 'ok',
        text: `已改为 ${KIND_LABEL[kind]}：成功 ${result.succeeded} 篇${failText}`,
      });
      await load();
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
        分类决定文档「何时消失」：长期保留不自动清理；临时到期进回收站（可恢复）；
        事件跟随阶段，收口时按类型设定的动作处理。
      </p>

      <div className="ki-card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <div className="ki-muted">知识库</div>
          <input value={scope} onChange={(e) => setScope(e.target.value.trim())} placeholder="default" />
        </label>
        <label>
          <div className="ki-muted">Group</div>
          <input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="全部（留空）" />
        </label>
        <label>
          <div className="ki-muted">搜索文档名</div>
          <input value={keyword} onChange={(e) => setKeyword(e.target.value)} placeholder="可留空" />
        </label>
        <button className="ki-btn" onClick={() => void load()}>刷新</button>
        {meta?.effectiveDefault ? (
          <span className="ki-muted">
            该组有效默认：<strong>{KIND_LABEL[meta.effectiveDefault.kind]}</strong>
            {meta.effectiveDefault.ttlDays ? ` · ${meta.effectiveDefault.ttlDays} 天` : ''}
          </span>
        ) : null}
      </div>

      {message ? <p style={{ color: message.tone === 'ok' ? 'inherit' : '#b42318' }}>{message.text}</p> : null}

      {/* 批量条：勾选后才出现，与 demo 的交互一致 */}
      {selectedDocs.length > 0 ? (
        <div className="ki-card" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <strong>已选 {selectedDocs.length} 篇</strong>
          <button className="ki-btn" disabled={busy} onClick={() => void runBatch('wiki')}>改为长期</button>
          <button className="ki-btn" disabled={busy} onClick={() => void runBatch('temp', 7)}>改为临时 7 天</button>
          <button className="ki-btn" disabled={busy} onClick={() => void runBatch('temp', 30)}>改为临时 30 天</button>
          <button className="ki-btn" disabled={busy} onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      ) : null}

      <div className="ki-card">
        <table className="ki-table">
          <thead>
            <tr>
              <th style={{ width: 32 }} />
              <th>文档</th>
              <th>Group</th>
              <th>分类</th>
              <th>剩余</th>
              <th>可见性</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {docs.map((doc) => {
              const key = keyOf(doc);
              return (
                <tr key={key}>
                  <td>
                    <input type="checkbox" checked={selected.has(key)} onChange={() => toggle(doc)} />
                  </td>
                  <td>{doc.name}{doc.imported ? '（数据源）' : ''}</td>
                  <td>{doc.group}</td>
                  <td>
                    {KIND_LABEL[doc.lifecycle]}
                    {doc.lifecycle === 'temp' && doc.ttlDays ? ` · ${doc.ttlDays} 天` : ''}
                    {doc.lifecycle === 'event' ? ' · 随阶段' : ''}
                  </td>
                  <td style={{ color: remainColor(doc.remainDays) }}>
                    {doc.remainDays === null ? '—' : `${doc.remainDays} 天`}
                  </td>
                  <td>{doc.visibility}</td>
                  <td style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button className="ki-btn" disabled={busy || doc.imported} onClick={() => void runSingle(doc, 'wiki')}>改长期</button>
                    <button className="ki-btn" disabled={busy || doc.imported} onClick={() => void runSingle(doc, 'temp', 7)}>临时 7 天</button>
                    <button className="ki-btn" disabled={busy || doc.imported} onClick={() => void runSingle(doc, 'temp', 30)}>临时 30 天</button>
                    {doc.imported ? <span className="ki-muted">数据源文档固定长期</span> : null}
                  </td>
                </tr>
              );
            })}
            {docs.length === 0 ? <tr><td colSpan={7} className="ki-muted">没有文档</td></tr> : null}
          </tbody>
        </table>
        <p className="ki-muted">共 {docs.length} 篇（最多显示 200 篇）。剩余 ≤2 天标红、3~5 天琥珀。</p>
      </div>
    </div>
  );
}
