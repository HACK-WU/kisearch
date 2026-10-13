/**
 * taskNotice.ts —— 顶栏任务徽标「需关注任务」的可见性判定
 *
 * 顶栏徽章只提示**需要用户知道**的终态任务，两类：失败/未知（红）与部分完成（橙）。
 * 两者共用同一套两条消解规则（失败自 2026-10-02 起如此，部分完成此前**一条都没有**，
 * 导致「1 个任务部分完成」在 1 小时 TTL 内一直挂在顶栏且无从消除）：
 *   ① 自动消除：同 scope + 同 operation 之后有更晚的 `succeeded` ⇒ 旧的失败/部分完成不再提示
 *      （用户已用一次成功重跑解决它，再挂着只是噪音）；
 *   ② 手动忽略：忽略时间戳之前的记录不再提示，其后的新记录仍会重新亮起。
 * 仅影响顶栏徽章；任务页始终保留完整历史用于追溯（含 TTL 内的部分完成详情）。
 *
 * 抽成纯函数以便单测（见 web/test/task-notice-dismiss.test.mjs）。
 */

/** 参与判定的最小字段集（`TaskRecord` 的结构子集） */
export interface TaskNoticeShape {
  scope: string;
  operation: string;
  state: string;
  finishedAt?: number;
  /**
   * 记录最后更新时间。**进程崩溃 / 被杀的任务从未 `finish`，只有 `updatedAt`**
   * （读侧还会把心跳过期 30s 的 active 任务改判为 `unknown`）——
   * 时间判定必须取 `finishedAt ?? updatedAt`，与后端 TTL 口径一致
   * （`task-registry.ts` 的 `record.finishedAt ?? record.updatedAt`），
   * 否则这类崩掉的任务永远进不了徽章，用户无从得知。
   */
  updatedAt?: number;
}

/** 任务的时间判定基准（与后端 TTL 口径一致） */
function noticeTimestamp(task: TaskNoticeShape): number {
  return task.finishedAt ?? task.updatedAt ?? 0;
}

/** 失败类状态：`unknown`（心跳过期）与 failed 同档提示 */
export const FAILURE_STATES: readonly string[] = ['failed', 'unknown'];
/** 部分完成：文档可用但有单元未处理完，需要用户知道但不阻塞 */
export const PARTIAL_STATE = 'partial';

/** `${scope}\u0000${operation}` → 最近一次 succeeded 的完成时间（用于自动消除被覆盖的旧提示） */
export function latestSuccessByScopeOperation<T extends TaskNoticeShape>(
  tasks: readonly T[],
): Map<string, number> {
  const map = new Map<string, number>();
  for (const task of tasks) {
    if (task.state !== 'succeeded') continue;
    const key = `${task.scope}\u0000${task.operation}`;
    map.set(key, Math.max(map.get(key) ?? 0, noticeTimestamp(task)));
  }
  return map;
}

export interface TaskNoticeDismissal {
  /** 失败/未知提示的手动忽略时间戳（0 = 未忽略） */
  failedAt: number;
  /** 部分完成提示的手动忽略时间戳（0 = 未忽略） */
  partialAt: number;
}

/** 进入顶栏徽章的两类任务（各自已应用两条消解规则） */
export interface VisibleTaskNotices<T> {
  failed: T[];
  partial: T[];
}

export function visibleTaskNotices<T extends TaskNoticeShape>(
  tasks: readonly T[],
  dismissal: TaskNoticeDismissal,
): VisibleTaskNotices<T> {
  const latestSuccess = latestSuccessByScopeOperation(tasks);
  const failed: T[] = [];
  const partial: T[] = [];
  for (const task of tasks) {
    const at = noticeTimestamp(task);
    const coveredByLaterSuccess = (latestSuccess.get(`${task.scope}\u0000${task.operation}`) ?? 0) > at;
    if (coveredByLaterSuccess) continue;
    if (task.state === PARTIAL_STATE) {
      if (at > dismissal.partialAt) partial.push(task);
      continue;
    }
    if (FAILURE_STATES.includes(task.state) && at > dismissal.failedAt) failed.push(task);
  }
  return { failed, partial };
}
