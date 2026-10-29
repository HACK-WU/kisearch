/**
 * 数据源运行态（来自任务台账）的读取口径。
 *
 * 与 `datasource.json.lastSync` 是两套事实：
 *  - `lastSync` = **上次同步结束时**写的快照（同步进行中仍是上一版或 null）
 *  - `active`   = 任务台账里的 queued/running（本次同步进行中）
 * 页面必须把两者合并成「当前状态」，否则同步期间会同时出现「同步中」与「从未同步」。
 */
import type { TaskRecord } from './task-registry.js';

export type DataSourceActiveState = 'queued' | 'running';

export interface DataSourceActiveSync {
  state: DataSourceActiveState;
  /** 本次同步开始时间（仅 running；排队中为 null） */
  startedAt: number | null;
}

/**
 * 从任务记录中挑出每个 scope 当前的同步任务。
 * 台账按 createdAt 倒序；同一 scope 同时存在排队与运行时**运行优先**——页面要回答的是
 * "正在做什么"，而不是"最新创建的是什么"。
 */
export function pickActiveDatasourceSync(
  tasks: Pick<TaskRecord, 'scope' | 'operation' | 'state' | 'startedAt'>[],
): Map<string, DataSourceActiveSync> {
  const map = new Map<string, DataSourceActiveSync>();
  for (const task of tasks) {
    if (task.operation !== 'datasource-sync') continue;
    if (task.state !== 'queued' && task.state !== 'running') continue;
    const prev = map.get(task.scope);
    if (prev?.state === 'running') continue;
    if (prev && task.state !== 'running') continue;
    map.set(task.scope, {
      state: task.state,
      startedAt: task.state === 'running' && typeof task.startedAt === 'number' ? task.startedAt : null,
    });
  }
  return map;
}
