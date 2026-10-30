/**
 * 任务列表行模型（REQ-20261022-002）
 *
 * 列表从「左列表 + 右详情」改为全宽表格后，列文案与判定不能散在 JSX 里：
 * 状态、来源、摘要、时间、进度单位必须与详情同口径，并可用单测锁死。
 */
import type { TaskRecord, TaskState } from '@/api/tasksApi';
import { operationLabel, sourceLabel, stateLabel, taskCreatedLine, taskSummaryLine } from '@/lib/taskDetailModel';

export interface TaskListRowView {
  state: TaskState;
  stateLabel: string;
  operationLabel: string;
  scope: string;
  sourceLabel: string;
  /** 摘要单行：成功/跳过/未完成，有新建文档快照时以 ` · 新增文档 N 篇` 续在后面；全 0 时压缩为「无变更」 */
  resultSummary: string;
  /** 失败/未知时的短错误；与摘要并列展示，不互相覆盖 */
  resultError?: string;
  resultTone: 'normal' | 'warn' | 'danger';
  timeLabel: string;
  /** 悬停提示：与开始时间不同的创建时间（排队过的任务）才额外补充，否则同 `timeLabel` */
  timeTitle: string;
  /** 持续时间（终态给实际耗时；运行中/排队中给状态或「—」） */
  durationLabel: string;
  progressPercent: number | null;
  ariaLabel: string;
}

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * 列表时间：`2026-10-30 15:57:55`（用户 2026-10-30 指定，需精确到秒）。
 * ★ 只改列表，不动详情抽屉：详情「时间」段是 163px 双列栅格，日期由 hint 承载，
 *   换成完整格式会折行（详情口径见 `taskDetailModel.timeRows`）。
 */
function formatListTimeMs(ts?: number): string {
  if (!ts) return '—';
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
    + ` ${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatListTime(task: TaskRecord): { label: string; title: string } {
  const started = task.startedAt;
  const created = task.createdAt;
  const label = formatListTimeMs(started ?? created);
  // 排队过的任务：开始时间与创建时间不同，悬停补出创建时间；否则提示与正文相同没有意义
  const title = started !== undefined && created !== undefined && started !== created
    ? `创建 ${formatListTimeMs(created)} · 开始 ${formatListTimeMs(started)}`
    : label;
  return { label, title };
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '<1s';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

function durationLabelOf(task: TaskRecord): string {
  // 排队中还没有开始时间，持续时间无从谈起（状态列已给出「排队中」）
  if (task.state === 'queued' || task.startedAt === undefined) return '—';
  if (task.finishedAt === undefined) return task.state === 'running' ? '运行中' : '—';
  return formatDuration(task.finishedAt - task.startedAt);
}

function progressPercentOf(task: TaskRecord): number | null {
  // 只有运行中才有进度；终态与排队中都不渲染进度条（排队中 0% 的空条只会增加噪音）
  if (task.state !== 'running') return null;
  const progress = task.progress;
  if (!progress || progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.done / progress.total) * 100));
}

/**
 * 「无变更」压缩（用户 2026-10-30 Q5 选定）：
 * 导入类任务全部计数为 0 时，`成功 0 · 跳过 0 · 未完成 0 · 新增文档 0 篇` 只会占满整列。
 * ★ 异常终态**不压缩**：失败 / 状态未知 / 已取消 —— 否则「快照还原 · 已取消」显示成「无变更」，
 *   把中断伪装成正常结束（取消是用户主动中断，不是「跑完没变化」）。
 * ★ 没有 `result.files` 的行（运行中 / 排队中 / 旧记录）走进度或阶段文案，不参与压缩。
 */
function isNoChangeSummary(task: TaskRecord): boolean {
  if (task.state === 'failed' || task.state === 'unknown' || task.state === 'cancelled') return false;
  const files = task.result?.files;
  if (!files) return false;
  if (files.completed !== 0 || files.skipped !== 0 || files.incomplete !== 0) return false;
  const created = task.result?.createdTotal ?? task.result?.created?.length ?? 0;
  return created === 0;
}

export function buildTaskListRow(task: TaskRecord): TaskListRowView {
  const time = formatListTime(task);
  const created = taskCreatedLine(task);
  // 摘要与新建文档数同一行（2026-10-30 用户要求横排）
  const base = taskSummaryLine(task);
  const summary = isNoChangeSummary(task) ? '无变更' : (created ? `${base} · ${created}` : base);
  const error = task.error?.trim() || undefined;
  const operation = operationLabel(task.operation);
  const source = sourceLabel(task.source);
  const stateText = stateLabel(task.state);
  const tone: TaskListRowView['resultTone'] = task.state === 'failed' || task.state === 'unknown'
    ? 'danger'
    : task.state === 'partial' || task.state === 'cancelled'
      ? 'warn'
      : 'normal';
  const durationLabel = durationLabelOf(task);

  return {
    state: task.state,
    stateLabel: stateText,
    operationLabel: operation,
    scope: task.scope,
    sourceLabel: source,
    resultSummary: summary,
    ...(error ? { resultError: error } : {}),
    resultTone: tone,
    timeLabel: time.label,
    timeTitle: time.title,
    durationLabel,
    progressPercent: progressPercentOf(task),
    ariaLabel: `${stateText}，${operation}，${task.scope}，${source}，${summary}${error ? `，${error}` : ''}，${time.title}，持续时间 ${durationLabel}`,
  };
}
