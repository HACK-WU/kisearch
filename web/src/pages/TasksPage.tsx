import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  getTask, getTasks, getImportIncomplete, retryImportIncomplete, activeImportCount,
  type TaskRecord, type TaskState, type TaskIndexReadiness, type ImportIncompleteStatus,
} from '@/api/tasksApi';
import { cancelImport } from '@/api/httpApi';
import { taskDetailActions, type TaskAction } from '@/lib/taskActions';
import { Icon } from '@/components/icons';

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

/**
 * S-02/R2（REQ-20261009-003）：阶段中文映射 —— 复用既有 `phase` 字段（**不新增状态枚举**），
 * 新增 `indexing` / `optimized` / `available` / `skipped` 四值（两级完成口径）。
 * 任务中心必须显示中文：不能把英文枚举直接露给用户（`phase` 未知时原样回显，便于排障）。
 */
const PHASE_LABEL: Record<string, string> = {
  scan: '扫描',
  vectorize: '向量化',
  persist: '写入',
  restore: '恢复',
  rebuild: '重建',
  indexing: '索引整理中',
  optimized: '已优化',
  available: '可用（索引未整理）',
  skipped: '未触发索引整理',
};

function phaseLabel(phase?: string): string {
  if (!phase) return '—';
  return PHASE_LABEL[phase] ?? phase;
}

/**
 * S-03/R6（REQ-20261009-003）：索引就绪判据文案（A11 交叉口径）。
 * ★ `unknown`（读取失败/超时）**不得**显示成"未建"——两者对用户的操作指引完全相反：
 *   未建 → 去整理（`ki index-optimize`）；未知 → 稍后重试诊断（别动引擎）。
 */
function indexReadinessLabel(readiness?: TaskIndexReadiness): string {
  if (!readiness) return '—';
  if (readiness.unknown) return '未知（读取超时/失败，稍后重试）';
  return readiness.denseIndexed
    ? `已建（dense ${readiness.completeness?.dense ?? 1}）`
    : '未建（可执行 ki index-optimize 整理）';
}

function timeLabel(value?: number): string {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(value);
}

function taskProgress(task: TaskRecord): string {
  const progress = task.progress;
  if (!progress || progress.total <= 0) return task.phase ? phaseLabel(task.phase) : '等待开始';
  const percent = Math.min(100, Math.round((progress.done / progress.total) * 100));
  const phase = progress.phase ? phaseLabel(progress.phase) : task.phase ? phaseLabel(task.phase) : '处理中';
  return `${phase} · ${percent}%（${progress.done}/${progress.total}）`;
}

function sourceLabel(source: TaskRecord['source']): string {
  if (source === 'web') return '网页';
  if (source === 'cli') return 'CLI';
  return '后台服务';
}

/** 进度百分比；无总数时返回 null（不渲染进度条，与 demo 不确定态一致） */
function progressPercent(task: TaskRecord): number | null {
  const progress = task.progress;
  if (!progress || progress.total <= 0) return null;
  return Math.min(100, Math.round((progress.done / progress.total) * 100));
}

/** 任务进度条（v2 §7-4：列表行与详情均显示；失败/未知转 danger、部分完成转 warn） */
function TaskProgressBar({ task, large = false }: { task: TaskRecord; large?: boolean }): JSX.Element | null {
  const percent = progressPercent(task);
  if (percent === null) return null;
  const tone = task.state === 'failed' || task.state === 'unknown' ? 'danger' : task.state === 'partial' ? 'warn' : 'accent';
  return (
    <div
      className={`ki-task-bar${large ? ' ki-task-bar--lg' : ''}`}
      role="progressbar"
      aria-valuenow={percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="任务进度"
    >
      <i className={`ki-task-bar__fill ki-task-bar__fill--${tone}`} style={{ width: `${percent}%` }} />
    </div>
  );
}

function TaskDetail({ id, tasks }: { id: string; tasks: TaskRecord[] }): JSX.Element {
  const { data, isPending, error, refetch } = useQuery({
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
          <span className="ki-panel-kicker">DETAIL</span>
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
            <div><dt>阶段</dt><dd>{phaseLabel(task.phase)}</dd></div>
            {/* S-03/R6：索引就绪（A11 交叉口径）——"索引是否真的建了"不必再开引擎诊断 */}
            <div><dt>索引</dt><dd>{indexReadinessLabel(task.indexReadiness)}</dd></div>
            <div><dt>进度</dt><dd>{taskProgress(task)}</dd></div>
            <div><dt>开始时间</dt><dd>{timeLabel(task.startedAt ?? task.createdAt)}</dd></div>
            <div><dt>结束时间</dt><dd>{timeLabel(task.finishedAt)}</dd></div>
            {task.partialCommitted !== undefined && <div><dt>已提交条目</dt><dd>{task.partialCommitted}</dd></div>}
          </dl>
          <TaskProgressBar task={task} large />
          {task.error && <p className="ki-task-error">{task.error}</p>}
          {task.recoveryHint && <p className="ki-task-recovery">{task.recoveryHint}</p>}
          {task.state === 'unknown' && <p className="ki-task-muted">任务来源已失去心跳；请查看启动任务的终端确认最终结果。</p>}
        </>
      ) : null}
      <code className="ki-task-id">{id}</code>
      {task ? (
        <TaskActions
          task={task}
          runningImports={activeImportCount(tasks, task.scope)}
          onRecheck={() => void refetch()}
        />
      ) : null}
    </aside>
  );
}

/**
 * 任务详情动作区（2026-10-13）。
 *
 * 背景：详情此前只有**恒定一个**「前往导入页处理 →」——失败 / 取消 / 中断任务点过去大概率
 * 空跑（导入页的重试入口依赖浏览器凭据与内存 job 结果，凭据在 failed / cancelled 时已被清，
 * 刷新恢复路径同样清理）。现按 `state × source × 服务端清单可重试性` 渲染真实可达的出路，
 * 判据与文案在 `lib/taskActions.ts`（纯函数、有单测）。
 *
 * ★ `unknown`（心跳丢失）刻意不给重试：进程可能仍在跑，重试会与其重复导入。
 * ★ 重试由**服务端按清单执行**（不需要浏览器凭据）——成功后刷新任务列表即可看到新任务。
 * ★ 动作区只读清单摘要（`read` 通道），导入/向量化期间不会被排队。
 */
function TaskActions({
  task,
  runningImports,
  onRecheck,
}: {
  task: TaskRecord;
  /** 同 scope 正在跑的导入任务数（`queued`/`running`，来自任务列表，与后端闸门同口径） */
  runningImports: number;
  onRecheck: () => void;
}): JSX.Element | null {
  const queryClient = useQueryClient();
  const isImport = task.operation === 'import';
  const recoverable = task.state === 'partial' || task.state === 'failed' || task.state === 'cancelled';
  const incompleteQuery = useQuery({
    queryKey: ['import-incomplete', task.scope],
    queryFn: () => getImportIncomplete(task.scope),
    // 只有导入类任务的非成功终态需要清单判据；success / running / unknown 都不查
    enabled: isImport && recoverable,
    staleTime: 5_000,
    retry: false,
  });
  const [retrying, setRetrying] = useState(false);
  /** 最近一次提交成功的 jobId（提示条长期保留；按钮解锁见 retryLocked） */
  const [retryJobId, setRetryJobId] = useState<string | null>(null);
  /**
   * 按钮防重锁（2026-10-13 评审 P2）：提交成功后只锁 20s 而非永久禁用——
   * 否则同一详情视图里再想重试（新 job 又 partial、清单又生成）只能刷新页面。
   * ★ 2026-10-13 用户反馈后：真正的判据已交给 `runningImports`（服务端状态，跨刷新成立），
   *   本锁只覆盖"提交到任务列表刷新之间"的窗口。
   */
  const [retryLocked, setRetryLocked] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<{ command: string; ok: boolean } | null>(null);

  const model = taskDetailActions({
    task: { id: task.id, scope: task.scope, operation: task.operation, state: task.state, source: task.source },
    incomplete: incompleteQuery.data as ImportIncompleteStatus | undefined,
    incompleteLoading: isImport && recoverable && incompleteQuery.isPending,
    incompleteError: incompleteQuery.isError,
    runningImports,
  });

  const startRetry = async (): Promise<void> => {
    if (retrying || retryLocked) return;
    setRetrying(true);
    setRetryError(null);
    try {
      const response = await retryImportIncomplete(task.scope, task.id);
      if (!response.ok || !response.jobId) throw new Error(response.error ?? '重试启动失败');
      setRetryJobId(response.jobId);
      // 防误重复点击：锁 20s 后解锁（提示条保留）——否则同一视图内再也无法重试
      setRetryLocked(true);
      window.setTimeout(() => setRetryLocked(false), 20_000);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['import-incomplete', task.scope] }),
      ]);
    } catch (failure) {
      // 400/409 的失败分支由 request 抛出：`body.error` 是后端给出的可读原因（fail-loud，不吞）
      const body = (failure as { body?: { error?: string } }).body;
      setRetryError(body?.error ?? (failure instanceof Error ? failure.message : '重试启动失败'));
    } finally {
      setRetrying(false);
    }
  };

  /**
   * 停止页面导入的任务（2026-10-13 用户要求）。
   * 两段式确认：停止会中断正在跑的导入（已完成文档保留、未完成部分进未完成清单），不适合一键生效。
   * ★ 只对 `source='web'` 的任务给出——`/api/import/cancel` 只认 HTTP 入口启动的 job。
   */
  const [stopArmed, setStopArmed] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);
  const [stopError, setStopError] = useState<string | null>(null);

  const stopTask = async (): Promise<void> => {
    setStopping(true);
    setStopError(null);
    try {
      const result = await cancelImport(task.id);
      setStopArmed(false);
      setStopNotice(result.message ?? '已请求停止：当前批次完成后停止写入');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['tasks'] }),
        queryClient.invalidateQueries({ queryKey: ['task', task.id] }),
      ]);
    } catch (failure) {
      setStopError(failure instanceof Error ? failure.message : '停止请求失败');
    } finally {
      setStopping(false);
    }
  };

  // 任务脱离进行中（cancelled / 终态）后，「已请求停止」不再适用——清掉，避免它与终态徽标
  // 长期并存被读成"还在停"（2026-10-13 评审 P2）。
  useEffect(() => {
    if (task.state !== 'queued' && task.state !== 'running') setStopNotice(null);
  }, [task.state]);

  const copyCommand = async (command: string): Promise<void> => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // 剪贴板不可用（非 https / 权限拒绝）：命令文本本身可见可手选，明确告知而不假装成功
      ok = false;
    }
    setCopyState({ command, ok });
    window.setTimeout(() => setCopyState((cur) => (cur?.command === command ? null : cur)), 4000);
  };

  function renderAction(action: TaskAction): JSX.Element {
    if (action.kind === 'retry-incomplete') {
      return (
        <div key={action.kind} className="ki-task-action">
          <button
            className="ki-btn ki-btn--primary ki-btn--small"
            onClick={() => void startRetry()}
            disabled={retrying || retryLocked}
          >
            {retrying ? '正在提交重试…' : retryLocked ? '已提交重试' : action.label}
          </button>
          {action.hint ? <span className="ki-task-action__hint">{action.hint}</span> : null}
        </div>
      );
    }
    if (action.kind === 'stop-import') {
      return (
        <div key={action.kind} className="ki-task-action">
          {stopArmed ? (
            <>
              <button
                className="ki-btn ki-btn--danger ki-btn--small"
                onClick={() => void stopTask()}
                disabled={stopping}
              >
                {stopping ? '正在请求停止…' : '确认停止'}
              </button>
              <button
                className="ki-btn ki-btn--secondary ki-btn--small"
                onClick={() => setStopArmed(false)}
                disabled={stopping}
              >
                取消
              </button>
              <span className="ki-task-action__hint">停止后未完成部分进入未完成清单，可稍后再重试</span>
            </>
          ) : (
            <button className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => setStopArmed(true)}>
              {action.label}
            </button>
          )}
        </div>
      );
    }
    if (action.kind === 'goto-import') {
      return (
        <div key={action.kind} className="ki-task-action">
          <Link className={`ki-btn ki-btn--small ${action.primary ? 'ki-btn--primary' : 'ki-btn--secondary'}`} to="/import">
            {action.label}
          </Link>
        </div>
      );
    }
    if (action.kind === 'cli-command') {
      const command = action.command ?? '';
      return (
        <div key={action.kind} className="ki-task-action">
          {/* 命令用 scope、不含真实路径（沿用脱敏惯例），可直接复制到终端执行 */}
          <code className="ki-task-action__cmd">{command}</code>
          <button className="ki-btn ki-btn--secondary ki-btn--small" onClick={() => void copyCommand(command)}>
            {copyState?.command === command && copyState.ok ? '已复制' : '复制命令'}
          </button>
          {copyState?.command === command && !copyState.ok ? (
            <span className="ki-task-action__hint">复制失败：请手动选择命令文本</span>
          ) : null}
        </div>
      );
    }
    return (
      <div key={action.kind} className="ki-task-action">
        <button className="ki-btn ki-btn--secondary ki-btn--small" onClick={onRecheck}>{action.label}</button>
      </div>
    );
  }

  const visible = model.actions.length > 0 || model.note !== undefined || retryError !== null
    || retryJobId !== null || stopNotice !== null || stopError !== null;
  if (!visible) return null;

  return (
    <div className="ki-task-actions">
      {stopNotice ? <p className="ki-task-action-note ki-task-action-note--ok">{stopNotice}</p> : null}
      {stopError ? <p className="ki-task-action-note ki-task-action-note--error">{stopError}</p> : null}
      {retryJobId ? (
        <p className="ki-task-action-note ki-task-action-note--ok">
          已提交重试任务（{retryJobId.slice(0, 8)}…）：只处理未完成文件，可在上方任务列表查看进度。
        </p>
      ) : null}
      {retryError ? <p className="ki-task-action-note ki-task-action-note--error">{retryError}</p> : null}
      {model.note ? (
        <p className={`ki-task-action-note ki-task-action-note--${model.noteTone ?? 'info'}`}>{model.note}</p>
      ) : null}
      {model.actions.map(renderAction)}
    </div>
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
            <span className="ki-panel-heading">
              <span className="ki-panel-kicker">TASKS</span>
              <span className="ki-card__title">任务记录</span>
            </span>
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
                  <TaskProgressBar task={task} />
                  {task.error && <small>{task.error}</small>}
                </span>
                <time>{timeLabel(task.startedAt ?? task.createdAt)}</time>
              </button>
            ))}
          </div>
        </section>
        {/* ★ key 必须绑 id（2026-10-13 评审 P1）：切任务时 React 会复用同一实例，
            否则上一个任务的重试状态（已提交 / jobId / 错误）会串到当前任务上。
            `tasks` 传入用于「该 scope 是否已有导入在跑」的判据（用户反馈的重复重试修复）。 */}
        {selectedId ? <TaskDetail key={selectedId} id={selectedId} tasks={tasks} /> : (
          <aside className="ki-task-detail ki-task-detail--empty">
            <span className="ki-task-detail__icon">
              <Icon name="clock" />
            </span>
            <h2>选择一个任务</h2>
            <p>任务详情会显示阶段、进度、错误摘要和恢复建议。</p>
          </aside>
        )}
      </div>
    </div>
  );
}
