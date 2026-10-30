/**
 * 任务列表的查询模型（2026-10-30）
 *
 * 背景：「统计卡」从纯展示升级为筛选入口后，筛选 / 搜索 / 排序的判据不能散在 JSX 里——
 * 卡片计数、列表过滤、空态文案必须用**同一个判据**，否则会出现「卡上写 3、点进去 2 条」。
 * 与 `taskListModel.ts`（行文案）分工：本模块只管「哪些行、什么顺序」，不碰文案格式。
 *
 * ★ 口径约定：
 *   - 筛选态只有 4 个（全部 / 失败·未知 / 部分完成 / 进行中·排队）；
 *     原「最近结束」与「全部」差异仅在运行中的少数行，已按用户 2026-10-30 决定删除。
 *   - 搜索支持状态关键词（输入「失败」「进行中」也能命中），别名表见 `STATE_SEARCH_ALIAS`。
 *   - 排序固定「默认降序」：切换列时回到 desc；无持续时间的行（运行中 / 排队中）永远排末尾。
 */
import type { TaskRecord, TaskState } from '@/api/tasksApi';

/* ══════════ 筛选 ══════════ */

export type TaskFilter = 'all' | 'failed' | 'partial' | 'running';

export interface TaskFilterDef {
  key: TaskFilter;
  /** 卡片标题（列表工具条与空态文案复用） */
  label: string;
  /** 未选中时的副行提示 */
  hint: string;
  match(task: TaskRecord): boolean;
}

/**
 * 卡片即筛选入口：顺序固定「全部任务」在最左（用户 2026-10-30 要求），
 * 其余按「需处理 → 可重试 → 进行中」排列。
 */
export const TASK_FILTERS: readonly TaskFilterDef[] = [
  {
    key: 'all',
    label: '全部任务',
    hint: '默认',
    match: () => true,
  },
  {
    key: 'failed',
    label: '失败 / 状态未知',
    hint: '需处理',
    match: (task) => task.state === 'failed' || task.state === 'unknown',
  },
  {
    key: 'partial',
    label: '部分完成',
    hint: '可重试',
    match: (task) => task.state === 'partial',
  },
  {
    key: 'running',
    label: '运行中 / 排队中',
    hint: '进行中',
    match: (task) => task.state === 'queued' || task.state === 'running',
  },
];

export function matchesTaskFilter(task: TaskRecord, filter: TaskFilter): boolean {
  const def = TASK_FILTERS.find((item) => item.key === filter);
  return def ? def.match(task) : true;
}

/** 卡片上的数字：与列表过滤同一判据，避免两套口径 */
export function countTasks(tasks: readonly TaskRecord[], filter: TaskFilter): number {
  return tasks.filter((task) => matchesTaskFilter(task, filter)).length;
}

export function taskFilterLabel(filter: TaskFilter): string {
  return TASK_FILTERS.find((item) => item.key === filter)?.label ?? '全部任务';
}

/* ══════════ 搜索 ══════════ */

/**
 * 状态关键词别名：搜索框输入「失败」「进行中」「排队」都能命中。
 * 只覆盖**状态语义**，不替代卡片筛选（卡片的「失败 / 状态未知」是一组，搜索按行匹配）。
 */
const STATE_SEARCH_ALIAS: Record<TaskState, readonly string[]> = {
  queued: ['排队中', '排队', 'queued'],
  running: ['运行中', '进行中', 'running'],
  succeeded: ['已完成', '成功', 'succeeded'],
  partial: ['部分完成', 'partial'],
  failed: ['失败', 'failed'],
  cancelled: ['已取消', '取消', 'cancelled'],
  unknown: ['状态未知', '未知', 'unknown'],
};

/** 搜索用的行文案（由展示层 `buildTaskListRow` 提供，本模块不重复做文案映射） */
export interface TaskSearchText {
  /** 结果摘要单行（含「成功 N」「新增文档 N 篇」，可被搜到） */
  summary: string;
  /** 来源中文名（网页 / CLI / 后台服务 / 定时同步） */
  sourceText: string;
  /** 操作中文名（上传导入 / 数据源同步 / 向量重建…） */
  operationText: string;
}

/**
 * 搜索命中判据：知识库 / 错误 / 摘要 / 来源 / 操作 / 状态关键词。
 * 支持状态词是用户 2026-10-30 明确要求（输入「失败」「进行中」即可过滤）。
 */
export function matchesTaskSearch(
  task: TaskRecord,
  rawQuery: string,
  text: TaskSearchText,
): boolean {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return true;
  const haystack = [
    task.scope,
    task.error,
    text.summary,
    text.sourceText,
    text.operationText,
    task.operation,
    ...(STATE_SEARCH_ALIAS[task.state] ?? []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

/* ══════════ 排序 ══════════ */

export type TaskSortKey = 'start' | 'duration';

export interface TaskSortState {
  key: TaskSortKey;
  dir: 'asc' | 'desc';
}

/** 默认按开始时间降序：最新任务在最前（用户 2026-10-30 要求） */
export const DEFAULT_TASK_SORT: TaskSortState = { key: 'start', dir: 'desc' };

/** 开始时间：优先 startedAt，排队中退回 createdAt（与列表时间列同口径） */
export function taskStartTime(task: TaskRecord): number {
  return task.startedAt ?? task.createdAt ?? 0;
}

/**
 * 持续时间秒数：终态才有值（运行中 / 排队中 / 缺失时间戳 → null）。
 * null 的行排序时**固定排在末尾**，不随升降序翻转（`—` 混在 45s 与 0.4s 之间没有意义）。
 */
export function taskDurationSeconds(task: TaskRecord): number | null {
  if (task.startedAt === undefined || task.finishedAt === undefined) return null;
  const delta = task.finishedAt - task.startedAt;
  if (!Number.isFinite(delta) || delta < 0) return null;
  // 与列表「<1s」显示口径对齐：不足 1s 记 0.4，避免与 1s 并列时顺序抖动
  return delta < 1000 ? 0.4 : delta / 1000;
}

/** 点表头：同列翻转方向，换列则切过去并回到默认降序 */
export function nextTaskSort(current: TaskSortState, key: TaskSortKey): TaskSortState {
  if (current.key === key) return { key, dir: current.dir === 'desc' ? 'asc' : 'desc' };
  return { key, dir: 'desc' };
}

export function sortTasks(tasks: readonly TaskRecord[], sort: TaskSortState): TaskRecord[] {
  const dir = sort.dir === 'asc' ? 1 : -1;
  return [...tasks].sort((a, b) => {
    if (sort.key === 'duration') {
      const left = taskDurationSeconds(a);
      const right = taskDurationSeconds(b);
      if (left === null && right === null) return taskStartTime(b) - taskStartTime(a);
      if (left === null) return 1;
      if (right === null) return -1;
      return (left - right) * dir;
    }
    return (taskStartTime(a) - taskStartTime(b)) * dir;
  });
}

/* ══════════ 组合 ══════════ */

export interface TaskQueryInput {
  tasks: readonly TaskRecord[];
  filter: TaskFilter;
  query: string;
  sort: TaskSortState;
  /** 行文案（搜索用），由 `buildTaskListRow` 提供，避免本模块依赖展示层 */
  describe(task: TaskRecord): TaskSearchText;
}

/** 筛选 → 搜索 → 排序，返回新数组（不修改入参） */
export function queryTasks(input: TaskQueryInput): TaskRecord[] {
  const filtered = input.tasks.filter((task) => matchesTaskFilter(task, input.filter));
  const searched = input.query.trim()
    ? filtered.filter((task) => matchesTaskSearch(task, input.query, input.describe(task)))
    : filtered;
  return sortTasks(searched, input.sort);
}

/* ══════════ 分页栏可见性 ══════════ */

export interface TaskPagerVisibilityInput {
  /** 列表请求进行中（首屏 pending） */
  loading: boolean;
  /** 列表请求失败 */
  hasError: boolean;
  /** **当前筛选下**的条数（`visibleTasks.length`，不是后端 total） */
  visibleCount: number;
}

/**
 * 分页栏是否渲染（用户 2026-10-30 口径，两次反转后定稿）：
 *   - **0 条时整条收起** —— 空态卡片已经说明「暂无任务」，再画一条
 *     「第 1/1 页 · 共 0 个任务 / 上一页(禁用) / ① / 下一页(禁用)」是自相矛盾的噪音；
 *   - **有数据时即使只有 1 页也显示** —— 保留「每页」选择器，否则用户把每页改成
 *     50/100、或筛选后只剩几条时，选择器随之消失，本会话内再也改不回 10；
 *   - 加载中 / 失败不渲染（各自有专门提示，此时的页数没有意义）。
 *
 * ★ 判据必须用 `visibleCount`（当前筛选），不能用后端 `total`：筛到 0 条时表体是空态卡片，
 *   分页栏却会显示「共 0 个任务」，两者由不同数据源驱动必然对不上。
 */
export function shouldShowTaskPager(input: TaskPagerVisibilityInput): boolean {
  if (input.loading || input.hasError) return false;
  return input.visibleCount > 0;
}
