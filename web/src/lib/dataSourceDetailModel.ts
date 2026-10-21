/**
 * dataSourceDetailModel.ts —— 数据源详情渲染模型（设计 S-05 §3.4）
 *
 * 与任务详情同构（三段 + 待删段），但**不伪造 TaskRecord**：
 * `lastSync` 是数据源自己的快照，字段与任务台账不同。
 */
import type { DataSourceLastSyncView, DataSourcePendingItem, DataSourceRecordView, DataSourceSyncState } from '@/api/httpApi';
import type { DetailItem, DetailRow } from '@/lib/taskDetailModel';

export interface DataSourcePendingGroup {
  group: string;
  count: number;
  items: DataSourcePendingItem[];
  /** 该组本次没有任何文件落入（勾选即清空整组） */
  untouched: boolean;
}

export interface DataSourceDetailModel {
  header: { title: string; state: DataSourceSyncState | 'never'; stateLabel: string };
  params: DetailRow[];
  results: DetailRow[];
  details: {
    failures: DetailItem[];
    conflicts: DetailItem[];
    /** 上次同步未完成文件总数（failures 服务端最多存 20 条） */
    failureTotal: number;
    /** 冲突/覆盖明细条数（服务端最多存 50 条） */
    conflictTotal: number;
  };
  times: DetailRow[];
  pending: {
    total: number;
    items: DataSourcePendingItem[];
    groups: DataSourcePendingGroup[];
    token?: string;
    computedAt: number;
    overLimit: boolean;
    truncated: boolean;
    blocked: string | null;
    skipDetail?: string;
    stale: boolean;
    staleReason?: string | null;
    eligibleCount: number;
    untouchedGroups: string[];
  };
  notices: { tone: 'warn' | 'info'; text: string }[];
}

export const DATASOURCE_STATE_LABEL: Record<DataSourceSyncState | 'never', string> = {
  never: '从未同步',
  ok: '成功',
  partial: '部分失败',
  failed: '失败',
  cancelled: '已取消',
};

const CONFLICT_LABEL: Record<string, string> = {
  incremental: '增量（同名覆盖）',
  overwrite: '覆盖已有文档',
  skip: '跳过同名文档',
  suffix: '自动添加后缀',
};

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(ts);
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
}

function failureItems(sync: DataSourceLastSyncView | null): DetailItem[] {
  if (!sync) return [];
  return sync.result.failures.map((item) => ({ title: item.path, meta: item.reason }));
}

function conflictItems(sync: DataSourceLastSyncView | null): DetailItem[] {
  if (!sync) return [];
  return sync.result.conflicts.map((item) => ({
    title: item.path,
    meta: item.unchanged ? '内容未变，已跳过重算' : (item.action === 'overwrite' ? '覆盖' : item.action === 'skip' ? '跳过' : '加后缀'),
  }));
}

export function buildDataSourceDetail(record: DataSourceRecordView): DataSourceDetailModel {
  const sync = record.lastSync;
  const pendingDelete = sync?.pendingDelete;
  const items = pendingDelete?.items ?? [];
  const groupMap = new Map<string, DataSourcePendingItem[]>();
  for (const item of items) {
    const list = groupMap.get(item.group) ?? [];
    list.push(item);
    groupMap.set(item.group, list);
  }
  const untouched = new Set(pendingDelete?.untouchedGroups ?? []);
  const groups: DataSourcePendingGroup[] = [...groupMap.entries()].map(([group, groupItems]) => ({
    group,
    count: groupItems.length,
    items: groupItems,
    untouched: untouched.has(group),
  }));

  const notices: DataSourceDetailModel['notices'] = [];
  if (pendingDelete?.stale) {
    const reason = pendingDelete.staleReason;
    notices.push({
      tone: 'warn',
      text: reason === 'source-missing'
        ? '候选来自上次同步：源目录当前不存在。删除前请确认目录已恢复。'
        : reason === 'source-unreadable'
          ? '候选来自上次同步：源目录当前不可读。删除前请确认目录权限。'
          : '候选来自上次同步：最近一次同步未重算候选。删除前请先重新同步。',
    });
  }
  if (pendingDelete?.blocked) {
    notices.push({ tone: 'warn', text: pendingDelete.skipDetail ?? `未生成候选（${pendingDelete.blocked}）` });
  }
  if (pendingDelete?.overLimit) {
    notices.push({
      tone: 'info',
      text: `候选 ${pendingDelete.total} 篇，超过单次上限：本页显示前 ${items.length} 篇，删除后刷新可继续。`,
    });
  }

  const result = sync?.result;
  // 「同步参数」取**上次同步实际使用的参数**（lastSync.params），不是当前登记配置：
  // add 改过策略/切分/落点后二者会不同，用 record 会让人误以为结果来自新配置。
  const p = sync?.params;
  const effGroup = p ? p.group : record.group;
  const effConflict = p ? p.conflictMode : record.conflictMode;
  const effVector = p ? p.vector : record.vector;
  const effChunkSize = p ? p.chunkSize : record.chunkSize;
  const effChunkOverlap = p ? p.chunkOverlap : record.chunkOverlap;
  if (p) {
    const changed = p.group !== record.group
      || p.conflictMode !== record.conflictMode
      || p.vector !== record.vector
      || p.chunkSize !== record.chunkSize
      || p.chunkOverlap !== record.chunkOverlap;
    if (changed) {
      notices.push({ tone: 'info', text: '登记配置已变更：上方为上次同步所用参数，新配置在下次同步生效。' });
    }
  }
  const params: DetailRow[] = [
    { label: '知识库', value: record.scope },
    { label: '源目录', value: record.dir, full: true },
    { label: '落点 Group', value: effGroup ?? '(自动：按顶层子目录)', full: true },
    { label: '同名策略', value: CONFLICT_LABEL[effConflict] ?? effConflict },
    { label: '向量化', value: effVector ? '开启' : '关闭（仅全文）' },
    { label: '切分参数', value: `${effChunkSize ?? 1000} / ${effChunkOverlap ?? 150}` },
  ];

  const results: DetailRow[] = result
    ? [
      { label: '扫描', value: String(result.files.scanned) },
      { label: '完成', value: String(result.files.completed), hint: result.files.unchanged > 0 ? `其中内容未变 ${result.files.unchanged} 篇` : undefined },
      { label: '跳过', value: String(result.files.skipped) },
      { label: '失败', value: String(result.files.incomplete), tone: result.files.incomplete > 0 ? 'danger' : 'normal' },
      { label: '向量条目', value: String(result.vectorized) },
      { label: '全文条目', value: String(result.fullTextIndexed) },
    ]
    : [];

  const times: DetailRow[] = sync
    ? [
      { label: '上次同步', value: formatTime(sync.at) },
      { label: '用时', value: formatDuration(sync.durationMs) },
    ]
    : [{ label: '上次同步', value: '从未同步' }];

  return {
    header: {
      title: '数据源同步',
      state: sync?.state ?? 'never',
      stateLabel: DATASOURCE_STATE_LABEL[sync?.state ?? 'never'],
    },
    params,
    results,
    details: {
      failures: failureItems(sync),
      conflicts: conflictItems(sync),
      failureTotal: sync?.result.files.incomplete ?? 0,
      conflictTotal: sync?.result.conflicts.length ?? 0,
    },
    times,
    pending: {
      total: pendingDelete?.total ?? 0,
      items,
      groups,
      token: pendingDelete?.token,
      computedAt: pendingDelete?.computedAt ?? 0,
      overLimit: pendingDelete?.overLimit ?? false,
      truncated: pendingDelete?.truncated ?? false,
      blocked: pendingDelete?.blocked ?? null,
      skipDetail: pendingDelete?.skipDetail,
      stale: pendingDelete?.stale ?? false,
      staleReason: pendingDelete?.staleReason ?? null,
      eligibleCount: pendingDelete?.eligibleCount ?? 0,
      untouchedGroups: pendingDelete?.untouchedGroups ?? [],
    },
    notices,
  };
}
