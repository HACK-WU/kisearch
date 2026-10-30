/**
 * DataSourcePage —— 数据源列表 + 右侧详情面板（REQ-20261020-001）
 *
 * 信息架构（2026-10-21 用户定稿）：
 *  - 主区是**全宽列表**（不再用左右分栏）：Scope / 源目录 / 落点 / 上次同步 / 状态 / 待删
 *  - 点击某行 → 右侧面板展示该数据源上一次同步详情 + 待删段（URL `/datasource/:scope`，可分享/刷新恢复）
 *  - 写动作只有三个，语义必须分清（2026-10-29 新增第三个）：
 *      ① 行内「同步」= 触发同步   ② 面板「删除所选」= 删**库内文档**（待删候选）
 *      ③ 行内「移除」= 取消**数据源登记**（库内文档保留，见 removeDataSource）
 *    「移除」是破坏性操作：必须二次确认，且同步/添加任务进行中一律禁用（服务端 409 兜底）。
 *  - **面板是模态浮层**（V5，2026-10-22 用户定稿）：宽度 70vw + 左侧遮罩压暗 ⇒ 点遮罩/外部关闭。
 *    历史：V3 曾定「非模态不铺遮罩」，V5 按用户要求加回遮罩；不要再按 V3 结论去掉。
 *  - **列表不再自带卡片标题**（PM 走查）：页面身份由顶栏 H1 唯一承载，总数在页头副标题；
 *    原先卡片头重复了一次「数据源」又把「共 N 个」数了两遍。想加回标题前先确认这两处仍在。
 *  - loading / error / empty 三者互斥（见下方卡内分支）：同屏出现「加载失败」与「还没有数据源」
 *    会把读取故障伪装成"用户没登记过"。
 *  - **不再展示"未登记的历史导入目录"**（用户 2026-10-21 决定删除该逻辑）：页面只列已登记数据源。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSourceDetail, useDataSourceList, useScopeList } from '@/lib/hooks';
import { useScopeValue } from '@/lib/scopeContext';
// upstream 侧新增定时设置视图（DataSourceScheduleView），本地侧新增移除接口（removeDataSource）
import { addRemoteDataSource, getDataSourceDetail, getDocContent, pruneDataSource, removeDataSource, syncDataSource, type DataSourcePendingItem, type DataSourceRecordView, type DataSourceScheduleView } from '@/api/httpApi';
import { getTask } from '@/api/tasksApi';
import { DatasourceScheduleDialog } from '@/components/DatasourceScheduleDialog';
import { DatasourceEditDialog } from '@/components/DatasourceEditDialog';
import { describeSchedule, scheduleBadge, scheduleNextLine } from '@/lib/datasourceSchedule';
import {
  buildDataSourceDetail,
  buildDataSourceListSummary,
  buildDataSourcePendingTree,
  dataSourceStatusView,
  formatSyncDuration,
  resolveDataSourceActiveState,
  type DataSourcePendingTreeNode,
} from '@/lib/dataSourceDetailModel';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { Notice } from '@/components/Notice';
import { DetailDrawer, DetailSection, DetailStatus } from '@/components/DetailDrawer';
import { ReadOnlyPathTree } from '@/components/ReadOnlyPathTree';
import { DetailHero, DetailMetrics, DetailParams } from '@/components/DetailParts';
import { Icon } from '@/components/icons';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { ScopePathSelect } from '@/components/ScopePathSelect';

const keyOf = (item: { group: string; relation: string }): string => `${item.group}\u0000${item.relation}`;

/**
 * 待移除的数据源：正常登记来自列表行；`corrupt` 来自损坏提示（列表里没有这一行、记录也无法解析）。
 * ★ corrupt 必须带 `corrupt` 原因走 `force` 分支，否则后端按 CORRUPT 拒绝 —— 坏文件解析不了，
 *   这里是它唯一的清理出口（CLI `remove` 同样拒绝解析坏登记）。
 */
interface RemoveTarget {
  scope: string;
  type?: 'directory' | 'git';
  dir?: string;
  lastSyncAt?: number | null;
  managed?: boolean;
  corrupt?: string;
}

const PAGE_SIZE_DEFAULT = 10;

/** 失败明细默认展示条数；超出折叠，展开后由 CSS 限高滚动 */
const FAILURE_PREVIEW = 5;

const FOLDER_ICON = (
  <svg
    className="ki-tree-icon"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M1.6 3.7c0-.6.5-1.1 1.1-1.1h2.9l1.6 1.7h5.7c.6 0 1.1.5 1.1 1.1v6.9c0 .6-.5 1.1-1.1 1.1H2.7c-.6 0-1.1-.5-1.1-1.1V3.7z" />
  </svg>
);

/** 目录节点下的全部候选（整组勾选 / 状态统计共用） */
function collectItems(node: DataSourcePendingTreeNode): DataSourcePendingItem[] {
  if (node.kind === 'file') return node.item ? [node.item] : [];
  return node.children.flatMap(collectItems);
}

/** 所有目录路径（「折叠全部」用） */
function allDirPaths(nodes: DataSourcePendingTreeNode[]): string[] {
  const paths: string[] = [];
  const walk = (list: DataSourcePendingTreeNode[]): void => {
    for (const node of list) {
      if (node.kind !== 'dir') continue;
      paths.push(node.path);
      walk(node.children);
    }
  };
  walk(nodes);
  return paths;
}

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function GroupCheckbox({ checked, indeterminate, disabled, onChange, label }: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
    />
  );
}

export function DataSourcePage(): JSX.Element {
  const { scope } = useParams<{ scope?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const listQuery = useDataSourceList();
  const detailQuery = useDataSourceDetail(scope ?? null);
  const currentScope = useScopeValue();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  // 待删树：折叠的目录（空 = 全部展开）、失败明细是否展开全部、正在查看正文的候选
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [showAllFailures, setShowAllFailures] = useState(false);
  const [docTarget, setDocTarget] = useState<DataSourcePendingItem | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [syncingScope, setSyncingScope] = useState<string | null>(null);
  // 行级操作结果条（同步 / 移除数据源共用同一位置，避免两套提示抢位）
  const [rowNotice, setRowNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  /**
   * 行内「编辑」结果条（同步参数 / 定时同步）与「缺失登记」的定时弹窗结果都落这里。
   * ★ 与 rowNotice 并存而非合并：保存完成要留下"改了什么 / 下次何时运行"，
   *   而行内「同步 / 移除」刚产生的提示不该被它顶掉；两条分别渲染（见下方两段 notice）。
   */
  const [rowSyncNotice, setRowSyncNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ scope: '', url: '', branch: '', subdir: '', group: '' });
  const [addScopeConfirmed, setAddScopeConfirmed] = useState(false);
  /** 「新建 Scope」模式才提供「创建为只读库」；已有 scope 只展示状态（改只读走 CLI） */
  const [addScopeMode, setAddScopeMode] = useState<'existing' | 'new'>('existing');
  const [addReadonly, setAddReadonly] = useState(false);
  const [addState, setAddState] = useState<{
    phase: 'idle' | 'submitting' | 'cloning' | 'done';
    taskId?: string;
    progress?: number;
    error?: string;
    notice?: string;
    noticeWarn?: boolean;
  }>({ phase: 'idle' });
  const scopeRef = useRef<string | undefined>(scope);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const addDialogRef = useRef<HTMLElement>(null);
  const addWasOpenRef = useRef(false);
  const [scheduleTarget, setScheduleTarget] = useState<{
    scope: string;
    schedule?: DataSourceScheduleView;
    schedulerDisabled?: boolean;
  } | null>(null);
  const scheduleTriggerRef = useRef<HTMLElement | null>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const lastScopeRef = useRef<string | null>(null);
  // 移除数据源登记（2026-10-29）：行内入口 / 损坏提示入口共用同一个确认弹窗
  const [removeTarget, setRemoveTarget] = useState<RemoveTarget | null>(null);
  const [removePurge, setRemovePurge] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removeDialogRef = useRef<HTMLElement>(null);
  /** 移除成功后行已消失：焦点要落在结果提示上，不能掉到 body（键盘用户会丢失位置） */
  const rowNoticeRef = useRef<HTMLParagraphElement>(null);
  // 确认框里的「库内文档 N 篇」：走已缓存的 scope 列表，不为弹窗单独打接口
  const scopeListQuery = useScopeList();
  // 编辑数据源（2026-10-30）：列表行不带切分参数 / 修订号，点开时按 scope 拉详情
  const [editTarget, setEditTarget] = useState<{ record: DataSourceRecordView } | null>(null);
  const [editLoadingScope, setEditLoadingScope] = useState<string | null>(null);
  // 能力声明：旧 daemon 不返回 ⇒ 隐藏「编辑」与只读开关（而不是让人填完再报错）
  const canUpdateDatasource = listQuery.data?.capabilities?.datasourceUpdate === true;
  const canSetReadonly = listQuery.data?.capabilities?.scopeReadonly === true;
  const selectedScopeReadonly = scopeListQuery.data?.scopes
    .find((item) => item.scope === addForm.scope.trim())?.readonly === true;

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    if (addOpen) {
      addWasOpenRef.current = true;
      // 只聚焦弹窗容器：聚焦 Scope 输入框会触发它的 onFocus 自动展开列表
      const timer = window.setTimeout(() => addDialogRef.current?.focus(), 0);
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setAddOpen(false);
      };
      window.addEventListener('keydown', onKey);
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener('keydown', onKey);
      };
    }
    if (addWasOpenRef.current) {
      addWasOpenRef.current = false;
      requestAnimationFrame(() => addTriggerRef.current?.focus());
    }
    return undefined;
  }, [addOpen]);

  useEffect(() => {
    setSelected(new Set());
    setConfirming(false);
    setSubmitting(false);
    setError(null);
    setReceipt(null);
    setSyncingScope(null);
    setRowNotice(null);
    setCollapsedDirs(new Set());
    setShowAllFailures(false);
    setDocTarget(null);
    setRemoveTarget(null);
    setRemoveError(null);
    setRemoving(false);
  }, [scope]);

  // 关闭抽屉后把焦点还给打开它的行（否则焦点掉到 body）
  useEffect(() => {
    if (scope) {
      lastScopeRef.current = scope;
      return;
    }
    const last = lastScopeRef.current;
    if (!last) return;
    lastScopeRef.current = null;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-ds-scope="${CSS.escape(last)}"]`)?.focus();
    });
  }, [scope]);

  // Esc 关闭抽屉（与站内其他浮层同口径）；添加弹窗 / 移除弹窗 / 文档抽屉打开时由它们独占 Esc，
  // 否则一次 Esc 会把文档抽屉和数据源详情一起关掉
  useEffect(() => {
    if (!scope || addOpen || docTarget || removeTarget) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') navigate('/datasource');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scope, navigate, addOpen, docTarget, removeTarget]);

  // 移除确认弹窗：打开时聚焦容器、Esc 关闭（移除进行中不响应，避免"关了但请求还在跑"）
  useEffect(() => {
    if (!removeTarget) return undefined;
    const timer = window.setTimeout(() => removeDialogRef.current?.focus(), 0);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || removing) return;
      setRemoveTarget(null);
      setRemoveError(null);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [removeTarget, removing]);

  // 旧 daemon 只返回 running：统一在这里归一，避免 `undefined !== null` 把空闲判成进行中
  const activeState = resolveDataSourceActiveState(detailQuery.data?.activeState, detailQuery.data?.running);
  const active = activeState !== null;
  const availability = detailQuery.data?.syncAvailability;
  const detailSchedule = detailQuery.data?.source.schedule;
  const model = useMemo(
    () => (detailQuery.data
      ? buildDataSourceDetail(detailQuery.data.source, {
        activeState,
        activeStartedAt: detailQuery.data.activeStartedAt,
      })
      : null),
    [detailQuery.data, activeState],
  );
  // 待删候选 → 目录树（group 段 + sourcePath 目录段合并，见 buildDataSourcePendingTree）
  const pendingTree = useMemo(
    () => buildDataSourcePendingTree(model?.pending.items ?? []),
    [model?.pending.items],
  );

  /** 待删除段常显：无候选时也要给一句说明（否则用户以为功能消失） */
  const pendingEmpty = model ? model.pending.total === 0 && !model.pending.blocked : false;

  const lastSync = detailQuery.data?.source.lastSync ?? null;
  const whenLabel = lastSync
    ? `上次同步 ${formatDateTime(lastSync.at)} · 用时 ${formatSyncDuration(lastSync.durationMs)}`
    : '尚未同步过';


  const toggleDir = (path: string): void => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  };

  /** 目录勾选：作用于该目录下**所有层级**的候选；子项状态由后代统计得出 */
  const toggleNodeItems = (node: DataSourcePendingTreeNode): void => {
    const items = collectItems(node);
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = items.length > 0 && items.every((item) => next.has(keyOf(item)));
      for (const item of items) {
        if (allSelected) next.delete(keyOf(item));
        else next.add(keyOf(item));
      }
      return next;
    });
  };

  const renderPendingNode = (node: DataSourcePendingTreeNode): JSX.Element => {
    if (node.kind === 'file') {
      const item = node.item;
      const key = item ? keyOf(item) : node.path;
      // 2026-10-29 用户要求：点整行 = 看正文（与「新增的文档」一致）；勾选只认复选框
      return (
        <div
          key={node.path}
          className={`ki-tree-doc${item ? ' ki-tree-doc--clickable' : ''}`}
          role={item ? 'button' : undefined}
          tabIndex={item ? 0 : undefined}
          title={item ? '查看内容' : undefined}
          onClick={item ? () => setDocTarget(item) : undefined}
          onKeyDown={item ? (event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            setDocTarget(item);
          } : undefined}
        >
          <span className="ki-tree-arrow" aria-hidden="true" />
          <input
            type="checkbox"
            className="ki-ds-check"
            checked={item ? selected.has(key) : false}
            disabled={!selectable || !item}
            onChange={() => { if (item) toggleOne(item); }}
            // 复选框在可点行内：不拦住冒泡会把「勾选」也当成「打开正文」
            onClick={(event) => event.stopPropagation()}
            aria-label={`选择 ${node.name}`}
          />
          <Icon name="file" className="ki-icon ki-icon--sm" />
          <span className="ki-tree-doc__name">{node.name}</span>
        </div>
      );
    }
    const open = !collapsedDirs.has(node.path);
    const items = collectItems(node);
    const picked = items.filter((item) => selected.has(keyOf(item))).length;
    const countText = node.direct > 0 && node.direct !== node.total
      ? `${node.direct} / ${node.total}`
      : String(node.total);
    return (
      <div key={node.path}>
        <div
          className={`ki-tree-dir${open ? ' ki-tree-dir--open' : ''}`}
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={`${node.name}，共 ${node.total} 篇`}
          title={node.path}
          onClick={(event) => {
            if ((event.target as Element).closest('input')) return;
            toggleDir(node.path);
          }}
          onKeyDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            toggleDir(node.path);
          }}
        >
          <button
            type="button"
            className="ki-tree-arrow"
            tabIndex={-1}
            aria-hidden="true"
            onClick={(event) => { event.stopPropagation(); toggleDir(node.path); }}
          >{open ? '▾' : '▸'}</button>
          <input
            type="checkbox"
            className="ki-ds-check"
            checked={items.length > 0 && picked === items.length}
            ref={(element) => { if (element) element.indeterminate = picked > 0 && picked < items.length; }}
            disabled={!selectable || items.length === 0}
            onChange={() => toggleNodeItems(node)}
            aria-label={`全选 ${node.path}`}
          />
          {FOLDER_ICON}
          <span className="ki-tree-dir__label">{node.name}</span>
          <span className="ki-cell-sub">{countText}</span>
        </div>
        {open ? <div className="ki-tree-group">{node.children.map(renderPendingNode)}</div> : null}
      </div>
    );
  };

  // 点抽屉外部自动关闭（2026-10-22 用户要求 V4）。例外：抽屉内部、列表行（切换数据源）、
  // 添加弹窗、文档抽屉（ModuleDrawer 自带遮罩）、AI 面板（浮层，不是"页面空白"）。
  useEffect(() => {
    if (!scope) return undefined;
    const onDocClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.ki-detail')) return;
      if (target.closest('.ki-ds-table__row')) return;
      if (target.closest('.ki-overlay')) return;
      if (target.closest('.ki-drawer')) return;
      // 文档抽屉的遮罩是 .ki-drawer 的**兄弟**，不排除的话点它关文档时会把详情页一起带走
      if (target.closest('.ki-drawer__scrim')) return;
      if (target.closest('.ki-chat')) return;
      navigate('/datasource');
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [scope, navigate]);

  const sources = listQuery.data?.sources ?? [];
  const missing = listQuery.data?.missing ?? [];
  const corrupt = listQuery.data?.corrupt ?? [];
  const total = sources.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageSources = sources.slice((page - 1) * pageSize, page * pageSize);
  // 失败时不得再报「加载中…」：该文案会一直挂着，与卡内的失败提示自相矛盾。
  const listSummary = listQuery.isError
    ? '数据源列表读取失败'
    : listQuery.data ? buildDataSourceListSummary(listQuery.data.total, sources) : '加载中…';
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const selectable = model !== null && !active && !model.pending.blocked && model.pending.items.length > 0;
  const visibleItems = model?.pending.items ?? [];
  const selectedCount = selected.size;
  const ratio = model && model.pending.eligibleCount > 0
    ? Math.round((selectedCount / model.pending.eligibleCount) * 1000) / 10
    : null;

  // 外部（CLI / 另一标签页）启动同步时 selectable 变 false：收起已打开的确认条，
  // 否则「确认删除」只剩 submitting 一道拦截，能在同步进行中被点下去。
  useEffect(() => {
    if (confirming && !selectable) setConfirming(false);
  }, [confirming, selectable]);

  // 数据刷新后（删除成功 / 同步完成）清掉已不在候选里的勾选
  useEffect(() => {
    const visibleKeys = new Set((model?.pending.items ?? []).map(keyOf));
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => visibleKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [model?.pending.items]);

  const toggleOne = (item: DataSourcePendingItem): void => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const key = keyOf(item);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = (): void => {
    setConfirming(false);
    setSelected((prev) => {
      if (prev.size >= visibleItems.length) return new Set();
      return new Set(visibleItems.map(keyOf));
    });
  };

  const runPrune = async (): Promise<void> => {
    if (!model || !scope || submitting) return;
    // 确认条打开后同步可能被外部启动：提交前再判一次，避免与本次扫描竞争
    if (!selectable) {
      setError('当前不可删除候选（同步进行中或候选已失效）。');
      setConfirming(false);
      return;
    }
    const runScope = scope;
    if (!model.pending.token) {
      setError('没有可用的候选凭证，请重新同步后再试。');
      setConfirming(false);
      return;
    }
    const selectedItems = visibleItems
      .filter((item) => selected.has(keyOf(item)))
      .map((item) => ({ group: item.group, relation: item.relation }));
    if (selectedItems.length === 0) {
      setError('请先勾选要删除的文档。');
      setConfirming(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await pruneDataSource({ scope: runScope, token: model.pending.token, selected: selectedItems });
      if (scopeRef.current !== runScope) return;
      setReceipt(`已删除 ${result.deleted} 篇${result.failed > 0 ? `，失败 ${result.failed} 篇` : ''}；剩余 ${result.pendingDelete.total} 篇`);
      setSelected(new Set());
      setConfirming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', runScope] }),
        queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
        queryClient.invalidateQueries({ queryKey: ['docList'] }),
      ]);
      requestAnimationFrame(() => closeBtnRef.current?.focus());
    } catch (err) {
      if (scopeRef.current !== runScope) return;
      const e = err as Error & { status?: number; body?: { code?: string; error?: string; skipDetail?: string } };
      if (e.status === 409) {
        // 409 有两种：候选失效（需重新同步）/ 重算后闸门拦截（附 skipDetail）
        setError(e.body?.code === 'PRUNE_BLOCKED'
          ? `未生成候选：${e.body?.skipDetail ?? e.body?.error ?? '请稍后重试'}`
          : `源目录已变化，当前候选已失效。本页不能触发同步，请在命令行执行：ki datasource sync --scope ${runScope} 后重试。`);
        // 重新拉详情：让页面拿到最新的 blocked/stale 状态（不再显示旧 token 的假象）
        await queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', runScope] });
      } else {
        setError(`删除失败：${e.message}`);
      }
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  const triggerSync = async (targetScope: string, full = false): Promise<void> => {
    if (syncingScope !== null) return;
    setSyncingScope(targetScope);
    setRowNotice(null);
    try {
      const result = await syncDataSource({ scope: targetScope, full });
      const message = `已提交${result.mode === 'full' ? '全量' : '增量'}同步（${targetScope}，任务 ${result.taskId.slice(0, 8)}）`;
      setRowNotice({ tone: 'info', text: message });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', targetScope] }),
        queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
        queryClient.invalidateQueries({ queryKey: ['docList'] }),
        // 修复：顶栏徽章按 ['tasks'] 轮询，提交后不失效会滞后最多 15s
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
      ]);
    } catch (err) {
      const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
      let message: string;
      if (e.status === 429) message = e.body?.error ?? '同步过于频繁，请稍后再试';
      else if (e.status === 409) message = e.body?.error ?? '已有同步任务在排队或执行中';
      else if (e.status === 403) message = '没有该知识库的同步权限';
      else message = `同步失败：${e.message}`;
      setRowNotice({ tone: 'warn', text: message });
      await queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', targetScope] });
    } finally {
      setSyncingScope(null);
    }
  };

  const openSchedule = (
    targetScope: string,
    schedule: DataSourceScheduleView | undefined,
    trigger: HTMLElement | null,
  ): void => {
    scheduleTriggerRef.current = trigger;
    setScheduleTarget({
      scope: targetScope,
      ...(schedule ? { schedule } : {}),
      schedulerDisabled: listQuery.data?.schedulerDisabled,
    });
  };

  // 编辑入口：先拉详情（含切分参数 / revision），成功后再开弹窗
  const openEdit = async (targetScope: string): Promise<void> => {
    if (editLoadingScope !== null) return;
    setEditLoadingScope(targetScope);
    try {
      const detail = await getDataSourceDetail(targetScope);
      setEditTarget({ record: detail.source });
    } catch (err) {
      const e = err as Error & { status?: number; body?: { error?: string } };
      setRowSyncNotice({
        tone: 'warn',
        text: e.status === 404
          ? `读取 ${targetScope} 配置失败：数据源不存在（可能已被移除）`
          : `读取 ${targetScope} 配置失败：${e.body?.error ?? e.message}`,
      });
    } finally {
      setEditLoadingScope(null);
    }
  };

  // 关闭编辑弹窗：焦点归还触发按钮（键盘用户不丢位置，与移除弹窗同口径）
  const closeEdit = (targetScope: string): void => {
    setEditTarget(null);
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-ds-edit="${CSS.escape(targetScope)}"]`)?.focus();
    });
  };

  const closeSchedule = (): void => {
    setScheduleTarget(null);
    const trigger = scheduleTriggerRef.current;
    scheduleTriggerRef.current = null;
    if (trigger) requestAnimationFrame(() => trigger.focus());
  };

  // ── 移除数据源登记（2026-10-29）────────────────────────
  const openRemove = (target: RemoveTarget): void => {
    setRemoveTarget(target);
    // 托管 clone 默认随登记一起删（工具自有目录，登记一删即成死数据）；引用计数在后端兜底
    setRemovePurge(target.managed === true);
    setRemoveError(null);
  };

  const closeRemove = (): void => {
    if (removing) return;
    setRemoveTarget(null);
    setRemoveError(null);
  };

  // 「库内文档 N 篇」来自已缓存的 scope 列表（不为此单独打接口）；取不到时显示「—」
  const removeDocCount = removeTarget
    ? scopeListQuery.data?.scopes.find((item) => item.scope === removeTarget.scope)?.wikiCount
    : undefined;

  const submitRemove = async (): Promise<void> => {
    const target = removeTarget;
    if (!target || removing) return;
    setRemoving(true);
    setRemoveError(null);
    try {
      const result = await removeDataSource({
        scope: target.scope,
        ...(target.corrupt ? { force: true } : {}),
        ...(!target.corrupt && removePurge && target.managed ? { purge: true } : {}),
      });
      setRemoveTarget(null);
      // 详情抽屉正开着被移除的 scope：直接回列表，别停在已失效的详情上
      if (scope === target.scope) navigate('/datasource');
      const kept = target.corrupt
        ? ''
        : removeDocCount !== undefined
          ? `，库内 ${removeDocCount} 篇文档保留`
          : '，库内文档保留';
      const clone = result.cloneRemoved
        ? '；托管 clone 已删除'
        : result.cloneRemoveSkipped
          ? `；${result.cloneRemoveReason ?? '托管 clone 仍被其他 scope 使用，已保留'}`
          // 失败必须带目录：否则用户不知道去哪手工清理（后端有下发 managedCloneDir）
          : result.cloneRemoveError
            ? `；托管 clone 未删除，请手动清理 ${result.managedCloneDir ?? '托管目录'}：${result.cloneRemoveError}`
            : '';
      setRowNotice({
        tone: result.cloneRemoveError ? 'warn' : 'info',
        text: result.removed
          ? `已移除 ${target.scope} 的数据源登记${kept}${clone}`
          : `${target.scope} 的数据源登记已不存在（可能在别处已移除）`,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
        queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', target.scope] }),
        queryClient.invalidateQueries({ queryKey: ['docList'] }),
        queryClient.invalidateQueries({ queryKey: ['scopeList'] }),
      ]);
      requestAnimationFrame(() => {
        // 成功移除后该行已不存在 → 焦点交给结果提示；失败（409/404）行还在 → 还原到原按钮
        const trigger = document.querySelector<HTMLElement>(`[data-ds-remove="${CSS.escape(target.scope)}"]`);
        if (trigger) trigger.focus();
        else rowNoticeRef.current?.focus();
      });
    } catch (err) {
      const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
      let message: string;
      if (e.status === 409 && e.body?.code === 'DATASOURCE_BUSY') {
        message = e.body?.error ?? '该数据源正在同步或添加，任务结束后再移除';
      } else if (e.status === 409) message = e.body?.error ?? '该知识库正在写入，请稍后再试';
      else if (e.status === 404) message = '该数据源登记已不存在（可能在别处已移除）';
      else if (e.status === 403) message = '没有该知识库的操作权限';
      else message = e.body?.error ?? `移除失败：${e.message}`;
      setRemoveError(message);
      // 409/404 多由别处已并发操作的现实状态导致：刷新列表，别让页面停在旧数据上
      await queryClient.invalidateQueries({ queryKey: ['dataSourceList'] });
    } finally {
      setRemoving(false);
    }
  };

  // ── S-05：页面添加 Git URL 数据源 ──────────────────────
  const addBusy = addState.phase === 'submitting' || addState.phase === 'cloning';

  useEffect(() => {
    if (addState.phase !== 'cloning' || !addState.taskId) return undefined;
    const taskId = addState.taskId;
    let cancelled = false;
    let failures = 0;
    const tick = async (): Promise<void> => {
      try {
        const { task } = await getTask(taskId);
        if (cancelled) return;
        failures = 0;
        if (task.state === 'queued' || task.state === 'running' || task.state === 'unknown') {
          const progress = task.progress && task.progress.total > 0
            ? Math.min(100, Math.round((task.progress.done / task.progress.total) * 100))
            : undefined;
          setAddState((prev) => (prev.phase === 'cloning' ? { ...prev, progress } : prev));
          return;
        }
        if (task.state === 'succeeded') {
          const syncTaskId = task.result?.syncTaskId ?? null;
          // 只读写失败不回滚登记：必须用警告语气显式告诉用户"只读没设上"
          const readonlyWarning = task.result?.readonlyWarning;
          const targetScope = task.scope;
          setAddState({
            phase: 'done',
            noticeWarn: Boolean(readonlyWarning),
            notice: readonlyWarning
              ? `已登记 ${targetScope}；${readonlyWarning}`
              : syncTaskId
                ? `已登记 ${targetScope}；首次全量同步已入队（任务 ${syncTaskId.slice(0, 8)}）`
                : `已登记 ${targetScope}；首次同步入队失败，请执行 ki datasource sync --scope ${targetScope}`,
          });
          setAddOpen(false);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
            queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', targetScope] }),
          ]);
          navigate(`/datasource/${encodeURIComponent(targetScope)}`);
          return;
        }
        const detail = task.error ?? '添加失败';
        const code = task.result?.errorCode ? `（${task.result.errorCode}）` : '';
        setAddState({ phase: 'idle', error: `${detail}${code}${task.recoveryHint ? `；${task.recoveryHint}` : ''}` });
      } catch (err) {
        if (cancelled) return;
        failures += 1;
        // daemon 重启 / 任务 1h TTL 到期：任务可能已不存在，不能无限显示「克隆中」
        const e = err as Error & { status?: number };
        if (e.status === 404 || failures >= 3) {
          setAddState({
            phase: 'idle',
            error: '无法读取添加任务状态（可能 daemon 已重启或任务已过期）；请刷新页面确认是否已登记，必要时执行 ki datasource remove --scope <scope> --purge --yes 后重试',
          });
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [addState.phase, addState.taskId, navigate, queryClient]);

  const submitAdd = async (): Promise<void> => {
    if (addBusy) return;
    const targetScope = addForm.scope.trim();
    const url = addForm.url.trim();
    if (!targetScope) {
      setAddState({ phase: 'idle', error: '请选择要登记到的 scope' });
      return;
    }
    if (!url) {
      setAddState({ phase: 'idle', error: '请填写 Git 仓库地址' });
      return;
    }
    setAddState({ phase: 'submitting' });
    try {
      const result = await addRemoteDataSource({
        scope: targetScope,
        url,
        ...(addForm.branch.trim() ? { branch: addForm.branch.trim() } : {}),
        ...(addForm.subdir.trim() ? { subdir: addForm.subdir.trim() } : {}),
        group: addForm.group.trim() || null,
        ...(addReadonly && addScopeMode === 'new' ? { readonly: true } : {}),
      });
      setAddState({ phase: 'cloning', taskId: result.taskId });
    } catch (err) {
      const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
      let message: string;
      if (e.status === 403) message = '没有该知识库的操作权限';
      else if (e.status === 404) message = '当前 daemon 不支持页面添加 Git 数据源，请升级并重启 daemon';
      else message = e.body?.error ?? `添加失败：${e.message}`;
      setAddState({ phase: 'idle', error: message });
    }
  };

  return (
    <div className={`ki-datasource-page${scope ? ' ki-datasource-page--drawer' : ''}`}>
      <div className="ki-page-head">
        <div>
          <p>{listSummary}</p>
        </div>
        <button
          type="button"
          ref={addTriggerRef}
          className="ki-btn ki-btn--secondary"
          aria-haspopup="dialog"
          aria-expanded={addOpen}
          onClick={() => {
            setAddForm({ scope: '', url: '', branch: '', subdir: '', group: '' });
            setAddScopeConfirmed(false);
            setAddScopeMode('existing');
            setAddReadonly(false);
            setAddState({ phase: 'idle' });
            setAddOpen(true);
          }}
        >添加 Git 数据源</button>
      </div>

      {addState.notice ? (
        <p className={`ki-task-notice ki-task-notice--${addState.noticeWarn ? 'warn' : 'info'}`}>{addState.notice}</p>
      ) : null}
      {!addOpen && addState.error ? (
        <p className="ki-task-notice ki-task-notice--warn" role="alert">{addState.error}</p>
      ) : null}

      {addOpen ? (
        <div
          className="ki-overlay ki-overlay--show ki-overlay--front"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAddOpen(false);
          }}
        >
          <section ref={addDialogRef} className="ki-dialog ki-dialog--form ki-ds-add" id="ki-ds-add-form" role="dialog" aria-modal="true" aria-labelledby="ki-ds-add-title" tabIndex={-1}>
            <header className="ki-dialog__head">
              <div>
                <h3 className="ki-dialog__title" id="ki-ds-add-title">添加 Git 数据源</h3>
                <p className="ki-ds-add__sub">服务端 clone 后自动开始首次全量同步</p>
              </div>
              <button type="button" className="ki-dialog__close" aria-label="关闭添加表单" onClick={() => setAddOpen(false)}>✕</button>
            </header>
            <div className="ki-dialog__body">
              <p className="ki-ds-add__hint">
                私有仓库使用 daemon 环境的 SSH agent / credential helper，本页不收集凭据。
                <br />
                本地目录请用 <code>ki datasource add --source &lt;目录&gt;</code>。
              </p>
              <div className="ki-ds-add__grid">
                <div className="ki-ds-add__scope">
                  <ScopePathSelect
                    hideLabel
                    value={addForm.scope}
                    confirmed={addScopeConfirmed}
                    currentScope={currentScope}
                    onChange={(value, confirmed) => {
                      setAddForm((prev) => (value !== prev.scope ? { ...prev, scope: value, group: '' } : { ...prev, scope: value }));
                      setAddScopeConfirmed(confirmed);
                    }}
                    onModeChange={(mode) => {
                      setAddScopeConfirmed(false);
                      setAddScopeMode(mode);
                      // 切回「选择已有」时清掉只读勾选，避免把只读带到别的 scope
                      if (mode === 'existing') setAddReadonly(false);
                    }}
                    autoConfirmNew
                    placeholder="按名称筛选已有 Scope，如：kafka"
                    hint="从已有 Scope 搜索选择；切到「新建 Scope」直接输入名称即可，无需再点创建。"
                    disabled={addBusy}
                  />
                </div>

                {canSetReadonly && addScopeMode === 'new' ? (
                  <div className="ki-ds-add__switch">
                    <div className="ki-ds-add__switch-text">
                      <span className="ki-form-label">创建为只读库</span>
                      <p className="ki-form-hint">
                        禁止逐条写入（含 Web 导入）；数据源同步与批量导入仍可更新。
                        可随时用 <code>ki scope readonly {addForm.scope.trim() || '<scope>'} --off</code> 解除。
                      </p>
                    </div>
                    <button
                      type="button"
                      className={`ki-switch${addReadonly ? ' ki-switch--on' : ''}${addBusy ? ' ki-switch--disabled' : ''}`}
                      role="switch"
                      aria-checked={addReadonly}
                      aria-label="创建为只读库"
                      disabled={addBusy}
                      onClick={() => setAddReadonly((value) => !value)}
                    >
                      <span className="ki-switch__knob" />
                    </button>
                  </div>
                ) : null}
                {canSetReadonly && addScopeMode === 'existing' && selectedScopeReadonly ? (
                  <p className="ki-ds-add__ro-state">
                    该 Scope 当前为只读（数据源同步仍可用）；如需写入请先执行{' '}
                    <code>ki scope readonly {addForm.scope} --off</code>
                  </p>
                ) : null}

                <div className="ki-ds-add__field">
                  <label className="ki-form-label" htmlFor="ki-ds-add-url">Git 仓库地址 *</label>
                  <input
                    id="ki-ds-add-url"
                    className="ki-form-input"
                    type="text"
                    placeholder="https://github.com/org/repo.git 或 git@github.com:org/repo.git"
                    value={addForm.url}
                    disabled={addBusy}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, url: event.target.value }))}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <label className="ki-form-label" htmlFor="ki-ds-add-branch">分支</label>
                  <input
                    id="ki-ds-add-branch"
                    className="ki-form-input"
                    type="text"
                    placeholder="留空 = 默认分支"
                    value={addForm.branch}
                    disabled={addBusy}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, branch: event.target.value }))}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <label className="ki-form-label" htmlFor="ki-ds-add-subdir">仓库子目录</label>
                  <input
                    id="ki-ds-add-subdir"
                    className="ki-form-input"
                    type="text"
                    placeholder="如 docs/guide（留空 = 仓库根）"
                    value={addForm.subdir}
                    disabled={addBusy}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, subdir: event.target.value }))}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <span className="ki-form-label">落点 Group</span>
                  {addScopeConfirmed && addForm.scope ? (
                    <GroupPathSelect
                      scope={addForm.scope}
                      value={addForm.group}
                      onChange={(value) => setAddForm((prev) => ({ ...prev, group: value }))}
                      placeholder="搜索或输入新 Group，如：docs/guide"
                      hint="下拉来自当前 Scope；输入新路径可新建 Group。留空 = 按子目录自动。"
                      disabled={addBusy}
                    />
                  ) : (
                    <input className="ki-form-input" disabled placeholder="请先选择 Scope" />
                  )}
                </div>
              </div>
              {addState.error ? (
                <p className="ki-write-error" role="alert">{addState.error}</p>
              ) : null}
            </div>
            <footer className="ki-dialog__foot ki-ds-add__foot">
              {addBusy ? (
                <div className="ki-ds-clone-progress" role="status" aria-live="polite">
                  <div className="ki-ds-clone-progress__head">
                    <span className="ki-ds-clone-progress__pulse" aria-hidden />
                    <span className="ki-ds-clone-progress__title">
                      {addState.phase === 'submitting'
                        ? '正在提交任务…'
                        : addState.progress !== undefined && addState.progress >= 100
                          ? '正在校验并登记数据源…'
                          : '正在克隆 Git 仓库…'}
                    </span>
                    {addState.phase === 'cloning' && addState.progress !== undefined ? (
                      <span className="ki-ds-clone-progress__pct">{addState.progress}%</span>
                    ) : null}
                  </div>
                  <div
                    className={`ki-ds-clone-progress__track${addState.phase === 'submitting' || addState.progress === undefined ? ' is-indeterminate' : ''}`}
                    role="progressbar"
                    aria-label="克隆进度"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    {...(addState.phase === 'cloning' && addState.progress !== undefined
                      ? { 'aria-valuenow': addState.progress }
                      : {})}
                  >
                    <span
                      className="ki-ds-clone-progress__bar"
                      style={addState.phase === 'cloning' && addState.progress !== undefined
                        ? { width: `${Math.max(4, addState.progress)}%` }
                        : undefined}
                    />
                  </div>
                  <div className="ki-ds-clone-progress__meta">
                    {addState.taskId ? `任务 ${addState.taskId.slice(0, 8)} · 关闭弹窗不会取消任务` : '正在创建后台任务'}
                  </div>
                </div>
              ) : null}
              <button type="button" className="ki-btn ki-btn--secondary" onClick={() => setAddOpen(false)}>
                {addBusy ? '关闭' : '取消'}
              </button>
              {!addBusy ? (
                <button
                  type="button"
                  className="ki-btn ki-btn--primary"
                  disabled={!addScopeConfirmed || !addForm.scope.trim() || !addForm.url.trim()}
                  onClick={() => { void submitAdd(); }}
                >添加并开始首次同步</button>
              ) : null}
            </footer>
          </section>
        </div>
      ) : null}

      {scheduleTarget ? (
        <DatasourceScheduleDialog
          key={scheduleTarget.scope}
          scope={scheduleTarget.scope}
          schedule={scheduleTarget.schedule}
          schedulerDisabled={scheduleTarget.schedulerDisabled}
          onClose={closeSchedule}
          onSaved={(response) => {
            setRowSyncNotice({
              tone: 'info',
              text: `定时设置已保存（${response.scope}）：${describeSchedule(response.schedule)}${response.nextRunAt ? `，下次 ${formatDateTime(response.nextRunAt)}` : ''}${response.schedulerDisabled ? '（服务端已禁用调度，不会自动执行）' : ''}`,
            });
            closeSchedule();
            void queryClient.invalidateQueries({ queryKey: ['dataSourceList'] });
            void queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', response.scope] });
          }}
        />
      ) : null}

      {editTarget ? (
        <DatasourceEditDialog
          key={editTarget.record.scope}
          record={editTarget.record}
          schedulerDisabled={listQuery.data?.schedulerDisabled}
          onClose={() => closeEdit(editTarget.record.scope)}
          onSaved={(message, tone = 'info') => {
            const scopeName = editTarget.record.scope;
            closeEdit(scopeName);
            setRowSyncNotice({ tone, text: `${scopeName}：${message}` });
            void queryClient.invalidateQueries({ queryKey: ['dataSourceList'] });
            void queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', scopeName] });
          }}
        />
      ) : null}

      {/* 移除数据源登记确认（2026-10-29 改版）：破坏性操作，二次确认 + 明示"库内文档保留"。
          语义口径见文件头：这是取消登记，不是删文档。
          视觉结构 = danger 顶条 + 三块分组（登记 / 影响 / 附加操作），
          设计台账：.plans/2026-10-29-datasource-remove-dialog-restyle/（本地目录，不入库）。
          ★ 宽度与限高只挂在 .ki-ds-remove 上：.ki-dialog--form 是其它表单弹窗共用的全局类。 */}
      {removeTarget ? (
        <div
          className="ki-overlay ki-overlay--show ki-overlay--front"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeRemove();
          }}
        >
          <section
            ref={removeDialogRef}
            className="ki-dialog ki-ds-remove"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ki-ds-remove-title"
            tabIndex={-1}
          >
            <div className="ki-ds-remove__bar" aria-hidden="true" />
            <header className="ki-dialog__head">
              <div className="ki-ds-remove__heading">
                <span className="ki-ds-remove__mark" aria-hidden="true">!</span>
                <div className="ki-ds-remove__heading-text">
                  <h3 className="ki-dialog__title" id="ki-ds-remove-title">移除数据源</h3>
                  <p className="ki-ds-remove__sub">
                    {removeTarget.corrupt
                      ? '登记文件已损坏、无法解析，移除只是清掉这个坏文件'
                      : '取消登记后不再自动同步，也不再产生待删候选'}
                  </p>
                </div>
              </div>
              <button type="button" className="ki-dialog__close" aria-label="关闭移除确认" disabled={removing} onClick={closeRemove}>✕</button>
            </header>
            <div className="ki-dialog__body">
              {/* ① 将被移除的登记：Scope + 类型徽标同行为身份，路径与时间降为次级键值 */}
              <section className="ki-ds-remove__card">
                <h4 className="ki-ds-remove__card-title">将被移除的登记</h4>
                <div className="ki-ds-remove__ident">
                  <span className="ki-ds-remove__scope">{removeTarget.scope}</span>
                  {removeTarget.corrupt ? (
                    <span className="ki-ds-remove__managed ki-ds-remove__managed--danger">
                      登记文件损坏：{removeTarget.corrupt}
                    </span>
                  ) : (
                    <>
                      <span className={`ki-ds-type-badge ${removeTarget.type === 'git' ? 'ki-ds-type-badge--git' : 'ki-ds-type-badge--dir'}`}>
                        {removeTarget.type === 'git' ? 'Git' : '目录'}
                      </span>
                      {removeTarget.managed ? (
                        <span className="ki-ds-remove__managed">服务端托管 clone</span>
                      ) : removeTarget.type === 'directory' ? (
                        <span className="ki-ds-remove__managed">本地目录</span>
                      ) : null}
                    </>
                  )}
                </div>
                {!removeTarget.corrupt && removeTarget.dir ? (
                  <dl className="ki-ds-remove__kv">
                    <dt>源目录</dt>
                    <dd className="ki-ds-remove__v--mono" title={removeTarget.dir}>{removeTarget.dir}</dd>
                    <dt>上次同步</dt>
                    <dd className="ki-ds-remove__v--num">
                      {removeTarget.lastSyncAt ? formatDateTime(removeTarget.lastSyncAt) : '尚未同步过'}
                    </dd>
                  </dl>
                ) : null}
              </section>

              {/* ② 移除后会怎样：「会保留」与「会失去」分语气两行，不再挤进一个黄块 */}
              <section className="ki-ds-remove__card">
                <h4 className="ki-ds-remove__card-title">移除后会怎样</h4>
                <ul className="ki-ds-remove__facts">
                  {removeTarget.corrupt ? null : (
                    <li className="ki-ds-remove__fact ki-ds-remove__fact--keep">
                      <span className="ki-ds-remove__fact-icon" aria-hidden="true">✓</span>
                      <span>
                        库内{removeDocCount !== undefined ? <> <b>{removeDocCount}</b> 篇</> : ''}文档保留，仍可被检索
                      </span>
                    </li>
                  )}
                  <li className="ki-ds-remove__fact ki-ds-remove__fact--lose">
                    <span className="ki-ds-remove__fact-icon" aria-hidden="true">!</span>
                    <span>
                      {removeTarget.corrupt
                        ? '只删除这个损坏的登记文件，无参数可恢复'
                        : '登记参数不保留（落点 Group / 同名策略 / 切分 / 向量化），重新登记需再填一次'}
                    </span>
                  </li>
                </ul>
                <p className="ki-ds-remove__guide">
                  {removeTarget.corrupt
                    ? '库内文档与源目录文件都不受影响，随时可以重新登记'
                    : '如需清理这些文档，请先在详情抽屉「待删除」处理候选；移除后本页不再产生候选'}
                </p>
              </section>

              {/* ③ 附加操作：只有托管 clone 才有可删目录；勾选后展开删除范围，让"可变部分"可见 */}
              {removeTarget.managed && !removeTarget.corrupt ? (
                <section className="ki-ds-remove__card">
                  <h4 className="ki-ds-remove__card-title">附加操作</h4>
                  <label className="ki-ds-remove__check">
                    <input
                      type="checkbox"
                      checked={removePurge}
                      disabled={removing}
                      onChange={(event) => setRemovePurge(event.target.checked)}
                    />
                    <span>
                      同时删除服务端托管 clone 目录
                      <span className="ki-ds-remove__check-sub">释放磁盘；其他 scope 仍在复用时自动保留</span>
                    </span>
                  </label>
                  {removePurge && removeTarget.dir ? (
                    <p className="ki-ds-remove__path">
                      <span className="ki-ds-remove__path-key">将删除</span>{removeTarget.dir}
                    </p>
                  ) : null}
                </section>
              ) : null}

              {removeError ? <p className="ki-ds-remove__error" role="alert">{removeError}</p> : null}
            </div>
            <footer className="ki-dialog__foot ki-ds-remove__foot">
              <p className={`ki-ds-remove__foot-note${!removeTarget.corrupt && removeTarget.managed === true && removePurge ? ' ki-ds-remove__foot-note--strong' : ''}`}>
                {removeTarget.corrupt
                  ? '只清掉损坏的登记文件，库内文档与源目录不动'
                  : removeTarget.managed === true && removePurge
                    ? '将同时删除 clone 目录，此操作不可撤销'
                    : '此操作不可撤销，源目录文件不受影响'}
              </p>
              <div className="ki-ds-remove__actions">
                <button type="button" className="ki-btn ki-btn--secondary" disabled={removing} onClick={closeRemove}>取消</button>
                <button type="button" className="ki-btn ki-btn--danger" disabled={removing} onClick={() => { void submitRemove(); }}>
                  {removing ? '移除中…' : '确认移除'}
                </button>
              </div>
            </footer>
          </section>
        </div>
      ) : null}

      <div className="ki-ds-callout" role="note">
        <span className="ki-ds-callout__icon" aria-hidden>ⓘ</span>
        <span>
          Git 仓库可在本页「添加 Git 数据源」（服务端 clone）；本地目录数据源通过命令行登记：<code className="ki-ds-callout__cmd">ki datasource add --scope &lt;scope&gt; --source &lt;目录&gt;</code>。
          <strong>同步可在本页触发</strong>（普通目录 30 分钟一次，CLI 可强制；<strong>手动同步另有冷却</strong>）；
          <strong>定时同步在行内「编辑」中按源开启，默认关闭</strong>。
          两个删除动作语义不同：行内<strong>「移除」</strong>只取消数据源登记（<strong>库内文档保留</strong>）；
          详情抽屉里的<strong>「删除所选」</strong>才删除库内文档。两者都不动源目录文件。
        </span>
      </div>

      {!listQuery.isLoading && sources.length > 0 && sources.every((item) => item.schedule === undefined) ? (
        <p className="ki-task-notice ki-task-notice--warn">⚠ 当前 daemon 不支持定时同步，请升级并重启</p>
      ) : null}

      {rowSyncNotice ? (
        <p className={`ki-task-notice ki-task-notice--${rowSyncNotice.tone}`} role={rowSyncNotice.tone === 'warn' ? 'alert' : undefined}>
          {rowSyncNotice.text}
        </p>
      ) : null}

      {rowNotice ? (
        /* tabIndex=-1：仅作「操作后焦点落点」用，不进入 Tab 序（见 submitRemove） */
        <p
          ref={rowNoticeRef}
          tabIndex={-1}
          className={`ki-task-notice ki-task-notice--${rowNotice.tone} ki-ds-notice--focus`}
          role={rowNotice.tone === 'warn' ? 'alert' : undefined}
        >
          {rowNotice.text}
        </p>
      ) : null}

      {missing.map((item) => (
        <div key={item.scope} className="ki-task-notice ki-task-notice--warn ki-ds-missing-row">
          <span>⚠ {item.scope} 目录不可读：{item.reason}</span>
          {item.schedule !== undefined ? (
            <button
              type="button"
              className="ki-btn ki-btn--secondary ki-btn--small"
              onClick={(event) => openSchedule(item.scope, item.schedule, event.currentTarget)}
            >定时</button>
          ) : null}
        </div>
      ))}
      {corrupt.map((item) => (
        /* 损坏登记不在列表里（无行可选），这里是唯一清理出口：走 force 移除坏文件 */
        <p key={item.scope} className="ki-task-notice ki-task-notice--warn ki-ds-notice--action">
          <span>⚠ {item.scope} 登记损坏：{item.reason}</span>
          <button
            type="button"
            data-ds-remove={item.scope}
            className="ki-btn ki-btn--secondary ki-btn--small ki-ds-remove-btn"
            aria-label={`移除 ${item.scope} 的损坏登记`}
            disabled={removing}
            onClick={() => openRemove({ scope: item.scope, corrupt: item.reason })}
          >移除登记</button>
        </p>
      ))}

      <section className="ki-card">
        <div className="ki-card__body ki-card__body--flush">
          {listQuery.isLoading ? (
            <p className="ki-ds-muted">加载中…</p>
          ) : listQuery.isError ? (
            /* 失败态与空态必须互斥（2026-10-21 PM 走查）：原先两块各自独立渲染，读取失败时
               「加载失败」与「还没有数据源」同屏出现，把故障伪装成"用户没登记过"。
               口径与结构照 BrowsePage 的「Group 加载失败」块，复用 .ki-empty 现成样式。 */
            <div className="ki-empty" style={{ padding: 24 }}>
              <div>
                <h3>数据源列表读取失败</h3>
                <p>{(listQuery.error as Error).message}</p>
                <div className="ki-empty__actions">
                  <button
                    className="ki-btn ki-btn--secondary ki-btn--small"
                    type="button"
                    disabled={listQuery.isFetching}
                    onClick={() => { void listQuery.refetch(); }}
                  >{listQuery.isFetching ? '重试中…' : '重试'}</button>
                </div>
              </div>
            </div>
          ) : sources.length === 0 ? (
            <div className="ki-empty">
              <p>还没有数据源。Git 仓库可用右上角「添加 Git 数据源」；本地目录通过命令行登记：</p>
              <code className="ki-ds-empty__cmd">{'ki datasource add\n  --scope <scope>\n  --source <目录>'}</code>
            </div>
          ) : (
            <>
              <table className="ki-ds-table" aria-label="数据源列表">
                <thead>
                  <tr className="ki-ds-table__head">
                    <th scope="col">Scope</th>
                    <th scope="col" className="ki-ds-col--type">类型</th>
                    <th scope="col">源目录</th>
                    <th scope="col" className="ki-ds-col--group">落点 Group</th>
                    <th scope="col" className="ki-ds-col--time">上次同步</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="ki-ds-col--duration">持续时间</th>
                    <th scope="col" className="ki-ds-col--actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                {pageSources.map((source) => {
                  const status = dataSourceStatusView({ activeState: source.activeState, running: source.running, lastSync: source.lastSync });
                  const lastSyncLabel = source.lastSync ? formatDateTime(source.lastSync.at) : null;
                  const rowAvailability = source.syncAvailability;
                  const rowSyncing = syncingScope === source.scope;
                  const rowCanSync = !source.running && rowAvailability?.allowed === true && syncingScope === null;
                  const rowTitle = rowSyncing
                    ? '正在提交同步请求'
                    : source.running
                      ? (source.activeState === 'queued' ? '同步已排队' : '同步进行中')
                      : rowAvailability === undefined
                        ? '当前 daemon 不支持页面同步，请升级并重启'
                        : rowAvailability.reason === 'cooldown'
                          ? `距上次成功同步不足 30 分钟；如需立即同步：ki datasource sync --scope ${source.scope}`
                          : '同步（Git 源为增量）';
                  const typeLabel = source.type === 'git' ? 'Git' : '目录';
                  const schedBadge = scheduleBadge(source.schedule);
                  const nextLine = scheduleNextLine(source.schedule);
                  const rowTitleWithSchedule = `${rowTitle}${source.schedule?.enabled ? `；定时同步已开启（${describeSchedule(source.schedule)}）` : ''}`;
                  return (
                  <tr
                    key={source.scope}
                    tabIndex={0}
                    data-ds-scope={source.scope}
                    aria-label={`${source.scope}，${typeLabel}，${source.dir}，${status.label}${lastSyncLabel ? `，上次同步 ${lastSyncLabel}` : ''}${source.lastSync ? `，持续时间 ${formatSyncDuration(source.lastSync.durationMs)}` : ''}`}
                    className={`ki-ds-table__row${scope === source.scope ? ' is-active' : ''}`}
                    onClick={() => navigate(`/datasource/${encodeURIComponent(source.scope)}`)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/datasource/${encodeURIComponent(source.scope)}`);
                      }
                    }}
                  >
                    <td>
                      <span className="ki-ds-table__scope" title={source.scope}>
                        <span className="ki-ds-table__scope-name">{source.scope}</span>
                        {schedBadge ? (
                          <span
                            className={`ki-ds-sched-badge ki-ds-sched-badge--compact${schedBadge === '定时⚠' ? ' ki-ds-sched-badge--warn' : ''}`}
                            title={source.schedule ? describeSchedule(source.schedule) : undefined}
                          >{schedBadge}</span>
                        ) : null}
                      </span>
                      {nextLine ? (
                        <div className={`ki-ds-sched-next ki-ds-sched-next--compact ki-ds-sched-next--${nextLine.tone}`}>{nextLine.text}</div>
                      ) : null}
                    </td>
                    <td className="ki-ds-col--type">
                      <span className={`ki-ds-type-badge ki-ds-type-badge--${source.type === 'git' ? 'git' : 'dir'}`}>{typeLabel}</span>
                      {schedBadge ? (
                        <span
                          className={`ki-ds-sched-badge${schedBadge === '定时⚠' ? ' ki-ds-sched-badge--warn' : ''}`}
                          title={source.schedule ? describeSchedule(source.schedule) : undefined}
                        >{schedBadge}</span>
                      ) : null}
                    </td>
                    <td className="ki-ds-table__dir" title={source.dir}>{source.dir}</td>
                    <td className="ki-ds-table__group ki-ds-col--group" title={source.group ?? '(自动)'}>{source.group ?? '(自动)'}</td>
                    <td className="ki-ds-col--time">
                      <div>{lastSyncLabel ?? '—'}</div>
                      {nextLine ? (
                        <div className={`ki-ds-sched-next ki-ds-sched-next--${nextLine.tone}`}>{nextLine.text}</div>
                      ) : null}
                    </td>
                    <td>
                      <span
                        className={`ki-task-state ki-task-state--${status.tone}`}
                        title={status.state === 'running' ? '本次同步进行中' : status.state === 'queued' ? '等待同知识库的其他任务完成' : undefined}
                      >{status.label}</span>
                    </td>
                    <td className="ki-ds-col--duration">
                      {source.lastSync ? formatSyncDuration(source.lastSync.durationMs) : '—'}
                    </td>
                    <td className="ki-ds-table__actions">
                      {/* flex 包一层：td 不能自己变 flex（会丢 table-cell 布局） */}
                      <div className="ki-ds-row-actions">
                        <button
                          type="button"
                          className="ki-btn ki-btn--secondary ki-btn--small ki-ds-sync-btn"
                          disabled={!rowCanSync}
                          title={rowTitleWithSchedule}
                          aria-label={`同步 ${source.scope}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (rowCanSync) void triggerSync(source.scope);
                          }}
                        >{rowSyncing ? '提交中…' : source.running ? (source.activeState === 'queued' ? '排队中' : '同步中') : '同步'}</button>
                        {canUpdateDatasource ? (
                          <button
                            type="button"
                            data-ds-edit={source.scope}
                            className="ki-btn ki-btn--secondary ki-btn--small ki-ds-edit-btn"
                            disabled={source.running || rowSyncing || editLoadingScope === source.scope}
                            title={source.running
                              ? '同步进行中，任务结束后可编辑'
                              : rowSyncing
                                ? '正在提交同步，稍后可编辑'
                                : `编辑 ${source.scope}：同步参数与定时同步`}
                            aria-label={`编辑数据源 ${source.scope}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              if (source.running || rowSyncing) return;
                              void openEdit(source.scope);
                            }}
                          >{editLoadingScope === source.scope ? '读取…' : '编辑'}</button>
                        ) : null}
                        <button
                          type="button"
                          data-ds-remove={source.scope}
                          className="ki-btn ki-btn--secondary ki-btn--small ki-ds-remove-btn"
                          disabled={source.running || rowSyncing}
                          title={source.running
                            ? '同步进行中，任务结束后可移除'
                            : rowSyncing
                              ? '正在提交同步，稍后可移除'
                              : `移除 ${source.scope} 的数据源登记（库内文档保留）`}
                          aria-label={`移除数据源 ${source.scope}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (source.running || rowSyncing) return;
                            openRemove({
                              scope: source.scope,
                              type: source.type,
                              dir: source.dir,
                              lastSyncAt: source.lastSync?.at ?? null,
                              managed: source.git?.managed === true,
                            });
                          }}
                        >移除</button>
                      </div>
                    </td>
                  </tr>
                  );
                })}
                </tbody>
              </table>
              {/* 单页时不渲染分页栏（四个控件全禁用、"第 1/1 页"与副标题重复）。
                  ★ 但 `pageSize !== 默认` 时必须继续渲染 —— 否则用户把每页改成 100 后、
                    页数变 1，分页栏连同「每页」选择器一起消失，本会话内再也改不回 10。 */}
              {(pageCount > 1 || pageSize !== PAGE_SIZE_DEFAULT) ? (
                <div className="ki-ds-pager">
                  <span className="ki-ds-pager__info">第 {page} / {pageCount} 页 · 共 {total} 个</span>
                  <label className="ki-ds-pager__size">
                    每页
                    <select
                      value={pageSize}
                      onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
                      aria-label="每页条数"
                    >
                      <option value={10}>10</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                    条
                  </label>
                  <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
                  <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>下一页</button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* 右侧详情：URL 驱动（/datasource/:scope），Esc / ✕ 关闭。
          ★ 非模态（2026-10-21 用户定稿 V3）：不铺遮罩、1px 描边分隔、面板常驻全高。
            列表保持可读可点 —— 直接点另一行即可切换数据源；代价是"点背景关闭"不再成立。 */}
      {scope ? (
        <>
          {/* ★ 模态浮层（2026-10-22 V5，用户定稿）：宽度 70vw + 左侧遮罩压暗 + 点遮罩/外部关闭。
              历史：V3 曾定稿"非模态不铺遮罩、列表可点"，V4 改成 70vw，V5 按用户反馈加回遮罩
              —— 不要再按 V3 的结论去掉遮罩。 */}
          <DetailDrawer
            ariaLabel={`数据源详情 ${scope}`}
            title={scope}
            status={model ? { tone: model.header.tone, label: model.header.stateLabel } : null}
            meta={whenLabel}
            onClose={() => navigate('/datasource')}
            closeRef={closeBtnRef}
          >
              {detailQuery.isLoading ? <p className="ki-ds-muted">加载中…</p> : null}
              {detailQuery.isError ? (
                <div className="ki-empty">
                  读取详情失败：{(detailQuery.error as Error).message}
                  <button type="button" className="ki-btn ki-btn--small" onClick={() => { void detailQuery.refetch(); }}>重试</button>
                </div>
              ) : null}
              {model ? (
                <>
                  {/* 同步中：进度块（阶段 + 进度条）。接口暂无 progress/stage，用不确定态兜底。 */}
                  {active ? (
                    <div className="ki-progress-block">
                      <div className="ki-track-head">
                        <span className="ki-track-kicker">PROGRESS</span>
                        <DetailStatus tone="running" label={activeState === 'queued' ? '排队中' : '同步中'} />
                      </div>
                      <div className="ki-track-title">同步进度</div>
                      <div className="ki-progress-row">
                        <span className="ki-progress-label">
                          <span className="ki-spinner" aria-hidden />
                          {activeState === 'queued' ? '等待同知识库的其他任务完成…' : '正在同步源目录…'}
                        </span>
                      </div>
                      <div className="ki-progress" role="progressbar" aria-label="同步进度" aria-valuemin={0} aria-valuemax={100}>
                        <div className="ki-progress__fill ki-progress__fill--indeterminate" />
                      </div>
                      <div className="ki-progress-sub">
                        {detailQuery.data?.activeStartedAt
                          ? `本次开始于 ${formatDateTime(detailQuery.data.activeStartedAt)} · 下方「执行结果」为上次同步数据`
                          : '下方「执行结果」为上次同步数据'}
                      </div>
                    </div>
                  ) : null}

                  {/* 待删段的 skipDetail 只在下方区块里出现一次：同一条 warn 在顶部与卡内各渲染一遍
                      会让"已生成候选 / 未生成候选"这类结论重复两遍（实测确实重复）。 */}
                  {!active ? model.notices
                    .filter((notice) => !(model.pending.blocked && notice.text === model.pending.blockedText))
                    .map((notice) => (
                      <Notice key={`${notice.tone}:${notice.text}`} tone={notice.tone} title={notice.title}>{notice.text}</Notice>
                    )) : null}
                  {/* 冷却提示只在空闲时才有意义：同步中再说"距上次不足 30 分钟"是噪音 */}
                  {!active && availability?.reason === 'cooldown' ? (
                    detailSchedule?.enabled ? (
                      <Notice tone="info" title="定时同步已开启">
                        下次 {detailSchedule.nextRunAt ? formatDateTime(detailSchedule.nextRunAt) : '—'}。普通目录手动同步仍在冷却中；如需立即同步：
                        <code className="ki-notice__code">ki datasource sync --scope {scope}</code>
                      </Notice>
                    ) : (
                      <Notice tone="info" title="距上次成功同步不足 30 分钟">
                        约 {Math.max(1, Math.ceil((availability.retryAfterSec ?? 0) / 60))} 分钟后可再次同步。如需立即同步：
                        <code className="ki-notice__code">ki datasource sync --scope {scope}</code>
                      </Notice>
                    )
                  ) : null}
                  {availability === undefined && detailQuery.data ? (
                    <Notice tone="warn">当前 daemon 不支持页面同步，请升级并重启。</Notice>
                  ) : null}

                  {/* ── 执行结果（数据区材质） ── */}
                  <DetailSection
                    material="data"
                    title="执行结果"
                    hint={model.summary ? `扫描 ${model.summary.scanned} 篇` : undefined}
                  >

                    {model.summary ? (
                      <>
                        <DetailHero
                          completed={model.summary.completed}
                          total={model.summary.scanned}
                          skipped={model.summary.skipped}
                          failed={model.summary.failed}
                          unchanged={model.summary.unchanged}
                        />
                        <DetailMetrics metrics={model.metrics} />

                        {model.details.failures.length > 0 ? (
                          <div className="ki-ds-failbox">
                            <div className="ki-ds-failbox__head">
                              <span className="ki-ds-failbox__title">失败明细</span>
                              <span className="ki-ds-failbox__count">
                                {model.details.failures.length} 条
                                {model.details.failures.length > FAILURE_PREVIEW ? ` · 先显示 ${FAILURE_PREVIEW} 条` : ''}
                              </span>
                            </div>
                            <ul className="ki-ds-failbox__list">
                              {(showAllFailures ? model.details.failures : model.details.failures.slice(0, FAILURE_PREVIEW)).map((item) => (
                                <li key={`${item.title}-${item.meta ?? ''}`} className="ki-ds-failbox__row">
                                  <span className="ki-ds-failbox__path">{item.title}</span>
                                  {item.meta ? <span className="ki-ds-failbox__why">{item.meta}</span> : null}
                                </li>
                              ))}
                            </ul>
                            {model.details.failures.length > FAILURE_PREVIEW ? (
                              <button
                                type="button"
                                className="ki-ds-failbox__more"
                                aria-expanded={showAllFailures}
                                onClick={() => setShowAllFailures((prev) => !prev)}
                              >
                                {showAllFailures ? '收起' : `展开剩余 ${model.details.failures.length - FAILURE_PREVIEW} 条`}
                              </button>
                            ) : null}
                            {model.details.failureTotal > model.details.failures.length ? (
                              <p className="ki-ds-pending__note" style={{ padding: '0 12px 8px' }}>
                                仅显示前 {model.details.failures.length} 条（服务端最多存 20 条）；完整清单见 datasource.json 的 lastSync.result.failures。
                              </p>
                            ) : null}
                          </div>
                        ) : null}

                        {model.details.conflicts.length > 0 ? (
                          <details className="ki-task-detail__details">
                            <summary>冲突 / 覆盖明细 {model.details.conflicts.length} 条</summary>
                            <ul className="ki-task-tree ki-task-tree--list">
                              {model.details.conflicts.map((item) => (
                                <li key={`${item.title}-${item.meta ?? ''}`} className="ki-task-tree__row ki-task-tree__row--item">
                                  <span className="ki-task-tree__path">{item.title}</span>
                                  {item.meta ? <span className="ki-task-tree__meta">{item.meta}</span> : null}
                                </li>
                              ))}
                            </ul>
                          </details>
                        ) : null}
                      </>
                    ) : (
                      <div className="ki-detail-hero__empty">
                        还没有同步记录。命令行执行后可在此查看结果：
                        <br />
                        <code className="ki-ds-callout__cmd">ki datasource sync --scope {scope}</code>
                      </div>
                    )}
                  </DetailSection>

                  {/* ── 同步参数（只读属性区材质；源目录已上移到头部，不重复） ── */}
                  <DetailSection material="meta" title="同步参数">
                    <DetailParams rows={model.params} />
                  </DetailSection>

                  {/* ── 定时同步（只读）：配置入口在行内「编辑」弹窗，这里只展示 ── */}
                  {model.schedule.available ? (
                    <DetailSection material="meta" title="定时同步（只读）">
                      <DetailParams rows={model.schedule.rows} />
                      {model.schedule.warning ? (
                        <Notice tone="warn" slim>{model.schedule.warning}</Notice>
                      ) : null}
                    </DetailSection>
                  ) : null}

                  {/* ── 新增的文档（2026-10-29）：与下方「待删除」同款目录树，只读
                       —— 落点 Group 已在参数里，用户更关心"这次多了哪些目录下的文档" ── */}
                  {model.summary ? <DetailSection
                    material="created"
                    title={model.created.available ? `新增的文档 ${model.created.total} 篇` : '新增的文档'}
                    hint={model.created.truncated ? '明细未完整显示' : undefined}
                  >
                    {!model.created.available ? (
                      <p className="ki-ds-pending__note" style={{ marginTop: 0 }}>
                        这次同步没有记录新建明细（旧版本同步快照）。重新同步一次即可看到。
                      </p>
                    ) : model.created.total === 0 ? (
                      <p className="ki-ds-pending__note" style={{ marginTop: 0 }}>
                        本次没有新建文档：全部为覆盖更新、内容未变或被跳过。
                      </p>
                    ) : model.created.items.length === 0 ? (
                      <p className="ki-ds-pending__note" style={{ marginTop: 0 }}>
                        共 {model.created.total} 篇，但明细未保留（同步快照被裁剪）。
                      </p>
                    ) : (
                      <>
                        <div className="ki-ds-subcard">
                          <ReadOnlyPathTree
                            nodes={buildDataSourcePendingTree(model.created.items)}
                            label="新增的文档目录"
                            onOpenDoc={(item) => setDocTarget(item)}
                          />
                        </div>
                        {model.created.truncated ? (
                          <p className="ki-ds-pending__note">
                            仅显示前 {model.created.items.length} 篇（共 {model.created.total} 篇）。
                          </p>
                        ) : null}
                      </>
                    )}
                  </DetailSection> : null}

                  {/* ── 待删除（操作台材质；唯一写入口）
                       ★ 常显（2026-10-22 用户要求）：没有候选时也要说明"当前没有待删"，
                         否则用户会以为这块功能消失了。 ── */}
                  <DetailSection
                    material="action"
                    title={model.pending.blocked ? '待删除（未生成候选）' : `待删除 ${model.pending.total} 篇`}
                    hint={model.pending.computedAt > 0
                      ? `由 ${new Date(model.pending.computedAt).toLocaleString('zh-CN')} 同步算出`
                      : undefined}
                    actions={!model.pending.blocked && pendingTree.length > 0 ? (
                      <div className="ki-ds-tree-actions">
                        <button type="button" className="ki-ds-linkbtn" onClick={() => setCollapsedDirs(new Set())}>展开全部</button>
                        <span className="ki-detail-legend__dot" aria-hidden>·</span>
                        <button
                          type="button"
                          className="ki-ds-linkbtn"
                          onClick={() => setCollapsedDirs(new Set(allDirPaths(pendingTree)))}
                        >折叠全部</button>
                      </div>
                    ) : undefined}
                  >

                      {model.pending.blocked ? (
                        <Notice tone="warn" slim className="ki-ds-pending__notice">{model.pending.blockedText ?? '未生成候选'}</Notice>
                      ) : pendingEmpty ? (
                        <p className="ki-ds-pending__note" style={{ marginTop: 0 }}>
                          当前没有待删除的文档：知识库与源目录一致。下次同步会重新比对并生成候选。
                        </p>
                      ) : (
                        <>
                          {active ? (
                            <Notice tone="info" slim className="ki-ds-pending__notice">
                              {activeState === 'queued'
                                ? '同步已排队，暂不能删除候选（避免与即将开始的同步冲突）。'
                                : '同步进行中，暂不能删除候选（避免与本次扫描冲突）。'}
                            </Notice>
                          ) : null}

                          <div className="ki-ds-pending__head">
                            <label className="ki-ds-pending__all">
                              <GroupCheckbox
                                checked={selectedCount > 0 && selectedCount >= visibleItems.length}
                                indeterminate={selectedCount > 0 && selectedCount < visibleItems.length}
                                disabled={!selectable}
                                onChange={toggleAllVisible}
                                label="全选待删候选"
                              />
                              全选（{visibleItems.length}）
                            </label>
                            <button
                              type="button"
                              ref={deleteBtnRef}
                              className="ki-btn ki-btn--danger ki-btn--small"
                              disabled={!selectable || selectedCount === 0 || submitting}
                              onClick={() => setConfirming(true)}
                            >
                              删除所选 {selectedCount} 篇…
                            </button>
                          </div>

                          <div className="ki-ds-subcard">
                            <div className="ki-ds-tree">{pendingTree.map(renderPendingNode)}</div>
                          </div>

                          {confirming ? (
                            <div className="ki-ds-confirm" role="alertdialog" aria-label="确认删除">
                              <span>
                                将删除 {selectedCount} 篇{ratio !== null ? `（本数据源 ${model.pending.eligibleCount} 篇的 ${ratio}%）` : ''} · 不可恢复
                              </span>
                              <div className="ki-ds-confirm__acts">
                                <button type="button" className="ki-btn ki-btn--small" disabled={submitting} onClick={() => { setConfirming(false); requestAnimationFrame(() => deleteBtnRef.current?.focus()); }}>取消</button>
                                <button type="button" className="ki-btn ki-btn--danger ki-btn--small" disabled={submitting || !selectable} onClick={() => { void runPrune(); }}>
                                  {submitting ? '删除中…' : '确认删除'}
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {ratio !== null && ratio > 20 ? (
                            <Notice tone="warn" slim className="ki-ds-pending__notice">本次将删除本数据源 {ratio}% 的文档，比例偏高，请确认源目录无误</Notice>
                          ) : null}
                          <p className="ki-ds-pending__note">删除不可恢复；执行时按当前源目录重新校验，目录变了会拒绝。只删知识库记录，不动源目录文件。</p>
                        </>
                      )}
                  </DetailSection>

                  {error ? <Notice tone="warn">{error}</Notice> : null}
                  {receipt ? <p className="ki-ds-receipt">{receipt}</p> : null}
                </>
              ) : null}
          </DetailDrawer>

          {/* 文档正文抽屉：复用知识目录的 ModuleDrawer（右侧滑出 + 遮罩 + dialog 语义） */}
          {docTarget ? (
            <ModuleDrawer
              scope={scope}
              module={docTarget.relation}
              group={docTarget.group}
              fetcher={getDocContent}
              onClose={() => setDocTarget(null)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}
