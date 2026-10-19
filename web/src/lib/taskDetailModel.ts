/**
 * 任务详情渲染模型（REQ-20261019-004 S-03）
 *
 * 为什么要有这一层：`TasksPage` 的详情从 8 个字段扩到 ~18 个，若判定写在 JSX 里，
 * 「进度单位」「跳过原因拆分」「缺字段兜底」这些口径无法被单测锁死。
 * 本项目有过教训：`verify-import-form-reset.cjs` 曾把错误的默认值锁成期望值。
 *
 * 原则：组件只渲染本文件的输出，不再做条件判断。
 */
import type { TaskIndexReadiness, TaskRecord, TaskResultSnapshot } from '@/api/tasksApi';

export type DetailTone = 'normal' | 'warn' | 'danger';

export interface DetailRow {
  label: string;
  value: string;
  /** 次要说明（如「其中内容未变 9 篇」） */
  hint?: string;
  tone?: DetailTone;
  /** 可跳转目标（R9：知识库 → Browse 页） */
  href?: string;
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

const SOURCE_KIND_LABEL: Record<'upload' | 'external', string> = {
  upload: '浏览器上传（暂存目录）',
  external: '外部目录',
};

/** 明细不完整时的统一文案（不区分「超 20 条」与「字节预算裁剪」） */
const TRUNCATED_HINT = '明细未完整显示';

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
      ...(task.result?.groups && task.result.groups.length > 0
        ? { hint: `实际落点：${task.result.groups.join(' / ')}` }
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
  if (result.groups && result.groups.length > 0) {
    rows.push({ label: '落点 Group', value: result.groups.join(' / ') });
  }
  // 索引行只在有诊断数据时出现：`—` 对用户没有信息量（code-review P2）
  if (task.indexReadiness) rows.push({ label: '索引', value: indexReadinessLabel(task.indexReadiness) });
  return rows;
}

function timeRows(task: TaskRecord): DetailRow[] {
  const rows: DetailRow[] = [];
  const startAt = task.startedAt;
  const waiting = startAt !== undefined && startAt >= task.createdAt ? startAt - task.createdAt : undefined;
  rows.push(
    startAt === undefined
      ? { label: '创建', value: timeLabel(task.createdAt), hint: '尚未开始执行' }
      : {
          label: '创建 → 开始',
          value: `${timeLabel(task.createdAt)} → ${timeLabel(startAt)}`,
          ...(waiting !== undefined ? { hint: `排队 ${durationLabel(waiting)}` } : {}),
        },
  );
  const finished = task.finishedAt;
  const ran = finished !== undefined && startAt !== undefined ? finished - startAt : undefined;
  rows.push({
    label: '结束',
    value: timeLabel(finished),
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

function detailItemsOf(task: TaskRecord): { duplicates: DetailItem[]; conflicts: DetailItem[] } {
  const duplicates: DetailItem[] = (task.result?.duplicates ?? []).map((item) => ({
    title: item.path,
    meta: `库中已有：${item.existingGroup ? `${item.existingGroup} / ` : ''}${item.existingRelation}`,
  }));
  const conflicts: DetailItem[] = (task.result?.conflicts ?? []).map((item) => ({
    title: item.path,
    // `unchanged` 优先：判定为覆盖但实际被「内容未变」跳过，不能说"已覆盖"（debug 2026-10-19）
    meta: `→ ${item.relation}（${item.unchanged
      ? '内容未变，跳过重算'
      : item.action === 'suffix' ? '已改名' : item.action === 'skip' ? '已跳过' : '已覆盖'}）`,
  }));
  return { duplicates, conflicts };
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
