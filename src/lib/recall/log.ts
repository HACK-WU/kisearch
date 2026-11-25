/**
 * recall/log.ts —— `ki_recall` 的单行审计日志（S-02 R7）。
 *
 * 为什么不用 ki_ask 那套会话落盘：recall 是"开工前拿资料"，不是问答；
 * 落盘会成为一堆没人回看的记录。审计只需要回答四个问题：
 *   谁调的、什么任务（前 200 字）、命中几篇、走了哪条通道 / 花了多久。
 *
 * 格式固定为 `[recall] {json}` 一行 —— 日志是给 `grep` 与 `jq` 用的，不要写多行、
 * 不要把整段任务描述打进去（200 字上限：够定位，不至于把知识库内容灌进日志）。
 */

export type RecallLogEvent = 'ok' | 'empty' | 'error' | 'throttled';

/** 任务描述进日志的字符上限 */
const TASK_PREVIEW_CHARS = 200;

export interface RecallLogFields {
  /** 调用方键（tokenId / 'local'） */
  principalKey: string;
  /** 参与检索的范围（视图保留视图名） */
  targets: string[];
  /** 实际参与的物理库数（IO 成本口径） */
  physicalCount?: number;
  /** 通道（一期恒 fast） */
  channel: 'fast' | 'deep';
  /** 候选条数 */
  candidates?: number;
  /** 是否降级 / 是否命中缓存 */
  degraded?: boolean;
  cached?: boolean;
  /** 错误码（error 时必带） */
  code?: string;
  durationMs?: number;
  /** 模型通道实际轮次（含收口轮）；排查「轮次耗尽拿不到结论」时最关键 */
  rounds?: number;
  /**
   * 本次**实际生效**过的 scope 并集（2026-11-25 Q4：模型可自选后必须留痕）。
   *
   * 与 `targets` 不同：`targets` 是调用方传入的默认范围，这里记的是模型真的查过哪些库。
   */
  scopes?: string[];
  /** 任务画像原文（内部截断） */
  task?: string;
}

export function recallLog(event: RecallLogEvent, fields: RecallLogFields): void {
  const payload: Record<string, unknown> = {
    ev: event,
    who: fields.principalKey,
    targets: fields.targets,
    channel: fields.channel,
    ms: fields.durationMs,
  };
  if (fields.physicalCount !== undefined) payload.physical = fields.physicalCount;
  if (fields.scopes && fields.scopes.length > 0) payload.scopes = fields.scopes;
  if (fields.candidates !== undefined) payload.hits = fields.candidates;
  if (fields.degraded === true) payload.degraded = true;
  if (fields.cached === true) payload.cached = true;
  if (fields.code) payload.code = fields.code;
  if (fields.task) {
    const task = fields.task.trim();
    payload.task = task.length > TASK_PREVIEW_CHARS ? `${task.slice(0, TASK_PREVIEW_CHARS)}…` : task;
  }
  try {
    process.stderr.write(`[recall] ${JSON.stringify(payload)}\n`);
  } catch {
    // 日志失败不得影响主流程（管道已关闭等场景）
  }
}
