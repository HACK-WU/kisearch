import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  getTask, getTasks, getImportIncomplete, retryImportIncomplete, activeImportCount,
  type TaskRecord, type ImportIncompleteStatus,
} from '@/api/tasksApi';
import { cancelImport, getDocContent, getDataSourceDetail } from '@/api/httpApi';
import { taskDetailActions, type TaskAction } from '@/lib/taskActions';
import {
  buildTaskDetail, operationLabel, sourceLabel, stateLabel,
} from '@/lib/taskDetailModel';
import { buildTaskListRow } from '@/lib/taskListModel';
import {
  DEFAULT_TASK_SORT, TASK_FILTERS, countTasks, nextTaskSort, queryTasks, taskFilterLabel,
  type TaskFilter, type TaskSortKey, type TaskSortState,
} from '@/lib/taskQueryModel';
import { ItemTree } from '@/components/TaskDetailParts';
import { ReadOnlyPathTree } from '@/components/ReadOnlyPathTree';
import { buildDataSourcePendingTree } from '@/lib/dataSourceDetailModel';
import { DetailHero, DetailMetrics, DetailParams } from '@/components/DetailParts';
import { useScopeReadonly } from '@/lib/hooks';
import { SCOPE_READONLY_BLOCKED_HINT, scopeReadonlyUnlockHint } from '@/lib/scopeReadonly';
import { DetailDrawer, DetailSection, type DetailStatusTone } from '@/components/DetailDrawer';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { Notice } from '@/components/Notice';

/** 客户端分页（与数据源页同口径：默认 10，可选 50 / 100） */
const PAGE_SIZE_DEFAULT = 10;
/** 每页条数可选项（分页条常显，单页也能改回 10） */
const PAGE_SIZE_OPTIONS = [10, 50, 100] as const;
/** 页码按钮：单页 1 个；>7 页时中段折叠成 …，保证分页条不换行 */
function pageNumbers(page: number, pageCount: number): Array<number | '…'> {
  const items: Array<number | '…'> = [];
  for (let i = 1; i <= pageCount; i += 1) {
    if (pageCount > 7 && i > 2 && i < pageCount - 1 && Math.abs(i - page) > 1) {
      if (items[items.length - 1] !== '…') items.push('…');
      continue;
    }
    items.push(i);
  }
  return items;
}

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
  // 「新增的文档」点开正文：与数据源「待删除」卡一致（阅读用同一套 ModuleDrawer）
  const [docTarget, setDocTarget] = useState<{ scope: string; group: string; relation: string } | null>(null);
  /**
   * 待删除候选属于**数据源**（同步时算出），任务本身没有。任务详情要展示这张卡，
   * 只能按 `task.scope` 反查数据源详情；该 scope 未登记数据源时静默不显示。
   */
  const dsQuery = useQuery({
    queryKey: ['dataSourceDetail', task?.scope],
    queryFn: () => getDataSourceDetail(task!.scope),
    enabled: Boolean(task?.scope && task.scope !== 'unknown'),
    staleTime: 30_000,
    retry: false,
  });
  const pending = dsQuery.data?.source.lastSync?.pendingDelete;

  return (
    <>
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

          {/* 新增的文档：与数据源「待删除」卡同款目录树（2026-10-29 用户要求，
              替代原先「执行结果 → 落点 Group」——落点组对用户价值低，新增目录才是关心的） */}
          <DetailSection
            material="created"
            title={detail.created.available ? `新增的文档 ${detail.created.total} 篇` : '新增的文档'}
            hint={detail.created.truncated ? '明细未完整显示' : undefined}
          >
            {!detail.created.available ? (
              <p className="ki-task-muted">
                {detail.legacy
                  ? '该任务创建于台账扩展之前，没有新建明细。'
                  : '该任务没有新建明细（未完成、非导入任务或旧记录）。'}
              </p>
            ) : detail.created.total === 0 ? (
              <p className="ki-task-muted">本次没有新建文档：全部为覆盖更新、内容未变或被跳过。</p>
            ) : detail.created.items.length === 0 ? (
              // 台账 32KB 预算把明细裁掉了：有总数但没有条目，不能说成「没有新建」
              <p className="ki-task-muted">共 {detail.created.total} 篇，但明细未保留（任务记录超限被裁剪）。</p>
            ) : (
              <>
                <div className="ki-ds-subcard">
                  <ReadOnlyPathTree
                    nodes={buildDataSourcePendingTree(detail.created.items)}
                    label="新增的文档目录"
                    onOpenDoc={(item) => setDocTarget({ scope: task.scope, group: item.group, relation: item.relation })}
                  />
                </div>
                {detail.created.truncated ? (
                  <p className="ki-task-muted">仅显示前 {detail.created.items.length} 篇（共 {detail.created.total} 篇）。</p>
                ) : null}
              </>
            )}
          </DetailSection>

          {/* 待删除候选属于数据源（同步时算出），本页只读展示、可点开正文；删除在「数据源」页 */}
          {pending && (pending.total > 0 || pending.blocked || pending.stale) ? (
            <DetailSection
              material="action"
              title={pending.blocked ? '待删除（未生成候选）' : `待删除 ${pending.total} 篇`}
              hint={pending.computedAt ? `由 ${new Date(pending.computedAt).toLocaleString('zh-CN')} 同步算出` : undefined}
            >
              {pending.blocked ? (
                <p className="ki-task-muted">{pending.skipDetail ?? '未生成候选；请在「数据源」页查看原因。'}</p>
              ) : pending.items.length === 0 ? (
                <p className="ki-task-muted">候选明细不可用（可能已过期或超限）。</p>
              ) : (
                <>
                  <div className="ki-ds-subcard">
                    <ReadOnlyPathTree
                      nodes={buildDataSourcePendingTree(pending.items)}
                      label="待删除文档"
                      onOpenDoc={(item) => setDocTarget({ scope: task.scope, group: item.group, relation: item.relation })}
                    />
                  </div>
                  <p className="ki-task-muted">本页只读；删除请在「数据源」页处理。</p>
                </>
              )}
            </DetailSection>
          ) : null}

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
    {docTarget ? (
      <ModuleDrawer
        scope={docTarget.scope}
        module={docTarget.relation}
        group={docTarget.group}
        fetcher={getDocContent}
        onClose={() => setDocTarget(null)}
      />
    ) : null}
    </>
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

  /**
   * 只读 scope（REQ-20261029-001 屏 7）：任务页**不属于上传导入页**，
   * 但「重试未完成导入」等于继续一次写入 —— 只读库必须在此禁用并给出 CLI 出路，
   * 否则用户会点出一个没有任何页面标识的裸 409。
   */
  const scopeReadonly = useScopeReadonly(task.scope);

  const startRetry = async (): Promise<void> => {
    if (retrying || retryLocked || scopeReadonly) return;
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
            disabled={retrying || retryLocked || scopeReadonly}
            aria-disabled={retrying || retryLocked || scopeReadonly}
            title={scopeReadonly ? SCOPE_READONLY_BLOCKED_HINT : undefined}
          >
            {retrying ? '正在提交重试…' : retryLocked ? '已提交重试' : action.label}
          </button>
          {scopeReadonly ? (
            <span className="ki-task-action__hint">
              ⚠ 该库为只读：页面无法重试，请用 CLI 继续（`ki import --scope {task.scope} --source &lt;原目录&gt;`）；
              解除：{scopeReadonlyUnlockHint(task.scope)}
            </span>
          ) : action.hint ? (
            <span className="ki-task-action__hint">{action.hint}</span>
          ) : null}
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
  /** 筛选态：卡片即入口（全部 / 失败·未知 / 部分完成 / 进行中·排队） */
  const [filter, setFilter] = useState<TaskFilter>('all');
  /** 排序：默认开始时间降序（最新在前），与表头箭头同一状态 */
  const [sort, setSort] = useState<TaskSortState>(DEFAULT_TASK_SORT);
  /** 搜索：支持知识库 / 任务 / 状态 / 错误 */
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const { id: routeId } = useParams<{ id?: string }>();
  const navigate = useNavigate();
  const selectedId = routeId ?? null;
  /** 关闭抽屉后把焦点还给打开它的行（否则焦点掉到 body） */
  const lastSelectedRef = useRef<string | null>(null);
  /** 已为哪个选中项做过「跳到所在页」——避免列表刷新或用户翻页时被反复拉回 */
  const syncedSelectionRef = useRef<string | null>(null);
  const query = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(200),
    staleTime: 0,
    retry: 1,
  });
  const tasks = query.data?.tasks ?? [];
  /**
   * 行视图按 id 缓存：卡片计数、列表渲染、搜索摘要共用同一份 `buildTaskListRow`，
   * 避免「卡片按一个口径计数、列表按另一个口径过滤」。
   */
  const rows = useMemo(
    () => new Map(tasks.map((task) => [task.id, buildTaskListRow(task)])),
    [tasks],
  );
  const visibleTasks = useMemo(() => queryTasks({
    tasks,
    filter,
    query: search,
    sort,
    describe: (task) => {
      const row = rows.get(task.id);
      return {
        summary: row?.resultSummary ?? '',
        sourceText: row?.sourceLabel ?? '',
        operationText: row?.operationLabel ?? '',
      };
    },
  }), [tasks, rows, filter, search, sort]);
  const pageCount = Math.max(1, Math.ceil(visibleTasks.length / pageSize));
  // 收敛帧不能直接读超界页码：下面的 effect 回写要到下一次渲染才生效，
  // 直接用 page 切片会渲染一帧「有表头无行」的空表（空态判据看的是 visibleTasks）
  const currentPage = Math.min(page, pageCount);
  const pageTasks = visibleTasks.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  /** 后端 total 是全部可见任务数，列表只取最近 200 条：两者不一致时必须给出说明 */
  const truncated = (query.data?.total ?? 0) > tasks.length;
  // 任务列表会自动刷新（顶栏同 queryKey 每 3–15s）：条目变少时把页码收回，避免停在空白页
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);
  // 深链 /tasks/:id 或列表刷新后，选中项可能落在别的页：跳到它所在页，否则看不到高亮行。
  // ★ 必须依赖 visibleTasks：深链首帧数据还没到，首次执行时 index=-1，数据到达后要再试一次；
  //   同步过就记下来 —— 列表自动刷新与用户翻页都不得被拉回。
  useEffect(() => {
    if (!selectedId) {
      syncedSelectionRef.current = null;
      return;
    }
    if (syncedSelectionRef.current === selectedId) return;
    const index = visibleTasks.findIndex((task) => task.id === selectedId);
    // 记录已被 TTL 清理时抽屉自己会提示，不强行翻页（下次数据变化再试）
    if (index < 0) return;
    syncedSelectionRef.current = selectedId;
    const target = Math.floor(index / pageSize) + 1;
    setPage((prev) => (prev === target ? prev : target));
  }, [selectedId, visibleTasks, pageSize]);
  /**
   * 卡片数字：与列表过滤同一判据（`taskQueryModel.countTasks`），避免「卡上写 3、点进去 2 条」。
   * ★ `all` 必须走服务端 total：列表只加载最近 200 条，被截断时 `tasks.length` 会小于真实总数，
   *   而页头写的也是 total —— 两处不一致会让用户以为任务丢了（分页条另有截断说明）。
   */
  const counts = useMemo(() => ({
    all: query.data?.total ?? tasks.length,
    failed: countTasks(tasks, 'failed'),
    partial: countTasks(tasks, 'partial'),
    running: countTasks(tasks, 'running'),
  }), [tasks, query.data?.total]);
  /** 是否有生效中的筛选 / 搜索：决定空态文案与「查看全部任务」入口 */
  const filtering = filter !== 'all' || search.trim().length > 0;
  const clearFilters = (): void => {
    setFilter('all');
    setSearch('');
    setPage(1);
  };
  const changeSort = (key: TaskSortKey): void => {
    setSort((prev) => nextTaskSort(prev, key));
    setPage(1);
  };
  /** 再点一次已选中的卡回到「全部」（少一个专门入口）；「全部」卡自身不弹回 */
  const pickFilter = (key: TaskFilter): void => {
    setFilter((prev) => (prev === key && key !== 'all' ? 'all' : key));
    setPage(1);
  };
  const sortArrow = (key: TaskSortKey): string => (
    sort.key === key ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'
  );
  const ariaSortOf = (key: TaskSortKey): 'ascending' | 'descending' | 'none' => (
    sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'
  );

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
      if (event.key !== 'Escape') return;
      // 文档抽屉（新增/待删除的「查看内容」）开着时 Esc 归它 —— 否则一次 Esc 会连任务详情一起关
      if (document.querySelector('.ki-drawer:not(.ki-drawer--inline)')) return;
      navigate('/tasks');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, navigate]);

  return (
    <div className="ki-tasks-page">
      <div className="ki-page-head">
        <div>
          {/* 总数并入副标题：统计卡全部让给筛选（用户 2026-10-30）。自动刷新间隔与顶栏轮询同源（3s / 15s）。 */}
          <p>
            查看网页导入、CLI 导入与向量重建 · 共 {query.data?.total ?? 0} 个任务 · 最近任务保留 1 小时
          </p>
        </div>
        <div className="ki-task-page-actions">
          <button className="ki-btn ki-btn--secondary" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? '刷新中…' : '刷新任务'}
          </button>
        </div>
      </div>

      {/* 卡片即筛选：整卡是 button，命中态用 aria-pressed + 主色描边（Tab 可达，不只靠 hover） */}
      <div className="ki-task-summary-row" role="group" aria-label="任务筛选">
        {TASK_FILTERS.map((def) => {
          const active = filter === def.key;
          const tone = def.key === 'failed'
            ? ' ki-task-summary--failure'
            : def.key === 'partial' ? ' ki-task-summary--partial' : '';
          return (
            <button
              type="button"
              key={def.key}
              className={`ki-task-summary ki-task-summary--filter${tone}${active ? ' is-active' : ''}`}
              aria-pressed={active}
              onClick={() => pickFilter(def.key)}
            >
              <b>{counts[def.key]}</b>
              <span>
                {def.label}
                <small className="ki-task-summary__hint">
                  {active ? '✓ 当前筛选' : `点击筛选 · ${def.hint}`}
                </small>
              </span>
            </button>
          );
        })}
      </div>

      <section className="ki-card ki-task-list-card">
        <div className="ki-card__body ki-card__body--flush">
          {/* 工具条：左＝当前筛选 + 计数，右＝搜索（支持状态词）+ 排序提示。筛选与列表同容器，消除原先 111px 断联。 */}
          <div className="ki-task-toolbar">
            {/* 长关键词由 CSS 截断（否则撑破工具条），完整内容进 title */}
            <span
              className="ki-task-toolbar__count"
              aria-live="polite"
              title={search.trim() ? `搜索「${search.trim()}」· ${taskFilterLabel(filter)} · ${visibleTasks.length} 个` : undefined}
            >
              {search.trim() ? `搜索「${search.trim()}」· ` : ''}
              {taskFilterLabel(filter)} · <b>{visibleTasks.length}</b> 个
            </span>
            <span className="ki-task-toolbar__spacer" />
            <label className="ki-task-search">
              <span className="ki-task-search__icon" aria-hidden="true">⌕</span>
              <input
                id="search-input"
                type="search"
                value={search}
                onChange={(event) => { setSearch(event.target.value); setPage(1); }}
                placeholder="搜索知识库 / 任务 / 状态 / 错误…"
                aria-label="搜索任务（支持状态，如「失败」「进行中」）"
              />
            </label>
            <span className="ki-task-toolbar__hint">点击表头箭头可排序</span>
          </div>
          {query.error ? <div className="ki-task-error">无法读取后台任务。请检查服务连接和数据目录权限。</div> : null}
          {query.isPending ? <div className="ki-task-muted">正在读取任务…</div> : null}
          {!query.error && !query.isPending && visibleTasks.length === 0 ? (
            <div className="ki-empty">
              <div>
                <h3>{filtering ? '当前筛选下没有任务' : '暂无任务'}</h3>
                <p>
                  {filtering
                    ? `筛选：${taskFilterLabel(filter)}${search.trim() ? ` · 关键词「${search.trim()}」` : ''}；共 ${tasks.length} 个任务在其它筛选条件下可见。`
                    : 'CLI 或网页启动导入、向量重建后，任务会自动出现在这里。'}
                </p>
                {filtering ? (
                  <div className="ki-empty__actions">
                    <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" onClick={clearFilters}>
                      查看全部任务
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
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
                  {/* 排序下沉到表头：箭头就地跟在列名后（当前列实心 ↑/↓，其它列灰色 ↕） */}
                  <th scope="col" className="ki-task-col--time" aria-sort={ariaSortOf('start')}>
                    <button type="button" className="ki-task-sort" onClick={() => changeSort('start')} title="按开始时间排序">
                      开始时间<span className="ki-task-sort__arrow" aria-hidden="true">{sortArrow('start')}</span>
                    </button>
                  </th>
                  <th scope="col" aria-sort={ariaSortOf('duration')}>
                    <button type="button" className="ki-task-sort" onClick={() => changeSort('duration')} title="按持续时间排序">
                      <span className="ki-sort-full">持续时间</span><span className="ki-sort-short">耗时</span>
                      <span className="ki-task-sort__arrow" aria-hidden="true">{sortArrow('duration')}</span>
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageTasks.map((task) => {
                  // 复用卡片计数那一份行视图（同一口径），缺失时兜底重算
                  const row = rows.get(task.id) ?? buildTaskListRow(task);
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
          {/* 客户端分页（照搬数据源页）+ 每页条数选择器。
              ★ 一直显示（用户 2026-10-30 要求）：单页 / 空态也给分页条 ——
                否则筛选后只剩 3 条时整条消失，页面高度跳变、每页条数也改不回来。 */}
          {!query.error && !query.isPending ? (
            <div className="ki-ds-pager" role="navigation" aria-label="任务分页">
              <span className="ki-ds-pager__info" aria-live="polite">
                第 {currentPage} / {pageCount} 页 · 共 {visibleTasks.length} 个任务
                {/* 后端 total 是全部可见任务数，而列表只取最近 200 条：两者不一致时说明差异，
                    否则页头计数与可翻页条数对不上（用户只会觉得少了任务）。
                    文案必须给每个数字贴标签：筛选后「共 5 个」与「200 条 / 350 个」并排时，
                    不写清楚会被读成同一个口径。 */}
                {truncated ? ` · 全部任务共 ${query.data?.total} 个，列表仅加载最近 ${tasks.length} 条` : ''}
              </span>
              <label className="ki-ds-pager__size">
                每页
                <select
                  id="page-size"
                  value={pageSize}
                  onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
                  aria-label="每页条数"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
                条
              </label>
              <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" disabled={currentPage <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
              {pageNumbers(currentPage, pageCount).map((item, index) => (item === '…'
                ? <span key={`gap-${index}`} className="ki-ds-pager__gap">…</span>
                : (
                  <button
                    type="button"
                    key={item}
                    className="ki-ds-pager__page"
                    aria-current={item === currentPage ? 'page' : undefined}
                    onClick={() => setPage(item)}
                  >
                    {item}
                  </button>
                )))}
              <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" disabled={currentPage >= pageCount} onClick={() => setPage((p) => p + 1)}>下一页</button>
            </div>
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
