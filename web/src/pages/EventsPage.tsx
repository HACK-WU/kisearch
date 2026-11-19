/**
 * 事件页（REQ-20261113-004 · S-07）
 *
 * 界面以 demo 的事件页为基线：**左侧事件列表 + 右侧详情**，详情含
 * 事件头（编号 / 类型 / 当前阶段 / 关联与参考篇数 / 操作）、阶段线（可点）、
 * 可见性提示条、关联文档、参考文档（AI 查找 / 添加）。2026-11-17 改版：MCP 同源操作代码块已移除。
 *
 * 与 demo 的三处差异：
 *   · 「AI 分析」是独立的仓库代码定位入口（`AiAnalyzePanel`，卡内嵌），与知识库检索无关；
 *   · 参考文档的「AI 查找」走**确定性检索**（不调 LLM），候选带分数与原因，由人勾选确认；
 *   · 点文档名开的是全站阅读器 `ModuleDrawer`（70vw 抽屉，带大纲/文档内查找/全屏），
 *     不是 demo 里 560px + 遮罩的只读弹窗 —— 这是 S-07 §3.3「直接复用 ModuleDrawer」的结果。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import '@/styles/governance.css';
import { useScopeValue } from '@/lib/scopeContext';
import { useAuth } from '@/lib/authContext';
import { aiSettingsHref } from '@/lib/aiSettingsUrl';
import { FindRefPanel } from '@/components/governance/FindRefPanel';
import { getFindSummary, saveFindSummary } from '@/api/governanceApi';
import { DocPickerModal, type DocPickerRef } from '@/components/governance/DocPickerModal';
import { EventRefUploadModal } from '@/components/governance/EventRefUploadModal';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { EventSummaryCard } from '@/components/governance/event-detail/EventSummaryCard';
import { EventAnalysisCard } from '@/components/governance/event-detail/EventAnalysisCard';
import { EventDocsCard } from '@/components/governance/event-detail/EventDocsCard';
import type { VisTone } from '@/components/governance/event-detail/types';
import { getDocContent } from '@/api/httpApi';
import {
  addMembers, addRefs, createEvent, deleteEvent, getEventDetail, getGovernanceCounts,
  listEventTypes, listEvents, listRefs, removeConfirmedCodeLocation, removeMember, removeRef,
  reopenEvent, setEventPinned, setEventStage, updateEvent, updateEventType,
  REF_LIMIT,
  GovernanceApiError,
  type EventAnalysis, type EventDetail, type EventTypeView, type EventView, type RefItem, type StagePatch,
  type Visibility,
} from '@/api/governanceApi';

type Status = 'open' | 'closed' | 'all';
type Tab = 'list' | 'types';
/**
 * 排序键（2026-11-17）：后端在**普通区**固定按 `updatedAt` 降序返回、置顶区按 `pinnedAt` 倒序
 * （2026-11-19），前端只在这两个区内各自重排。
 * 保持「最近更新」为默认值 = 升级前后默认视图完全一致，不让人莫名多一次认知重排。
 */
type SortKey = 'updated-desc' | 'created-desc' | 'created-asc';

const SORT_LABEL: Record<SortKey, string> = {
  'updated-desc': '最近更新',
  'created-desc': '最新创建',
  'created-asc': '最早创建',
};

/** 已置顶 = `pinnedAt` 有正数（后端缺省为 undefined，详情 DTO 为 null） */
function isPinnedEvent(e: Pick<EventView, 'pinnedAt'>): boolean {
  return typeof e.pinnedAt === 'number' && e.pinnedAt > 0;
}

const VIS_TEXT: Record<string, string> = {
  full: '语义+全文',
  'fts-only': '仅全文',
  hidden: '不可检索',
};

/** 可见性档位 → demo 的圆点形状（实心 / 半环 / 空心） */
const VIS_CLASS: Record<Visibility, string> = { full: 'full', 'fts-only': 'fts', hidden: 'hidden' };


/** 类型徽标配色（demo：bug 墨绿 / 性能 蓝 / 需求 紫） */
function typeBadgeClass(name: string): string {
  if (name.includes('bug')) return 'gov-badge gov-badge--bug';
  if (name.includes('性能')) return 'gov-badge gov-badge--perf';
  if (name.includes('需求')) return 'gov-badge gov-badge--req';
  return 'gov-badge gov-badge--kb';
}

/** 列表第二行时间（demo 是「2 小时前 / 1 天前」） */
function relTime(ms?: number | null): string {
  if (!ms) return '—';
  const min = Math.floor((Date.now() - ms) / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  const d = new Date(ms);
  return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}`;
}

export function EventsPage(): JSX.Element {
  // 跟顶部 scope 选择器走：治理数据本身按 scope 隔离，写死 'default' 会让页头徽标撒谎、
  // 也让「添加参考文档」去错库里搜（同一台机器上事件与文档可能不在同一 scope）
  const scope = useScopeValue();
  const [tab, setTab] = useState<Tab>('list');
  /**
   * 状态筛选默认「全部」（2026-11-19 用户拍板）：默认只看未收口时，
   * 页头计数写着「已收口 N」却一条都看不到，容易让人以为事件丢了。
   */
  const [status, setStatus] = useState<Status>('all');
  /** 列表排序（默认「最近更新」降序 = 后端返回顺序；仅重排已取回的当前页，不改请求） */
  const [sort, setSort] = useState<SortKey>('updated-desc');
  const [keyword, setKeyword] = useState('');
  const [events, setEvents] = useState<EventView[]>([]);
  const [types, setTypes] = useState<EventTypeView[]>([]);
  /** 列表请求在途（2026-11-19）：驱动刷新按钮的转圈与防连点 */
  const [listLoading, setListLoading] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  /**
   * 事件深链 + 选中态回写：`/governance/events?event=<evt_id 或 #shortId>`。
   * 文档分类页 / 生命周期页的「事件」列用它在新标签里直跳；
   * 左栏点选也会**写回同一个参数**（2026-11-19），刷新 / 分享链接后仍停在同一事件。
   */
  const [searchParams, setSearchParams] = useSearchParams();
  /**
   * 进入页面时的 `?event=` 只认一次：之后点选写回的参数不参与下面「找不到就提示可能已删除」的兜底，
   * 否则每点一次事件、每切一次筛选都会重跑一遍深链判定。
   */
  const entryDeepLink = useRef(searchParams.get('event')).current;
  /**
   * 深链兜底是否**已经判过**（不管结果）：找到、找不到、换库主动压掉，三种都置位。
   * 只置「找不到」的话，用户第一次切筛选就会在按筛选后的列表上重判一次 → 误报「已删除」（2026-11-19）。
   */
  const deepLinkWarned = useRef(false);
  /** 列表里按 id 或 `#shortId` 找事件：深链与选中态回写共用同一口径 */
  const findEventKey = useCallback((list: readonly EventView[], key: string | null): string | null => {
    if (!key) return null;
    const raw = key.replace(/^#/, '');
    return list.find((e) => e.id === key || String(e.shortId) === raw)?.id ?? null;
  }, []);
  const matchDeepLink = useCallback(
    (list: readonly EventView[]): string | null => findEventKey(list, entryDeepLink),
    [entryDeepLink, findEventKey],
  );
  /**
   * 选中事件的唯一入口：切详情的同时把 id 写回 URL。
   * `replace: true` —— 点十次事件不该在浏览器历史里留十个台阶，但刷新仍停在同一事件；
   * 新 id 也顺手清掉上一个事件的深链标记，避免旧 id 留在地址栏里骗人。
   */
  /**
   * 选中 id 的 ref 镜像（2026-11-19 修「删除事件后弹 404」）：
   * `run()` 收尾要「操作完刷新当前详情」，但它读的是**闭包里的 `activeId`** ——
   * 删除事件后 `selectEvent(null)` 只改 state，闭包仍是刚删掉的 id，
   * 于是紧接着 `loadDetail(旧 id)` 打出 `getEventDetail` + `listRefs` 双 404，
   * 其错误消息还会覆盖掉成功提示。ref 在这里同步写，闭包读它才是「此刻」的选中。
   */
  const activeIdRef = useRef<string | null>(null);
  const selectEvent = useCallback((id: string | null): void => {
    // 必须先于 setState 同步写：run 的收尾在同一次事件循环里就要读到新值
    activeIdRef.current = id;
    setActiveId(id);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('event', id);
      else next.delete('event');
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [detail, setDetail] = useState<EventDetail | null>(null);
  const [refs, setRefs] = useState<RefItem[]>([]);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedTypeId, setSelectedTypeId] = useState<string | null>(null);
  /** 页头计数（与侧栏同源 `/governance/counts`）：列表被 status 过滤后自带数量会失真 */
  const [counts, setCounts] = useState<{ open: number; closed: number } | null>(null);
  const [addStageOpen, setAddStageOpen] = useState(false);
  const [newEventOpen, setNewEventOpen] = useState(false);
  const [newTypeOpen, setNewTypeOpen] = useState(false);
  /** 递增触发一次 AI 分析（面板用 useRef 比对上次值，挂载时不会误触发） */
  const [startSignal, setStartSignal] = useState(0);
  const [transOpen, setTransOpen] = useState(false);
  /** 「删除事件」两步确认（会清空阶段日志，不可恢复） */
  const [delConfirm, setDelConfirm] = useState(false);
  const [addRefOpen, setAddRefOpen] = useState(false);
  /** 「上传文件」弹窗（REQ-20261118-001）：上传成功即成为本事件参考文档 */
  const [uploadRefOpen, setUploadRefOpen] = useState(false);
  /** 「＋ 添加」关联文档（与参考文档同款搜索弹窗，mode='member'） */
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  /** 关联文档行内二次确认（点一次变「确认」，再点才真解绑） */
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);
  /** 参考文档的二次确认 key（与关联文档分开，避免两处同时进入确认态） */
  const [refConfirmKey, setRefConfirmKey] = useState<string | null>(null);
  /** 绑定成功但索引没摘掉：必须持续显示，不能只闪一条消息 */
  const [memberVisWarn, setMemberVisWarn] = useState<string | null>(null);
  /** 「AI 查找」弹窗：打开即请求候选，不再一点就自动加入（R28/R29） */
  /** 上次「AI 查找」的结论：面板关闭后仍固定展示（确认后不消失）；含「判断不了的点」 */
  const [findSummary, setFindSummary] = useState<{ summary: string; uncertainties?: string[] } | null>(null);
  const [findRefOpen, setFindRefOpen] = useState(false);
  /** 查找面板回抛的状态：卡头 chip 用（检索中 / N 篇候选） */
  const [findStatus, setFindStatus] = useState<{ state: string; count: number } | null>(null);
  const [typeFilter, setTypeFilter] = useState('');
  /** 「事件描述」内联编辑态（REQ-20261113-003 · S-05） */
  /** 描述内联编辑：单一 state（C-12）；切事件由 activeId 的 effect 复位 */
  const [descEdit, setDescEdit] = useState<{ open: boolean; draft: string; saving: boolean }>({
    open: false,
    draft: '',
    saving: false,
  });
  /**
   * 点开正文的文档（关联文档 / 参考文档）。null = 未打开。
   * 复用浏览页的 `ModuleDrawer`（抽屉态，S-07 §3.3「文档抽屉直接复用 ModuleDrawer」），
   * 不新造一个只读弹窗 —— 用户在这里看到的阅读器与浏览页一致（大纲 / 文档内查找 / 全屏）。
   */
  const [docTarget, setDocTarget] = useState<{ group: string; name: string } | null>(null);

  /**
   * 切 scope / 换事件时收起正文抽屉：`ModuleDrawer` 一旦载入正文就不再重取
   * （`if (content !== null) return`），留着会把上一个库 / 上一个事件的正文继续挂着，
   * 而抽屉头部已换成新 scope —— 静默串库比直接收起更糟。
   */
  /*
   * 切 scope / 切事件时必须把「跨事件会串台」的临时态一起收回：
   * 抽屉正文、AI 查找面板与它的 chip、两处行内二次确认。
   * 分析卡另有 key={active.id} 强制重挂（面板内部 state 不跟随 props）。
   */
  useEffect(() => {
    setDocTarget(null);
    setFindRefOpen(false);
    setFindStatus(null);
    setPendingRemove(null);
    setRefConfirmKey(null);
    // 触发信号必须归零：否则切回事件时残留的 signal 会被面板当成"用户刚点了分析"
    setStartSignal(0);
  }, [scope, activeId]);

  /**
   * 上传弹窗（REQ-20261118-001）单独收回：它带着上一个事件的 `eventId`、名额与已选文件，
   * 切 scope / 切事件后继续开着，就会把 A 的文件传进 B 事件。
   * 不复用上面那个 effect：那条路径有「首句必须是 setDocTarget(null)」的既有契约测试钉着。
   */
  useEffect(() => { setUploadRefOpen(false); }, [scope, activeId]);

  /**
   * 换库 = 换一批事件（2026-11-19）。事件 id 只在本库内有效，留着上一个库的选中态会有两处后果：
   * 右栏立刻 404 弹红条（本来就会），以及地址栏 `?event=` 指向别库的事件（选中态回写带出来的新问题）——
   * 刷新后还会被判成「可能已被删除」。
   * 这里清空选中 + 参数，让 `loadList` 按新库重新挑一条；`deepLinkWarned` 同时置位，
   * 否则紧跟着跑的深链兜底 effect 会把这次主动换库也报成「找不到事件」。
   * `lastScope` 挡住首帧：初次挂载就是同一个 scope，不该清掉深链进来的选中。
   */
  const lastScope = useRef(scope);
  useEffect(() => {
    if (lastScope.current === scope) return;
    lastScope.current = scope;
    deepLinkWarned.current = true;
    selectEvent(null);
  }, [scope, selectEvent]);

  // 页面只判 capability，不判 role（authContext 的约定）
  const { can, status: authStatus } = useAuth();
  const canWrite = can('knowledge.write');
  /** 追问提问权限（knowledge.ask）：viewer 也有，与写权限分开判 */
  const canAsk = can('knowledge.ask');

  /**
   * 就近深链（2026-11-15）：从「AI 分析 / AI 查找」弹窗直达 AI 设置的对应分组。
   * 任务现场调提示词不必再绕到顶栏 —— 这是本需求的 R7。
   */
  const navigate = useNavigate();
  const openAiSettings = useCallback((cap: 'analysis' | 'find'): void => {
    // 路径与 `from` 口径统一在 lib/aiSettingsUrl（与顶栏 toggle 共用同一份白名单）
    navigate(aiSettingsHref({ cap, from: `${window.location.pathname}${window.location.search}` }));
  }, [navigate]);
  /**
   * R34 / S-07 §3.4：只读账号可进页面、可看全部信息，写入口统一禁用并在 title 说明原因。
   * 前端禁用只是体验层，后端 `knowledge.write` 仍会 403 兜底。
   * 「AI 查找」不在此列 —— 检索是读，只有弹窗里的「加入」需要写（由弹窗自己门禁）。
   */
  const readOnlyHint = canWrite ? undefined : '需要写权限';
  // 鉴权加载中（permissions 暂空）只禁用、不弹"只读"横幅，避免进页闪一下
  const showReadOnlyHint = !canWrite && authStatus !== 'loading';

  /**
   * 列表视图要真正「到底」：给主内容区挂 `--noscroll`（浏览页 / 资源页同款范式），
   * 让左列表与右详情各自内滚。
   *
   * 为什么不再用 `max-height: calc(100vh - N)`：N 是猜的页头高度，猜小了吸附后底部跑出视口
   * （永远看不到），猜大了滚到底还留半屏空白 —— 2026-11-19 用户三轮反馈都栽在这里。
   *
   * 两种情形必须摘掉 `--noscroll`：
   *  · 「事件类型」视图 —— 普通长表格，必须能整页滚；
   *  · 单列断点（≤1080）—— 两栏上下堆叠，禁滚会让下半页永远看不到。
   */
  const [narrowLayout, setNarrowLayout] = useState(() => (
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1080px)').matches
  ));
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 1080px)');
    const onChange = (): void => setNarrowLayout(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    const el = document.querySelector('.ki-content');
    if (!el) return undefined;
    if (tab !== 'list' || narrowLayout) return undefined;
    el.classList.add('ki-content--noscroll');
    // 卸载 / 切视图都要摘掉：这是挂在全局布局容器上的类，留着会污染其它页面
    return () => el.classList.remove('ki-content--noscroll');
  }, [tab, narrowLayout]);

  /**
   * 列表请求序号（2026-11-19）：搜索框每次输入都会重新取列表，刷新按钮还会再叠一次。
   * 没有这层保护时，先发的慢响应会盖掉后发的快响应（敲完 "abc" 却看到 "ab" 的结果）。
   * 只丢弃过期响应，不改请求本身、不改接口签名。
   */
  const listSeq = useRef(0);

  const loadList = useCallback(async () => {
    const seq = ++listSeq.current;
    setListLoading(true);
    try {
      const [list, typeList, govCounts] = await Promise.all([
        /*
         * `includePinned: true`（2026-11-19）：置顶事件不受「类型 / 状态」筛选影响。
         * 只开给事件页 —— MCP 与脚本走同一函数，它们要的是严格筛出来的集合。
         */
        listEvents(scope, {
          status,
          ...(typeFilter ? { type: typeFilter } : {}),
          ...(keyword ? { q: keyword } : {}),
          limit: 100,
          includePinned: true,
        }),
        listEventTypes(scope),
        getGovernanceCounts(scope).catch(() => null),
      ]);
      // 晚到的响应直接丢弃：更新的请求已经在路上（或已经回来）
      if (seq !== listSeq.current) return;
      setEvents(list.events);
      setTypes(typeList.types);
      if (govCounts) setCounts({ open: govCounts.eventsOpen, closed: govCounts.eventsClosed });
      setActiveId((prev) => prev ?? matchDeepLink(list.events) ?? list.events[0]?.id ?? null);
    } catch (err) {
      if (seq !== listSeq.current) return;
      setMessage({ tone: 'err', text: (err as Error).message });
    } finally {
      // 只有「最后一次请求」能收掉转圈，否则中途的过期响应会提前把 loading 关掉
      if (seq === listSeq.current) setListLoading(false);
    }
  }, [scope, status, keyword, typeFilter, matchDeepLink]);

  useEffect(() => { void loadList(); }, [loadList]);

  /** 兜底同步：首屏与深链的选中由 `loadList` 直接 `setActiveId`，不经过 `selectEvent` */
  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  /**
   * 深链：选中后滚到可见（列表可能很长，右栏已切过去但左栏还停在别处）。
   *
   * 只滚一次：`activeId` 也会因用户点列表而变，若无条件滚，带 `?event=` 的页面上
   * 每次点选都会轻微跳一下。`deepLinkScrolled` 保证「深链定位」这件事只做一次。
   */
  const deepLinkScrolled = useRef(false);
  useEffect(() => {
    if (!entryDeepLink || !activeId || deepLinkScrolled.current) return;
    const el = document.querySelector(`[data-event-id="${activeId}"]`);
    if (!(el instanceof HTMLElement)) return; // 列表还没渲染出来，等下一轮
    deepLinkScrolled.current = true;
    el.scrollIntoView({ block: 'nearest' });
  }, [entryDeepLink, activeId]);

  /**
   * 深链指向的事件不在**进入页面时**的列表里。
   *
   * **只判一次**（2026-11-19 误报修复）：判完就置位 `deepLinkWarned`，之后用户怎么切筛选都不再走这里。
   * 旧实现只把「值」读一次、判定却随 `events` / `status` 反复重跑，于是：
   *   · 切到「会把这条事件排除掉」的那一档 → 列表里自然找不到它 → 误报「可能已被删除」（事件明明在）；
   *   · 切「未收口」更糟 → 旧兜底会 `setStatus('all')` 把用户刚选的筛选弹回去，而这一帧 `events`
   *     还是上一份（未收口）列表 → 紧接着就弹误报。两条路径均已在真机复现。
   * 默认筛选是「全部」，进入页面这份列表就是权威判据：找到即终结，找不到才提示。
   * ⚠️ 若将来把状态筛选写进 URL（进页面就可能不是「全部」），这份列表不再是权威判据，
   * 要改成「按未筛选的列表判定」，否则又会把「被筛掉」误报成「已删除」。
   */
  useEffect(() => {
    if (!entryDeepLink || deepLinkWarned.current || events.length === 0) return;
    deepLinkWarned.current = true;
    if (matchDeepLink(events)) return;
    /*
     * 不能只写「可能已被删除」：地址栏里的 `?event=` 是**库内** id（2026-11-19 起点选也会写回），
     * 换库 / 转发给用别的库的人都会走到这里，而事件其实一直在，只是不在当前库。
     * 把两种原因都写出来，别让人以为数据丢了。
     */
    setMessage({
      tone: 'err',
      text: `未找到事件 ${entryDeepLink}：它可能已被删除，或不在当前知识库「${scope}」中`,
    });
  }, [entryDeepLink, events, matchDeepLink, scope]);

  /**
   * 操作提示自动收（2026-11-18）：成功 2.6s 自隐 —— 它已是 fixed 浮层、不占布局，
   * 但长期悬在右上角会挡视线。**失败不自动消失**：错误原因被自动收掉等于用户没看到。
   */
  useEffect(() => {
    if (!message || message.tone === 'err') return undefined;
    const t = window.setTimeout(() => setMessage(null), 2600);
    return () => window.clearTimeout(t);
  }, [message]);

  const loadDetail = useCallback(async (id: string) => {
    try {
      const [d, r] = await Promise.all([getEventDetail(scope, id), listRefs(scope, id)]);
      setDetail(d);
      setRefs(r.refs);
    } catch (err) {
      setMessage({ tone: 'err', text: (err as Error).message });
    }
  }, [scope]);

  useEffect(() => {
    setDelConfirm(false);
    setDescEdit({ open: false, draft: '', saving: false });
    if (activeId) void loadDetail(activeId);
    else { setDetail(null); setRefs([]); }
  }, [activeId, loadDetail]);

  /*
   * 切事件后右栏回到顶部（2026-11-19）：`--noscroll` 下右栏是独立滚动容器，
   * 不回顶就会停在上一条的滚动位置，看着像「点了没反应」。
   */
  useEffect(() => {
    const el = document.querySelector('.gov-pane--flat');
    if (el instanceof HTMLElement) el.scrollTop = 0;
  }, [activeId]);

  // 分析进度轮询已下沉到 AiAnalyzePanel（1.5s，单一真源）；页面不再持有轮询

  const active = useMemo(() => events.find((e) => e.id === activeId) ?? detail?.event ?? null, [events, activeId, detail]);

  /*
   * 从磁盘读回上次「AI 查找」的结论（2026-11-19）。
   *
   * ⚠️ 两个"不许清空"的坑（真机踩过）：
   *   · `loadDetail` 过程中 `active` 会短暂为空 → 旧实现立刻置 null，刚固定的总结当场消失；
   *   · 接口失败（daemon 未重启时 404）→ 旧实现也置 null，等于"存过但看不见"。
   * 现在只在**明确读到空**时才清，其余保留已有值。
   */
  useEffect(() => {
    const id = active?.id;
    if (!id) return; // 切换中：保留上一份，等新 id 到了再覆盖
    let alive = true;
    void getFindSummary(scope, id)
      .then((r) => {
        if (!alive) return;
        const last = r.lastFind;
        setFindSummary(last
          ? { summary: last.summary, ...(last.uncertainties ? { uncertainties: last.uncertainties } : {}) }
          : null);
      })
      .catch(() => { /* 读失败保留现有值，不清空 */ });
    return () => { alive = false; };
  }, [active?.id, scope]);
  const activeAnalysis = detail?.event.id === active?.id ? (detail?.analysis ?? null) : null;
  const type = useMemo(
    () => types.find((t) => t.id === (active?.typeId ?? '')) ?? null,
    [types, active],
  );

  const selectedType = useMemo(
    () => types.find((t) => t.id === selectedTypeId) ?? types[0] ?? null,
    [types, selectedTypeId],
  );

  /**
   * 行内保存：demo 里点一下即生效，没有「保存」按钮。
   * 每次都用**最新 revision**发 PATCH（同一类型连点两次也要成立，否则第二次 409）。
   */
  const patchType = async (mutate: (stages: StagePatch[], type: EventTypeView) => {
    stages?: StagePatch[];
    terminalAction?: 'keep' | 'trash';
  }): Promise<void> => {
    if (!selectedType) return;
    const latest = types.find((t) => t.id === selectedType.id) ?? selectedType;
    const base: StagePatch[] = latest.stages.map((st) => ({
      key: st.key,
      name: st.name,
      visibility: st.visibility,
      ...(st.disabled ? { disabled: true } : {}),
    }));
    const patch = mutate(base, latest);
    await run(async () => {
      const res = await updateEventType(scope, latest.id, {
        revision: latest.revision,
        ...(patch.stages ? { stages: patch.stages } : {}),
        ...(patch.terminalAction ? { terminalAction: patch.terminalAction } : {}),
      });
      return `「${res.type.name}」已更新`;
    });
  };

  /** 删除类型：内置不可删；仍有事件在用时服务端返回 TYPE_IN_USE */
  const removeType = async (): Promise<void> => {
    if (!selectedType) return;
    const target = selectedType;
    await run(async () => {
      const res = await fetch(
        `/api/governance/event-types/${encodeURIComponent(target.id)}?scope=${encodeURIComponent(scope)}`,
        { method: 'DELETE' },
      );
      const payload = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (!res.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${res.status}`);
      setSelectedTypeId(null);
      return `已删除类型「${target.name}」`;
    });
  };

  const run = async (fn: () => Promise<string>): Promise<void> => {
    setBusy(true);
    /*
     * 不先 `setMessage(null)`：提示已是浮层不占布局，但"清空→再填"会让浮层整体卸载重挂
     * （淡入动画重播 + 一闪），看起来像闪了一下。直接覆盖即可（2026-11-18）。
     */
    try {
      setMessage({ tone: 'ok', text: await fn() });
      await loadList();
      // 读 ref 而不是闭包里的 activeId：删除事件后它已被清空，不能再拿旧 id 去查
      if (activeIdRef.current) await loadDetail(activeIdRef.current);
    } catch (err) {
      const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
      setMessage({ tone: 'err', text: `${code}${(err as Error).message}` });
    } finally {
      setBusy(false);
    }
  };

  /**
   * 排序只在**已取回的当前页**内进行：后端 `listEvents` 固定 `updatedAt` 降序且不接排序参数，
   * 前端一次取 `limit:100`（当前事件量远小于此，无差异）。将来事件破百要真排序，
   * 应给 `/governance/events` 加 `sort` 参数在服务端排 —— 否则第 101 条起永远排不进来。
   */
  const sortedEvents = useMemo(() => {
    // 先分区、后排序（2026-11-19）：置顶项由 `pinnedEvents` 单独渲染，
    // 三种排序键都只在普通区内生效 —— 否则「最早创建」会把置顶项顶到下面去。
    const arr = events.filter((e) => !isPinnedEvent(e));
    // `createdAt` 在 `EventRecord` 里是必填，但 `readAllEvents` 只校验 id/stageKey，
    // 2026-11 之前手工写入的老文件可能没有 → 回退到 updatedAt，避免整批沉到末尾。
    const created = (e: EventView): number => e.createdAt ?? e.updatedAt ?? 0;
    if (sort === 'created-desc') arr.sort((a, b) => created(b) - created(a));
    else if (sort === 'created-asc') arr.sort((a, b) => created(a) - created(b));
    else arr.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return arr;
  }, [events, sort]);

  /**
   * 置顶区（2026-11-19）：区内按「最近置顶在上」。
   *
   * 服务端已经这样排过，这里重排一次是**幂等的**：列表接口将来若换排序实现，
   * 置顶区顺序也不会跟着漂。置顶区永远在普通区之上，不参与 `sort`。
   */
  const pinnedEvents = useMemo(
    () => events.filter((e) => isPinnedEvent(e)).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    [events],
  );

  /**
   * 第二行时间标签跟着排序键走：按创建时间排却显示「更新于」会让人以为排序坏了。
   * 按更新时间排时保留原样（只一个相对时间），不额外加前缀词。
   */
  const listTimeText = (e: EventView): string =>
    sort === 'updated-desc' ? relTime(e.updatedAt) : `创建 ${relTime(e.createdAt ?? e.updatedAt)}`;

  /** 状态筛选的显示名：下拉与置顶分区标题共用，避免两处措辞飘 */
  const statusLabel = status === 'open' ? '未收口' : status === 'closed' ? '已收口' : '全部';

  /**
   * 单行事件卡。抽成函数而不是两段 JSX：置顶区与普通区必须**完全同构**，
   * 复制一份的结果是改了一处、另一处悄悄不一致（例如新增的置顶标识只出现在一半行里）。
   */
  const renderEventRow = (event: EventView, pinned: boolean): JSX.Element => {
    const t = types.find((x) => x.id === event.typeId);
    // 已收口 = `closedAt` 非空（收口的唯一权威）。只降视觉权重、不禁用：
    // 收口事件仍要能点开复盘，灰底 ≠ 不可操作。
    const isClosed = event.closedAt !== null && event.closedAt !== undefined;
    /*
     * 当前阶段（2026-11-19）：列表里看不出「这条走到哪一步了」，只能点开详情看阶段线。
     * 列表接口本来就下发 `stage`，直接用；类型还没加载到 / 老数据缺字段时按 stageKey
     * 从类型定义里反查一次。`(未知阶段)` 是后端找不到阶段时的占位，显示出来只是噪音。
     */
    const stageOfType = t?.stages.find((s) => s.key === event.stageKey);
    const rawStageName = event.stage?.name ?? stageOfType?.name ?? null;
    const stageName = rawStageName && rawStageName !== '(未知阶段)' ? rawStageName : null;
    const stageIdx2 = event.stage?.index ?? (stageOfType ? (t?.stages.indexOf(stageOfType) ?? -1) : -1);
    const stageTotal = t?.stages.length ?? 0;
    return (
      <div
        key={event.id}
        data-event-id={event.id}
        className={`gov-ev${isClosed ? ' gov-ev--closed' : ''}${event.id === activeId ? ' gov-ev--active' : ''}${pinned ? ' gov-ev--pinned' : ''}`}
        onClick={() => selectEvent(event.id)}
      >
        <div className="gov-ev__title">
          <div className="gov-ev__main">
            {/*
              * 标题缩略 1 行（2026-11-19 用户要求）：3-5 行折行会让行高在 60~120px 间跳，
              * 整列读起来没有节奏。完整标题由 title 属性与右栏详情承担。
              */}
            <div className="gov-ev__name" title={event.title}>{event.title}</div>
            {/* 列表只留编号 / 时间 / 类型 / 当前阶段：文档数与可见性点开详情可见，行内不再重复 */}
            <div className="gov-ev__meta">
              {/*
                * 置顶标识放在最前（2026-11-19）：分区标题说明「这一组是什么」，
                * 行内标识说明「为什么它在筛选结果里」。只靠分组还不够 ——
                * 一行滚到视口外时，标题已经看不见了。
                */}
              {pinned ? (
                <span
                  className="gov-ev__pin"
                  role="img"
                  title="已置顶：不受筛选与排序影响"
                  aria-label="已置顶"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
                  </svg>
                </span>
              ) : null}
              {/*
                * 编号（2026-11-19）：从标题行挪进 meta 行，标题因此吃满整行宽度；
                * 正文只显示裸数字（`#` 留在 title / aria-label），样式与详情页编号 chip 同源。
                */}
              <span className="gov-ev__id" title={`事件 #${event.shortId}`} aria-label={`事件 #${event.shortId}`}>
                {event.shortId}
              </span>
              <span className="gov-ev__sep" aria-hidden="true">·</span>
              <span>{listTimeText(event)}</span>
              {t ? (
                <>
                  <span className="gov-ev__sep" aria-hidden="true">·</span>
                  <span className={typeBadgeClass(t.name)}>{t.name}</span>
                </>
              ) : null}
              {/*
                * 当前阶段紧跟类型徽标：同一行读成「类型 → 走到哪」。
                * **不做成带框徽标**（像按钮、会诱人点），只留圆点 + 文字；
                * 序号这类精确位置放进 title，不占版面。
                */}
              {stageName ? (
                <>
                  <span className="gov-ev__sep" aria-hidden="true">·</span>
                  <span
                    className={`gov-badge gov-ev__stage${isClosed ? ' gov-ev__stage--closed' : ''}`}
                    title={stageIdx2 >= 0 && stageTotal > 0
                      ? `当前阶段 第 ${stageIdx2 + 1}/${stageTotal} 步「${stageName}」`
                      : `当前阶段「${stageName}」`}
                  >
                    {stageName}
                  </span>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  };

  const closed = active?.closedAt !== null && active?.closedAt !== undefined;
  const stageIdx = type && active ? type.stages.findIndex((s) => s.key === active.stageKey) : -1;
  const stageVis = stageIdx >= 0 ? type!.stages[stageIdx].visibility : 'full';
  const memberCount = detail?.members.length ?? active?.memberTotal ?? 0;

  return (
    // `--fill` 只在列表视图挂：它让高度链一路撑到视口底（见上方 `--noscroll` 的注释）
    <div className={`gov-page${tab === 'list' ? ' gov-page--fill' : ''}`}>
      <header className="gov-head">
        <p className="gov-head__path">
          <span className="gov-badge gov-badge--kb">{scope}</span>
          {/* 计数读取失败时整段不渲染：留空 span 会让 flex gap 多出一段空白，也会让人以为"0 个" */}
          {counts ? (
            <span className="gov-cell-muted">未收口 {counts.open} · 已收口 {counts.closed}</span>
          ) : null}
        </p>
        <div className="gov-head__actions">
          {/* 视图切换挪到主操作左侧：它切的是整页内容（列表 / 类型），属页面级，
              放在下一行左端会与「列表过滤器」混成一条，看起来像在过滤自己 */}
          <div className="gov-seg" role="group" aria-label="视图">
            <button aria-pressed={tab === 'list'} onClick={() => setTab('list')}>事件列表</button>
            <button aria-pressed={tab === 'types'} onClick={() => setTab('types')}>事件类型</button>
          </div>
          <button
            className="gov-btn gov-btn--sm"
            disabled={!canWrite}
            title={readOnlyHint}
            onClick={() => setNewEventOpen(true)}
          >
            ＋ 新建事件
          </button>
        </div>
      </header>

      {/* 过滤器贴左：它只作用于下方的左侧列表，顶到视口右端会跨 1000px 才建立因果。
          只在「事件列表」视图渲染 —— 「事件类型」页没有事件可过滤，留着是空转控件。 */}
      {tab === 'list' ? (
        <div className="gov-toolbar">
          <DropdownFilter
            label="类型"
            value={typeFilter}
            options={[{ value: '', label: '全部类型' }, ...types.map((t) => ({ value: t.id, label: t.name }))]}
            onChange={setTypeFilter}
          />
          <DropdownFilter
            label={statusLabel}
            value={status}
            options={[
              { value: 'open', label: '未收口' },
              { value: 'closed', label: '已收口' },
              { value: 'all', label: '全部' },
            ]}
            onChange={(v) => setStatus(v as Status)}
          />
          <DropdownFilter
            label={SORT_LABEL[sort]}
            value={sort}
            options={[
              { value: 'updated-desc', label: '最近更新' },
              { value: 'created-desc', label: '最新创建' },
              { value: 'created-asc', label: '最早创建' },
            ]}
            onChange={(v) => setSort(v as SortKey)}
          />
        </div>
      ) : null}

      {/*
       * 提示改成**脱离布局的浮层**（2026-11-18 报障「点删除页面抖一下」）：
       * 原来这行是普通块级元素，`run()` 里 `setMessage(null)` → 完成后再 `setMessage(ok)`
       * 会让它消失一次、出现一次 ⇒ 下面整块内容上下各被推一回，整页看起来抖一下。
       * 现在 fixed 定位、不参与布局，文字替换不再影响任何元素位置。
       */}
      {message ? (
        <p
          className={`gov-page-toast${message.tone === 'err' ? ' gov-page-toast--err' : ''}`}
          role="status"
          aria-live="polite"
        >
          {message.text}
        </p>
      ) : null}
      {showReadOnlyHint ? (
        <p className="gov-hint">
          当前账号为只读：可以查看事件、阶段与可见性；新建 / 流转 / 删除 / 编辑类型需要写权限。
          「AI 查找」可照常用，只有「加入参考文档」需要写权限。
        </p>
      ) : null}

      {tab === 'types' ? (
        <>
          <div className="gov-card">
          <div className="gov-typebar">
            <div className="gov-seg" role="group" aria-label="事件类型">
              {types.map((t) => (
                <button key={t.id} aria-pressed={selectedType?.id === t.id} onClick={() => setSelectedTypeId(t.id)}>
                  {t.name}
                </button>
              ))}
            </div>
            <span className="gov-toolbar__spacer" />
            <span className="gov-cell-muted">
              {selectedType?.builtin ? '内置类型，不可删除' : '自定义类型'}
            </span>
            <button
              className="gov-btn gov-btn--sm"
              disabled={busy || !canWrite}
              title={readOnlyHint}
              onClick={() => setNewTypeOpen(true)}
            >
              ＋ 新建类型
            </button>
            <button
              className="gov-btn gov-btn--sm gov-btn--danger-ghost"
              disabled={busy || !selectedType || selectedType.builtin || !canWrite}
              title={!canWrite ? readOnlyHint : selectedType?.builtin ? '内置类型不可删除' : '删除该类型（仍有事件在用时会被拒绝）'}
              onClick={() => void removeType()}
            >
              删除类型
            </button>
          </div>

          {selectedType ? (
            <>
                <table className="gov-tbl">
                  <colgroup>
                    <col style={{ width: 160 }} />
                    <col style={{ width: 290 }} />
                    <col />
                    <col style={{ width: 90 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>阶段（有序）</th>
                      <th>检索可见性</th>
                      <th>进入时动作</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedType.stages.map((stage, i) => {
                      // 序号徽标跟随左侧选中事件的当前阶段；没选事件就不标（此前硬编码 i===2 是假数据）
                      const isCurrent = active?.stageKey === stage.key && active?.typeId === selectedType.id;
                      return (
                        <tr key={stage.key} data-current={isCurrent ? '' : undefined}>
                          <td>
                            <span className="gov-stage-row__idx">{i + 1}</span>
                            {stage.name}
                          </td>
                          <td>
                            <div className="gov-seg gov-seg--vis" role="group" aria-label={`${stage.name} 检索可见性`}>
                              {(['full', 'fts-only', 'hidden'] as Visibility[]).map((value) => (
                                <button
                                  key={value}
                                  type="button"
                                  aria-pressed={stage.visibility === value}
                                  disabled={busy || !canWrite}
                                  title={readOnlyHint}
                                  onClick={() => void patchType((stages) => {
                                    const next = [...stages];
                                    next[i] = { ...next[i], visibility: value };
                                    return { stages: next };
                                  })}
                                >
                                  {VIS_TEXT[value]}
                                </button>
                              ))}
                            </div>
                          </td>
                          <td>
                            <span className="gov-cell-muted">
                              {i === selectedType.stages.length - 1 && selectedType.terminalAction === 'trash'
                                ? '移入回收站'
                                : '保留'}
                            </span>
                          </td>
                          <td>
                            <button
                              className="gov-btn gov-btn--ghost gov-btn--sm"
                              disabled={busy || i === selectedType.stages.length - 1 || !canWrite}
                              title={!canWrite ? readOnlyHint : i === selectedType.stages.length - 1 ? '末位是终态，不能停用' : '停用后不能再流转到该阶段'}
                              onClick={() => void patchType((stages) => {
                                const next = [...stages];
                                next[i] = { ...next[i], disabled: !next[i].disabled };
                                return { stages: next };
                              })}
                            >
                              {stage.disabled ? '启用' : '停用'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div className="gov-card__foot">
                  <button
                    className="gov-btn gov-btn--sm"
                    disabled={busy || !canWrite}
                    title={readOnlyHint}
                    onClick={() => setAddStageOpen(true)}
                  >
                    ＋ 追加阶段
                  </button>
                  <p className="gov-hint">
                    <b>阶段只能追加、不能删除</b>：已有事件停在某阶段后，删除定义会留下悬空状态；
                    要废弃某个阶段请用「停用」—— 新事件不再进入、老事件可停留，并提供「迁移到 X」的引导。
                  </p>
                </div>
              </>
            ) : (
              <div className="gov-cell-muted" style={{ padding: 24 }}>暂无事件类型</div>
            )}
          </div>

          {selectedType ? (
            <p className="gov-notice">
              <strong>为什么是三档而不是开关：</strong>
              <code>ki_search</code> 默认 hybrid（语义+全文），只关语义（dense）全文仍会命中并召回给 AI ——
              「不召回」不等于「搜不到」。三档对应：
              <strong>语义+全文</strong>（完整）/
              <strong>仅全文</strong>（关键词能搜到、不主动语义推送）/
              <strong>不可检索</strong>（两者都断，但按浏览可见，人工可读）。
              第三档还要清 <code>ki-relation</code> / <code>ki-path</code> 两类辅助向量 —— 否则语义会绕回。
            </p>
          ) : null}
        </>
      ) : (
        <div className="gov-split">
          {/* 左：事件列表（`--list` 让它吸附视口，列表本身内滚，见 `.gov-pane--list`） */}
          <div className="gov-pane gov-pane--list">
            <div className="gov-pane__search">
              <input
                className="gov-input"
                placeholder="搜索事件名或编号…"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
              {/*
                * 刷新（2026-11-19）：只重取列表，**保留筛选 / 搜索 / 选中 / 滚动位置**。
                * 只读账号也能用 —— 这是读操作，不该被 `canWrite` 挡住。
                * 请求在途时禁用 + 转圈，避免连点打出并发请求。
                */}
              <button
                type="button"
                className={`gov-btn gov-btn--ghost gov-pane__refresh${listLoading ? ' is-loading' : ''}`}
                onClick={() => {
                  void loadList();
                  /*
                   * 详情不跟着刷会让人以为「刷了还是旧的」：列表里的标题变了、右栏还停在旧阶段。
                   * 只在已有选中时刷，避免首次进页面并发两条同样的详情请求。
                   */
                  if (activeId) void loadDetail(activeId);
                }}
                disabled={listLoading}
                aria-label="刷新事件列表"
                title="刷新事件列表（保留筛选、搜索与选中）"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
              </button>
            </div>
            <div className="gov-pane__list">
              {/*
                * 置顶分区（2026-11-19）：只有真的存在置顶项时才画分隔与标题 ——
                * 没人置顶时列表与升级前**像素级一致**（不给所有用户平白多两行标题）。
                */}
              {pinnedEvents.length > 0 ? (
                <>
                  {/*
                    * 分区标题（2026-11-19 改版）：带计数 + `sticky` 吸附列表顶部。
                    * 解释句不再常驻（每屏都要读一遍的噪音），收进 ⓘ 的 title。
                    */}
                  <div className="gov-evgroup">
                    <span className="gov-evgroup__label">置顶</span>
                    <span className="gov-evgroup__count">{pinnedEvents.length}</span>
                    <span
                      className="gov-evgroup__info"
                      role="img"
                      title="置顶事件不受「类型 / 状态」筛选与排序影响"
                      aria-label="置顶事件不受类型与状态筛选影响"
                    >i</span>
                  </div>
                  {pinnedEvents.map((event) => renderEventRow(event, true))}
                  {/* 普通区被筛空时不画空标题：只剩一行「已收口」下面是空白，像页面没加载出来 */}
                  {sortedEvents.length > 0 ? (
                    <div className="gov-evgroup">
                      <span className="gov-evgroup__label">{status === 'all' ? '其他事件' : statusLabel}</span>
                      <span className="gov-evgroup__count">{sortedEvents.length}</span>
                      <span
                        className="gov-evgroup__info"
                        role="img"
                        title={`${SORT_LABEL[sort]}在前`}
                        aria-label={`排序：${SORT_LABEL[sort]}`}
                      >i</span>
                    </div>
                  ) : null}
                </>
              ) : null}
              {sortedEvents.map((event) => renderEventRow(event, false))}
              {events.length === 0 ? <div className="gov-cell-muted" style={{ padding: 16 }}>暂无事件</div> : null}
            </div>
          </div>

          {/* 右：详情（卡片自己承担边界，外层不再画一层白卡，见 .gov-pane--flat） */}
          <div className="gov-pane gov-pane--flat">
            {!active ? (
              <div className="gov-cell-muted" style={{ padding: 24 }}>左侧选择一个事件查看详情</div>
            ) : (
              <div className="gov-dcard-flow">
                <EventSummaryCard
                  event={active}
                  typeName={type?.name ?? active.typeId}
                  stageName={type?.stages[stageIdx]?.name ?? '未知'}
                  memberCount={memberCount}
                  refCount={refs.length}
                  closed={closed}
                  pinned={isPinnedEvent(active)}
                  canWrite={canWrite}
                  busy={busy}
                  delConfirm={delConfirm}
                  descEdit={descEdit}
                  showAnalyzeGuide={!activeAnalysis?.draft && (activeAnalysis?.confirmed.length ?? 0) === 0}
                  stageSlot={(
                    <>
                <div className="gov-stage">
                  {(type?.stages ?? []).map((s, i) => (
                    <div
                      key={s.key}
                      className={`gov-stage__node${i < stageIdx ? ' gov-stage__node--done' : ''}${i === stageIdx ? ' gov-stage__node--current' : ''}`}
                    >
                      <span className="gov-stage__dot" />
                      <span className="gov-stage__name">{s.name}</span>
                      <span className="gov-stage__cap">{VIS_TEXT[s.visibility]}</span>
                    </div>
                  ))}
                </div>
                <div className="gov-infobar">
                  当前阶段「{type?.stages[stageIdx]?.name ?? '未知'}」：{memberCount} 篇文档的可见性为
                  <strong>{VIS_TEXT[stageVis]}</strong>
                  {stageVis === 'hidden' ? '（语义与全文都搜不到，这是阶段设计的预期行为）' : ''}
                </div>
                    </>
                  )}
                  onAnalyze={() => {
                    // G-08：已分析过再点只提示；重跑走卡片内的「重新分析」
                    if (activeAnalysis?.draft || (activeAnalysis?.confirmed.length ?? 0) > 0) {
                      void run(async () => '这次分析已经完成，不用重复点；如需重跑请用「AI 分析」卡里的「重新分析」');
                      return;
                    }
                    // 立刻给一次反馈：卡片要等下一帧才挂载，期间用户会以为"点了没反应"
                    setMessage({ tone: 'ok', text: '正在启动分析…' });
                    setStartSignal((n) => n + 1);
                  }}
                  onTogglePin={() => void run(async () => {
                    /*
                     * 取反当前态而不是"永远置顶"：同一个按钮承担开关，
                     * 文案由 `pinned` 决定（见 EventSummaryCard），两边必须同一口径。
                     */
                    const r = await setEventPinned(scope, active.id, !isPinnedEvent(active));
                    return r.hint;
                  })}
                  onReopen={() => void run(async () => {
                    const r = await reopenEvent(scope, active.id);
                    return r.hint;
                  })}
                  onDelete={() => {
                    if (!delConfirm) { setDelConfirm(true); return; }
                    setDelConfirm(false);
                    void run(async () => {
                      const r = await deleteEvent(scope, active.id, "wiki");
                      // 连带清掉地址栏里的 `?event=`：留着会让刷新后的深链兜底报「可能已被删除」
                      selectEvent(null);
                      return `已删除事件；${r.affected.docs} 篇文档改为长期保留`;
                    });
                  }}
                  onTransition={() => setTransOpen(true)}
                  onDescEdit={() => setDescEdit({ open: true, draft: active.description ?? '', saving: false })}
                  onDescChange={(v) => setDescEdit((s2) => ({ ...s2, draft: v }))}
                  onDescSave={() => {
                    setDescEdit((s2) => ({ ...s2, saving: true }));
                    void run(async () => {
                      await updateEvent(scope, active.id, { description: descEdit.draft, revision: active.revision });
                      setDescEdit({ open: false, draft: '', saving: false });
                      return '已更新事件描述';
                    }).finally(() => setDescEdit((s2) => (s2.open ? { ...s2, saving: false } : s2)));
                  }}
                  onDescCancel={() => setDescEdit({ open: false, draft: '', saving: false })}
                />

                {/* AI 分析（默认不渲染：无草稿且无已确认位置时整卡不出现） */}
                <EventAnalysisCard
                  key={active.id}
                  scope={scope}
                  event={active}
                  analysis={activeAnalysis}
                  canWrite={canWrite}
                  canAsk={canAsk}
                  busy={busy}
                  readOnlyHint={readOnlyHint}
                  startSignal={startSignal}
                  onUpdated={(next: EventAnalysis) => {
                    setDetail((prev) => (prev ? { ...prev, analysis: next } : prev));
                  }}
                  onOpenSettings={() => openAiSettings('analysis')}
                  onRemoveLocation={(loc) => void run(async () => {
                    await removeConfirmedCodeLocation(scope, active.id, loc.id);
                    return `已移除代码位置「${loc.file}:${loc.line}」`;
                  })}
                />

                {/* 关联文档 */}
                {/* 关联文档（可见性随事件阶段变化） */}
                <EventDocsCard
                  mode="member"
                  docs={(detail?.members ?? []).map((m) => ({
                    key: m.group + "/" + m.name,
                    name: m.name,
                    group: m.group,
                    vis: { tone: (VIS_CLASS[stageVis] ?? "hidden") as VisTone, text: VIS_TEXT[stageVis] },
                  }))}
                  canWrite={canWrite}
                  busy={busy}
                  hint="可见性随事件阶段变化"
                  notice={memberVisWarn ? (
                    <div className="gov-cell-muted" style={{ color: "var(--ki-warn, #b26a00)" }}>{memberVisWarn}</div>
                  ) : undefined}
                  emptyText="暂无关联文档，点右上「＋ 添加」把要跟踪的文档挂上来"
                  confirmKey={pendingRemove}
                  onConfirmChange={setPendingRemove}
                  onOpen={(group, name) => setDocTarget({ group, name })}
                  onRemove={(row) => void run(async () => {
                    const r = await removeMember(scope, active.id, row.group, row.name);
                    setMemberVisWarn(null);
                    return `已移除「${row.name}」${r.pending.length > 0 ? '；索引补齐中，数秒后可被语义检索' : ''}`;
                  })}
                  actions={(
                    <button
                      className="gov-btn gov-btn--ghost gov-btn--sm"
                      disabled={busy || !canWrite || closed}
                      title={readOnlyHint ?? (closed ? "事件已收口，不能再挂文档；如需继续请先「重新打开」" : "选择要挂到本事件的文档")}
                      onClick={() => setAddMemberOpen(true)}
                    >
                      ＋ 添加
                    </button>
                  )}
                />

                {/* 参考文档 */}
                {/* 参考文档（不随事件阶段变化） */}
                <EventDocsCard
                  mode="ref"
                  docs={refs.map((ref) => ({
                    key: (ref.sourceScope ?? "") + "/" + ref.group + "/" + ref.name,
                    name: ref.name,
                    group: [
                      ref.sourceScope && ref.sourceScope !== scope ? ref.sourceScope + " · " : "",
                      ref.group,
                      ref.stale ? (ref.staleReason === "scope-missing" ? " · 源库已不存在" : " · 文档已不存在") : "",
                    ].join(""),
                    vis: { tone: (VIS_CLASS[ref.visibility] ?? "hidden") as VisTone, text: VIS_TEXT[ref.visibility] },
                  }))}
                  canWrite={canWrite}
                  busy={busy}
                  hint="外部引用，不随事件阶段变化"
                  panel={findRefOpen ? (
                    <FindRefPanel
                      scope={scope}
                      eventId={active.id}
                      canWrite={canWrite}
                      context={{
                        title: active.title,
                        shortId: active.shortId,
                        ...(type?.name ? { typeName: type.name } : {}),
                        stageName: type?.stages.find((s) => s.key === active.stageKey)?.name ?? '—',
                        assocCount: memberCount,
                        scope,
                      }}
                      open={findRefOpen}
                      onOpenChange={(open) => { if (!open) setFindRefOpen(false); }}
                      onStatus={setFindStatus}
                      onSummary={(summary, uncertainties) => setFindSummary(uncertainties ? { summary, uncertainties } : { summary })}
                      onAdded={(added, skipped, summary, uncertainties) => {
                        // 确认后把结论固定下来：面板随即卸载，不带走这段文字
                        if (summary) {
                          setFindSummary(uncertainties ? { summary, uncertainties } : { summary });
                          // 落盘：刷新 / 换机后仍能看到这次的结论（含判断不了的点）
                          void saveFindSummary(scope, active.id, summary, uncertainties).catch(() => {
                            /* 落盘失败不影响加入结果，静默即可 */
                          });
                        }
                        // 局部刷新参考文档区：查找本身没写数据，不该触发整页重载
                        setMessage({
                          tone: 'ok',
                          text: `已加入 ${added} 篇参考文档${skipped > 0 ? `，跳过 ${skipped} 篇（已存在）` : ''}`,
                        });
                        void loadDetail(active.id);
                      }}
                      onSwitchToManual={() => { setFindRefOpen(false); setAddRefOpen(true); }}
                      onOpenSettings={() => { setFindRefOpen(false); openAiSettings('find'); }}
                    />
                  ) : findSummary ? (
                    <div className="gov-find-last">
                      <div className="gov-find-last__head">查找总结</div>
                      <p className="gov-find-last__text">{findSummary.summary}</p>
                      {findSummary.uncertainties && findSummary.uncertainties.length > 0 ? (
                        <div className="gov-ai-final__uncertain">
                          <div className="gov-ai-final__uncertain-head">判断不了的点 · {findSummary.uncertainties.length}</div>
                          <ul className="gov-ai-final__uncertain-list">
                            {findSummary.uncertainties.map((u, i) => <li key={i}>{u}</li>)}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                  emptyText="暂无参考文档：可用「AI 查找」、「＋ 添加」或「上传文件」"
                  confirmKey={refConfirmKey}
                  onConfirmChange={setRefConfirmKey}
                  onOpen={(group, name) => setDocTarget({ group, name })}
                  onRemove={(row) => {
                    const ref = refs.find((r) => (r.sourceScope ?? "") + "/" + r.group + "/" + r.name === row.key);
                    if (!ref) return;
                    void run(async () => {
                      await removeRef(scope, active.id, ref.group, ref.name, ref.sourceScope);
                      return `已移除参考文档「${ref.name}」`;
                    });
                  }}
                  actions={(
                    <>
                      {findRefOpen ? (
                        <span className="gov-dchip gov-dchip--run">{findStatus?.state === 'loading' ? '检索中 ◐' : (findStatus?.count ?? 0) > 0 ? `${findStatus?.count} 篇候选` : '无候选'}</span>
                      ) : null}
                      <button className="gov-btn gov-btn--sm" disabled={busy} onClick={() => setFindRefOpen(true)}>AI 查找</button>
                      <button
                        className="gov-btn gov-btn--ghost gov-btn--sm"
                        disabled={busy || !canWrite}
                        title={readOnlyHint}
                        onClick={() => setAddRefOpen(true)}
                      >
                        ＋ 添加
                      </button>
                      {/* 上传文件（REQ-20261118-001）：与「＋ 添加」同层级，写权限才可用 */}
                      <button
                        className="gov-btn gov-btn--ghost gov-btn--sm"
                        disabled={busy || !canWrite}
                        title={readOnlyHint}
                        onClick={() => setUploadRefOpen(true)}
                      >
                        上传文件
                      </button>
                    </>
                  )}
                />

              </div>
            )}
          </div>
        </div>
      )}

      {addStageOpen && selectedType ? (
        <AddStageModal
          type={selectedType}
          busy={busy}
          onClose={() => setAddStageOpen(false)}
          onSubmit={(name, visibility, action) => {
            setAddStageOpen(false);
            void patchType((stages, latest) => ({
              stages: [...stages, { name, visibility }],
              // 「进入时动作」是**类型级**字段：只有新阶段位居末位时才会生效
              ...(action ? { terminalAction: action } : {}),
              ...(latest ? {} : {}),
            }));
          }}
        />
      ) : null}
      {newTypeOpen ? (
        <NewTypeModal
          types={types}
          onClose={() => setNewTypeOpen(false)}
          onCreate={(payload) => {
            setNewTypeOpen(false);
            void run(async () => {
              const res = await fetch('/api/governance/event-types', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope, ...payload }),
              });
              const body = await res.json() as { ok?: boolean; type?: EventTypeView; error?: string };
              if (!res.ok || body.ok === false) throw new Error(body.error ?? `HTTP ${res.status}`);
              if (body.type) setSelectedTypeId(body.type.id);
              return `已创建类型「${body.type?.name}」（${body.type?.stages.length} 个阶段）`;
            });
          }}
        />
      ) : null}


      {/*
        关联文档 / 参考文档 → 右侧阅读抽屉（S-07 §3.3：复用 `ModuleDrawer`，不改组件本身）。
        key 含 group+name：切到另一篇会整块重挂载，正文、大纲、滚动位置不会串台。
        正文走 `/api/doc/get`（read 通道），导入/向量化期间不会被 MCP 写队列排队。
      */}
      {docTarget ? (
        <ModuleDrawer
          key={`${docTarget.group}/${docTarget.name}`}
          scope={scope}
          module={docTarget.name}
          group={docTarget.group}
          fetcher={getDocContent}
          onClose={() => setDocTarget(null)}
        />
      ) : null}

      {transOpen && active ? (
        <TransitionModal
          event={active}
          stages={type?.stages ?? []}
          currentKey={active.stageKey}
          busy={busy}
          onClose={() => setTransOpen(false)}
          onConfirm={(stage) => void run(async () => {
            const r = await setEventStage(scope, active.id, stage);
            const pending = r.pending.length > 0 ? `；索引重建中（${r.pending.join('/')}）` : '';
            return `已流转到「${r.to.name}」${r.closed ? '（已收口）' : ''}${pending}`;
          })}
        />
      ) : null}


      {addRefOpen && active ? (
        <DocPickerModal
          scope={scope}
          mode="ref"
          eventId={active.id}
          existing={refs}
          alsoPicked={detail?.members ?? []}
          busy={busy}
          onClose={() => setAddRefOpen(false)}
          onAdd={(docs) => void run(async () => {
            const r = await addRefs(scope, active.id, docs);
            const skipped = r.skipped.length > 0 ? `，跳过 ${r.skipped.length} 篇（已存在或不可用）` : '';
            return `已加入 ${r.added} 篇参考文档${skipped}`;
          })}
        />
      ) : null}

      {uploadRefOpen && active ? (
        <EventRefUploadModal
          scope={scope}
          eventId={active.id}
          refCount={refs.length}
          refLimit={REF_LIMIT}
          defaultGroupHint={`事件参考/${active.shortId}-${active.title.slice(0, 40)}`}
          onClose={() => {
            setUploadRefOpen(false);
            /**
             * 关窗也刷一次：用户可能在导入中途选「后台继续」，此时 `onFinished` 还没触发，
             * 不刷新会让列表看起来"什么都没发生"（真实结果要稍后才可见，属预期）。
             */
            void loadDetail(active.id);
          }}
          onFinished={(text, tone) => {
            // 导入落定即刷新：参考文档区与「N 篇」计数都要跟着变（R4）
            setMessage({ tone, text });
            void loadDetail(active.id);
            void loadList();
          }}
        />
      ) : null}

      {addMemberOpen && active ? (
        <DocPickerModal
          scope={scope}
          mode="member"
          eventId={active.id}
          existing={detail?.members ?? []}
          alsoPicked={refs}
          busy={busy}
          onClose={() => setAddMemberOpen(false)}
          onAdd={(docs) => void run(async () => {
            const r = await addMembers(scope, active.id, docs);
            setMemberVisWarn(
              r.visibilityFailed && r.visibilityFailed.length > 0
                ? `⚠ ${r.visibilityFailed.length} 篇索引未能摘除，仍可能被检索到（已记录诊断，可在诊断页重试）`
                : null,
            );
            const failed = r.failed.length > 0 ? `，${r.failed.length} 篇被拒：${r.failed[0].error}` : '';
            return `已挂上 ${r.bound.length} 篇关联文档${r.skipped.length > 0 ? `，跳过 ${r.skipped.length} 篇` : ''}${failed}`;
          })}
        />
      ) : null}

      {newEventOpen ? (
        <NewEventModal
          scope={scope}
          types={types}
          busy={busy}
          onClose={() => setNewEventOpen(false)}
          onCreate={(title, description, typeId, stageKey, docs, refDocs) => {
            setNewEventOpen(false);
            void run(async () => {
              // 起始阶段必须一并提交：后端缺省落首阶段，UI 的选择会被静默丢弃
              const res = await createEvent(scope, {
                title,
                ...(description ? { description } : {}),
                typeId,
                ...(stageKey ? { stageKey } : {}),
                ...(docs.length > 0 ? { docs } : {}),
                ...(refDocs.length > 0 ? { refs: refDocs } : {}),
              });
              if (res.event) selectEvent(res.event.id);
              const failed = res.binding.docs.failed.length + res.binding.refs.failed.length;
              return `已创建 #${res.event?.shortId} ${res.event?.title}`
                + `（关联 ${res.binding.docs.bound.length} 篇、参考 ${res.binding.refs.added} 篇${failed > 0 ? `，${failed} 项被拒` : ''}）`
                + (res.visibility.mode === 'hidden' ? '；当前阶段不可检索（预期行为）' : '');
            });
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * 追加阶段（demo 弹窗）
 *
 * 与 demo 的一处必要偏差：「进入时动作」在 demo 里挂在阶段行上，本实现是**类型级**字段
 * （DESIGN 缺口②：挂在阶段上时，追加一个阶段会让原终态动作静默失效）。
 * 因此这里只在「新阶段成为末位」时把它写进类型，并在弹窗里说明。
 */
function AddStageModal(args: {
  type: EventTypeView;
  busy: boolean;
  onClose: () => void;
  onSubmit: (name: string, visibility: Visibility, action: 'keep' | 'trash' | undefined) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [visibility, setVisibility] = useState<Visibility>('fts-only');
  const [action, setAction] = useState<'keep' | 'trash'>(args.type.terminalAction);
  const becomesTerminal = true; // 追加阶段总在末尾

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>追加阶段</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>
            类型「{args.type.name}」现有 {args.type.stages.length} 个阶段，新阶段将排在末尾
          </div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>阶段名称</span>
            <input
              className="gov-input"
              value={name}
              placeholder="如「已验证」"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="gov-field">
            <span>检索可见性</span>
            <div className="gov-seg" role="group" aria-label="检索可见性">
              {([
                ['full', '语义+全文'],
                ['fts-only', '仅全文'],
                ['hidden', '不可检索'],
              ] as Array<[Visibility, string]>).map(([value, label]) => (
                <button key={value} aria-pressed={visibility === value} onClick={() => setVisibility(value)}>{label}</button>
              ))}
            </div>
            <span className="gov-hint">决定这个阶段下的关联文档能否被 ki_search 召回。</span>
          </div>

          {becomesTerminal ? (
            <div className="gov-field">
              <span>进入时动作</span>
              <div className="gov-seg" role="group" aria-label="进入时动作">
                {([['keep', '保留在库'], ['trash', '移入回收站']] as Array<['keep' | 'trash', string]>).map(([value, label]) => (
                  <button key={value} aria-pressed={action === value} onClick={() => setAction(value)}>{label}</button>
                ))}
              </div>
              <span className="gov-hint">
                选「移入回收站」= 事件走到末位阶段时，关联文档自动进回收站（{7} 天内可恢复）。
                本实现把该动作记在**类型**上，避免以后追加阶段时把原动作覆盖掉。
              </span>
            </div>
          ) : null}

          <div className="gov-rowbox">
            <span className="gov-hint">
              阶段只能追加、不能删除：已有事件停在该阶段后，删除定义会留下悬空状态。要废弃请用「停用」。
            </span>
          </div>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || !name.trim()}
            onClick={() => args.onSubmit(name.trim(), visibility, becomesTerminal ? action : undefined)}
          >
            追加阶段
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * 流转（demo 的二次确认弹窗）：默认选中下一阶段，也可手选（含回退）。
 * 当前阶段不可选；停用阶段不可作为目标；选回已走过的阶段 = 回退，可见性一并回退。
 */
function TransitionModal(args: {
  event: EventView;
  stages: EventTypeView['stages'];
  currentKey: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: (key: string) => void;
}): JSX.Element {
  const curIdx = Math.max(0, args.stages.findIndex((s) => s.key === args.currentKey));
  const defaultTarget = (): string => {
    for (let i = curIdx + 1; i < args.stages.length; i += 1) {
      if (!args.stages[i].disabled) return args.stages[i].key;
    }
    return args.currentKey;
  };
  const [target, setTarget] = useState(defaultTarget);
  const same = target === args.currentKey;

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>流转事件</div>
          <div className="gov-hint">#{args.event.shortId} {args.event.title} · 当前「{args.stages[curIdx]?.name ?? '未知'}」</div>
        </div>
        <div className="gov-modal__body">
          <div className="gov-field">
            <span>流转到</span>
            <div className="gov-stage-picker" role="group" aria-label="选择目标阶段">
              {args.stages.map((s, i) => (
                <button
                  key={s.key}
                  type="button"
                  className="gov-stage-option"
                  aria-pressed={target === s.key}
                  disabled={s.key === args.currentKey || s.disabled}
                  onClick={() => setTarget(s.key)}
                >
                  <span className="gov-stage-option__dot" />
                  <span>{s.name}</span>
                  <span className="gov-stage-option__tag">
                    {s.key === args.currentKey ? '当前' : s.disabled ? '停用' : i === curIdx + 1 ? '下一步' : i < curIdx ? '回退' : ''}
                  </span>
                </button>
              ))}
            </div>
          </div>
          <span className="gov-hint">
            默认选中下一个阶段。选已走过的阶段等于<b>回退</b>，关联文档的检索可见性会一并回退。
          </span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || same}
            onClick={() => { args.onClose(); args.onConfirm(target); }}
          >
            {same ? '已在当前阶段' : '确认流转'}
          </button>
        </div>
      </div>
    </div>
  );
}


/** 筛选下拉（demo 的「类型 ▾」「未收口 ▾」）：按钮 + 浮层，不用原生 select */
function DropdownFilter(args: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // 点空白处收起（否则只能靠选中项关掉）
  useEffect(() => {
    if (!open) return;
    const close = (): void => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <span className="gov-dd">
      <button
        className="gov-btn gov-btn--sm"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
      >
        {args.label} ▾
      </button>
      {open ? (
        <span className="gov-dd__menu" onClick={(e) => e.stopPropagation()}>
          {args.options.map((o) => (
            <button
              key={o.value || 'all'}
              className={`gov-dd__item${o.value === args.value ? ' gov-dd__item--on' : ''}`}
              aria-selected={o.value === args.value}
              onClick={() => { args.onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </button>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** 新建事件（标题 + 可选描述 + 类型 chips + 起始阶段） */
function NewEventModal(args: {
  scope: string;
  types: EventTypeView[];
  busy: boolean;
  onClose: () => void;
  onCreate: (
    title: string,
    description: string | undefined,
    typeId: string,
    stageKey: string | undefined,
    docs: DocPickerRef[],
    refs: DocPickerRef[],
  ) => void;
}): JSX.Element {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [typeId, setTypeId] = useState(args.types[0]?.id ?? '');
  const current = args.types.find((t) => t.id === typeId) ?? args.types[0] ?? null;
  const [stageKey, setStageKey] = useState(current?.stages[0]?.key ?? '');
  const stage = current?.stages.find((st) => st.key === stageKey) ?? current?.stages[0] ?? null;
  /** 创建前预选的文档（事件还不存在，只能前端暂存，提交时一并带给后端） */
  const [pickedDocs, setPickedDocs] = useState<DocPickerRef[]>([]);
  const [pickedRefs, setPickedRefs] = useState<DocPickerRef[]>([]);
  const [picker, setPicker] = useState<'member' | 'ref' | null>(null);
  const VIS_TEXT: Record<Visibility, string> = { full: '语义+全文', 'fts-only': '仅全文', hidden: '不可检索' };

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>新建事件</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>
            事件把一批文档绑在一条处理链上，阶段决定它们能不能被检索到
          </div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>事件标题</span>
            <input className="gov-input" value={title} placeholder="如「登录页白屏」" onChange={(e) => setTitle(e.target.value)} />
          </label>

          <label className="gov-field">
            <span>事件描述（可选）</span>
            <textarea
              className="gov-textarea"
              rows={3}
              maxLength={4000}
              value={description}
              placeholder="现象、报错信息、复现路径等（会注入 AI 分析上下文）"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          <div className="gov-field">
            <span>事件类型</span>
            <div className="gov-seg" role="group" aria-label="事件类型">
              {args.types.map((t) => (
                <button
                  key={t.id}
                  aria-pressed={t.id === typeId}
                  onClick={() => {
                    setTypeId(t.id);
                    setStageKey(t.stages[0]?.key ?? '');
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
            <span className="gov-hint">类型决定阶段列表与每阶段的检索可见性。</span>
          </div>

          <div className="gov-field">
            <span>起始阶段</span>
            <div className="gov-rowbox">
              <select
                className="gov-select gov-inline-select"
                value={stageKey}
                onChange={(e) => setStageKey(e.target.value)}
              >
                {(current?.stages ?? []).map((st) => (
                  <option key={st.key} value={st.key} disabled={st.disabled}>
                    {st.name}{st.disabled ? '（停用）' : ''}
                  </option>
                ))}
              </select>
              <span className={`gov-vis gov-vis--${stage ? VIS_CLASS[stage.visibility] : 'hidden'}`}>
                <span className="gov-vis__dot" />
                {stage ? VIS_TEXT[stage.visibility] : '—'}
              </span>
              <span className="gov-rowbox__hint">
                {stage?.visibility === 'full' ? '新挂的文档可被语义检索' : '新挂的文档默认不参与语义检索'}
              </span>
            </div>
          </div>

          <div className="gov-field">
            <span>
              关联文档（可选）
              <span className="gov-hint" style={{ marginLeft: 8, fontWeight: 400 }}>挂到事件链路上，可见性随阶段变化</span>
            </span>
            {pickedDocs.map((d) => (
              <div className="gov-rowbox" key={`${d.group}/${d.name}`}>
                <span className="gov-cand__name">{d.name}</span>
                <span className="gov-cell-muted">{d.group}</span>
                <button
                  className="gov-btn gov-btn--ghost gov-btn--sm"
                  onClick={() => setPickedDocs((prev) => prev.filter((x) => !(x.group === d.group && x.name === d.name)))}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="gov-rowbox">
              <button className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => setPicker('member')}>
                ＋ 选择关联文档
              </button>
              <span className="gov-rowbox__hint">已选 {pickedDocs.length} 篇（单事件上限 50）</span>
            </div>
          </div>

          <div className="gov-field">
            <span>
              参考文档（可选）
              <span className="gov-hint" style={{ marginLeft: 8, fontWeight: 400 }}>只建立引用，不随阶段变化，也不改变文档分类</span>
            </span>
            {pickedRefs.map((d) => (
              <div className="gov-rowbox" key={`${d.group}/${d.name}`}>
                <span className="gov-cand__name">{d.name}</span>
                <span className="gov-cell-muted">{d.group}</span>
                <button
                  className="gov-btn gov-btn--ghost gov-btn--sm"
                  onClick={() => setPickedRefs((prev) => prev.filter((x) => !(x.group === d.group && x.name === d.name)))}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="gov-rowbox">
              <button className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => setPicker('ref')}>
                ＋ 选择参考文档
              </button>
              <span className="gov-rowbox__hint">已选 {pickedRefs.length} 条（单事件上限 50）</span>
            </div>
          </div>

          <span className="gov-hint">
            创建后仍可在详情里继续增删；事件收口时按终态动作决定关联文档保留还是移入回收站。
          </span>

          {picker ? (
            <DocPickerModal
              scope={args.scope}
              mode={picker}
              existing={picker === 'member' ? pickedDocs : pickedRefs}
              alsoPicked={picker === 'member' ? pickedRefs : pickedDocs}
              busy={args.busy}
              onClose={() => setPicker(null)}
              onAdd={(docs) => {
                if (picker === 'member') setPickedDocs((prev) => [...prev, ...docs]);
                else setPickedRefs((prev) => [...prev, ...docs]);
              }}
            />
          ) : null}
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={args.busy || !title.trim() || !typeId}
            onClick={() => args.onCreate(
              title.trim(),
              description.trim() || undefined,
              typeId,
              stageKey || undefined,
              pickedDocs,
              pickedRefs,
            )}
          >
            创建事件
          </button>
        </div>
      </div>
    </div>
  );
}


/** 新建事件类型（demo 弹窗：名称 + 回车加阶段 + 复用已有 + 终态动作） */
function NewTypeModal(args: {
  types: EventTypeView[];
  onClose: () => void;
  onCreate: (payload: { name: string; stages: Array<{ name: string; visibility: Visibility }>; terminalAction: 'keep' | 'trash' }) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [stages, setStages] = useState<Array<{ name: string; visibility: Visibility }>>([
    { name: '进行中', visibility: 'hidden' },
  ]);
  const [draft, setDraft] = useState('');
  const [reuseFrom, setReuseFrom] = useState('');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // 拖拽源用 ref：dragstart 与 drop 同 tick 触发，state 尚未刷新会读到 null
  const dragFrom = useRef<number | null>(null);
  const [action, setAction] = useState<'keep' | 'trash'>('keep');

  const VIS_TEXT: Record<Visibility, string> = { full: '语义+全文', 'fts-only': '仅全文', hidden: '不可检索' };
  const CYCLE: Visibility[] = ['hidden', 'fts-only', 'full'];

  const addStage = (): void => {
    const v = draft.trim();
    if (!v) return;
    setStages((prev) => [...prev, { name: v, visibility: 'hidden' }]);
    setDraft('');
  };

  const applyReuse = (id: string): void => {
    setReuseFrom(id);
    if (!id) return;
    const src = args.types.find((t) => t.id === id);
    if (!src) return;
    setStages(src.stages.map((st) => ({ name: st.name, visibility: st.visibility, })));
    setAction(src.terminalAction);
  };

  const moveStage = (from: number, to: number): void => {
    if (to < 0 || to >= stages.length) return;
    setStages((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const canSubmit = name.trim().length > 0 && stages.length >= 2;

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>新建事件类型</div>
          <div className="gov-hint" style={{ fontWeight: 400, marginTop: 2 }}>先建两条骨架阶段，创建后可逐个追加</div>
        </div>
        <div className="gov-modal__body">
          <label className="gov-field">
            <span>类型名称</span>
            <input
              className="gov-input"
              value={name}
              placeholder="如「线上事故」「技术调研」"
              onChange={(e) => setName(e.target.value)}
            />
          </label>

          <div className="gov-field">
            <span>阶段（按回车逐个添加，可拖动排序）</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {stages.map((st, i) => (
                <span
                  key={`${st.name}-${i}`}
                  className="gov-badge gov-badge--kb"
                  draggable
                  onDragStart={() => { dragFrom.current = i; setDragIndex(i); }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    const from = dragFrom.current;
                    if (from === null || from === i) return;
                    moveStage(from, i);
                    dragFrom.current = null;
                    setDragIndex(null);
                  }}
                  onDragEnd={() => { dragFrom.current = null; setDragIndex(null); }}
                  style={{ gap: 6, cursor: 'grab', opacity: dragIndex === i ? 0.45 : 1 }}
                  title="按住拖动可调整阶段顺序"
                >
                  {i + 1} {st.name}
                  {i === stages.length - 1 ? <span style={{ fontSize: 10 }}>终态</span> : null}
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    title={`点击循环切换可见性（当前：${VIS_TEXT[st.visibility]}）`}
                    onClick={() => setStages((prev) => prev.map((item, idx) => idx === i
                      ? { ...item, visibility: CYCLE[(CYCLE.indexOf(item.visibility) + 1) % CYCLE.length] }
                      : item))}
                  >
                    ●
                  </button>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    disabled={i === 0}
                    title="前移"
                    onClick={() => moveStage(i, i - 1)}
                  >
                    ←
                  </button>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    disabled={i === stages.length - 1}
                    title="后移"
                    onClick={() => moveStage(i, i + 1)}
                  >
                    →
                  </button>
                  <button
                    className="gov-btn gov-btn--ghost gov-btn--sm"
                    style={{ padding: '0 4px' }}
                    disabled={stages.length <= 1}
                    onClick={() => setStages((prev) => prev.filter((_, idx) => idx !== i))}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
            <input
              className="gov-input"
              value={draft}
              placeholder="输入阶段名后按回车，如「排查中」"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addStage();
                }
              }}
            />
            <span className="gov-hint">
              先输入的排最前，最后一条自动为「终态」。点圆点按下面三档循环切换：
              &nbsp;● 语义+全文　○ 仅全文　○ 不可检索
            </span>
            <span className="gov-hint">决定这个阶段下的文档能否被 ki_search 召回。</span>
          </div>

          <label className="gov-field">
            <span>复用已有类型的阶段</span>
            <select className="gov-select" value={reuseFrom} onChange={(e) => applyReuse(e.target.value)}>
              <option value="">不复用，自己录入</option>
              {args.types.map((t) => <option key={t.id} value={t.id}>复制「{t.name}」的 {t.stages.length} 个阶段</option>)}
            </select>
            <span className="gov-hint">复用是复制一份副本，此后两边各改各的；源类型后续调整阶段，不会影响这个新类型。</span>
          </label>

          <div className="gov-field">
            <span>终态动作（最后一阶段）</span>
            <div className="gov-seg" role="group" aria-label="终态动作">
              {([['keep', '保留在库'], ['trash', '移入回收站']] as Array<['keep' | 'trash', string]>).map(([v, label]) => (
                <button key={v} aria-pressed={action === v} onClick={() => setAction(v)}>{label}</button>
              ))}
            </div>
            <span className="gov-hint">
              选「移入回收站」= 事件走到终态时，关联文档自动进回收站（7 天内可恢复）。
            </span>
          </div>

          <span className="gov-hint">
            新建类型后，它会出现在事件列表的「类型」筛选里；事件可随时切换类型，已有相关文档不受影响。
          </span>
        </div>
        <div className="gov-modal__foot">
          <button className="gov-btn gov-btn--sm" onClick={args.onClose}>取消</button>
          <button
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={!canSubmit}
            onClick={() => args.onCreate({ name: name.trim(), stages, terminalAction: action })}
          >
            创建类型
          </button>
        </div>
      </div>
    </div>
  );
}
