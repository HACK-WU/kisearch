import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getTask, getTasks, type TaskRecord, type TaskState } from '@/api/tasksApi';

type Filter = 'all' | 'running' | 'failed' | 'recent';

const STATE_LABEL: Record<TaskState, string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  partial: '部分完成',
  failed: '失败',
  cancelled: '已取消',
  unknown: '状态未知',
};

const OPERATION_LABEL: Record<string, string> = {
  import: '上传导入',
  'rebuild-vector': '向量重建',
  'restore-snapshot': '快照还原',
};

function timeLabel(value?: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(value);
}

function taskProgress(task: TaskRecord): string {
  const progress = task.progress;
  if (!progress || progress.total <= 0) return task.phase ?? '等待开始';
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
  return `${progress.phase ?? task.phase ?? '处理中'} · ${percent}%（${progress.done}/${progress.total}）`;
}

function sourceLabel(source: TaskRecord['source']): string {
  if (source === 'web') return '网页';
  if (source === 'cli') return 'CLI';
  return '后台服务';
}

function TaskDetail({ id }: { id: string }): JSX.Element {
  const { data, isPending, error } = useQuery({
    queryKey: ['task', id],
    queryFn: () => getTask(id),
    refetchInterval: (queryState) => {
      const state = queryState.state.data?.task.state;
      return state === 'queued' || state === 'running' ? 3_000 : state === 'unknown' ? 15_000 : false;
    },
    staleTime: 2_000,
    retry: false,
  });
  const task = data?.task;
  return (
    <aside className="ki-task-detail">
      <div className="ki-task-detail__head">
        <div>
          <span className="ki-card__sub">任务详情</span>
          <h2>{task ? (OPERATION_LABEL[task.operation] ?? task.operation) : '任务'}</h2>
        </div>
        <span className={`ki-task-state ki-task-state--${task?.state ?? 'unknown'}`}>
          {task ? STATE_LABEL[task.state] : '读取中'}
        </span>
      </div>
      {isPending ? <p className="ki-task-muted">正在读取任务详情…</p> : null}
      {error ? <p className="ki-task-error">任务详情暂不可用，可能已过期。</p> : null}
      {task ? (
        <>
          <dl className="ki-task-detail__grid">
            <div><dt>来源</dt><dd>{sourceLabel(task.source)}</dd></div>
            <div><dt>知识库</dt><dd>{task.scope}</dd></div>
            <div><dt>阶段</dt><dd>{task.phase ?? '—'}</dd></div>
            <div><dt>进度</dt><dd>{taskProgress(task)}</dd></div>
            <div><dt>开始时间</dt><dd>{timeLabel(task.startedAt ?? task.createdAt)}</dd></div>
            <div><dt>结束时间</dt><dd>{timeLabel(task.finishedAt)}</dd></div>
            {task.partialCommitted !== undefined && <div><dt>已提交条目</dt><dd>{task.partialCommitted}</dd></div>}
          </dl>
          {task.error && <p className="ki-task-error">{task.error}</p>}
          {task.recoveryHint && <p className="ki-task-recovery">{task.recoveryHint}</p>}
          {task.state === 'unknown' && <p className="ki-task-muted">任务来源已失去心跳；请查看启动任务的终端确认最终结果。</p>}
        </>
      ) : null}
      <code className="ki-task-id">{id}</code>
    </aside>
  );
}

export function TasksPage(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(200),
    staleTime: 0,
    retry: 1,
  });
  const tasks = query.data?.tasks ?? [];
  const visibleTasks = useMemo(() => tasks.filter((task) => {
    if (filter === 'running') return task.state === 'queued' || task.state === 'running';
    if (filter === 'failed') return task.state === 'failed' || task.state === 'unknown';
    if (filter === 'recent') return task.state !== 'queued' && task.state !== 'running';
    return true;
  }), [tasks, filter]);
  const runningCount = tasks.filter((task) => task.state === 'queued' || task.state === 'running').length;
  const failedCount = tasks.filter((task) => task.state === 'failed' || task.state === 'unknown').length;
  const partialCount = tasks.filter((task) => task.state === 'partial').length;

  return (
    <div className="ki-tasks-page">
      <div className="ki-page-head">
        <div>
          <h1>后台任务</h1>
          <p>查看网页导入、CLI 导入与向量重建 · 最近任务保留 1 小时</p>
        </div>
        <button className="ki-btn ki-btn--secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
          {query.isFetching ? '刷新中…' : '刷新任务'}
        </button>
      </div>

      <div className="ki-task-summary-row">
        <div className="ki-task-summary"><b>{runningCount}</b><span>运行中 / 排队中</span></div>
        <div className="ki-task-summary ki-task-summary--failure"><b>{failedCount}</b><span>失败 / 状态未知</span></div>
        <div className="ki-task-summary ki-task-summary--partial"><b>{partialCount}</b><span>部分完成</span></div>
        <div className="ki-task-summary"><b>{query.data?.total ?? 0}</b><span>可见任务</span></div>
      </div>

      <div className="ki-task-workspace">
        <section className="ki-card ki-task-list-card">
          <div className="ki-card__head">
            <span className="ki-card__title">任务记录</span>
            <div className="ki-task-filters" role="tablist" aria-label="任务筛选">
              {([['all', '全部'], ['running', '进行中'], ['failed', '失败'], ['recent', '最近结束']] as const).map(([key, label]) => (
                <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'ki-task-filter ki-task-filter--active' : 'ki-task-filter'} onClick={() => setFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
          </div>
          <div className="ki-card__body ki-task-list">
            {query.error ? <div className="ki-task-error">无法读取后台任务。请检查服务连接和数据目录权限。</div> : null}
            {query.isPending ? <div className="ki-task-muted">正在读取任务…</div> : null}
            {!query.error && !query.isPending && visibleTasks.length === 0 ? (
              <div className="ki-empty"><div><h3>暂无任务</h3><p>CLI 或网页启动导入、向量重建后，任务会自动出现在这里。</p></div></div>
            ) : null}
            {visibleTasks.map((task) => (
              <button key={task.id} className={`ki-task-row${selectedId === task.id ? ' ki-task-row--selected' : ''}`} onClick={() => setSelectedId(task.id)}>
                <span className={`ki-task-state ki-task-state--${task.state}`}>{STATE_LABEL[task.state]}</span>
                <span className="ki-task-row__main">
                  <b>{OPERATION_LABEL[task.operation] ?? task.operation}</b>
                  <span>{task.scope} · {sourceLabel(task.source)} · {taskProgress(task)}</span>
                  {task.error && <small>{task.error}</small>}
                </span>
                <time>{timeLabel(task.startedAt ?? task.createdAt)}</time>
              </button>
            ))}
          </div>
        </section>
        {selectedId ? <TaskDetail id={selectedId} /> : (
          <aside className="ki-task-detail ki-task-detail--empty">
            <span className="ki-task-detail__icon">◷</span>
            <h2>选择一个任务</h2>
            <p>任务详情会显示阶段、进度、错误摘要和恢复建议。</p>
          </aside>
        )}
      </div>
    </div>
  );
}
