import { executeStore } from '../store.js';
import { executeBulkStore } from '../bulk-store.js';
import { executeSearch } from '../search.js';
import { executeSyncRelation, executeBulkSyncRelation } from '../sync-relation.js';
import { executeDeleteRelation, executeDeleteGroup, executeBatchDelete } from '../delete-relation.js';
import { handleDirectImport } from './import.js';
import { executeScopeList, executeScopeDelete, executeScopeClear } from '../scope.js';
import { executeQueryGroup } from '../query-group.js';
import { executeGetModuleInfo, executeGetModuleInfoBatch } from '../get-module-info.js';
import { executeTagList } from '../tag.js';
import { executeDocList, executeDocDelete } from '../doc.js';
import { executeManageCreate, executeManageDeleteEmpty, executeManageDelete } from '../manage-index.js';
import { rebuildScopeVectors } from './rebuild-vector.js';
import { vectorCountScope } from './vector-client.js';
import { restoreSnapshotLocal } from './restore-snapshot.js';
import { executeBackup, executeBackupList } from './backup.js';
import { backfillWiki } from './wiki-sync.js';
import type { OperationRequest } from './operation-coordinator.js';

type Handler = (params: any) => Promise<unknown> | unknown;

export interface DaemonOperationContext {
  jobId?: string;
  abortSignal?: AbortSignal;
  onProgress?: (progress: {
    phase: 'queued' | 'scan' | 'vectorize' | 'persist' | 'restore' | 'rebuild';
    done: number;
    total: number;
    persisted?: number;
    metadataPending?: number;
    failed?: number;
    cancelled?: number;
  }) => void;
}

const HANDLERS: Record<string, Handler> = {
  store: executeStore,
  'bulk-store': executeBulkStore,
  search: executeSearch,
  'sync-relation': executeSyncRelation,
  'bulk-sync-relation': executeBulkSyncRelation,
  'delete-relation': executeDeleteRelation,
  'delete-group': executeDeleteGroup,
  'batch-delete': (params) => executeBatchDelete(params?.scope, params?.items ?? []),
  import: handleDirectImport,
  'scope-list': executeScopeList,
  'scope-delete': executeScopeDelete,
  'scope-clear': executeScopeClear,
  'query-group': executeQueryGroup,
  'get-module-info': executeGetModuleInfo,
  'get-module-info-batch': executeGetModuleInfoBatch,
  'tag-list': executeTagList,
  'doc-list': executeDocList,
  'doc-delete': executeDocDelete,
  'manage-create': executeManageCreate,
  'manage-delete-empty': executeManageDeleteEmpty,
  'manage-delete': executeManageDelete,
  'rebuild-vector': (params) => rebuildScopeVectors(
    params.scope,
    { countScope: vectorCountScope },
    { ...(params.options ?? {}), abortSignal: params.abortSignal ?? params.options?.abortSignal, onProgress: params.onProgress ?? params.options?.onProgress },
  ),
  'restore-snapshot': async (params) => {
    if (params?.yes !== true) {
      throw Object.assign(new Error('daemon 还原操作必须显式确认 --yes'), { code: 'CONFIRMATION_REQUIRED' });
    }
    const restored = await restoreSnapshotLocal(params.scope, {
      timestamp: params.timestamp,
      backupDir: params.backupDir,
      snapshotFile: params.snapshotFile,
      abortSignal: params.abortSignal,
      onProgress: params.onProgress,
    });
    if (params.rebuildVector !== true) return restored;
    const rebuilt = await rebuildScopeVectors(
      params.scope,
      { countScope: vectorCountScope },
      { ...(params.options ?? {}), abortSignal: params.abortSignal ?? params.options?.abortSignal, onProgress: params.onProgress ?? params.options?.onProgress },
    );
    return { ...restored, rebuildVector: rebuilt };
  },
  backup: (params) => executeBackup({ scope: params.scope }),
  'backup-list': (params) => executeBackupList(params.scope),
  export: async (params) => {
    // 延迟导入：export.ts 同时承载 CLI 参数入口；daemon owner 标记已设置后
    // 再加载，避免 daemon 启动阶段误执行 CLI 解析。
    const { handleExport } = await import('../export.js');
    return handleExport({ scope: params.scope, output: params.output, group: params.group });
  },
  'wiki-backfill': (params) => backfillWiki(params.scope, { force: params.force === true }),
};

export async function dispatchOperation(
  request: OperationRequest,
  context: DaemonOperationContext = {},
): Promise<unknown> {
  const handler = HANDLERS[request.operation];
  if (!handler) throw Object.assign(new Error(`daemon 不支持操作：${request.operation}`), { code: 'DAEMON_OPERATION_UNSUPPORTED' });
  // 这些长任务的取消/进度回调是 daemon 进程内能力，不能通过 JSON params 传递；
  // 在 dispatch 边界注入，其他短操作保持原 handler 契约。
  if (request.operation === 'import') {
    return handler({ ...(request.params as Record<string, unknown>), jobId: context.jobId, abortSignal: context.abortSignal, onProgress: context.onProgress });
  }
  if (request.operation === 'rebuild-vector') {
    const params = request.params as Record<string, any>;
    return handler({ ...params, options: { ...(params.options ?? {}), abortSignal: context.abortSignal, onProgress: context.onProgress } });
  }
  if (request.operation === 'restore-snapshot') {
    const params = request.params as Record<string, any>;
    return handler({ ...params, abortSignal: context.abortSignal, onProgress: context.onProgress, options: { ...(params.options ?? {}), abortSignal: context.abortSignal, onProgress: context.onProgress } });
  }
  return handler(request.params);
}

export function supportedOperations(): string[] {
  return Object.keys(HANDLERS).sort();
}
