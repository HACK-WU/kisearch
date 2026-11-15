/**
 * 回收站页（REQ-20261113-004 · S-07）
 *
 * 界面以 demo 为基线：页头（scope 徽标 · 回收站 · 保留天数说明 · 右侧「回收站设置」）、
 * 分段筛选（带各来源计数）、批量恢复 / 彻底删除、表格（文档名 / 原 Group / 删除原因 /
 * 剩余 / 操作「恢复 · 沉淀为 wiki」）、底部两条说明。
 *
 * 「沉淀为 wiki」= 恢复时把分类直接改成 wiki（demo 的判断：恢复后还要再改一次分类太绕）。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import '@/styles/governance.css';
import { useScopeValue } from '@/lib/scopeContext';
import { useAuth } from '@/lib/authContext';
import {
  getTrashSettings, listTrash, purgeTrash, putTrashSettings, restoreTrash,
  GovernanceApiError,
  type TrashItemView, type TrashReason, type TrashSettingsView,
} from '@/api/governanceApi';

type Filter = 'all' | TrashReason;

const REASON_TEXT: Record<TrashReason, string> = {
  'temp-expired': '临时到期',
  'event-closed': '事件关闭',
  'event-expired': '兜底过期',
  manual: '手动删除',
};
const REASON_CLASS: Record<TrashReason, string> = {
  'temp-expired': 'gov-badge gov-badge--temp',
  'event-closed': 'gov-badge gov-badge--event',
  'event-expired': 'gov-badge gov-badge--temp',
  manual: 'gov-badge gov-badge--kb',
};

export function TrashPage(): JSX.Element {
  // 跟顶部 scope 选择器走（写死 'default' 会让页头徽标与实际查询的库不一致）
  const scope = useScopeValue();
  const [filter, setFilter] = useState<Filter>('all');
  const [items, setItems] = useState<TrashItemView[]>([]);
  const [settings, setSettings] = useState<TrashSettingsView>({ keepDays: 7, expireAction: 'purge' });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 「彻底删除」的两步确认态：勾选变化即撤销（避免选了 A 确认后误删 B） */
  const [purgeConfirm, setPurgeConfirm] = useState(false);

  /**
   * 只读账号（R34 / S-07 §3.4）：回收站可看（恢复/清理是写操作，一律禁用）。
   * 「回收站设置」入口保持可用 —— 看设置是读；只有弹窗里的「保存」需要写权限。
   */
  const { can, status: authStatus } = useAuth();
  const canWrite = can('knowledge.write');
  const readOnlyHint = canWrite ? undefined : '需要写权限';
  // 鉴权加载中（permissions 暂空）只禁用、不弹"只读"横幅，避免进页闪一下
  const showReadOnlyHint = !canWrite && authStatus !== 'loading';

  const keyOf = (item: TrashItemView): string => `${item.group}\u0000${item.dirName}`;

  const load = useCallback(async () => {
    try {
      const [list, cfg] = await Promise.all([listTrash(scope, { limit: 200 }), getTrashSettings(scope)]);
      setItems(list.items);
      setSettings(cfg.settings);
      setSelected(new Set());
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: items.length, 'temp-expired': 0, 'event-closed': 0, 'event-expired': 0, manual: 0 };
    for (const item of items) base[item.reason] += 1;
    return base;
  }, [items]);

  const visible = filter === 'all' ? items : items.filter((i) => i.reason === filter);
  const selectedItems = items.filter((i) => selected.has(keyOf(i)));
  /** 正文缺失的条目不能恢复（写回去是空文档）——批量路径同样要挡 */
  const restorable = selectedItems.filter((i) => i.sizeBytes > 0);
  const brokenSelected = selectedItems.length - restorable.length;

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

  // 勾选变化 → 撤销确认态（防止"确认"发生在此前那批选择上）
  useEffect(() => { setPurgeConfirm(false); }, [selected]);

  return (
    <div className="gov-page">
      <header className="gov-head">
        <p className="gov-head__path">
          <span className="gov-badge gov-badge--kb">{scope}</span>
          <span className="gov-cell-muted">
            保留 {settings.keepDays} 天，{settings.expireAction === 'purge' ? '到期自动清除' : '到期仅提醒'}
          </span>
        </p>
        <div className="gov-head__actions">
          <button className="gov-btn gov-btn--sm" onClick={() => setSettingsOpen(true)}>回收站设置</button>
        </div>
      </header>

      <div className="gov-toolbar">
        <div className="gov-seg" role="group" aria-label="按删除原因筛选">
          {([
            ['all', `全部 ${counts.all}`],
            ['temp-expired', `临时到期 ${counts['temp-expired']}`],
            ['event-closed', `事件关闭 ${counts['event-closed']}`],
            ['manual', `手动删除 ${counts.manual}`],
          ] as Array<[Filter, string]>).map(([key, label]) => (
            <button key={key} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        <span className="gov-toolbar__spacer" />
        <button
          className="gov-btn gov-btn--sm"
          disabled={busy || restorable.length === 0 || !canWrite}
          title={!canWrite ? readOnlyHint : brokenSelected > 0 ? `${brokenSelected} 篇正文缺失，恢复只会得到空文档，已排除` : '恢复到原位置'}
          onClick={() => void (async () => {
            const targets = [...restorable];
            const skipped = brokenSelected;
            await run(async () => {
              let ok = 0;
              for (const item of targets) {
                const r = await restoreTrash(scope, { group: item.group, dirName: item.dirName }).catch(() => null);
                if (r) ok += 1;
              }
              const skipText = skipped > 0 ? `；跳过 ${skipped} 篇（正文缺失，请彻底删除）` : '';
              return `批量恢复完成：${ok} / ${targets.length} 篇${skipText}`;
            });
          })()}
        >
          批量恢复{restorable.length > 0 ? ` (${restorable.length})` : ''}
        </button>
        <button
          className="gov-btn gov-btn--sm gov-btn--danger-ghost"
          disabled={busy || selectedItems.length === 0 || !canWrite}
          title={readOnlyHint}
          onClick={() => {
            // 不可逆操作：第一次点击只进入确认态，再点才执行
            if (!purgeConfirm) { setPurgeConfirm(true); return; }
            setPurgeConfirm(false);
            void (async () => {
              const targets = [...selectedItems];
              await run(async () => {
                let ok = 0;
                for (const item of targets) {
                  const done = await purgeTrash(scope, { group: item.group, dirName: item.dirName }).then(() => true).catch(() => false);
                  if (done) ok += 1;
                }
                return `已彻底删除 ${ok} / ${targets.length} 篇（不可恢复）`;
              });
            })();
          }}
        >
          {purgeConfirm ? `确认彻底删除 ${selectedItems.length} 篇（不可恢复）` : '彻底删除'}
        </button>
      </div>

      {message ? <p className={message.tone === 'err' ? 'gov-error' : 'gov-hint'}>{message.text}</p> : null}
      {showReadOnlyHint ? (
        <p className="gov-hint">当前账号为只读：可以查看回收站内容，恢复 / 彻底删除 / 保存设置需要写权限。</p>
      ) : null}

      <div className="gov-card">
        <table className="gov-tbl">
          <colgroup>
            <col className="gov-col-check" />
            <col />
            <col className="gov-col-group" />
            <col style={{ width: 104 }} />
            <col style={{ width: 96 }} />
            <col style={{ width: 168 }} />
          </colgroup>
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  aria-label="全选"
                  checked={visible.length > 0 && selectedItems.length === visible.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(visible.map(keyOf)) : new Set())}
                />
              </th>
              <th>文档名</th>
              <th>原 Group</th>
              <th>删除原因</th>
              <th>剩余</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => {
              const left = daysLeft(item.expiresAt);
              // 快照里没有正文（sizeBytes=0）时恢复只会写进空串 —— 禁用两条恢复路径
              const broken = item.sizeBytes === 0;
              return (
                <tr key={keyOf(item)}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${item.name}`}
                      checked={selected.has(keyOf(item))}
                      onChange={() => setSelected((prev) => {
                        const next = new Set(prev);
                        if (next.has(keyOf(item))) next.delete(keyOf(item));
                        else next.add(keyOf(item));
                        return next;
                      })}
                    />
                  </td>
                  <td>
                    <div className="gov-cell-name">{item.name}</div>
                    {broken ? <span className="gov-badge gov-badge--temp">正文缺失</span> : null}
                  </td>
                  <td><span className="gov-cell-muted">{item.group}</span></td>
                  <td><span className={REASON_CLASS[item.reason] ?? 'gov-badge gov-badge--kb'}>{REASON_TEXT[item.reason] ?? item.reason}</span></td>
                  <td><span className={`gov-days ${left <= 2 ? 'gov-days--hot' : left <= 5 ? 'gov-days--warm' : 'gov-days--calm'}`}>剩 {left} 天</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      <button
                        className="gov-btn gov-btn--sm"
                        disabled={busy || broken || !canWrite}
                        title={!canWrite ? readOnlyHint : broken ? '快照里没有正文，恢复会得到空文档；请彻底删除' : '恢复到原位置'}
                        onClick={() => void run(async () => {
                          const r = await restoreTrash(scope, { group: item.group, dirName: item.dirName });
                        return `已恢复「${item.name}」${r.expiresAtChanged ? '（已按原期限续期）' : ''}`;
                      })}>恢复</button>
                      <button
                        className="gov-btn gov-btn--ghost gov-btn--sm"
                        disabled={busy || broken || !canWrite}
                        title={!canWrite ? readOnlyHint : broken ? '快照里没有正文' : '恢复并改为长期保留'}
                        onClick={() => void run(async () => {
                          const r = await restoreTrash(scope, { group: item.group, dirName: item.dirName, targetLifecycle: 'wiki' });
                        return `「${item.name}」已恢复并沉淀为 wiki（${r.lifecycle}）`;
                      })}>沉淀为 wiki</button>
                    </span>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 ? (
              <tr><td colSpan={6} className="gov-cell-muted" style={{ textAlign: 'center', padding: 24 }}>回收站为空</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="gov-notice">
        删除时索引已摘除（语义、全文、路径、关系四类），所以回收站里的文档不会污染检索；
        恢复会重建索引（数秒），这是「可恢复性」必须付的代价。
      </div>
      <div className="gov-notice">
        <strong>「沉淀为 wiki」为什么放在这里、而不是删除前拦截：</strong>
        删除时用户只想清干净，不想做知识整理；放在回收站里由人主动触发，既不阻塞删除，
        也天然有 7 天窗口 —— 真没用的直接到期清除，有价值的再提炼成 wiki。
      </div>

      {settingsOpen ? (
        <div className="gov-modal-mask" onClick={() => setSettingsOpen(false)}>
          <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gov-modal__head gov-modal__head--stack">
              <div>回收站设置</div>
              <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>作用于当前知识库</div>
            </div>
            <div className="gov-modal__body">
              <div className="gov-field">
                <span>保留天数</span>
                <div className="gov-seg" role="group" aria-label="保留天数">
                  {[3, 7, 14, 30].map((d) => (
                    <button
                      key={d}
                      aria-pressed={settings.keepDays === d}
                      onClick={() => setSettings({ ...settings, keepDays: d as TrashSettingsView['keepDays'] })}
                    >
                      {d} 天
                    </button>
                  ))}
                </div>
                <span className="gov-hint">改小之后，超出新天数的条目会在下一次清理时被移除。</span>
              </div>

              <div className="gov-field">
                <span>到期处理</span>
                <div className="gov-seg" role="group" aria-label="到期处理">
                  <button
                    aria-pressed={settings.expireAction === 'purge'}
                    onClick={() => setSettings({ ...settings, expireAction: 'purge' })}
                  >
                    自动清除
                  </button>
                  <button
                    aria-pressed={settings.expireAction === 'notify'}
                    onClick={() => setSettings({ ...settings, expireAction: 'notify' })}
                  >
                    仅提醒，不自动删
                  </button>
                </div>
                <span className="gov-hint">选「仅提醒」时，到期条目会标红并一直留着，直到你手动彻底删除。</span>
              </div>

              <div className="gov-infobar">
                <span>
                  <b>i</b>&nbsp;&nbsp;删除时索引（语义 / 全文 / 路径 / 关系四类）已立即摘除，回收站里的文档不会污染检索；
                  恢复要重建索引，需要数秒。这项不可关闭。
                </span>
              </div>
            </div>
            <div className="gov-modal__foot">
              <button className="gov-btn gov-btn--sm" onClick={() => setSettingsOpen(false)}>取消</button>
              <button
                className="gov-btn gov-btn--sm gov-btn--primary"
                disabled={busy || !canWrite}
                title={readOnlyHint}
                onClick={() => void run(async () => {
                  const r = await putTrashSettings(scope, settings);
                  setSettingsOpen(false);
                  return `已保存：保留 ${r.settings.keepDays} 天 / ${r.settings.expireAction === 'purge' ? '自动清除' : '仅提醒'}`;
                })}
              >
                保存
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
