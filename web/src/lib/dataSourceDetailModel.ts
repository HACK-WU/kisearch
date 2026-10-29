/**
 * dataSourceDetailModel.ts —— 数据源详情渲染模型（设计 S-05 §3.4）
 *
 * 与任务详情同构（三段 + 待删段），但**不伪造 TaskRecord**：
 * `lastSync` 是数据源自己的快照，字段与任务台账不同。
 */
import type { DataSourceActiveState, DataSourceLastSyncView, DataSourcePendingItem, DataSourceRecordView, DataSourceSyncState } from '@/api/httpApi';
import type { DetailItem, DetailRow } from '@/lib/taskDetailModel';

export type DataSourceStatusState = DataSourceSyncState | 'never' | DataSourceActiveState;
export type DataSourceStatusTone = 'queued' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled';

export interface DataSourceStatusView {
  state: DataSourceStatusState;
  label: string;
  tone: DataSourceStatusTone;
  active: boolean;
}

/** 运行态描述（由 `/api/datasource/detail` 下发；`running` 用于旧 daemon 缺字段时兜底） */
export interface DataSourceRuntimeState {
  activeState?: DataSourceActiveState | null;
  activeStartedAt?: number | null;
  running?: boolean;
}

/**
 * 统一运行态口径：
 * - 新接口给 `activeState`（queued/running/null）——精确；
 * - 旧 daemon 只给 `running:boolean`——按 running 兜底，避免 `undefined !== null` 把空闲判成进行中。
 */
export function resolveDataSourceActiveState(
  activeState: DataSourceActiveState | null | undefined,
  running?: boolean,
): DataSourceActiveState | null {
  if (activeState === 'running' || activeState === 'queued') return activeState;
  return running === true ? 'running' : null;
}

export interface DataSourcePendingGroup {
  group: string;
  count: number;
  items: DataSourcePendingItem[];
  /** 该组本次没有任何文件落入（勾选即清空整组） */
  untouched: boolean;
}

/** 结果概览：hero 大数字 + 分段进度条 + 图例（2026-10-22 视觉改造） */
export interface DataSourceSummary {
  /**
   * hero 分母 = **本轮处理量**（`files.scanned`，恒等式 `completed + incomplete + skipped = scanned`）。
   * ★ 不要用 `fullScanned`：Git 增量同步时它是仓库全量（如 2226），会把「完成 48」显示成 2.2%。
   */
  scanned: number;
  completed: number;
  unchanged: number;
  skipped: number;
  failed: number;
  vectorized: number;
  fullText: number;
}

/** 指标网格单元（3×2），zero 值降权、失败>0 走危险色 */
export interface DataSourceMetric {
  label: string;
  value: number;
  tone?: 'normal' | 'danger';
}

/**
 * group 路径与 sourcePath 合并成文档的逻辑路径。
 *
 * ★ 口径与后端 `src/lib/doc-path.ts::logicalDocPath` 完全一致（前端不能跨端 import 后端 src）：
 *   - sourcePath 已含 group 后缀前缀（`aiops/rca/x.md` @ group `aiops/rca`）→ 原样
 *   - sourcePath 缺 group 前缀（`API文档/x.md` @ group `wiki/API文档`）→ 补 group
 *   - 无 sourcePath（MCP / CLI 写入）→ 退回 `group/name`
 * 按「最长重叠段」判定，不要改成简单字符串拼接 —— 拼接会把 group 重复一层。
 */
export function mergeGroupSourcePath(group: string, sourcePath: string | undefined, name: string): string {
  const split = (value: string): string[] => value.replace(/[\\/]+/g, '/').split('/').map((s) => s.trim()).filter(Boolean);
  const groupSegments = split(group);
  const fileSegments = sourcePath ? split(sourcePath) : split(name);
  let overlap = 0;
  const max = Math.min(groupSegments.length, fileSegments.length);
  for (let size = max; size > 0; size -= 1) {
    if (groupSegments.slice(-size).join('/') === fileSegments.slice(0, size).join('/')) {
      overlap = size;
      break;
    }
  }
  return [...groupSegments, ...fileSegments.slice(overlap)].join('/');
}

/** 待删候选树节点：dir = 目录（group 段或 sourcePath 目录段），file = 候选文档 */
export interface DataSourcePendingTreeNode {
  kind: 'dir' | 'file';
  name: string;
  /** 逻辑路径（已合并 group），目录折叠态与勾选联动都以它为键 */
  path: string;
  children: DataSourcePendingTreeNode[];
  /** 本级直属文档数（file 子节点数） */
  direct: number;
  /** 子树文档总数 */
  total: number;
  /** 仅 file 节点：候选本身（勾选 / 打开正文都用它） */
  item?: DataSourcePendingItem;
}

/**
 * 把待删候选合并成一棵目录树（对齐知识目录形态）。
 *
 * 路径来源：`mergeGroupSourcePath(item.group, item.sourcePath, item.relation)` ——
 * **不能只用 sourcePath 建树**，否则 group 层会重复（护栏 #3）。
 */
export function buildDataSourcePendingTree(items: DataSourcePendingItem[]): DataSourcePendingTreeNode[] {
  const roots: DataSourcePendingTreeNode[] = [];
  const dirs = new Map<string, DataSourcePendingTreeNode>();
  const split = (value: string): string[] => value.replace(/[\\/]+/g, '/').split('/').map((s) => s.trim()).filter(Boolean);

  const ensureDir = (segments: string[]): DataSourcePendingTreeNode | null => {
    let level = roots;
    let path = '';
    let node: DataSourcePendingTreeNode | null = null;
    for (const segment of segments) {
      path = path ? `${path}/${segment}` : segment;
      node = dirs.get(path) ?? null;
      if (!node) {
        node = { kind: 'dir', name: segment, path, children: [], direct: 0, total: 0 };
        dirs.set(path, node);
        level.push(node);
      }
      level = node.children;
    }
    return node;
  };

  for (const item of items) {
    const logical = mergeGroupSourcePath(item.group, item.sourcePath, item.relation);
    const segments = split(logical);
    if (segments.length === 0) continue;
    const parent = ensureDir(segments.slice(0, -1));
    if (!parent) continue;
    parent.children.push({
      kind: 'file',
      name: segments[segments.length - 1],
      path: logical,
      children: [],
      direct: 0,
      total: 0,
      item,
    });
  }

  const countFiles = (nodes: DataSourcePendingTreeNode[]): number => nodes
    .reduce((sum, node) => sum + (node.kind === 'file' ? 1 : countFiles(node.children)), 0);
  const walk = (nodes: DataSourcePendingTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind !== 'dir') continue;
      node.direct = node.children.filter((child) => child.kind === 'file').length;
      node.total = countFiles(node.children);
      walk(node.children);
    }
  };
  walk(roots);
  return roots;
}

export interface DataSourceDetailModel {
  header: { title: string; state: DataSourceStatusState; stateLabel: string; tone: DataSourceStatusTone; active: boolean };
  params: DetailRow[];
  /** 无同步记录时为 null（渲染空态引导） */
  summary: DataSourceSummary | null;
  metrics: DataSourceMetric[];
  results: DetailRow[];
  details: {
    failures: DetailItem[];
    conflicts: DetailItem[];
    /** 上次同步未完成文件总数（failures 服务端最多存 20 条） */
    failureTotal: number;
    /** 冲突/覆盖明细条数（服务端最多存 50 条） */
    conflictTotal: number;
  };
  times: DetailRow[];
  pending: {
    total: number;
    items: DataSourcePendingItem[];
    groups: DataSourcePendingGroup[];
    token?: string;
    computedAt: number;
    overLimit: boolean;
    truncated: boolean;
    blocked: string | null;
    skipDetail?: string;
    /** 待删段展示的拦截文案（与顶部 notice 同源，避免两处各拼一份） */
    blockedText?: string;
    stale: boolean;
    staleReason?: string | null;
    eligibleCount: number;
    untouchedGroups: string[];
  };
  notices: { tone: 'warn' | 'info'; title?: string; text: string }[];
}

export const DATASOURCE_STATE_LABEL: Record<DataSourceSyncState | 'never', string> = {
  never: '从未同步',
  ok: '成功',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
};

export function datasourceStateTone(state: DataSourceStatusState): DataSourceStatusTone {
  switch (state) {
    case 'running': return 'running';
    case 'ok': return 'succeeded';
    case 'partial': return 'partial';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    default: return 'queued';
  }
}

/**
 * 数据源「当前状态」的唯一口径（列表行 / 抽屉头部 / aria-label 共用）：
 * 运行态（排队 / 同步中）优先于上次同步结果；只有空闲且从未同步才是「从未同步」。
 * ★ 不要把 `lastSync.state` 直接当状态渲染——同步进行中它仍是上一版或 null。
 */
export function dataSourceStatusView(input: {
  activeState?: DataSourceActiveState | null;
  running?: boolean;
  lastSync: { state: DataSourceSyncState } | null;
}): DataSourceStatusView {
  const activeState = resolveDataSourceActiveState(input.activeState, input.running);
  if (activeState) {
    return {
      state: activeState,
      label: activeState === 'running' ? '同步中' : '排队中',
      tone: datasourceStateTone(activeState),
      active: true,
    };
  }
  if (input.lastSync) {
    const state = input.lastSync.state;
    return { state, label: DATASOURCE_STATE_LABEL[state], tone: datasourceStateTone(state), active: false };
  }
  return { state: 'never', label: DATASOURCE_STATE_LABEL.never, tone: 'queued', active: false };
}

export interface DataSourceSummaryRow {
  lastSync: { state: DataSourceSyncState } | null;
  activeState?: DataSourceActiveState | null;
  running?: boolean;
  stale: boolean;
}

/**
 * 页头统计口径（与状态列同源）：
 * - 「从未同步」只数**空闲**且无 lastSync 的；同步中的行不算（否则又是「同步中 + 从未同步」同屏）；
 * - 「超过 24h 未同步」只数有上次结果且已过期的；
 * - 同步中 / 排队中分别计数。
 */
export function buildDataSourceListSummary(total: number, sources: DataSourceSummaryRow[]): string {
  let never = 0;
  let staleOver24h = 0;
  let running = 0;
  let queued = 0;
  for (const source of sources) {
    const status = dataSourceStatusView(source);
    if (status.state === 'never') never += 1;
    else if (status.state === 'running') running += 1;
    else if (status.state === 'queued') queued += 1;
    else if (source.stale) staleOver24h += 1;
  }
  return [
    `共 ${total} 个数据源`,
    never > 0 ? `${never} 个从未同步` : '',
    staleOver24h > 0 ? `${staleOver24h} 个超过 24h 未同步` : '',
    running > 0 ? `${running} 个同步中` : '',
    queued > 0 ? `${queued} 个排队中` : '',
  ].filter(Boolean).join(' · ');
}

const CONFLICT_LABEL: Record<string, string> = {
  incremental: '增量（同名覆盖）',
  overwrite: '覆盖已有文档',
  skip: '跳过同名文档',
  suffix: '自动添加后缀',
};

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(ts);
}

/** 用时格式化（抽屉头部元信息与「时间」段共用） */
export function formatSyncDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
}

function failureItems(sync: DataSourceLastSyncView | null): DetailItem[] {
  if (!sync) return [];
  return sync.result.failures.map((item) => ({ title: item.path, meta: item.reason }));
}

function conflictItems(sync: DataSourceLastSyncView | null): DetailItem[] {
  if (!sync) return [];
  return sync.result.conflicts.map((item) => ({
    title: item.path,
    meta: item.unchanged ? '内容未变，已跳过重算' : (item.action === 'overwrite' ? '覆盖' : item.action === 'skip' ? '跳过' : '加后缀'),
  }));
}

export function buildDataSourceDetail(
  record: DataSourceRecordView,
  runtime: DataSourceRuntimeState = {},
): DataSourceDetailModel {
  const sync = record.lastSync;
  const activeState = resolveDataSourceActiveState(runtime.activeState, runtime.running);
  const status = dataSourceStatusView({ activeState, lastSync: sync });
  const pendingDelete = sync?.pendingDelete;
  const items = pendingDelete?.items ?? [];
  const groupMap = new Map<string, DataSourcePendingItem[]>();
  for (const item of items) {
    const list = groupMap.get(item.group) ?? [];
    list.push(item);
    groupMap.set(item.group, list);
  }
  const untouched = new Set(pendingDelete?.untouchedGroups ?? []);
  const groups: DataSourcePendingGroup[] = [...groupMap.entries()].map(([group, groupItems]) => ({
    group,
    count: groupItems.length,
    items: groupItems,
    untouched: untouched.has(group),
  }));

  const notices: DataSourceDetailModel['notices'] = [];
  // 运行态提示放在最前：它解释「为什么头部不是上次结果」「为什么删除候选不可选」
  if (activeState) {
    const lastDataNote = sync ? '；下方执行结果与明细为上次同步数据' : '';
    notices.push({
      tone: 'info',
      text: activeState === 'running'
        ? `${runtime.activeStartedAt ? `同步进行中（本次开始于 ${formatTime(runtime.activeStartedAt)}）` : '同步进行中'}${lastDataNote}`
        : `同步已排队，等待同知识库的其他任务完成${lastDataNote}`,
    });
  }
  if (pendingDelete?.stale) {
    const reason = pendingDelete.staleReason;
    notices.push({
      tone: 'warn',
      text: reason === 'source-missing'
        ? '候选来自上次同步：源目录当前不存在。删除前请确认目录已恢复。'
        : reason === 'source-unreadable'
          ? '候选来自上次同步：源目录当前不可读。删除前请确认目录权限。'
          : '候选来自上次同步：最近一次同步未重算候选。删除前请先重新同步。',
    });
  }
  const blockedText = pendingDelete?.blocked
    ? pendingDelete.skipDetail ?? `未生成候选（${pendingDelete.blocked}）`
    : undefined;
  if (blockedText) {
    notices.push({ tone: 'warn', text: blockedText });
  }
  if (pendingDelete?.overLimit) {
    notices.push({
      tone: 'info',
      text: `候选 ${pendingDelete.total} 篇，超过单次上限：本页显示前 ${items.length} 篇，删除后刷新可继续。`,
    });
  }
  const git = sync?.git;
  if (sync?.warnings && sync.warnings.length > 0) {
    // 服务端给完整 message，前端直出（不在两端各维护一份 code→文案）
    for (const item of sync.warnings) {
      notices.push({ tone: item.code === 'GIT_UNTRACKED_SKIPPED' ? 'info' : 'warn', text: item.message });
    }
  } else if (git) {
    // 旧快照没有 warnings 时的降级展示
    if (git.fetch === 'failed') {
      notices.push({ tone: 'warn', text: `远端更新检查失败：${git.fetchDetail ?? '未知原因'}；本次同步基于本地内容` });
    }
    if (git.update === 'failed') {
      notices.push({ tone: 'warn', text: `自动更新失败：${git.updateDetail ?? '未知原因'}；本地工作区未改动，本次同步本地内容` });
    }
    if (git.untrackedMarkdown > 0) {
      notices.push({ tone: 'info', text: `检测到 ${git.untrackedMarkdown} 个未跟踪文件不参与增量；需要同步请执行全量同步` });
    }
  }
  if (sync?.state === 'partial' && git && git.commit !== git.runCommit) {
    notices.push({ tone: 'warn', text: '本次有未完成文件，commit 水位未推进；下次同步会重试' });
  }
  if (sync && sync.state === 'ok' && sync.result.files.changed === 0 && (sync.result.files.fullScanned ?? 0) > 0) {
    notices.push({ tone: 'info', title: '本次同步无变更', text: `全量扫描 ${sync.result.files.fullScanned} 篇，源目录与知识库内容一致。` });
  }

  const result = sync?.result;
  // 「同步参数」取**上次同步实际使用的参数**（lastSync.params），不是当前登记配置：
  // add 改过策略/切分/落点后二者会不同，用 record 会让人误以为结果来自新配置。
  const p = sync?.params;
  const effGroup = p ? p.group : record.group;
  const effConflict = p ? p.conflictMode : record.conflictMode;
  const effVector = p ? p.vector : record.vector;
  const effChunkSize = p ? p.chunkSize : record.chunkSize;
  const effChunkOverlap = p ? p.chunkOverlap : record.chunkOverlap;
  if (p) {
    const changed = p.group !== record.group
      || p.conflictMode !== record.conflictMode
      || p.vector !== record.vector
      || p.chunkSize !== record.chunkSize
      || p.chunkOverlap !== record.chunkOverlap;
    if (changed) {
      notices.push({ tone: 'info', text: '登记配置已变更：上方为上次同步所用参数，新配置在下次同步生效。' });
    }
  }
  const typeLabel = record.type === 'git' ? 'Git 仓库' : '普通目录';
  const modeLabel = p?.mode === 'incremental' ? '增量' : p?.mode === 'full' ? '全量' : '—';
  const gitRows: DetailRow[] = record.type === 'git' && record.git
    ? [
      {
        // 只显示远端地址（用户要求：不要"托管 clone（服务端维护…）"这类描述）
        label: '仓库来源',
        value: record.git.remoteUrl ?? '本地仓库',
      },
      { label: 'Git 仓库', value: record.git.repoRoot },
      { label: '分支', value: record.git.branch ?? 'detached' },
      {
        label: '最近提交',
        value: git?.shortCommit ? `${git.shortCommit}${git.subject ? ` · ${git.subject}` : ''}` : '—',
        hint: git?.authorTime ? formatTime(git.authorTime) : undefined,
      },
    ]
    : [];
  // 顺序与两列栅格对齐（2026-10-22 视觉改造）：短字段两列、长字段独占整行。
  // ★ 源目录不再出现在这里 —— 抽屉头部已展示（mono + 复制按钮），重复展示是冗余。
  const params: DetailRow[] = [
    { label: '类型', value: typeLabel },
    { label: '同步模式', value: modeLabel },
    { label: '知识库', value: record.scope },
    { label: '同名策略', value: CONFLICT_LABEL[effConflict] ?? effConflict },
    { label: '向量化', value: effVector ? '开启' : '关闭（仅全文）' },
    { label: '切分参数', value: `${effChunkSize ?? 1000} / ${effChunkOverlap ?? 150}` },
    ...gitRows,
    // 落点 Group 放最后：它是"这条数据源写到哪里"的结论，放在参数末尾读起来更顺
    { label: '落点 Group', value: effGroup ?? '自动：按顶层子目录', full: true },
  ];

  const fullScanned = result ? (result.files.fullScanned ?? result.files.scanned) : 0;
  const changed = result ? (sync?.git?.changedCount ?? result.files.changed ?? result.files.scanned) : 0;
  // 目录源没有 diff 语义：不展示「本次变更」（否则会显示 fullScanned，看起来像 250 篇都变了）
  const results: DetailRow[] = result
    ? [
      { label: '全量扫描', value: String(fullScanned) },
      ...(record.type !== 'directory'
        ? [{
          label: '本次变更',
          value: String(changed),
          hint: result.files.changed === undefined ? '旧快照无增量字段，按导入基准显示' : undefined,
        }]
        : []),
      { label: '处理', value: String(result.files.scanned) },
      { label: '完成', value: String(result.files.completed), hint: result.files.unchanged > 0 ? `其中内容未变 ${result.files.unchanged} 篇` : undefined },
      { label: '跳过', value: String(result.files.skipped) },
      { label: '失败', value: String(result.files.incomplete), tone: result.files.incomplete > 0 ? 'danger' : 'normal' },
      { label: '向量条目', value: String(result.vectorized) },
      { label: '全文条目', value: String(result.fullTextIndexed) },
    ]
    : [];

  // 概览与指标把「完成 / 未变 / 跳过 / 失败」拆成可比较的数字：
  // hero 表达"这次同步到底成了多少"，指标网格补齐其余维度（完成不在网格里，避免与 hero 重复）
  // ★ 分母取 files.scanned（本轮处理量），与任务详情同源；fullScanned 只作「全量扫描」明细。
  const summary: DataSourceSummary | null = result
    ? {
      scanned: result.files.scanned,
      completed: result.files.completed,
      unchanged: result.files.unchanged,
      skipped: result.files.skipped,
      failed: result.files.incomplete,
      vectorized: result.vectorized,
      fullText: result.fullTextIndexed,
    }
    : null;
  const metrics: DataSourceMetric[] = result
    ? [
      { label: '全量扫描', value: fullScanned },
      { label: '处理', value: result.files.scanned },
      { label: '跳过', value: result.files.skipped },
      { label: '失败', value: result.files.incomplete, tone: result.files.incomplete > 0 ? 'danger' : 'normal' },
      { label: '向量条目', value: result.vectorized },
      { label: '全文条目', value: result.fullTextIndexed },
    ]
    : [];

  const times: DetailRow[] = sync
    ? [
      { label: '上次同步', value: formatTime(sync.at) },
      { label: '用时', value: formatSyncDuration(sync.durationMs) },
    ]
    : [{ label: '上次同步', value: '—' }];

  return {
    header: {
      title: '数据源同步',
      state: status.state,
      stateLabel: status.label,
      tone: status.tone,
      active: status.active,
    },
    params,
    summary,
    metrics,
    results,
    details: {
      failures: failureItems(sync),
      conflicts: conflictItems(sync),
      failureTotal: sync?.result.files.incomplete ?? 0,
      conflictTotal: sync?.result.conflicts.length ?? 0,
    },
    times,
    pending: {
      total: pendingDelete?.total ?? 0,
      items,
      groups,
      token: pendingDelete?.token,
      computedAt: pendingDelete?.computedAt ?? 0,
      overLimit: pendingDelete?.overLimit ?? false,
      truncated: pendingDelete?.truncated ?? false,
      blocked: pendingDelete?.blocked ?? null,
      skipDetail: pendingDelete?.skipDetail,
      blockedText,
      stale: pendingDelete?.stale ?? false,
      staleReason: pendingDelete?.staleReason ?? null,
      eligibleCount: pendingDelete?.eligibleCount ?? 0,
      untouchedGroups: pendingDelete?.untouchedGroups ?? [],
    },
    notices,
  };
}
