/**
 * 调度触发的同步执行（S-03）。
 *
 * 锁序固定为 scope → clone（与 syncDataSource 内部一致），避免与手动同步死锁。
 * 先拿锁、再建任务：锁/共享仓库忙时直接跳过，不留下假失败任务。
 */
import crypto from 'node:crypto';
import { runWithConfigSnapshot, type KiConfig } from './config.js';
import {
  applyScheduleRunResult,
  syncDataSource,
  withManagedCloneLock,
  type ScheduleRunOutcome,
  type SyncDataSourceResult,
} from './datasource.js';
import { readDataSource } from './datasource.js';
import { withScopeWriteLock } from './scope-write-lock.js';
import { createTaskReporter, listTaskRecords, type TaskReporter } from './task-registry.js';
import { getSharedOperationCoordinator } from './operation-coordinator.js';
import { datasourceSyncParams, toDatasourceSyncResultSnapshot } from './datasource-task.js';
import type { DataSourceRecord } from './datasource-types.js';

export interface ScheduledRunInput {
  scope: string;
  slot: number | null;
  record: DataSourceRecord;
  config: KiConfig;
  abortSignal?: AbortSignal;
}

export interface ScheduledRunResult {
  outcome: ScheduleRunOutcome;
  reason?: string;
  durationMs?: number;
  errorCode?: string;
}

function skipped(reason: string, startedAt: number): ScheduledRunResult {
  return { outcome: 'skipped', reason, durationMs: Date.now() - startedAt };
}

/** 同 scope 是否已有长任务（台账）或排队；台账读失败按不可运行处理 */
function canRunNow(scope: string, config: KiConfig): boolean {
  let tasks;
  try {
    tasks = listTaskRecords(config);
  } catch {
    return false;
  }
  const active = tasks.some((task) => task.scope === scope
    && (task.state === 'queued' || task.state === 'running')
    && ['import', 'datasource-sync', 'datasource-add-remote'].includes(task.operation));
  if (active) return false;
  return (getSharedOperationCoordinator().snapshot().queues[scope] ?? 0) === 0;
}

function finishTask(
  task: TaskReporter,
  outcome: ScheduleRunOutcome,
  result: SyncDataSourceResult | null,
  thrown: Error | null,
): void {
  const snapshot = result ? toDatasourceSyncResultSnapshot(result) : undefined;
  if (outcome === 'succeeded') {
    task.finish('succeeded', snapshot ? { result: snapshot } : {});
    return;
  }
  if (outcome === 'partial') {
    task.finish('partial', {
      ...(snapshot ? { result: snapshot } : {}),
      error: '部分文件未完成',
      recoveryHint: '修复后重试同步；未完成文件会自动重试',
    });
    return;
  }
  if (outcome === 'cancelled') {
    task.finish('cancelled');
    return;
  }
  const errorCode = thrown
    ? ((thrown as Error & { code?: string }).code ?? 'SYNC_FAILED')
    : result && !result.ok ? result.code : 'SYNC_FAILED';
  const error = thrown
    ? thrown.message
    : result && !result.ok ? result.error : '同步失败';
  task.finish('failed', { errorCode, error, ...(snapshot ? { result: snapshot } : {}) });
}

export async function runScheduledSync(input: ScheduledRunInput): Promise<ScheduledRunResult> {
  const startedAt = Date.now();
  try {
    return await withScopeWriteLock(input.scope, 'datasource-sync', async () => {
      return await runWithConfigSnapshot(input.config, async (): Promise<ScheduledRunResult> => {
        // 1) 锁内重读：配置可能已被删除/关闭
        const read = readDataSource(input.scope);
        if (!read.ok) return skipped('not-found', startedAt);
        if (!read.record.schedule.enabled) return skipped('disabled', startedAt);

        // 2) 可运行判定（台账 + coordinator 队列）
        if (!canRunNow(input.scope, input.config)) {
          applyScheduleRunResult(input.scope, { outcome: 'skipped', reason: 'active-task', slot: input.slot, at: Date.now() });
          return skipped('active-task', startedAt);
        }

        const exec = async (): Promise<ScheduledRunResult> => {
          // 3) 先建任务：同步开始那一刻任务页/顶栏可见
          const taskId = crypto.randomUUID();
          let task: TaskReporter;
          try {
            task = createTaskReporter(input.config, {
              id: taskId,
              source: 'scheduler',
              operation: 'datasource-sync',
              scope: input.scope,
            });
          } catch {
            applyScheduleRunResult(input.scope, { outcome: 'skipped', reason: 'task-registry-unavailable', slot: input.slot, at: Date.now() });
            return skipped('task-registry-unavailable', startedAt);
          }
          task.update({ state: 'running', startedAt: Date.now(), params: datasourceSyncParams(read.record, false) });

          // 4) 执行（scope 锁 / clone 锁由外层继承）
          let result: SyncDataSourceResult | null = null;
          let thrown: Error | null = null;
          try {
            result = await syncDataSource({
              scope: input.scope,
              taskId,
              config: input.config,
              abortSignal: input.abortSignal,
              onProgress: (p) => task.progress(p),
              onPhase: (phase) => task.update({ phase }),
            });
          } catch (err) {
            thrown = err as Error;
          }

          // 5) 竞态下的共享仓库忙：任务记 cancelled、不计失败
          if (!thrown && result && !result.ok && result.code === 'CLONE_BUSY') {
            applyScheduleRunResult(input.scope, { outcome: 'skipped', reason: 'clone-busy', slot: input.slot, at: Date.now() });
            task.finish('cancelled', { errorCode: 'CLONE_BUSY', error: '共享仓库正在被其他数据源同步，本次跳过' });
            return skipped('clone-busy', startedAt);
          }

          // 6) 收尾：先写运行态（避免崩溃后重复补跑），再 finish 任务
          let outcome: ScheduleRunOutcome;
          if (input.abortSignal?.aborted) {
            outcome = 'cancelled';
          } else if (thrown) {
            outcome = 'failed';
          } else if (!result || !result.ok || result.dryRun) {
            outcome = 'failed';
          } else {
            const state = result.summary.state;
            outcome = state === 'ok' ? 'succeeded' : state === 'partial' ? 'partial' : state === 'cancelled' ? 'cancelled' : 'failed';
          }
          applyScheduleRunResult(input.scope, { outcome, slot: input.slot, at: Date.now() });
          finishTask(task, outcome, result, thrown);
          return { outcome, durationMs: Date.now() - startedAt };
        };

        // 2.1) 托管 clone 预锁：同 scope→clone 锁序；忙则 skip（无任务、不计失败）
        if (read.record.type === 'git' && read.record.git?.managed && read.record.git.repoRoot) {
          try {
            return await withManagedCloneLock(read.record.git.repoRoot, 'datasource-clone-sync', exec);
          } catch (err) {
            if ((err as { code?: string }).code === 'SCOPE_OPERATION_BUSY') {
              applyScheduleRunResult(input.scope, { outcome: 'skipped', reason: 'clone-busy', slot: input.slot, at: Date.now() });
              return skipped('clone-busy', startedAt);
            }
            throw err;
          }
        }
        return exec();
      });
    });
  } catch (err) {
    if ((err as { code?: string }).code === 'SCOPE_OPERATION_BUSY') {
      return skipped('scope-lock-busy', startedAt);
    }
    return {
      outcome: 'failed',
      durationMs: Date.now() - startedAt,
      errorCode: (err as { code?: string }).code ?? 'SYNC_FAILED',
    };
  }
}
