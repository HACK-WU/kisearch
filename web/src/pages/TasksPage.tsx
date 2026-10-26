import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getTask, getTasks, getImportIncomplete, retryImportIncomplete, activeImportCount,
  type TaskRecord, type ImportIncompleteStatus,
} from '@/api/tasksApi';
import { cancelImport } from '@/api/httpApi';
import { taskDetailActions, type TaskAction } from '@/lib/taskActions';
import {
  buildTaskDetail, operationLabel, sourceLabel, stateLabel,
} from '@/lib/taskDetailModel';
import { buildTaskListRow } from '@/lib/taskListModel';
import { ItemTree } from '@/components/TaskDetailParts';
import { DetailHero, DetailMetrics, DetailParams } from '@/components/DetailParts';
import { DetailDrawer, DetailSection, type DetailStatusTone } from '@/components/DetailDrawer';
import { Notice } from '@/components/Notice';

type Filter = 'all' | 'running' | 'failed' | 'recent';

/**
 * 阶段中文映射 / 索引就绪文案 / 状态与操作文案 / 列表行摘要统一收敛到 `lib/taskDetailModel.ts`
 * 与 `lib/taskListModel.ts`（REQ-20261019-004 S-03 / REQ-20261022-002）：
 * 口径需要被单测锁死，不能散落在 JSX 里做判断。
 */

/** 任务进度条（v2 §7-4：列表行与详情均显示；失败/未知转 danger、部分完成转 warn） */
function TaskProgressBar({ task, percent, large = false }: {
  task: TaskRecord;
  /** 百分比由调用方给出——详情用 `buildTaskDetail` 的口径（含阶段单位判定），避免两处各算一份 */
  percent: number | null;
  large?: boolean;
}): JSX.Element | null {
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

/** 任务状态 → 详情抽屉状态 pill 的语义（unknown 走中性灰） */
function taskStatusTone(state: TaskRecord['state']): DetailStatusTone {
  switch (state) {
    case 'succeeded': return 'succeeded';
    case 'partial': return 'partial';
    case 'failed': return 'failed';
    case 'running': return 'running';
    case 'queued': return 'queued';
    case 'cancelled': return 'cancelled';
    default: return 'unknown';
  }
}

/**
 * 任务详情抽屉（REQ-20261022-002）：与数据源详情共用 `.ki-detail*` 外壳与三材质分区。
 * ★ 所有判定在 `buildTaskDetail` / `taskActions` 里，组件只渲染。
 * ★ 任务页跨 scope：详情、落点与动作全部使用 `task.scope`，不跟随顶部当前 scope。
 */
function TaskDetailDrawer({ id, tasks, onClose }: {
  id: string;
  tasks: TaskRecord[];
  onClose: () => void;
}): JSX.Element {
  const { data, isPending, error, refetch } = useQuery({
    queryKey: ['task', id],
    queryFn: () => getTask(id),
    refetchInterval: (queryState) => {
      // 记录已被 TTL 清理（404）：继续轮询只会持续打 404
      if (queryState.state.error) return false;
      const state = queryState.state.data?.task.state;
      return state === 'queued' || state === 'running' ? 3_000 : state === 'unknown' ? 15_000 : false;
    },
    staleTime: 2_000,
    retry: false,
  });
  const task = data?.task;
  const detail = task ? buildTaskDetail(task) : null;
  const title = task ? `${operationLabel(task.operation)} · ${task.scope}` : '任务详情';

  return (
    <DetailDrawer
      ariaLabel="任务详情"
      title={title}
      status={task ? { tone: taskStatusTone(task.state), label: stateLabel(task.state) } : null}
      meta={task ? (
        <>
          <code title={task.id}>{task.id.slice(0, 8)}…</code>
          <span>{sourceLabel(task.source)}</span>
          <span>创建 {new Date(task.createdAt).toLocaleString('zh-CN')}</span>
        </>
      ) : null}
      onClose={onClose}
      dataAttributes={{ 'data-task-detail-id': id }}
    >
      {isPending ? <p className="ki-task-muted">正在读取任务详情…</p> : null}
      {error ? (
        <>
          <Notice tone="danger">记录已清理或读取失败：任务仅保留 1 小时。</Notice>
          <button className="ki-btn ki-btn--secondary ki-btn--small" type="button" onClick={() => void refetch()}>
            重试
          </button>
          <code className="ki-task-id">任务 ID：{id}</code>
        </>
      ) : null}
      {task && detail ? (
        <>
          {/* 提示与错误统一走 Notice（信息/警告/失败三档） */}
          {detail.notices.map((notice, index) => (
            <Notice key={`${notice.tone}-${index}`} tone={notice.tone}>{notice.text}</Notice>
          ))}

          {detail.summary || detail.showProgress || detail.progressText || detail.results.length > 0 ? (
            <DetailSection
              material="data"
              title="执行结果"
              hint={detail.summary
                ? `扫描 ${detail.summary.scanned} 篇`
                : detail.progressPercent !== null ? `完成 ${detail.progressPercent}%` : undefined}
            >
              {detail.summary ? (
                <>
                  <DetailHero
                    completed={detail.summary.completed}
                    total={detail.summary.scanned}
                    skipped={detail.summary.skipped}
                    failed={detail.summary.incomplete}
                    unchanged={detail.summary.unchanged}
                    failedLabel="未完成"
                  />
                  <DetailMetrics metrics={detail.metrics} />
                  {detail.resultExtras.length > 0 ? <DetailParams rows={detail.resultExtras} /> : null}
                </>
              ) : detail.showProgress ? (
                <div className="ki-detail-progress">
                  {detail.progressText ? <p className="ki-task-muted">{detail.progressText}</p> : null}
                  <TaskProgressBar task={task} percent={detail.progressPercent} large />
                </div>
              ) : detail.progressText ? (
                <p className="ki-task-muted">{detail.progressText}</p>
              ) : null}
              {!detail.summary && detail.results.length > 0 ? <DetailParams rows={detail.results} /> : null}
              {detail.duplicates.length > 0 ? (
                <details className="ki-task-detail__details">
                  <summary>疑似重复明细 {detail.duplicates.length} 条</summary>
                  <ItemTree items={detail.duplicates} label="疑似重复明细" />
                </details>
              ) : null}
              {detail.conflicts.length > 0 ? (
                <details className="ki-task-detail__details">
                  <summary>同名冲突明细 {detail.conflicts.length} 条</summary>
                  <ItemTree items={detail.conflicts} label="同名冲突明细" />
                </details>
              ) : null}
            </DetailSection>
          ) : null}

          {/* 参数段恒非空（至少含「知识库」「来源」两行） */}
          <DetailSection material="meta" title="本次参数">
            <DetailParams rows={detail.params} />
          </DetailSection>

          {detail.times.length > 0 ? (
            <DetailSection material="meta" title="时间">
              <DetailParams rows={detail.times} />
            </DetailSection>
          ) : null}

          <TaskActions
            task={task}
            runningImports={activeImportCount(tasks, task.scope)}
            onRecheck={() => void refetch()}
          />
          <code className="ki-task-id">任务 ID：{id}</code>
        </>
      ) : null}
      {!isPending && !error && !task ? <p className="ki-task-muted">未找到任务详情。</p> : null}
    </DetailDrawer>
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
    <DetailSection material="action" title="后续操作">
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
    </DetailSection>
  );
}

export function TasksPage(): JSX.Element {
  const [filter, setFilter] = useState<Filter>('all');
  const { id: routeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const selectedId = routeId ?? null;
  /** 关闭抽屉后把焦点还给打开它的行（否则焦点掉到 body） */
  const lastSelectedRef = useRef<string | null>(null);
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

  useEffect(() => {
    if (selectedId) {
      lastSelectedRef.current = selectedId;
      return;
    }
    const last = lastSelectedRef.current;
    if (!last) return;
    lastSelectedRef.current = null;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(last)}"]`)?.focus();
    });
  }, [selectedId]);

  // Esc 关闭抽屉（与数据源页 / 站内其他浮层同口径）
  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') navigate('/tasks');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, navigate]);

  return (
    <div className="ki-tasks-page">
      <div className="ki-page-head">
        <div>
          <p>查看网页导入、CLI 导入与向量重建 · 最近任务保留 1 小时</p>
        </div>
        <div className="ki-task-page-actions">
          <div className="ki-task-filters" role="tablist" aria-label="任务筛选">
            {([['all', '全部'], ['running', '进行中'], ['failed', '失败'], ['recent', '最近结束']] as const).map(([key, label]) => (
              <button key={key} role="tab" aria-selected={filter === key} className={filter === key ? 'ki-task-filter ki-task-filter--active' : 'ki-task-filter'} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
          <button className="ki-btn ki-btn--secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? '刷新中…' : '刷新任务'}
          </button>
        </div>
      </div>

      <div className="ki-task-summary-row">
        <div className="ki-task-summary"><b>{runningCount}</b><span>运行中 / 排队中</span></div>
        <div className="ki-task-summary ki-task-summary--failure"><b>{failedCount}</b><span>失败 / 状态未知</span></div>
        <div className="ki-task-summary ki-task-summary--partial"><b>{partialCount}</b><span>部分完成</span></div>
        <div className="ki-task-summary"><b>{query.data?.total ?? 0}</b><span>可见任务</span></div>
      </div>

      <section className="ki-card ki-task-list-card">
        <div className="ki-card__body ki-card__body--flush">
          {query.error ? <div className="ki-task-error">无法读取后台任务。请检查服务连接和数据目录权限。</div> : null}
          {query.isPending ? <div className="ki-task-muted">正在读取任务…</div> : null}
          {!query.error && !query.isPending && visibleTasks.length === 0 ? (
            <div className="ki-empty"><div><h3>暂无任务</h3><p>CLI 或网页启动导入、向量重建后，任务会自动出现在这里。</p></div></div>
          ) : null}
          {visibleTasks.length > 0 ? (
            <table className="ki-task-table" aria-label="任务列表">
              <thead>
                <tr className="ki-task-table__head">
                  <th scope="col">状态</th>
                  <th scope="col">任务</th>
                  <th scope="col" className="ki-task-col--scope">知识库</th>
                  <th scope="col" className="ki-task-col--source">来源</th>
                  <th scope="col" className="ki-task-col--result">结果摘要</th>
                  <th scope="col" className="ki-task-col--time">开始时间</th>
                  <th scope="col">持续时间</th>
                </tr>
              </thead>
              <tbody>
                {visibleTasks.map((task) => {
                  const row = buildTaskListRow(task);
                  const active = selectedId === task.id;
                  const openTask = (): void => {
                    navigate(`/tasks/${encodeURIComponent(task.id)}`);
                  };
                  return (
                    <tr
                      key={task.id}
                      tabIndex={0}
                      className={`ki-task-table__row${active ? ' is-active' : ''}`}
                      data-task-id={task.id}
                      aria-label={row.ariaLabel}
                      aria-current={active ? 'true' : undefined}
                      onClick={openTask}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          openTask();
                        }
                      }}
                    >
                      <td>
                        <span className="ki-task-table__state">
                          <span className={`ki-task-state ki-task-state--${task.state}`}>{row.stateLabel}</span>
                          {row.progressPercent !== null ? (
                            <span className="ki-task-table__bar">
                              <TaskProgressBar task={task} percent={row.progressPercent} />
                            </span>
                          ) : null}
                        </span>
                      </td>
                      <td>
                        <span className="ki-task-table__task">
                          <b>{row.operationLabel}</b>
                          <code title={row.id}>#{row.shortId}</code>
                          <small className="ki-task-table__task-scope" title={row.scope}>{row.scope}</small>
                          <small
                            className="ki-task-table__task-result"
                            title={[row.resultSummary, row.resultError].filter(Boolean).join(' · ')}
                          >
                            {row.resultError ?? row.resultSummary}
                          </small>
                        </span>
                      </td>
                      <td className="ki-task-col--scope">
                        <span className="ki-task-table__scope" title={row.scope}>{row.scope}</span>
                      </td>
                      <td className="ki-task-col--source">
                        <span className={`ki-task-source-badge ki-task-source-badge--${task.source}`}>{row.sourceLabel}</span>
                      </td>
                      <td className="ki-task-col--result">
                        <span
                          className={`ki-task-table__result${row.resultTone !== 'normal' ? ` ki-task-table__result--${row.resultTone}` : ''}`}
                          title={[row.resultSummary, row.resultError].filter(Boolean).join(' · ')}
                        >
                          <span className="ki-task-table__summary">{row.resultSummary}</span>
                          {row.resultError ? <span className="ki-task-table__error">{row.resultError}</span> : null}
                        </span>
                      </td>
                      <td className="ki-task-col--time">
                        <span className="ki-task-table__time" title={row.timeTitle}>{row.timeLabel}</span>
                      </td>
                      <td className="ki-task-table__duration">{row.durationLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
        </div>
      </section>

      {/* ★ key 必须绑 id（2026-10-13 评审 P1）：切任务时 React 会复用同一实例，
          否则上一个任务的重试状态（已提交 / jobId / 错误）会串到当前任务上。
          `tasks` 传入用于「该 scope 是否已有导入在跑」的判据（用户反馈的重复重试修复）。 */}
      {selectedId ? (
        <TaskDetailDrawer key={selectedId} id={selectedId} tasks={tasks} onClose={() => navigate('/tasks')} />
      ) : null}
    </div>
  );
}
