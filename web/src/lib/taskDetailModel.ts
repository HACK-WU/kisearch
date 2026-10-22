/**
 * 任务详情渲染模型（REQ-20261019-004 S-03）
 *
 * 为什么要有这一层：`TasksPage` 的详情从 8 个字段扩到 ~18 个，若判定写在 JSX 里，
 * 「进度单位」「跳过原因拆分」「缺字段兜底」这些口径无法被单测锁死。
 * 本项目有过教训：`verify-import-form-reset.cjs` 曾把错误的默认值锁成期望值。
 *
 * 原则：组件只渲染本文件的输出，不再做条件判断。
 */
import type { TaskIndexReadiness, TaskRecord, TaskResultSnapshot, TaskState } from '@/api/tasksApi';

export type DetailTone = 'normal' | 'warn' | 'danger';

export interface DetailRow {
  label: string;
  value: string;
  /** 次要说明（如「其中内容未变 9 篇」） */
  hint?: string;
  tone?: DetailTone;
  /** 可跳转目标（R9：知识库 → Browse 页） */
  href?: string;
  /**
   * 独占整行（`grid-column: 1 / -1`）。
   * 双列栅格里出现长值会把同行的另一格一起拉高、空出一大片（实测「落点 Group」
   * 曾把右侧「标签」拉到 451px 高只放一行字），长值必须自己占满整行。
   */
  full?: boolean;
  /**
   * 多值路径列表（如落点 Group）：渲染为**可折叠的层级树**，`value` 留空。
   * 不用 ` / ` 串联也不用胶囊流——落点本来就是一棵树，压平后看不出
   * `stages` 是 `stages/1-入门与模型层` 的父级（实测同一任务：串联 507px、
   * 胶囊 474px/最宽 303px 撑满卡片、树 418px/最宽 22 字符）。
   * `summary` 由 model 给：折叠文案里的量词（「20 个 Group」）也是口径，不该写死在 JSX 里。
   * ★ `summary` 为 undefined ⇒ **不折叠直接摊开**：只有 2~3 个落点还让人多点一次是负担
   *   （真实台账里 `ui-prune-test` 这类任务全是 3 个落点），摊开也只占 3 行。
   */
  tree?: { items: string[]; summary?: string };
}

export interface DetailItem {
  title: string;
  meta?: string;
}

export interface TaskNotice {
  tone: 'info' | 'warn' | 'danger';
  text: string;
}

export interface TaskDetailView {
  /** 旧记录：终态且既无 params 也无 result（台账扩展前创建） */
  legacy: boolean;
  params: DetailRow[];
  results: DetailRow[];
  times: DetailRow[];
  duplicates: DetailItem[];
  conflicts: DetailItem[];
  notices: TaskNotice[];
  showProgress: boolean;
  progressText: string;
  progressPercent: number | null;
}

const TERMINAL_STATES = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

const PHASE_LABEL: Record<string, string> = {
  scan: '扫描',
  vectorize: '向量化',
  persist: '写入',
  clone: '克隆仓库',
  'queued-sync': '排队首次同步',
  'git-fetch': '拉取远端',
  'git-update': '更新工作区',
  'git-diff': '计算变更',
  restore: '恢复',
  rebuild: '重建',
  indexing: '索引整理中',
  optimized: '已优化',
  // `available` 现在只表示「已入队整理但失败/超时」；「未触发」走 skipped（2026-10-19 收窄语义）
  available: '索引未优化（文档可用）',
  skipped: '未触发索引整理',
};

const CONFLICT_MODE_LABEL: Record<string, string> = {
  incremental: '增量导入',
  suffix: '自动添加后缀',
  overwrite: '覆盖已有文档',
  skip: '跳过同名',
};

const SOURCE_LABEL: Record<TaskRecord['source'], string> = {
  web: '网页',
  cli: 'CLI',
  daemon: '后台服务',
};

/** 来源中文名（列表行与详情共用，避免两套映射） */
export function sourceLabel(source: TaskRecord['source']): string {
  return SOURCE_LABEL[source] ?? source;
}

const STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

/** 任务状态中文名（列表、抽屉头部共用） */
export function stateLabel(state: TaskState): string {
  return STATE_LABEL[state] ?? state;
}

const OPERATION_LABEL: Record<string, string> = {
  import: '上传导入',
  'rebuild-vector': '向量重建',
  'restore-snapshot': '快照还原',
  'datasource-sync': '数据源同步',
  'datasource-add-remote': '添加 Git 数据源',
};

/** 任务操作中文名（列表、抽屉头部共用） */
export function operationLabel(operation: string): string {
  return OPERATION_LABEL[operation] ?? operation;
}

const SOURCE_KIND_LABEL: Record<'upload' | 'external', string> = {
  upload: '浏览器上传（暂存目录）',
  external: '外部目录',
};

/** 明细不完整时的统一文案（不区分「超 20 条」与「字节预算裁剪」） */
const TRUNCATED_HINT = '明细未完整显示';

/** 落点少于此值时直接摊开（折叠一次的成本 > 多出来的两三行） */
const GROUP_TREE_COLLAPSE_THRESHOLD = 4;

function dash(value: unknown): string {
  if (value === undefined || value === null || value === '') return '—';
  if (typeof value === 'number' && !Number.isFinite(value)) return '—';
  return String(value);
}

function phaseLabel(phase?: string): string {
  if (!phase) return '—';
  return PHASE_LABEL[phase] ?? phase;
}

/**
 * 索引就绪文案（沿用既有口径）：`unknown`（读取失败/超时）**不得**显示成「未建」——
 * 两者对用户的操作指引完全相反（未建 → 去整理；未知 → 稍后重试诊断）。
 */
export function indexReadinessLabel(readiness?: TaskIndexReadiness): string {
  if (!readiness) return '—';
  if (readiness.unknown) return '未知（读取超时/失败，稍后重试）';
  return readiness.denseIndexed
    ? `已建（dense ${readiness.completeness?.dense ?? 1}）`
    : '未建（可执行 ki index-optimize 整理）';
}

function timeLabel(value?: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(value);
}

function timeOnly(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium' }).format(value);
}

/** 「10/20」——只有跨天判断需要日期时，才把它挪到 hint 里（列宽 163px） */
function dayLabel(value: number): string {
  return new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit' }).format(value);
}

function sameDay(a: number, b: number): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString();
}

/**
 * 时间区间：同一天**不重复打印日期**。
 * 原实现写成 `2026/10/20 16:56:07 → 2026/10/20 16:56:07`：既看不出这是「同一时刻还是
 * 跨了整天」，在双列栅格 163px 的列宽里又必然折行（实测断成「…16:56:07 →」/「16:56:07」）。
 * 现在同一天只留时间，日期由调用方放进 hint。
 */
function rangeLabel(from: number, to: number): string {
  return sameDay(from, to) ? `${timeOnly(from)} → ${timeOnly(to)}` : `${timeLabel(from)} → ${timeLabel(to)}`;
}

function durationLabel(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function conflictModeLabel(mode?: string): string {
  if (!mode) return '—';
  return CONFLICT_MODE_LABEL[mode] ?? mode;
}

function isLegacy(task: TaskRecord): boolean {
  /**
   * ★ 只对 `import` 判定（code-review P0-1 核实成立）：`toParamSnapshot` / `toResultSnapshot`
   *   对 rebuild-vector / restore-snapshot **按设计返回 undefined**，所以"缺失"不等于
   *   "台账扩展前创建"——把不适用误读成未记录，会让所有重建/还原任务挂上「旧记录」提示。
   */
  return task.operation === 'import'
    && TERMINAL_STATES.has(task.state)
    && task.params === undefined
    && task.result === undefined;
}

/** 进度：单位随 phase 变化（scan=篇 / vectorize=段 / persist=无意义），终态一律不显示 */
function progressOf(task: TaskRecord): { show: boolean; text: string; percent: number | null } {
  const progress = task.progress;
  const percentOf = (): number | null => {
    if (!progress || progress.total <= 0) return null;
    return Math.min(100, Math.round((progress.done / progress.total) * 100));
  };
  if (task.state === 'queued') {
    return { show: false, text: '排队中，等待同知识库的写入任务完成', percent: null };
  }
  if (task.state === 'unknown') {
    return { show: false, text: '心跳丢失，最终结果未知；记录可能不完整', percent: null };
  }
  if (TERMINAL_STATES.has(task.state)) {
    // 有结果摘要 ⇒ 由结果段承载，不再显示阶段进度（终态进度条无意义）
    if (task.result) return { show: false, text: '', percent: null };
    // 旧记录：保留阶段信息，但绝不显示 `persist 1/1` 这类误导值。
    // 无 phase 时按是否已结束给文案——终态任务说「等待开始」是错的（code-review P0 复核时发现）。
    const phase = task.phase ? phaseLabel(task.phase) : (task.finishedAt ? '已结束' : '等待开始');
    const percent = percentOf();
    return {
      show: percent !== null && percent < 100,
      text: percent === null ? phase : `${phase} · ${percent}%`,
      percent,
    };
  }
  const phase = progress?.phase ?? task.phase;
  const percent = percentOf();
  if (phase === 'persist') return { show: false, text: '写入元数据', percent: null };
  const unit = phase === 'scan' ? '篇' : phase === 'vectorize' ? '段' : '';
  if (progress && progress.total > 0) {
    return {
      show: true,
      text: `${phaseLabel(phase)} ${progress.done}/${progress.total}${unit ? ` ${unit}` : ''}`,
      percent,
    };
  }
  return { show: false, text: phase ? phaseLabel(phase) : '处理中', percent: null };
}

function paramRows(task: TaskRecord): DetailRow[] {
  const params = task.params;
  // R9：知识库可一键跳到 Browse（scope 合法才给链接，非法时退化为纯文本）
  const rows: DetailRow[] = [{
    label: '知识库',
    value: dash(task.scope),
    ...(task.scope && task.scope !== 'unknown'
      ? { href: `/browse?scope=${encodeURIComponent(task.scope)}` }
      : {}),
  }];
  const sourceText = params?.sourceKind
    ? `${SOURCE_LABEL[task.source]} · ${SOURCE_KIND_LABEL[params.sourceKind]}`
    : SOURCE_LABEL[task.source];
  rows.push({ label: '来源', value: sourceText });
  if (params) {
    rows.push({
      label: 'Group',
      value: params.group ? dash(params.group) : '未指定（按源目录派生）',
      // 只给数量、指向下方结果段：整份落点曾在这里再抄一遍（601 字 / 435px），
      // 与「执行结果 → 落点 Group」完全重复，还把双列栅格拉断。
      ...(task.result?.groups && task.result.groups.length > 0
        ? { hint: `实际落点 ${task.result.groups.length} 个 Group（见下方执行结果）` }
        : {}),
    });
    rows.push({ label: '标签', value: params.tags && params.tags.length > 0 ? params.tags.join(' / ') : '未设置' });
    rows.push({
      label: '向量',
      value: params.vector === false ? '仅全文索引（未写 dense）' : params.vector === true ? '已开启（dense）' : '—',
    });
    const mode = conflictModeLabel(params.conflictMode);
    rows.push({
      label: '同名策略',
      value: params.conflictMode === 'suffix' && params.conflictSuffix ? `${mode}（模板 ${params.conflictSuffix}）` : mode,
    });
    rows.push({ label: '疑似重复', value: params.skipDuplicates ? '已启用跳过' : '未启用' });
    if (task.retryOf) {
      rows.push({
        label: '重试自',
        value: `${task.retryOf.slice(0, 8)}…`,
        hint: '原任务保留 1 小时，可能已清理',
      });
    }
  }
  return rows;
}

function skippedHint(files: NonNullable<TaskResultSnapshot['files']>): string | undefined {
  const reasons = files.skippedReasons;
  if (!reasons) return undefined;
  return `同名 ${reasons.conflict} / 疑似重复 ${reasons.duplicate} / 其他 ${reasons.other}`;
}

function resultRows(task: TaskRecord): DetailRow[] {
  const result = task.result;
  const rows: DetailRow[] = [];
  /**
   * `partialCommitted` 是台账里既有的跨 operation 结果量（导入=向量条目数，restore/rebuild=成功条目数）。
   * 它不走 `result` 快照（S-02 D2-4 只给 import 写 result），所以必须单独兜住——
   * 否则重写详情后，重建/还原任务的「已提交条目」会凭空消失（auto-review 抓出的回归）。
   */
  if (task.partialCommitted !== undefined && result?.vectorized === undefined) {
    rows.push({
      label: task.operation === 'import' ? '向量条目' : '已提交条目',
      value: String(task.partialCommitted),
    });
  }
  if (!result) return rows;
  const files = result.files;
  if (files) {
    rows.push({ label: '文件', value: `扫描 ${files.scanned} 篇` });
    rows.push({
      label: '成功',
      // ★ 内容未变必须与「成功」并列展示：默认策略是增量导入，否则用户会把
      //   "改了文档没生效"误判成 Bug（REQ §3.1 R1.1）
      value: `${files.completed} 篇`,
      ...(files.unchanged > 0 ? { hint: `其中内容未变 ${files.unchanged} 篇（未重算）` } : {}),
    });
    rows.push({
      label: '未完成',
      value: `${files.incomplete} 篇`,
      tone: files.incomplete > 0 ? 'warn' : 'normal',
    });
    rows.push({
      label: '跳过',
      value: `${files.skipped} 篇`,
      ...(skippedHint(files) ? { hint: skippedHint(files) } : {}),
    });
  }
  if (result.vectorized !== undefined) rows.push({ label: '向量条目', value: dash(result.vectorized) });
  if (result.fullTextIndexed !== undefined) rows.push({ label: '全文索引', value: `${result.fullTextIndexed} 条` });
  // 0 个附件不占一行（关闭附件收集与「一张都没复制」在详情里没有区分价值）
  if (result.assets) rows.push({ label: '附件', value: `复制 ${result.assets} 个` });
  // 落点经常是几十个层级路径：`value` 留空，由渲染层折叠成摘要 + 层级树
  if (result.groups && result.groups.length > 0) {
    rows.push({
      label: '落点 Group',
      value: '',
      tree: {
        items: result.groups,
        ...(result.groups.length >= GROUP_TREE_COLLAPSE_THRESHOLD
          ? { summary: `全部 ${result.groups.length} 个 Group` }
          : {}),
      },
      full: true,
    });
  }
  // 索引行只在有诊断数据时出现：`—` 对用户没有信息量（code-review P2）
  if (task.indexReadiness) rows.push({ label: '索引', value: indexReadinessLabel(task.indexReadiness) });
  return rows;
}

function timeRows(task: TaskRecord): DetailRow[] {
  const rows: DetailRow[] = [];
  const created = task.createdAt;
  const startAt = task.startedAt;
  const waiting = startAt !== undefined && startAt >= created ? startAt - created : undefined;
  if (startAt === undefined) {
    rows.push({ label: '创建', value: timeLabel(created), hint: '尚未开始执行' });
  } else {
    // 同一天时区间里只剩时间，日期挪到这里——否则「2026/10/20 16:56:07 → 16:56:07」
    // 在半宽列里必然折行（实测）。
    const hintParts = [
      ...(sameDay(created, startAt) ? [dayLabel(created)] : []),
      ...(waiting !== undefined ? [`排队 ${durationLabel(waiting)}`] : []),
    ];
    rows.push({
      label: '创建 → 开始',
      value: rangeLabel(created, startAt),
      ...(hintParts.length > 0 ? { hint: hintParts.join(' · ') } : {}),
    });
  }
  const finished = task.finishedAt;
  const ran = finished !== undefined && startAt !== undefined ? finished - startAt : undefined;
  rows.push({
    label: '结束',
    // 与创建同一天：日期已在上一行 hint 里，这里不再重复
    value: finished === undefined ? '—' : sameDay(created, finished) ? timeOnly(finished) : timeLabel(finished),
    ...(ran !== undefined ? { hint: `执行 ${durationLabel(ran)}` } : {}),
  });
  return rows;
}

/**
 * 错误文案可读化：`safeErrorSummary` 的兜底句「请查看发起端的命令输出或服务日志」
 * 对网页用户无效（没有发起端）。该句只在 CLI 来源保留，其余替换为可执行文案。
 */
function readableError(task: TaskRecord): string | undefined {
  const raw = task.error;
  if (!raw) return undefined;
  const cliFallback = /查看发起端的命令输出或服务日志/.test(raw);
  if (cliFallback && task.source !== 'cli') {
    return '任务失败（未记录可判别原因）；可重新导入，或查看下方可用的处理入口。';
  }
  return raw;
}

/** 错误码 → 结论文案（challenger 意见：`ALL_FILES_DUPLICATES` 不是故障，不得红态） */
function noticesOf(task: TaskRecord): TaskNotice[] {
  const notices: TaskNotice[] = [];
  const errorCode = task.result?.errorCode;
  if (errorCode === 'ALL_FILES_DUPLICATES') {
    notices.push({ tone: 'warn', text: '本批全部为疑似重复，未写入任何文件。如需建副本，请重新导入并选择「仍然导入」。' });
  } else if (errorCode === 'IMPORT_CANCELLED') {
    notices.push({ tone: 'info', text: '导入已取消；已完成部分已保留。' });
  }
  const errorText = readableError(task);
  if (errorText) {
    const tone: TaskNotice['tone'] = errorCode === 'ALL_FILES_DUPLICATES' || errorCode === 'IMPORT_CANCELLED' ? 'warn' : 'danger';
    // 失败/取消路径没有文件级统计（result.files 缺失是预期），N/M 只存在于 error 文案里
    notices.push({ tone, text: errorText });
  }
  // ★ 与错误文案**并列**而非互斥：前者是原因，后者解释「为什么没有数字」。
  //   实测踩过：写成 else-if 后，任何带 error 的失败任务都看不到这句（走查 A2 抓出）。
  // ★ 只对 `import` 判定（code-review P0-1）：重建/还原没有"文件级"概念，不该出现这句。
  if (task.operation === 'import'
    && TERMINAL_STATES.has(task.state)
    && !task.result?.files
    && task.state !== 'succeeded') {
    notices.push({ tone: 'info', text: '文件级明细不可用（任务未完成元数据提交）。' });
  }
  if (task.recoveryHint) notices.push({ tone: 'warn', text: task.recoveryHint });
  if (task.state === 'partial' && !task.error) notices.push({ tone: 'warn', text: '部分完成：已完成的部分可用。' });
  return notices;
}

/** 路径去掉文件扩展名（`a/b.md` → `a/b`），用于判断库里位置是否只是把源路径抄了一遍 */
function stripExtension(path: string): string {
  return path.replace(/\.[^./]+$/, '');
}

function detailItemsOf(task: TaskRecord): { duplicates: DetailItem[]; conflicts: DetailItem[] } {
  /**
   * ★ 说明里的路径要**去冗余**（2026-10-20 实测）：疑似重复绝大多数就是「同一落点」，
   *   `existingGroup/existingRelation` 拼回来与源 `path` 逐字相同；原来无条件打全路径，
   *   在 380px 卡片里每条明细被撑成 4 行（树已经写过一次目录，等于抄第三遍）。
   *   真要指向别处（跨 Group 重复）才把位置写出来。
   */
  const duplicates: DetailItem[] = (task.result?.duplicates ?? []).map((item) => {
    const existing = item.existingGroup ? `${item.existingGroup}/${item.existingRelation}` : item.existingRelation;
    const samePath = existing === stripExtension(item.path) || existing === item.path;
    return { title: item.path, meta: samePath ? '库中已有同一路径' : `库中已有：${existing}` };
  });
  const conflicts: DetailItem[] = (task.result?.conflicts ?? []).map((item) => {
    // `unchanged` 优先：判定为覆盖但实际被「内容未变」跳过，不能说"已覆盖"（debug 2026-10-19）
    const action = item.unchanged
      ? '内容未变，跳过重算'
      : item.action === 'suffix' ? '已改名' : item.action === 'skip' ? '已跳过' : '已覆盖';
    const rewritten = item.relation === stripExtension(item.path) || item.relation === item.path;
    return { title: item.path, meta: rewritten ? `→ ${action}` : `→ ${item.relation}（${action}）` };
  });
  return { duplicates, conflicts };
}

/** 树的一行：`text` 是带 `├ └ │` 前缀的路径片段，`meta` 是挂在条目行上的说明 */
export interface TreeLine {
  text: string;
  /** 该行是否对应一条真实明细条目（中间目录行没有） */
  item: boolean;
  /** 条目行才有的说明（`库中已有：raw/a` / `→ a（已覆盖）`） */
  meta?: string;
}

/**
 * 路径集合 → 层级树（`├` `└` `│`）。
 *
 * 为什么是树：落点 Group 与导入明细（疑似重复 / 同名冲突）**本来就是一棵树**
 * （`stages` 是 `stages/1-入门与模型层` 的父级），` / ` 串联和胶囊流都在把树压平。
 * 实测同一任务 20 个落点（380px 卡片）：串联成段 507px（看不出层级）· 胶囊流
 * 474px / 最宽 303px（占卡片 80%，一条一行）· 树形 418px / 最宽 22 字符（不折行）。
 *
 * 顶层只有一个根时（如全部落在 `langchain/` 下）不画连接符，顶端直接写根名——
 * 否则会出现「一棵只有一层分支的树」，多两个字符的缩进却读不出任何结构。
 */
export function buildPathTree(entries: { path: string; meta?: string }[]): TreeLine[] {
  /** `entry` 与 `meta` 解耦：说明可以没有，但「这一行是不是一条真实条目」不能靠说明推断 */
  interface TreeNode { name: string; children: Map<string, TreeNode>; meta?: string; entry: boolean }
  const root: TreeNode = { name: '', children: new Map(), entry: false };
  for (const entry of entries) {
    const segments = entry.path.split('/').filter(Boolean);
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments) {
      let child = node.children.get(segment);
      if (!child) {
        child = { name: segment, children: new Map(), entry: false };
        node.children.set(segment, child);
      }
      node = child;
    }
    node.entry = true;
    // 同一条路径出现多次（不会发生，但别静默丢说明）：保留第一条非空 meta
    if (node.meta === undefined && entry.meta !== undefined) node.meta = entry.meta;
  }

  const lines: TreeLine[] = [];
  const walk = (node: TreeNode, prefix: string): void => {
    const children = [...node.children.values()];
    children.forEach((child, index) => {
      const last = index === children.length - 1;
      lines.push({
        text: `${prefix}${last ? '└ ' : '├ '}${child.name}`,
        item: child.entry,
        ...(child.meta !== undefined ? { meta: child.meta } : {}),
      });
      walk(child, `${prefix}${last ? '   ' : '│  '}`);
    });
  };

  const roots = [...root.children.values()];
  if (roots.length === 1) {
    // 单根直接写根名，同样要带上它自己的 meta（单条目时它就是叶子）
    const [only] = roots;
    lines.push({
      text: only.name,
      item: only.entry,
      ...(only.meta !== undefined ? { meta: only.meta } : {}),
    });
    walk(only, '');
  } else {
    walk(root, '');
  }
  return lines;
}

/**
 * 落点 Group 等纯路径列表：只要文本（渲染为 `<pre>`）。
 * ★ 命名带 `Lines`：`lib/groupTree.ts` 已有一个**同名但语义完全不同**的 `buildGroupTree`
 *   （返回 `GroupTreeNode` 树，供浏览页/搜索页用），两个模块同名导出极易 import 错。
 */
export function buildGroupTreeLines(paths: string[]): string[] {
  return buildPathTree(paths.map((path) => ({ path }))).map((line) => line.text);
}

export function buildTaskDetail(task: TaskRecord): TaskDetailView {
  const legacy = isLegacy(task);
  const progress = progressOf(task);
  const notices = noticesOf(task);
  if (legacy) {
    notices.unshift({ tone: 'info', text: '旧记录：该任务创建于台账扩展之前，无参数与结果快照。' });
  }
  if (task.result?.truncated) {
    notices.push({ tone: 'info', text: TRUNCATED_HINT });
  }
  return {
    legacy,
    params: paramRows(task),
    results: resultRows(task),
    times: timeRows(task),
    ...detailItemsOf(task),
    notices,
    showProgress: progress.show,
    progressText: progress.text,
    progressPercent: progress.percent,
  };
}

/**
 * 列表行摘要：结果态给关键数字，运行中给进度，旧记录回退阶段名。
 * 与详情共用同一口径，避免两套文案（S-03 §3.5）。
 */
export function taskSummaryLine(task: TaskRecord): string {
  const files = task.result?.files;
  if (files) {
    return `成功 ${files.completed} · 跳过 ${files.skipped} · 未完成 ${files.incomplete}`;
  }
  const progress = progressOf(task);
  if (progress.text) return progress.text;
  return phaseLabel(task.phase);
}
