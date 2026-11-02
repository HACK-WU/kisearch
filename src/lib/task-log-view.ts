/**
 * task-log-view.ts - ki log 的纯函数与渲染层（供 CLI / MCP 共享）
 *
 * ★ 与 `src/log.ts` 分离的原因：`log.ts` 顶层会 `program.parse()`，
 *   被测试或 MCP 导入时会把当前进程的 argv 当命令参数解析。
 *   本模块不 import commander，可安全被任何调用方导入。
 *
 * 数据来源（两条，互不依赖）：
 *   1. 任务台账 `{dataDir}/.ki-tasks/<taskId>.json` —— 只活 1 小时，有状态/参数/压缩后的类别
 *   2. 任务运行日志 `{dataDir}/.ki-tasks/logs/<taskId>.log` —— 活 7 天，有**原始**错误
 * 台账过期但日志仍在时走「过期降级」：从日志头行恢复 scope/operation 继续输出。
 */

import { getTaskRecord, listTaskRecords } from './task-registry.js';
import { hasTaskLog, pruneTaskLogs, readTaskLog } from './task-log.js';
import type { TaskLogMeta, TaskLogPresence } from './task-log.js';
import type { TaskRecord, TaskState } from './task-registry.js';
import type { KiConfig } from './config.js';

const TASK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;
/** 日志正文显示上限（`--full` 时） */
const MAX_TAIL = 10_000;
const DEFAULT_TAIL = 100;

const STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

const SOURCE_LABEL: Record<string, string> = {
  cli: '命令行',
  daemon: '后台服务',
  web: '网页',
  scheduler: '定时任务',
};

/** 列表模式下视为「需要排查」的终态 */
const RECOVERABLE: Set<TaskState> = new Set(['failed', 'partial', 'cancelled']);

export interface LogCommandInput {
  taskId?: string;
  scope?: string;
  failed?: boolean;
  limit?: number;
  /** 日志显示最后 N 行（默认 100，夹紧 0–10000；0 = 不显示正文） */
  tail?: number;
  /** 读日志全部行（等价 tail = 上限） */
  full?: boolean;
}

export interface LogTaskView {
  id: string;
  operation: string;
  scope: string;
  source: string;
  state: TaskState;
  stateLabel: string;
  /** 失败/停顿发生时的阶段（`clone` / `queued-sync` / `vector` …）——「卡在哪一步」的关键信息 */
  phase?: string;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  errorCode?: string;
  error?: string;
  recoveryHint?: string;
  params?: Record<string, unknown>;
  files?: { scanned: number; completed: number; incomplete: number; skipped: number };
  /** 列表模式的日志存在性 */
  hasLog?: TaskLogPresence;
}

/** 运行日志正文（已脱敏） */
export interface TaskLogSection {
  path: string;
  lines: string[];
  totalLines: number;
  rotated: boolean;
  bytes: number;
}

export type LogCommandResult =
  | {
      kind: 'task';
      task: LogTaskView;
      log: TaskLogSection | null;
      /** 台账已过期，`task` 由日志头行恢复 */
      expired: boolean;
      /** 日志存在但头行损坏，无法恢复元信息 */
      metaUnreadable: boolean;
    }
  | { kind: 'list'; scope?: string; rows: LogTaskView[] }
  | { kind: 'not-found'; taskId: string; next: string[] }
  | { kind: 'invalid'; message: string };

function toView(task: TaskRecord): LogTaskView {
  const durationMs = task.finishedAt !== undefined && task.startedAt !== undefined
    ? task.finishedAt - task.startedAt
    : undefined;
  const files = task.result?.files
    ? {
        scanned: task.result.files.scanned,
        completed: task.result.files.completed,
        incomplete: task.result.files.incomplete,
        skipped: task.result.files.skipped,
      }
    : undefined;
  return {
    id: task.id,
    operation: task.operation,
    scope: task.scope,
    source: task.source,
    state: task.state,
    stateLabel: STATE_LABEL[task.state] ?? task.state,
    ...(task.phase ? { phase: task.phase } : {}),
    createdAt: task.createdAt,
    ...(task.startedAt !== undefined ? { startedAt: task.startedAt } : {}),
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(task.result?.errorCode ? { errorCode: task.result.errorCode } : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.recoveryHint ? { recoveryHint: task.recoveryHint } : {}),
    ...(task.params ? { params: task.params as Record<string, unknown> } : {}),
    ...(files ? { files } : {}),
  };
}

/**
 * 台账已过期：用日志头行拼一个最小视图（状态/错误未知，渲染时另行标注）。
 *
 * ★ `head` 可能为 null（日志在但头行损坏）：必须容忍 —— 早期版本直接 `head.id`，
 *   在「台账过期 + 头行损坏」这个组合下会抛 `Cannot read properties of null`。
 */
function viewFromHead(head: TaskLogMeta | null, taskId: string): LogTaskView {
  const base = {
    id: taskId,
    operation: head?.operation ?? 'unknown',
    scope: head?.scope ?? 'unknown',
    source: head?.source ?? 'unknown',
    state: 'unknown' as TaskState,
    stateLabel: '状态未知',
    createdAt: head?.createdAt ?? 0,
  };
  return head ? { ...base, id: head.id } : base;
}

function clampTail(input: LogCommandInput): number {
  if (input.full) return MAX_TAIL;
  const raw = input.tail ?? DEFAULT_TAIL;
  if (!Number.isFinite(raw)) return DEFAULT_TAIL;
  return Math.max(0, Math.min(MAX_TAIL, Math.trunc(raw)));
}

/** 纯函数：不写 stdout，便于单测。渲染交给 `renderTask` / `renderList`。 */
export function executeTaskLog(
  config: Pick<KiConfig, 'dataDir'>,
  input: LogCommandInput,
): { exitCode: 0 | 1 | 2; result: LogCommandResult } {
  const taskId = input.taskId?.trim();
  const scope = input.scope?.trim();

  if (taskId) {
    if (!TASK_ID_RE.test(taskId)) {
      return {
        exitCode: 2,
        result: { kind: 'invalid', message: `任务 ID 非法：${taskId}（只允许字母、数字与 -，最长 128）` },
      };
    }
    const task = getTaskRecord(config, taskId);
    const tail = clampTail(input);
    const raw = readTaskLog(config, taskId, tail);
    const log: TaskLogSection | null = raw
      ? { path: raw.path, lines: raw.lines, totalLines: raw.totalLines, rotated: raw.rotated, bytes: raw.bytes }
      : null;

    if (!task && !log) {
      return {
        exitCode: 1,
        result: {
          kind: 'not-found',
          taskId,
          next: [
            scope
              ? `ki log --scope ${scope} --failed    该知识库最近的失败任务`
              : 'ki log --scope <scope> --failed    某知识库最近的失败任务',
            'ki log                              最近 10 个任务',
            '任务台账只保留 1 小时、运行日志保留 7 天；两者都已过期时只能重新复现',
          ],
        },
      };
    }

    // scope 校验：台账优先，其次日志头行（过期降级）
    const actualScope = task?.scope ?? raw?.head?.scope;
    if (scope && actualScope && scope !== actualScope) {
      return {
        exitCode: 2,
        result: {
          kind: 'invalid',
          message: `任务 ${taskId} 属于 scope ${actualScope}，与 --scope ${scope} 不符（去掉 --scope 即可查询）`,
        },
      };
    }

    return {
      exitCode: 0,
      result: {
        kind: 'task',
        task: task ? toView(task) : viewFromHead(raw?.head ?? null, taskId),
        log,
        expired: !task,
        metaUnreadable: !task && !raw?.head,
      },
    };
  }

  const limit = Math.max(1, Math.min(100, input.limit ?? 10));
  /**
   * 过滤先于裁剪：否则 `--failed` 在「最近 10 条全是成功」时会给出空列表。
   * 但只有需要过滤时才多读：无过滤的 `ki log` 只读 limit 条，避免为 10 行输出读 500 个 JSON。
   */
  const scanLimit = input.failed || scope ? 500 : limit;
  // 列表顺带清理过期日志（与 writer 侧的 10 分钟节流互补：长期只读的用户也会被清）
  pruneTaskLogs(config);
  const all = listTaskRecords(config, scanLimit);
  const rows = all
    .filter((task) => (scope ? task.scope === scope : true))
    .filter((task) => (input.failed ? RECOVERABLE.has(task.state) : true))
    .slice(0, limit)
    .map((task) => ({ ...toView(task), hasLog: hasTaskLog(config, task.id) }));
  return { exitCode: 0, result: { kind: 'list', ...(scope ? { scope } : {}), rows } };
}

// ─── 渲染 ───

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m${pad(sec % 60)}s`;
}

/**
 * 终端显示宽度：CJK 全角字符占 2 列。
 * ★ 不能用 `String.length` 补空格 —— 「错误码」(6 列 / 3 字符) 与「操作」(4 列 / 2 字符)
 *   按字符数补会让值起点相差 2 列，键值对看起来参差不齐。
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  }
  return width;
}

/** 按**显示宽度**左对齐补空格（超宽不截断） */
function padCol(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** 键值行：标签按显示宽度对齐到 10 列（最宽标签「知识库」= 6 列） */
function kv(label: string, value: string | undefined): string | null {
  if (!value) return null;
  return `  ${padCol(label, 10)}${value}`;
}

function renderParams(params: Record<string, unknown> | undefined): string | undefined {
  if (!params) return undefined;
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  return parts.length > 0 ? parts.join('  ') : undefined;
}

const LOG_PRESENCE_LABEL: Record<TaskLogPresence, string> = {
  yes: '有',
  no: '无',
  rotated: '已滚动',
};

export interface RenderTaskOptions {
  expired?: boolean;
  metaUnreadable?: boolean;
}

export function renderTask(
  view: LogTaskView,
  log?: TaskLogSection | null,
  options: RenderTaskOptions = {},
): string {
  const lines: string[] = [`任务  ${view.id}`];
  if (options.expired) {
    // 过期降级：head 能提供的元信息别浪费（早期版本只打一行「已过期」，operation/scope 全丢）
    lines.push(...[
      kv('记录', '台账已过期（只保留 1 小时），以下元信息来自日志头行'),
      kv('操作', view.operation === 'unknown' ? undefined : view.operation),
      kv('知识库', view.scope === 'unknown' ? undefined : view.scope),
      kv('来源', view.source === 'unknown' ? undefined : (SOURCE_LABEL[view.source] ?? view.source)),
      kv('创建', view.createdAt > 0 ? fmtTime(view.createdAt) : undefined),
    ].filter((line): line is string => line !== null));
  } else {
    lines.push(...[
      kv('操作', view.operation),
      kv('知识库', view.scope),
      kv('来源', SOURCE_LABEL[view.source] ?? view.source),
      kv('状态', `${view.stateLabel}（${view.state}）`),
      kv('阶段', view.phase),
      kv('创建', fmtTime(view.createdAt)),
      kv('结束', view.finishedAt !== undefined ? fmtTime(view.finishedAt) : '—'),
      kv('耗时', view.durationMs !== undefined ? fmtDuration(view.durationMs) : undefined),
      kv('错误码', view.errorCode),
      kv('错误', view.error),
      kv('提示', view.recoveryHint),
      kv('参数', renderParams(view.params)),
      kv('文件', view.files
        ? `扫描 ${view.files.scanned} / 完成 ${view.files.completed} / 未完成 ${view.files.incomplete} / 跳过 ${view.files.skipped}`
        : undefined),
    ].filter((line): line is string => line !== null));
  }

  lines.push('');
  if (log) {
    const shown = log.lines.length;
    const clipNote = shown === 0
      ? `共 ${log.totalLines} 行（--tail 0：不显示正文）`
      : shown < log.totalLines ? `共 ${log.totalLines} 行，显示最后 ${shown} 行` : `共 ${shown} 行`;
    lines.push(`日志  ${log.path}   ${clipNote}`);
    if (log.rotated) lines.push('      （更早日志已滚动到同名 .log.1）');
    lines.push('─'.repeat(56));
    lines.push(...log.lines);
    if (options.metaUnreadable) {
      lines.push('');
      lines.push('⚠ 日志头行损坏：无法从日志恢复操作/知识库等元信息');
    }
  } else {
    lines.push('该任务没有运行日志（早于日志能力上线，或已被 7 天保留期清理）');
    lines.push('任务台账只保留 1 小时；过期后本命令将查不到该任务');
  }
  return lines.join('\n');
}

export function renderList(result: Extract<LogCommandResult, { kind: 'list' }>): string {
  const head = result.scope
    ? `scope ${result.scope} 的任务（台账保留 1 小时，本页 ${result.rows.length} 条；--limit 可扩大）`
    : `最近任务（台账保留 1 小时，本页 ${result.rows.length} 条；--limit 可扩大）`;
  if (result.rows.length === 0) {
    return [
      head,
      '',
      result.scope
        ? `没有匹配的任务：scope ${result.scope}（没有失败任务，或满足条件的任务已过期）`
        : '当前没有任务记录（可能从未执行过写操作，或记录已过 1 小时保留期）',
      '',
      '提示：任务记录在操作执行后 1 小时内可查；重新发起操作可再产生记录',
    ].join('\n');
  }
  // 列宽按显示宽度而非字符数（表头含中文，用 String.length 会让表头与数据错位）
  const COLS = { id: 10, operation: 24, state: 10, finished: 21, code: 18, log: 8 } as const;
  const body = result.rows.map((row) => [
    padCol(row.id.slice(0, 8), COLS.id),
    padCol(row.operation, COLS.operation),
    padCol(row.state, COLS.state),
    padCol(row.finishedAt !== undefined ? fmtTime(row.finishedAt) : '—', COLS.finished),
    padCol(row.errorCode ?? '—', COLS.code),
    padCol(row.hasLog ? LOG_PRESENCE_LABEL[row.hasLog] : '—', COLS.log),
    row.scope,
  ].join(''));
  return [
    head,
    [
      padCol('任务ID', COLS.id),
      padCol('操作', COLS.operation),
      padCol('状态', COLS.state),
      padCol('结束时间', COLS.finished),
      padCol('错误码', COLS.code),
      padCol('日志', COLS.log),
      '知识库',
    ].join(''),
    ...body,
    '',
    '提示：ki log <任务ID> 查看详情与日志正文',
  ].join('\n');
}

/**
 * `--json` 载荷（`ok` 与 `exitCode` 跟随结果类型）。
 * ★ 抽成纯函数是为了可测：CLI 壳（`src/log.ts`）顶层 `program.parse()`，导入即执行，无法单测。
 */
export function toJsonPayload(result: LogCommandResult, exitCode: number): Record<string, unknown> {
  const ok = result.kind === 'task' || result.kind === 'list';
  return { ok, exitCode, ...result };
}

/**
 * `-id` 归一化：commander 会把 `-id` 拆成 `-i -d` 并报未知选项。
 * 用户习惯写法是 `ki log --scope ai-docs -id <taskId>`，必须在解析前归一。
 * 只改 `-id` 一项；`-i` / `-d` 保持未知（fail-loud，不静默当成别名）。
 */
export function normalizeTaskLogArgv(argv: string[]): string[] {
  return argv.map((arg) => (arg === '-id' ? '--id' : arg));
}
