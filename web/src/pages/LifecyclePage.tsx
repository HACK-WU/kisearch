/**
 * 文档分类页（REQ-20261113-004 · S-07）
 *
 * 界面以 `demo/index.html` 的分类页为基线：页头面包屑、分段筛选（带各档计数）、
 * 搜索、按剩余天数排序、含「期限 / 事件」与「最后活跃」列的表格、底部虚线说明块。
 *
 * 数据来自 `GET /governance/docs`（分片现算，一次带回分类 / 剩余天数 / 事件与阶段），
 * 不用 `/api/doc/list` —— 那个接口不含分类，逐篇再查会变成 N+1。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '@/styles/governance.css';
import { pageNumbers } from '@/lib/pager';
import { useScopeValue } from '@/lib/scopeContext';
import { useAuth } from '@/lib/authContext';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { getDocContent } from '@/api/httpApi';
import {
  applyLifecycle, applyLifecycleBatch, listEventTypes, listGovernanceDocs,
  GovernanceApiError,
  type EventTypeView, type GovernanceDocItem, type GovernanceLifecycleCounts, type LifecycleKind,
} from '@/api/governanceApi';
import { govDocKey, govGroupLabel, isGovernanceView, VIEW_WRITE_HINT } from '@/lib/governanceView';

type Filter = 'all' | LifecycleKind;

/**
 * 客户端分页（2026-11-16 用户确认）：默认 20，可选 20 / 50 / 100。
 * 与数据源页 / 任务页（默认 10）不同：这里是紧凑表格行（约 34px），10 行/页要翻
 * 15 页才看完一个 144 篇的库；那两页是卡片列表，行高更大，10 行并不显得太空。
 */
const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const;

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
  /** 服务端返回的**过滤后全量篇数**：`docs` 一次只取前 200 篇，两者不等即被截断 */
  const [total, setTotal] = useState(0);
  const [types, setTypes] = useState<EventTypeView[]>([]);
  /**
   * 视图元信息（null = 单库）：成员库 / 被跳过的成员 / 是否被截断。
   * 它是页面「只读形态」的总开关 —— 提示条、库归属、写禁用全部依赖它。
   */
  const [viewInfo, setViewInfo] = useState<{
    members: string[];
    skipped: Array<{ scope: string; reason: string }>;
    truncated: boolean;
  } | null>(null);
  /** 服务端全量分档计数（旧 daemon 缺失时回退按已加载列表统计） */
  const [lifecycleCounts, setLifecycleCounts] = useState<GovernanceLifecycleCounts | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_DEFAULT);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [presetOpen, setPresetOpen] = useState(false);
  /**
   * 点开正文的文档（文档名列）。null = 未打开。
   * 复用全站阅读器 `ModuleDrawer`（与浏览页 / 任务页 / 数据源页 / 事件页同一形态）：
   * 分类页最常问的是「这篇为什么是临时/事件」，跳转过去看原文比反复跨页便宜。
   */
  const [docTarget, setDocTarget] = useState<{ scope: string; group: string; name: string } | null>(null);

  /**
   * 切 scope 时收起正文抽屉：`ModuleDrawer` 载入正文后不再重取（`if (content !== null) return`），
   * 留着会在新 scope 下继续显示上一个库的正文 —— 静默串库比直接收起更糟。
   * 页码同样归 1：新库的篇数与本页无关，沿用旧页码可能直接落在空白页。
   */
  useEffect(() => { setDocTarget(null); setPage(1); }, [scope]);

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

  /** 视图形态总开关：提示条、库归属、写入口禁用全部由它决定 */
  const isView = viewInfo !== null;

  const keyOf = (doc: { scope?: string; group: string; name: string }): string => govDocKey(doc);

  const load = useCallback(async () => {
    try {
      const list = await listGovernanceDocs(scope, {
        ...(group ? { group } : {}), ...(keyword ? { q: keyword } : {}), limit: 200,
      });
      const view = isGovernanceView(list);
      /*
       * 视图下不拉事件类型：它只服务「改分类时绑定事件」的弹窗，而视图下编辑入口已禁用；
       * 且 `listTypes` 对不存在的库返回**内置类型**，容易被误认为真实配置。
       */
      const typeList = view
        ? { ok: true as const, scope, types: [] as EventTypeView[] }
        : await listEventTypes(scope).catch(() => ({ ok: true as const, scope, types: [] as EventTypeView[] }));
      setDocs(list.items);
      setTotal(list.total);
      setLifecycleCounts(list.lifecycleCounts ?? null);
      setViewInfo(view
        ? {
          members: list.members ?? [],
          skipped: list.skipped ?? [],
          truncated: list.truncated === true,
        }
        : null);
      setTypes(typeList.types);
      setSelected(new Set());
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope, group, keyword]);

  useEffect(() => { void load(); }, [load]);

  /**
   * 分档计数：**优先用服务端全量统计**。
   *
   * `docs` 一次只取前 200 篇，用 `docs.length` 会让「共 350 篇」的库 tab 只显示 200；
   * 视图下误差会按库数放大。旧 daemon（无 `lifecycleCounts`）回退到列表统计。
   */
  const counts = useMemo(() => {
    if (lifecycleCounts) return lifecycleCounts;
    const base = { all: docs.length, wiki: 0, temp: 0, event: 0 };
    for (const doc of docs) base[doc.lifecycle] += 1;
    return base;
  }, [docs, lifecycleCounts]);

  const visible = useMemo(() => {
    const list = filter === 'all' ? docs : docs.filter((d) => d.lifecycle === filter);
    if (!sortByRemain) return list;
    return [...list].sort((a, b) => {
      const av = a.remainDays ?? Number.POSITIVE_INFINITY;
      const bv = b.remainDays ?? Number.POSITIVE_INFINITY;
      return av - bv;
    });
  }, [docs, filter, sortByRemain]);

  /**
   * 客户端分页：**筛选 → 排序 → 切页**，三步顺序不可换。
   *
   * 为什么不走服务端分页（后端其实已支持 `offset`）：分类筛选、各档计数、按剩余天数
   * 排序全在前端算，改了服务端分页它们就只覆盖当前页 —— 页头的「事件 3」会和翻页后
   * 的行对不上。因此 `limit` 仍取 200，用服务端 `total` 兜住「被截断」的提示。
   */
  const pageCount = Math.max(1, Math.ceil(visible.length / pageSize));
  /** 收敛帧：页码越界时先按 `pageCount` 渲染，effect 回写要到下一帧才生效，否则会闪一帧空表 */
  const currentPage = Math.min(page, pageCount);
  const pageDocs = visible.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  /** 当前页已选篇数：「全选」作用域是当前页，跨页已选仍留在 `selected` 里 */
  const pageSelectedCount = pageDocs.filter((d) => selected.has(keyOf(d))).length;
  const pageAllSelected = pageDocs.length > 0 && pageSelectedCount === pageDocs.length;
  const pageSomeSelected = pageSelectedCount > 0 && !pageAllSelected;
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    // 半选态只能走 DOM 属性（HTML 没有对应 attribute）
    if (selectAllRef.current) selectAllRef.current.indeterminate = pageSomeSelected;
  }, [pageSomeSelected]);
  // 数据变少（编辑分类 / 换筛选 / 删文档）后把页码收回，避免停在空白页
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  /** 列表被 200 条上限截断：`total` 是服务端过滤后的全量篇数 */
  const truncated = total > docs.length;
  /** 分页栏：0 条整条收起（空态行已说明「没有匹配的文档」）；单页时保留「每页」选择器，否则改不回默认值 */
  const showPager = visible.length > 0 && (pageCount > 1 || pageSize !== PAGE_SIZE_DEFAULT);

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
          <span className="gov-badge gov-badge--kb">{isView ? `视图 ${scope}` : scope}</span>
          <span className="gov-cell-muted">
            {group || '全部 Group'}{isView ? ` · ${viewInfo.members.length} 个库` : ''}
          </span>
        </p>
        <div className="gov-head__actions">
          <button
            className="gov-btn gov-btn--sm"
            disabled={!canWrite || isView}
            title={isView ? VIEW_WRITE_HINT : readOnlyHint}
            onClick={() => setPresetOpen(true)}
          >
            ＋ 新建分类
          </button>
        </div>
      </header>

      {/* 筛选 / 搜索 / 排序都会改变结果集大小 ⇒ 一律回第 1 页，否则可能停在超界页 */}
      <div className="gov-toolbar">
        <div className="gov-seg" role="group" aria-label="按分类筛选">
          {/* 切筛选同时清空已选：筛选是换视角（wiki / 临时 / 事件互斥），留着上一视角的勾选
              就会变成「已选 N 篇，当前页 0 篇」的闷改入口。搜索同样是改变结果集，已由 load 清空；
              只改顺序的「排序」不清空。跨页分批挑选（翻页）不受影响 —— 那是同一视角内的操作。 */}
          {([
            ['all', `全部 ${counts.all}`],
            ['event', `事件 ${counts.event}`],
            ['temp', `临时 ${counts.temp}`],
            ['wiki', `wiki ${counts.wiki}`],
          ] as Array<[Filter, string]>).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              onClick={() => {
                // 只在**真的换了视角**时清空：重复点当前 tab 不该把辛苦勾好的选择清掉
                if (filter !== key) {
                  setFilter(key);
                  setSelected(new Set());
                }
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className="gov-input"
          type="search"
          placeholder="搜索文档名 / 路径…"
          /* 220 → 320：分类页文档名/路径经常较长，220 只能看半截（2026-11-16 用户反馈）。
             ≤900px 由 governance.css 的 media 规则（`.gov-toolbar .gov-input{width:100%!important}`）
             改成整行宽；这里 maxWidth 只是 900px 以上的兜底，防止容器比 320 还窄时撑破。 */
          style={{ width: 320, maxWidth: '100%' }}
          value={keyword}
          onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
        />
        <span className="gov-toolbar__spacer" />
        <button className="gov-btn gov-btn--sm" onClick={() => { setSortByRemain((v) => !v); setPage(1); }}>
          {sortByRemain ? '按最近活跃排序' : '按剩余天数排序'}
        </button>
        <button className="gov-btn gov-btn--sm" onClick={() => void load()}>刷新</button>
      </div>

      {/*
       * 视图提示条（S-04 ①）：必须说明「数据来自哪些库」与「为什么改不了」。
       * 只写「只读」而不给成员库时，用户会以为数据是凭空聚合的、也不知道该切哪个库。
       */}
      {isView ? (
        <p className="gov-hint">
          只读聚合视图：数据来自 {viewInfo.members.join('、') || '（无可用成员）'}；改分类请切到具体知识库。
          {viewInfo.truncated ? ` 仅合并前 ${viewInfo.members.length} 个成员库。` : ''}
          {viewInfo.skipped.length > 0 ? ` 未参与：${viewInfo.skipped.map((s) => s.scope).join('、')}。` : ''}
        </p>
      ) : null}
      {message ? <p className={message.tone === 'err' ? 'gov-error' : 'gov-hint'}>{message.text}</p> : null}
      {/*
       * 截断提示**不能只放分页栏**：分页栏在 0 条时会收起，而「筛出 0 条」恰恰是最需要
       * 这句话的场景 —— 未加载的那部分可能全是临时 / 事件文档，用户会据此判定「没有」。
       * 所以独立成条，常驻在结果区上方。
       */}
      {truncated ? (
        <p className="gov-hint">
          {isView ? '视图合并后仅加载前 ' : '列表仅加载前 '}
          <strong>{docs.length}</strong> 篇（共 {total} 篇）——
          未加载的部分不参与下面的筛选与搜索，请先用搜索词缩小范围再判断分类。
        </p>
      ) : null}
      {showReadOnlyHint ? (
        <p className="gov-hint">当前账号为只读：可以查看分类与期限，编辑分类 / 新建分类入口已禁用。</p>
      ) : null}

      {selectedDocs.length > 0 ? (
        <div className="gov-selbar">
          <strong>已选 {selectedDocs.length} 篇</strong>
          {/* 跨页（或被筛选挡在页外）的已选行此刻看不到 —— 必须显式说明，否则等于「闷改」 */}
          {selectedDocs.length > pageSelectedCount ? (
            <span className="gov-cell-muted">其中当前页 {pageSelectedCount} 篇</span>
          ) : null}
          <button className="gov-btn gov-btn--sm" disabled={busy || !canWrite || isView} title={isView ? VIEW_WRITE_HINT : readOnlyHint} onClick={() => submitBatch('wiki')}>改为 wiki</button>
          <button className="gov-btn gov-btn--sm" disabled={busy || !canWrite || isView} title={isView ? VIEW_WRITE_HINT : readOnlyHint} onClick={() => submitBatch('temp', 7)}>改为临时 7 天</button>
          <button className="gov-btn gov-btn--sm" disabled={busy || !canWrite || isView} title={isView ? VIEW_WRITE_HINT : readOnlyHint} onClick={() => submitBatch('temp', 30)}>改为临时 30 天</button>
          <span className="gov-selbar__spacer" />
          {/* 取消选择不改数据，只读账号照常可用 */}
          <button className="gov-btn gov-btn--sm gov-btn--ghost" disabled={busy} onClick={() => setSelected(new Set())}>
            取消选择
          </button>
        </div>
      ) : null}

      <div className="gov-card">
        <table className="gov-tbl gov-tbl--docs">
          <colgroup>
            <col className="gov-col-check" />
            <col className="gov-col-name" />
            <col className="gov-col-group" />
            <col className="gov-col-cat" />
            <col className="gov-col-term" />
            <col className="gov-col-seen" />
            <col className="gov-col-act" />
          </colgroup>
          <thead>
            <tr>
              <th>
                {/* 全选只作用于**当前页**（表格惯例）：跨页已选不受影响，总数由上方批量条统一显示 */}
                <input
                  ref={selectAllRef}
                  type="checkbox"
                  aria-label={`全选当前页（${pageDocs.length} 篇）`}
                  checked={pageAllSelected}
                  onChange={(e) => setSelected((prev) => {
                    const next = new Set(prev);
                    for (const doc of pageDocs) {
                      if (e.target.checked) next.add(keyOf(doc));
                      else next.delete(keyOf(doc));
                    }
                    return next;
                  })}
                />
              </th>
              <th>文档名</th>
              <th>Group</th>
              <th>分类</th>
              <th>期限 / 事件</th>
              <th>最后活跃</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {pageDocs.map((doc) => (
              <tr key={keyOf(doc)}>
                <td><input type="checkbox" aria-label={`选择 ${doc.name}`} checked={selected.has(keyOf(doc))} onChange={() => toggle(doc)} /></td>
                <td>
                  {/* 文档名是按钮：点开右侧阅读抽屉看正文（此前的纯文本行点了没有任何反应） */}
                  <button
                    type="button"
                    className="gov-cell-name gov-cell-name--link"
                    title={`查看「${doc.name}」正文`}
                    onClick={() => setDocTarget({ scope: doc.scope, group: doc.group, name: doc.name })}
                  >
                    {doc.name}
                  </button>
                </td>
                {/* 视图下必须显示来源库：两个库都有「运维」组时，只写组名等于让人改错库 */}
                <td>
                  <span
                    className="gov-cell-muted"
                    /* 列宽有限，长组路径会被截断 —— hover 给出完整「库 / 组」 */
                    title={isView ? govGroupLabel(doc.scope, doc.group) : doc.group}
                  >
                    {isView ? govGroupLabel(doc.scope, doc.group) : doc.group}
                  </span>
                </td>
                <td><span className={BADGE_CLASS[doc.lifecycle]}>{KIND_TEXT[doc.lifecycle]}</span></td>
                <td>
                  {doc.lifecycle === 'temp' ? (
                    <span className="gov-term">
                      <span className={remainClass(doc.remainDays)}>剩 {doc.remainDays ?? 0} 天</span>
                      <span className="gov-days gov-days--calm">· {formatMonthDay(doc.expiresAt)} 到期</span>
                      {doc.imported ? (
                        /**
                         * REQ-20261116-006（Q6）：数据源文档的 `temp` 只是保留用户设置，
                         * 扫描侧豁免它（不会被自动清理）。不写这一句，用户会等一个永不到来的清理。
                         */
                        <span
                          className="gov-days gov-days--calm"
                          title="数据源文档的临时期限不生效：正文由源侧文件托管，不会被自动清理"
                        >
                          · 期限不生效
                        </span>
                      ) : null}
                    </span>
                  ) : doc.lifecycle === 'event' ? (
                    <span className="gov-term">
                      {/*
                       * 事件名直链：新标签打开事件页并定位到该事件（deep link 走 `?event=`）。
                       * 事件已删除（无 eventId 或无 shortId）时退化为纯文本，不给死链。
                       */}
                      {doc.eventId && doc.event?.shortId ? (
                        <a
                          className="gov-badge gov-badge--event gov-eventlink"
                          href={`/governance/events?event=${encodeURIComponent(doc.eventId)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={`在新标签打开事件 #${doc.event.shortId} ${doc.event.title}`}
                        >
                          #{doc.event.shortId} {doc.event.title}
                        </a>
                      ) : (
                        <span className="gov-badge gov-badge--event">
                          {doc.event?.shortId ? `#${doc.event.shortId} ${doc.event.title}` : '事件（已删除）'}
                        </span>
                      )}
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
                    disabled={doc.imported || !canWrite || isView}
                    title={isView
                      ? VIEW_WRITE_HINT
                      : !canWrite
                        ? readOnlyHint
                        : doc.imported
                          /* 保留分类后「固定 wiki」不再成立：数据源文档也可能是 temp / event */
                          ? '数据源文档的分类由同步保留，不能在这里修改'
                          : '编辑分类'}
                    onClick={() => setEditing({
                      group: doc.group,
                      name: doc.name,
                      lifecycle: doc.lifecycle,
                      ...(doc.ttlDays ? { ttlDays: doc.ttlDays } : {}),
                      ...(doc.eventId ? { eventId: doc.eventId } : {}),
                      imported: doc.imported,
                    })}
                  >
                    {doc.imported ? '锁定' : '编辑'}
                  </button>
                </td>
              </tr>
            ))}
            {visible.length === 0 ? (
              <tr><td colSpan={7} className="gov-cell-muted" style={{ textAlign: 'center', padding: 24 }}>没有匹配的文档</td></tr>
            ) : null}
          </tbody>
        </table>
        {showPager ? (
          <div className="ki-ds-pager" role="navigation" aria-label="文档分页">
            <span className="ki-ds-pager__info" aria-live="polite">
              第 {currentPage} / {pageCount} 页 · 共 {visible.length} 篇
            </span>
            <label className="ki-ds-pager__size">
              每页
              <select
                value={pageSize}
                aria-label="每页条数"
                onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
              >
                {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
              </select>
              条
            </label>
            <button
              type="button"
              className="gov-btn gov-btn--sm"
              disabled={currentPage <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              上一页
            </button>
            {pageNumbers(currentPage, pageCount).map((item, index) => (item === '…'
              ? <span key={`gap-${index}`} className="ki-ds-pager__gap">…</span>
              : (
                <button
                  type="button"
                  key={item}
                  className="ki-ds-pager__page"
                  aria-current={item === currentPage ? 'page' : undefined}
                  onClick={() => setPage(item)}
                >
                  {item}
                </button>
              )))}
            <button
              type="button"
              className="gov-btn gov-btn--sm"
              disabled={currentPage >= pageCount}
              onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            >
              下一页
            </button>
          </div>
        ) : null}
      </div>

      <div className="gov-notice">
        分类决定「什么时候消失」：<strong>wiki</strong> 永不删、<strong>临时</strong> 到期 → 回收站（剩 ≤3 天转红）、
        <strong>事件</strong> 由事件阶段决定去留。缺省是 wiki —— 判错两个方向代价不对称：
        临时标成 wiki 只是脏一点，wiki 标成临时会把有用知识删掉。
        {/* 计数口径随截断切换：否则页面写「共 200 篇」而侧栏 badge 写 350，用户只会觉得数字在飘。
            指引文案不在这里重复 —— 上方截断提示条已经说过怎么缩小范围。 */}
        {truncated ? (
          <>{isView ? `当前视图（${viewInfo.members.length} 个库）` : '当前 scope'}已加载 <strong>{counts.all}</strong> 篇（共 {total} 篇）</>
        ) : (
          <>{isView ? `当前视图（${viewInfo.members.length} 个库）` : '当前 scope'}共 <strong>{counts.all}</strong> 篇</>
        )}
        （临时 {counts.temp} / 事件 {counts.event} / wiki {counts.wiki}）。
      </div>

      {editing ? (
        <div className="gov-modal-mask" onClick={() => setEditing(null)}>
          <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
            <div className="gov-modal__head">
              <span>编辑分类 · {editing.name}</span>
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
              {editing.imported ? (
                <span className="gov-error">数据源文档的分类由同步保留，不能在此修改</span>
              ) : null}
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

      {/* 文档名 → 右侧阅读抽屉；key 含 group+name，切到另一篇整块重挂载，正文/大纲不串台 */}
      {docTarget ? (
        <ModuleDrawer
          key={`${docTarget.scope}/${docTarget.group}/${docTarget.name}`}
          /* 必须用条目所属库：传顶栏 scope（视图名）会读不到正文，跨库重名还会直接报错 */
          scope={docTarget.scope}
          module={docTarget.name}
          group={docTarget.group}
          fetcher={getDocContent}
          onClose={() => setDocTarget(null)}
        />
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
