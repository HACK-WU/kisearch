/**
 * 任务列表行模型（REQ-20261022-002）
 *
 * 列表从「左列表 + 右详情」改为全宽表格后，列文案与判定不能散在 JSX 里：
 * 状态、来源、摘要、时间、进度单位必须与详情同口径，并可用单测锁死。
 */
import type { TaskRecord, TaskState } from '@/api/tasksApi';
import { operationLabel, sourceLabel, stateLabel, taskSummaryLine } from '@/lib/taskDetailModel';

export interface TaskListRowView {
  id: string;
  /** 短 ID：列表只留 8 位，完整 ID 进抽屉 */
  shortId: string;
  state: TaskState;
  stateLabel: string;
  operationLabel: string;
  scope: string;
  sourceLabel: string;
  resultSummary: string;
  /** 失败/未知时的短错误；与摘要并列展示，不互相覆盖 */
  resultError?: string;
  resultTone: 'normal' | 'warn' | 'danger';
  timeLabel: string;
  /** 完整时间（悬停提示；列表只显示月/日 时:分） */
  timeTitle: string;
  /** 持续时间（终态给实际耗时；运行中/排队中给状态或「—」） */
  durationLabel: string;
  progressPercent: number | null;
  ariaLabel: string;
}

function formatListTime(ts?: number): { label: string; title: string } {
  if (!ts) return { label: '—', title: '—' };
  const date = new Date(ts);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return {
    // 月日中文写法（用户 2026-10-26：`10/26` 看起来像分数）：`10月26日 15:57`
    label: `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`,
    title: new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' }).format(ts),
  };
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

export function buildTaskListRow(task: TaskRecord): TaskListRowView {
  const time = formatListTime(task.startedAt ?? task.createdAt);
  const summary = taskSummaryLine(task);
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
    id: task.id,
    shortId: task.id.slice(0, 8),
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
