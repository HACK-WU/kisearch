/**
 * 回收站页（REQ-20261113-004 · S-07）
 *
 * 两条必须交代给用户的语义（页面上直接写出来，不藏）：
 *   · **恢复会按原期限续期**：过期进站的文档恢复后不会立刻再过期；
 *   · **同名冲突拒绝恢复**：同组已有同名文档时不覆盖，提示先改名。
 */

import { useCallback, useEffect, useState } from 'react';
import {
  getTrashSettings, listTrash, purgeTrash, putTrashSettings, restoreTrash,
  GovernanceApiError,
  type TrashItemView, type TrashReason, type TrashSettingsView,
} from '@/api/governanceApi';

const REASON_LABEL: Record<TrashReason, string> = {
  'temp-expired': '临时到期',
  'event-closed': '事件收口',
  'event-expired': '兜底过期',
  manual: '手动删除',
};

export function TrashPage(): JSX.Element {
  const [scope, setScope] = useState('default');
  const [reason, setReason] = useState<TrashReason | ''>('');
  const [items, setItems] = useState<TrashItemView[]>([]);
  const [settings, setSettings] = useState<TrashSettingsView>({ keepDays: 7, expireAction: 'purge' });
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([
        listTrash(scope, reason ? { reason } : {}),
        getTrashSettings(scope),
      ]);
      setItems(list.items);
      setSettings(cfg.settings);
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, reason]);

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

  const daysLeft = (expiresAt: number): number => Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));

  return (
    <div className="ki-page">
      <h1 className="ki-page__title">知识治理 · 回收站</h1>
      <p className="ki-muted">
        删除的文档先落这里，保留期内可恢复。恢复会按原期限续期（过期进站的不会一刷新又过期）；
        同组已有同名文档时拒绝恢复，不覆盖现有内容。
      </p>

      <div className="ki-card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          <div className="ki-muted">知识库</div>
          <input value={scope} onChange={(e) => setScope(e.target.value.trim())} placeholder="default" />
        </label>
        <label>
          <div className="ki-muted">来源</div>
          <select value={reason} onChange={(e) => setReason(e.target.value as TrashReason | '')}>
            <option value="">全部</option>
            <option value="temp-expired">临时到期</option>
            <option value="event-closed">事件收口</option>
            <option value="event-expired">兜底过期</option>
            <option value="manual">手动删除</option>
          </select>
        </label>
        <button className="ki-btn" onClick={() => void load()}>刷新</button>
        <span className="ki-muted">共 {items.length} 篇</span>
      </div>

      {message ? <p style={{ color: message.tone === 'ok' ? 'inherit' : '#b42318' }}>{message.text}</p> : null}

      <div className="ki-card">
        <table className="ki-table">
          <thead>
            <tr><th>文档</th><th>Group</th><th>来源</th><th>站内剩余</th><th>恢复次数</th><th>操作</th></tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={`${item.group}/${item.dirName}`}>
                <td>{item.name}</td>
                <td>{item.group}</td>
                <td>{REASON_LABEL[item.reason] ?? item.reason}</td>
                <td>{daysLeft(item.expiresAt)} 天</td>
                <td>{item.restoreCount > 0 ? `${item.restoreCount} 次` : '—'}</td>
                <td style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="ki-btn ki-btn--primary" disabled={busy} onClick={() => void run(async () => {
                    const r = await restoreTrash(scope, { group: item.group, dirName: item.dirName });
                    return r.hint ?? `已恢复（${r.lifecycle}${r.expiresAtChanged ? '，已续期' : ''}）`;
                  })}>恢复</button>
                  <button className="ki-btn" disabled={busy} onClick={() => void run(async () => {
                    await purgeTrash(scope, { group: item.group, dirName: item.dirName });
                    return `已彻底删除「${item.name}」`;
                  })}>彻底删除</button>
                </td>
              </tr>
            ))}
            {items.length === 0 ? <tr><td colSpan={6} className="ki-muted">回收站为空</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="ki-card">
        <h2>回收站设置</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label>
            <div className="ki-muted">保留天数</div>
            <select
              value={settings.keepDays}
              onChange={(e) => setSettings({ ...settings, keepDays: Number(e.target.value) as TrashSettingsView['keepDays'] })}
            >
              {[3, 7, 14, 30].map((d) => <option key={d} value={d}>{d} 天</option>)}
            </select>
          </label>
          <label>
            <div className="ki-muted">到期处理</div>
            <select
              value={settings.expireAction}
              onChange={(e) => setSettings({ ...settings, expireAction: e.target.value as TrashSettingsView['expireAction'] })}
            >
              <option value="purge">自动清除</option>
              <option value="notify">仅提醒（不删）</option>
            </select>
          </label>
          <button className="ki-btn ki-btn--primary" disabled={busy} onClick={() => void run(async () => {
            const r = await putTrashSettings(scope, settings);
            return `已保存：保留 ${r.settings.keepDays} 天 / ${r.settings.expireAction === 'purge' ? '自动清除' : '仅提醒'}`;
          })}>保存</button>
        </div>
        <p className="ki-muted">改小保留天数不会立刻删除已过期条目 —— 下次惰性清理（写入/删除/daemon 启动时）才生效。</p>
      </div>
    </div>
  );
}
