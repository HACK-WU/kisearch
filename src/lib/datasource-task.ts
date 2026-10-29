/**
 * 数据源同步任务快照映射（S-03）。
 *
 * HTTP 页面同步与定时调度共用，避免两端口径漂移。
 */
import type { DataSourceRecord } from './datasource-types.js';
import type { SyncDataSourceResult } from './datasource.js';
import { MAX_SNAPSHOT_CREATED, toParamSnapshot } from './task-snapshot.js';
import type { TaskParamSnapshot, TaskResultSnapshot } from './task-registry.js';

/** 首次同步没有 commit 水位时必然是 full；不能只看 type/full */
export function datasourceSyncMode(record: DataSourceRecord, full: boolean): 'incremental' | 'full' {
  return record.type === 'git' && !full && Boolean(record.lastSync?.git?.commit) ? 'incremental' : 'full';
}

/** 登记参数快照（页面 sync、add-remote 首次同步、定时调度同口径） */
export function datasourceSyncParams(record: DataSourceRecord, full: boolean): TaskParamSnapshot | undefined {
  return toParamSnapshot('datasource-sync', {
    sourceDir: record.dir,
    type: record.type,
    mode: datasourceSyncMode(record, full),
    ...(record.group ? { group: record.group } : {}),
    vector: record.vector,
    conflictMode: record.conflictMode,
    conflictSuffix: record.conflictSuffix,
    ...(record.chunkSize !== null ? { chunkSize: record.chunkSize } : {}),
    ...(record.chunkOverlap !== null ? { chunkOverlap: record.chunkOverlap } : {}),
  });
}

export function toDatasourceSyncResultSnapshot(result: SyncDataSourceResult): TaskResultSnapshot | undefined {
  if (!result.ok || result.dryRun) return undefined;
  const summary = result.summary;
  return {
    ...(summary.files
      ? {
        files: {
          scanned: summary.files.scanned,
          completed: summary.files.completed,
          incomplete: summary.files.incomplete,
          skipped: summary.files.skipped,
          unchanged: summary.files.unchanged,
          duplicatesSkipped: summary.files.duplicatesSkipped,
        },
      }
      : {}),
    vectorized: summary.vectorized,
    fullTextIndexed: summary.fullTextIndexed,
    groups: summary.groups,
    ...(summary.created && summary.created.length > 0
      ? {
        created: summary.created
          .slice(0, MAX_SNAPSHOT_CREATED)
          .map((item) => [item.group, item.relation] as [string, string]),
      }
      : {}),
    ...(typeof summary.createdTotal === 'number' ? { createdTotal: summary.createdTotal } : {}),
    ...(summary.createdTruncated || (summary.created?.length ?? 0) > MAX_SNAPSHOT_CREATED
      ? { createdTruncated: true }
      : {}),
  };
}
