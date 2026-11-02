/**
 * task-log-view.ts - ki log 的纯函数与渲染层（供 CLI / MCP 共享）
 *
 * ★ 与 `src/log.ts` 分离的原因：`log.ts` 顶层会 `program.parse()`，
 *   被测试或 MCP 导入时会把当前进程的 argv 当命令参数解析。
 *   本模块不 import commander，可安全被任何调用方导入。
 *
 * 数据来源：任务台账（`{dataDir}/.ki-tasks/<taskId>.json`，只保留 1 小时）。
 * 运行日志落盘（`.ki-tasks/logs/<taskId>.log`）尚未启用（S-02），
 * 接入后本模块的 `executeTaskLog` 追加读取日志正文即可，命令形态不变。
 */

import { getTaskRecord, listTaskRecords } from './task-registry.js';
import type { TaskRecord, TaskState } from './task-registry.js';
import type { KiConfig } from './config.js';

const TASK_ID_RE = /^[A-Za-z0-9-]{1,128}$/;

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
}

export type LogCommandResult =
  | { kind: 'task'; task: LogTaskView }
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
    if (!task) {
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
            '任务台账只保留 1 小时；重新发起该操作并等待失败后，再执行本命令即可取到记录',
          ],
        },
      };
    }
    if (scope && scope !== task.scope) {
      return {
        exitCode: 2,
        result: {
          kind: 'invalid',
          message: `任务 ${taskId} 属于 scope ${task.scope}，与 --scope ${scope} 不符（去掉 --scope 即可查询）`,
        },
      };
    }
    return { exitCode: 0, result: { kind: 'task', task: toView(task) } };
  }

  const limit = Math.max(1, Math.min(100, input.limit ?? 10));
  /**
   * 过滤先于裁剪：否则 `--failed` 在「最近 10 条全是成功」时会给出空列表。
   * 但只有需要过滤时才多读：无过滤的 `ki log` 只读 limit 条，避免为 10 行输出读 500 个 JSON。
   */
  const scanLimit = input.failed || scope ? 500 : limit;
  const all = listTaskRecords(config, scanLimit);
  const rows = all
    .filter((task) => (scope ? task.scope === scope : true))
    .filter((task) => (input.failed ? RECOVERABLE.has(task.state) : true))
    .slice(0, limit)
    .map(toView);
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

export function renderTask(view: LogTaskView): string {
  const lines: string[] = [`任务  ${view.id}`];
  const rows = [
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
  ].filter((line): line is string => line !== null);
  lines.push(...rows);
  lines.push('');
  /**
   * ★ S-02 接入点（勿漏）：日志落盘启用后，这两行必须改成「有日志 → 输出正文；无日志 → 才打印本提示」。
   *   当前硬编码是为了让本版本**诚实披露能力边界**——不能让用户以为已经看过完整日志。
   */
  lines.push('本任务暂无运行日志：运行日志落盘尚未启用，以上信息来自任务台账');
  lines.push('任务台账只保留 1 小时；过期后本命令将查不到该任务');
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
  const COLS = { id: 10, operation: 26, state: 10, finished: 21, code: 20 } as const;
  const body = result.rows.map((row) => [
    padCol(row.id.slice(0, 8), COLS.id),
    padCol(row.operation, COLS.operation),
    padCol(row.state, COLS.state),
    padCol(row.finishedAt !== undefined ? fmtTime(row.finishedAt) : '—', COLS.finished),
    padCol(row.errorCode ?? '—', COLS.code),
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
      '知识库',
    ].join(''),
    ...body,
    '',
    '提示：ki log <任务ID> 查看详情',
  ].join('\n');
}

/**
 * `-id` 归一化：commander 会把 `-id` 拆成 `-i -d` 并报未知选项。
 * 用户习惯写法是 `ki log --scope ai-docs -id <taskId>`，必须在解析前归一。
 * 只改 `-id` 一项；`-i` / `-d` 保持未知（fail-loud，不静默当成别名）。
 */
export function normalizeTaskLogArgv(argv: string[]): string[] {
  return argv.map((arg) => (arg === '-id' ? '--id' : arg));
}
