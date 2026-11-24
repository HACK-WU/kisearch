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
import { ModuleDrawer } from '@/components/ModuleDrawer';
import {
  getTrashContent, getTrashSettings, listTrash, purgeTrash, putTrashSettings, restoreTrash,
  GovernanceApiError,
  type TrashItemView, type TrashReason, type TrashSettingsView,
} from '@/api/governanceApi';
import {
  govDocKey, govFailedMembers, govFailedNotice, govFailedTitle, govGroupLabel, isGovernanceView, VIEW_WRITE_HINT,
  type GovFailedMember,
} from '@/lib/governanceView';

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
  /**
   * 回收站设置。视图下**不更新**（各库可能不同，取哪个都是撒谎）：
   * 页头走 `isView` 分支不展示保留天数，设置入口也禁用 —— 该默认值只用于兜底渲染。
   */
  const [settings, setSettings] = useState<TrashSettingsView>({ keepDays: 7, expireAction: 'purge' });
  /** 服务端总条数：合并后可能 > items.length（被 limit 截断） */
  const [total, setTotal] = useState(0);
  /** 视图元信息（null = 单库） */
  const [viewInfo, setViewInfo] = useState<{
    members: string[];
    skipped: Array<{ scope: string; reason: string }>;
    truncated: boolean;
    /** 读取失败的成员库（后端 buckets[].error）：不显示就等于「条目凭空少了」 */
    failed: GovFailedMember[];
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 「彻底删除」的两步确认态：勾选变化即撤销（避免选了 A 确认后误删 B） */
  const [purgeConfirm, setPurgeConfirm] = useState(false);
  /**
   * 点开正文的回收站条目（文档名可点，与分类页 / 事件页同一形态）。
   *
   * `dirName` 是条目唯一坐标：同一个 `group + name` 可能有多份（撞名目录带时间戳后缀），
   * 只带 group + name 会读错条目。
   */
  const [docTarget, setDocTarget] = useState<{ scope: string; group: string; name: string; dirName: string } | null>(null);

  /**
   * 只读账号（R34 / S-07 §3.4）：回收站可看（恢复/清理是写操作，一律禁用）。
   * 「回收站设置」入口保持可用 —— 看设置是读；只有弹窗里的「保存」需要写权限。
   */
  const { can, status: authStatus } = useAuth();
  const canWrite = can('knowledge.write');
  const readOnlyHint = canWrite ? undefined : '需要写权限';
  // 鉴权加载中（permissions 暂空）只禁用、不弹"只读"横幅，避免进页闪一下
  const showReadOnlyHint = !canWrite && authStatus !== 'loading';

  const isView = viewInfo !== null;
  /** 条目标识必须带库：`dirName` 在两个库里可能重复 */
  const keyOf = (item: TrashItemView): string => govDocKey({ scope: item.scope, group: item.group, name: item.dirName });

  const load = useCallback(async () => {
    try {
      const list = await listTrash(scope, { limit: 200 });
      const view = isGovernanceView(list);
      /*
       * 视图下不拉设置：各库不同、入口也已禁用；拉了只会把「第一个库的设置」
       * 误显示成全视图的保留天数。
       */
      const cfg = view ? null : await getTrashSettings(scope).catch(() => null);
      setItems(list.items);
      setTotal(list.total);
      if (cfg?.settings) setSettings(cfg.settings);
      setViewInfo(view
        ? {
          members: list.members ?? [],
          skipped: list.skipped ?? [],
          truncated: list.truncated === true,
          failed: govFailedMembers(list),
        }
        : null);
      setSelected(new Set());
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 切 scope 时收起正文抽屉：`ModuleDrawer` 载入正文后不再重取
   * （`if (content !== null) return`），留着会在新库下继续显示上一个库的快照。
   */
  useEffect(() => { setDocTarget(null); }, [scope]);

  /**
   * 抽屉取数：回收站条目的正文快照。
   *
   * ⚠️ 必须 `useCallback`：`ModuleDrawer` 把 `fetcher` 列入取数 effect 的依赖，
   * 内联箭头函数每次 render 都换引用 ⇒ 失败态（content 仍为 null）会无限重试。
   */
  const trashFetcher = useCallback(
    (s: string) => {
      // 缺条目坐标时不发请求（抽屉已被收起却仍有调用方取数时，直接给可读原因而不是 400 响应）
      if (!docTarget?.dirName) {
        return Promise.resolve({ content: '', error: '条目已关闭或不存在，请重新点开文档名' });
      }
      return getTrashContent(s, docTarget.group, docTarget.dirName)
        /**
         * 空正文是既定事实：给一句能照着做的说明，别落到阅读器的通用「未找到原文」。
         * 正常路径上这类条目已被 `hasContent === false` 挡住、名字不可点（事件 #81）；
         * 这条只剩「列表加载后正文才丢」的竞态兜底，所以措辞不写"历史遗留"。
         */
        .then((res) => (res.empty
          ? { content: '', error: '这篇的快照里没有正文，恢复也只会得到空文档；请彻底删除该条目' }
          : { content: res.content }));
    },
    [docTarget?.dirName, docTarget?.group],
  );

  const counts = useMemo(() => {
    const base: Record<Filter, number> = { all: items.length, 'temp-expired': 0, 'event-closed': 0, 'event-expired': 0, manual: 0 };
    for (const item of items) base[item.reason] += 1;
    return base;
  }, [items]);

  const visible = filter === 'all' ? items : items.filter((i) => i.reason === filter);
  const selectedItems = items.filter((i) => selected.has(keyOf(i)));
  /**
   * 正文缺失的条目不能恢复（写回去是空文档）——批量路径同样要挡。
   * 判据是 `hasContent === false`（后端现读 content.md 得出），**不是** `sizeBytes > 0`：
   * sizeBytes 是入站瞬间的目录字节快照，入站后正文丢失的条目仍是旧值 >0（事件 #81）。
   * 组条目也排除：它的回执是 `restored / failed` 明细，与文档的单条回执揉不进一句提示，
   * 由行内的「恢复整组」单独处理（REQ-20261123-005 · S05）。
   */
  const docSelected = selectedItems.filter((i) => i.kind !== 'group');
  const restorable = docSelected.filter((i) => i.hasContent !== false);
  const brokenSelected = docSelected.length - restorable.length;
  const groupSelected = selectedItems.length - docSelected.length;

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ tone: 'ok', text: await fn() });
      /*
       * 写操作成功 = 条目集合变了（恢复出站 / 彻底删除）：把正文抽屉收起。
       * 不按"是不是同一条目"细分 —— 抽屉里挂着的是**已被删除的**快照，
       * 操作后再留着它，用户会以为这篇还在回收站里。
       */
      setDocTarget(null);
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
          <span className="gov-badge gov-badge--kb">{isView ? `视图 ${scope}` : scope}</span>
          <span className="gov-cell-muted">
            {isView
              ? `${viewInfo.members.length} 个库 · 共 ${total} 条`
              : settings
                ? `保留 ${settings.keepDays} 天，${settings.expireAction === 'purge' ? '到期自动清除' : '到期仅提醒'}`
                : ''}
          </span>
        </p>
        <div className="gov-head__actions">
          <button
            className="gov-btn gov-btn--sm"
            disabled={isView}
            title={isView ? VIEW_WRITE_HINT : undefined}
            onClick={() => setSettingsOpen(true)}
          >
            回收站设置
          </button>
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
          disabled={busy || restorable.length === 0 || !canWrite || isView}
          title={isView
            ? VIEW_WRITE_HINT
            : !canWrite ? readOnlyHint
              : groupSelected > 0 ? `已排除 ${groupSelected} 个分组条目，请点行内「恢复整组」`
                : brokenSelected > 0 ? `${brokenSelected} 篇正文缺失，恢复只会得到空文档，已排除`
                  : '恢复到原位置'}
          onClick={() => void (async () => {
            const targets = [...restorable];
            const skipped = brokenSelected;
            await run(async () => {
              let ok = 0;
              /**
               * 失败项必须说出原因：列表算出的判据与恢复时的事实可能不同步
               * （条目加载后正文才丢失 → 服务端 fail-closed 返回 TRASH_CORRUPTED）。
               * 此前这里 `catch(() => null)` 只把它算作"没成功"，用户看到 `0 / 1 篇`
               * 却不知道是坏条目还是权限/网络问题（事件 #81 复核时发现）。
               */
              const failures: string[] = [];
              for (const item of targets) {
                // 按条目所属库恢复：视图名不是库，传它会直接 409
                try {
                  await restoreTrash(item.scope, { group: item.group, dirName: item.dirName });
                  ok += 1;
                } catch (err) {
                  const code = err instanceof GovernanceApiError && err.code ? `${err.code}：` : '';
                  failures.push(`${item.name}（${code}${(err as Error).message}）`);
                }
              }
              const skipText = skipped > 0 ? `；跳过 ${skipped} 篇（正文缺失，请彻底删除）` : '';
              const failText = failures.length > 0
                ? `；失败 ${failures.length} 篇：${failures.slice(0, 2).join('；')}${failures.length > 2 ? '…' : ''}`
                : '';
              return `批量恢复完成：${ok} / ${targets.length} 篇${skipText}${failText}`;
            });
          })()}
        >
          批量恢复{restorable.length > 0 ? ` (${restorable.length})` : ''}
        </button>
        <button
          className="gov-btn gov-btn--sm gov-btn--danger-ghost"
          disabled={busy || selectedItems.length === 0 || !canWrite || isView}
          title={isView ? VIEW_WRITE_HINT : readOnlyHint}
          onClick={() => {
            // 不可逆操作：第一次点击只进入确认态，再点才执行
            if (!purgeConfirm) { setPurgeConfirm(true); return; }
            setPurgeConfirm(false);
            void (async () => {
              const targets = [...selectedItems];
              await run(async () => {
                let ok = 0;
                for (const item of targets) {
                  // 同恢复：按条目所属库提交
                  const done = await purgeTrash(item.scope, { group: item.group, dirName: item.dirName }).then(() => true).catch(() => false);
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

      {isView ? (
        <p className="gov-hint" title={govFailedTitle(viewInfo.failed)}>
          只读聚合视图：数据来自 {viewInfo.members.join('、') || '（无可用成员）'}；恢复 / 彻底删除会落到条目所属库，
          回收站设置请切到具体知识库修改。
          {/* 读取失败比「未参与 / 被截断」严重（数据缺失 vs 数据未加载），排在最前（#57） */}
          {viewInfo.failed.length > 0 ? ` ${govFailedNotice(viewInfo.failed)}` : ''}
          {viewInfo.truncated ? ` 仅合并前 ${viewInfo.members.length} 个成员库。` : ''}
          {items.length < total ? ` 当前仅加载各库前 ${items.length} 条（共 ${total} 条），更早的条目请切到具体库查看。` : ''}
          {viewInfo.skipped.length > 0 ? ` 未参与：${viewInfo.skipped.map((s) => s.scope).join('、')}。` : ''}
        </p>
      ) : null}
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
              /**
               * 快照里没有正文时恢复只会写进空串 —— 禁用两条恢复路径、名字也不给点。
               * 判据是 `hasContent === false`（后端读 content.md 得出）：`sizeBytes === 0`
               * 曾在「入站后正文丢失」的条目上失效（sizeBytes 停在入站旧值 >0，事件 #81）。
               * 只认 `false`：旧 daemon 不下发该字段时按未知处理，避免把整页条目锁死。
               * 组条目是例外：空组快照本来就没有正文（它走「恢复整组」分支）。
               */
              const broken = item.kind !== 'group' && item.hasContent === false;
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
                    <div className="gov-cell-name">
                      {/* 组条目用 ▸ + 徽标区分：不新增筛选段 —— 「分组」与现有 reason 段是两套维度，
                          混在一行会让计数重复（手动删除里已含组条目），用户会认为数字错乱 */}
                      {item.kind === 'group' ? (
                        `▸ ${item.name}`
                      ) : broken ? (
                        /* 正文缺失的条目点开只会得到空正文：保留纯文本并说明原因，不做"点了才知道" */
                        <span title="快照里没有正文（正文缺失），无法查看">{item.name}</span>
                      ) : (
                        /* 文档名可点开正文（与分类页 / 事件页同一形态，2026-11-23）：
                           正文取的是删除时的快照，走 trash/content 而非 doc/get */
                        <button
                          type="button"
                          className="gov-cell-name--link"
                          title={`查看「${item.name}」删除时的正文`}
                          onClick={() => setDocTarget({
                            scope: item.scope, group: item.group, name: item.name, dirName: item.dirName,
                          })}
                        >
                          {item.name}
                        </button>
                      )}
                      {item.kind === 'group' ? (
                        <span className="gov-badge gov-badge--kb" style={{ marginLeft: 6 }}>
                          {/* docCount 缺失（旧 daemon）时只说「分组」，不要显示「含 undefined 篇」 */}
                          {typeof item.docCount === 'number'
                            ? (item.docCount === 0 ? '分组 · 空' : `分组 · 含 ${item.docCount} 篇`)
                            : '分组'}
                        </span>
                      ) : null}
                    </div>
                    {broken ? <span className="gov-badge gov-badge--temp">正文缺失</span> : null}
                  </td>
                  <td>
                    <span
                      className="gov-cell-muted"
                      title={isView ? govGroupLabel(item.scope, item.group) : item.group}
                    >
                      {isView ? govGroupLabel(item.scope, item.group) : item.group}
                    </span>
                  </td>
                  <td><span className={REASON_CLASS[item.reason] ?? 'gov-badge gov-badge--kb'}>{REASON_TEXT[item.reason] ?? item.reason}</span></td>
                  <td><span className={`gov-days ${left <= 2 ? 'gov-days--hot' : left <= 5 ? 'gov-days--warm' : 'gov-days--calm'}`}>剩 {left} 天</span></td>
                  <td>
                    <span style={{ display: 'inline-flex', gap: 6 }}>
                      {item.kind === 'group' ? (
                        /* 组行只给「恢复整组」：组内每篇分类各自不同，不提供整组改分类；
                           彻底删除走勾选 + 顶部批量按钮（与文档条目同一入口） */
                        <button
                          className="gov-btn gov-btn--sm"
                          disabled={busy || !canWrite || isView}
                          title={isView ? VIEW_WRITE_HINT : !canWrite ? readOnlyHint : '重建分组，并把整组文档与附件写回'}
                          onClick={() => void run(async () => {
                            const r = await restoreTrash(item.scope, { group: item.group, dirName: item.dirName });
                            if (r.kind === 'group') {
                              return `已恢复整组「${r.restored.group}」${r.restored.docs} 篇${r.hint ? `；${r.hint}` : ''}`;
                            }
                            return `已恢复「${item.name}」`;
                          })}>恢复整组</button>
                      ) : (
                        <>
                          <button
                            className="gov-btn gov-btn--sm"
                            disabled={busy || broken || !canWrite || isView}
                            title={isView ? VIEW_WRITE_HINT : !canWrite ? readOnlyHint : broken ? '快照里没有正文，恢复会得到空文档；请彻底删除' : '恢复到原位置'}
                            onClick={() => void run(async () => {
                              const r = await restoreTrash(item.scope, { group: item.group, dirName: item.dirName });
                              if (r.kind === 'group') return `已恢复整组「${r.restored.group}」`;
                              return `已恢复「${item.name}」${r.expiresAtChanged ? '（已按原期限续期）' : ''}`;
                            })}>恢复</button>
                          <button
                            className="gov-btn gov-btn--ghost gov-btn--sm"
                            disabled={busy || broken || !canWrite || isView}
                            title={isView ? VIEW_WRITE_HINT : !canWrite ? readOnlyHint : broken ? '快照里没有正文' : '恢复并改为长期保留'}
                            onClick={() => void run(async () => {
                              const r = await restoreTrash(item.scope, { group: item.group, dirName: item.dirName, targetLifecycle: 'wiki' });
                              if (r.kind === 'group') return `已恢复整组「${r.restored.group}」`;
                              return `「${item.name}」已恢复并沉淀为 wiki（${r.lifecycle}）`;
                            })}>沉淀为 wiki</button>
                        </>
                      )}
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

      {/*
        文档名 → 右侧阅读抽屉（与分类页 / 事件页同一形态，S-07 §3.3「直接复用 ModuleDrawer」）。
        · `key` 含 dirName：同组同名的多份回收条目也能各自重挂载，正文不串台；
        · `scope` 用**条目所属库**（视图模式下顶栏 scope 是视图名，拿它读不到正文）；
        · 不传 editable / onDeleted / onMoved：这是读入口，抽屉里只该有复制 / 下载 / 全屏。
      */}
      {docTarget ? (
        <ModuleDrawer
          key={`${docTarget.scope}/${docTarget.dirName}`}
          scope={docTarget.scope}
          module={docTarget.name}
          group={docTarget.group}
          fetcher={trashFetcher}
          /* 图片附件从条目目录的 assets 副本读（`writeTrashItem` 入站时整目录复制过一份） */
          assetTrashDir={docTarget.dirName}
          notice={(
            <span>
              正在查看<strong>回收站快照</strong>（删除时的正文，不可编辑）。恢复后才会回到知识库，并重建检索索引。
            </span>
          )}
          onClose={() => setDocTarget(null)}
        />
      ) : null}

      {settingsOpen ? (
        <div className="gov-modal-mask" onClick={(e) => { if (e.target === e.currentTarget) setSettingsOpen(false); }}>
          <div className="gov-modal">
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
