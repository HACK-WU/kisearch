/**
 * DataSourcePage —— 数据源列表 + 右侧详情面板（REQ-20261020-001）
 *
 * 信息架构（2026-10-21 用户定稿）：
 *  - 主区是**全宽列表**（不再用左右分栏）：Scope / 源目录 / 落点 / 上次同步 / 状态 / 待删
 *  - 点击某行 → 右侧面板展示该数据源上一次同步详情 + 待删段（URL `/datasource/:scope`，可分享/刷新恢复）
 *  - 页面只读；唯一写动作是面板里的「删除待删候选」
 *  - **面板是非模态的**（V3 定稿）：不铺遮罩、1px 描边、全高常驻 ⇒ 点另一行直接切换数据源。
 *    曾试过「半高 + 全屏遮罩」，实测面板像悬空白板、选中行绿带透过遮罩像污渍，已推翻。
 *  - **列表不再自带卡片标题**（PM 走查）：页面身份由顶栏 H1 唯一承载，总数在页头副标题；
 *    原先卡片头重复了一次「数据源」又把「共 N 个」数了两遍。想加回标题前先确认这两处仍在。
 *  - loading / error / empty 三者互斥（见下方卡内分支）：同屏出现「加载失败」与「还没有数据源」
 *    会把读取故障伪装成"用户没登记过"。
 *  - **不再展示"未登记的历史导入目录"**（用户 2026-10-21 决定删除该逻辑）：页面只列已登记数据源。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useDataSourceDetail, useDataSourceList } from '@/lib/hooks';
import { useScopeValue } from '@/lib/scopeContext';
import { addRemoteDataSource, pruneDataSource, syncDataSource, type DataSourcePendingItem } from '@/api/httpApi';
import { getTask } from '@/api/tasksApi';
import { buildDataSourceDetail, buildDataSourceListSummary, dataSourceStatusView, resolveDataSourceActiveState } from '@/lib/dataSourceDetailModel';
import { RowList, SectionTitle } from '@/components/TaskDetailParts';
import { GroupPathSelect } from '@/components/GroupPathSelect';
import { ScopePathSelect } from '@/components/ScopePathSelect';

const keyOf = (item: { group: string; relation: string }): string => `${item.group}\u0000${item.relation}`;

const PAGE_SIZE_DEFAULT = 10;

function formatDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function GroupCheckbox({ checked, indeterminate, disabled, onChange, label }: {
  checked: boolean;
  indeterminate: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
    />
  );
}

export function DataSourcePage(): JSX.Element {
  const { scope } = useParams<{ scope?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const listQuery = useDataSourceList();
  const detailQuery = useDataSourceDetail(scope ?? null);
  const currentScope = useScopeValue();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);
  const [syncingScope, setSyncingScope] = useState<string | null>(null);
  const [rowSyncNotice, setRowSyncNotice] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState({ scope: '', url: '', branch: '', subdir: '', group: '' });
  const [addScopeConfirmed, setAddScopeConfirmed] = useState(false);
  const [addState, setAddState] = useState<{
    phase: 'idle' | 'submitting' | 'cloning' | 'done';
    taskId?: string;
    progress?: number;
    error?: string;
    notice?: string;
  }>({ phase: 'idle' });
  const scopeRef = useRef<string | undefined>(scope);
  const addTriggerRef = useRef<HTMLButtonElement>(null);
  const addDialogRef = useRef<HTMLElement>(null);
  const addWasOpenRef = useRef(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const deleteBtnRef = useRef<HTMLButtonElement>(null);
  const lastScopeRef = useRef<string | null>(null);

  useEffect(() => {
    scopeRef.current = scope;
  }, [scope]);

  useEffect(() => {
    if (addOpen) {
      addWasOpenRef.current = true;
      // 只聚焦弹窗容器：聚焦 Scope 输入框会触发它的 onFocus 自动展开列表
      const timer = window.setTimeout(() => addDialogRef.current?.focus(), 0);
      const onKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') setAddOpen(false);
      };
      window.addEventListener('keydown', onKey);
      return () => {
        window.clearTimeout(timer);
        window.removeEventListener('keydown', onKey);
      };
    }
    if (addWasOpenRef.current) {
      addWasOpenRef.current = false;
      requestAnimationFrame(() => addTriggerRef.current?.focus());
    }
    return undefined;
  }, [addOpen]);

  useEffect(() => {
    setSelected(new Set());
    setConfirming(false);
    setSubmitting(false);
    setError(null);
    setReceipt(null);
    setSyncingScope(null);
    setRowSyncNotice(null);
  }, [scope]);

  // 关闭抽屉后把焦点还给打开它的行（否则焦点掉到 body）
  useEffect(() => {
    if (scope) {
      lastScopeRef.current = scope;
      return;
    }
    const last = lastScopeRef.current;
    if (!last) return;
    lastScopeRef.current = null;
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-ds-scope="${CSS.escape(last)}"]`)?.focus();
    });
  }, [scope]);

  // Esc 关闭抽屉（与站内其他浮层同口径）；添加弹窗打开时由弹窗独占 Esc
  useEffect(() => {
    if (!scope || addOpen) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') navigate('/datasource');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scope, navigate, addOpen]);

  // 旧 daemon 只返回 running：统一在这里归一，避免 `undefined !== null` 把空闲判成进行中
  const activeState = resolveDataSourceActiveState(detailQuery.data?.activeState, detailQuery.data?.running);
  const active = activeState !== null;
  const availability = detailQuery.data?.syncAvailability;
  const model = useMemo(
    () => (detailQuery.data
      ? buildDataSourceDetail(detailQuery.data.source, {
        activeState,
        activeStartedAt: detailQuery.data.activeStartedAt,
      })
      : null),
    [detailQuery.data, activeState],
  );
  const sources = listQuery.data?.sources ?? [];
  const missing = listQuery.data?.missing ?? [];
  const corrupt = listQuery.data?.corrupt ?? [];
  const total = sources.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const pageSources = sources.slice((page - 1) * pageSize, page * pageSize);
  // 失败时不得再报「加载中…」：该文案会一直挂着，与卡内的失败提示自相矛盾。
  const listSummary = listQuery.isError
    ? '数据源列表读取失败'
    : listQuery.data ? buildDataSourceListSummary(listQuery.data.total, sources) : '加载中…';
  useEffect(() => {
    if (page > pageCount) setPage(pageCount);
  }, [page, pageCount]);

  const selectable = model !== null && !active && !model.pending.blocked && model.pending.items.length > 0;
  const visibleItems = model?.pending.items ?? [];
  const selectedCount = selected.size;
  const ratio = model && model.pending.eligibleCount > 0
    ? Math.round((selectedCount / model.pending.eligibleCount) * 1000) / 10
    : null;

  // 外部（CLI / 另一标签页）启动同步时 selectable 变 false：收起已打开的确认条，
  // 否则「确认删除」只剩 submitting 一道拦截，能在同步进行中被点下去。
  useEffect(() => {
    if (confirming && !selectable) setConfirming(false);
  }, [confirming, selectable]);

  // 数据刷新后（删除成功 / 同步完成）清掉已不在候选里的勾选
  useEffect(() => {
    const visibleKeys = new Set((model?.pending.items ?? []).map(keyOf));
    setSelected((prev) => {
      const next = new Set([...prev].filter((key) => visibleKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [model?.pending.items]);

  const toggleOne = (item: DataSourcePendingItem): void => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const key = keyOf(item);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = (): void => {
    setConfirming(false);
    setSelected((prev) => {
      if (prev.size >= visibleItems.length) return new Set();
      return new Set(visibleItems.map(keyOf));
    });
  };

  const toggleGroup = (items: DataSourcePendingItem[]): void => {
    setConfirming(false);
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = items.every((item) => next.has(keyOf(item)));
      for (const item of items) {
        if (allSelected) next.delete(keyOf(item));
        else next.add(keyOf(item));
      }
      return next;
    });
  };

  const runPrune = async (): Promise<void> => {
    if (!model || !scope || submitting) return;
    // 确认条打开后同步可能被外部启动：提交前再判一次，避免与本次扫描竞争
    if (!selectable) {
      setError('当前不可删除候选（同步进行中或候选已失效）。');
      setConfirming(false);
      return;
    }
    const runScope = scope;
    if (!model.pending.token) {
      setError('没有可用的候选凭证，请重新同步后再试。');
      setConfirming(false);
      return;
    }
    const selectedItems = visibleItems
      .filter((item) => selected.has(keyOf(item)))
      .map((item) => ({ group: item.group, relation: item.relation }));
    if (selectedItems.length === 0) {
      setError('请先勾选要删除的文档。');
      setConfirming(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await pruneDataSource({ scope: runScope, token: model.pending.token, selected: selectedItems });
      if (scopeRef.current !== runScope) return;
      setReceipt(`已删除 ${result.deleted} 篇${result.failed > 0 ? `，失败 ${result.failed} 篇` : ''}；剩余 ${result.pendingDelete.total} 篇`);
      setSelected(new Set());
      setConfirming(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', runScope] }),
        queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
        queryClient.invalidateQueries({ queryKey: ['docList'] }),
      ]);
      requestAnimationFrame(() => closeBtnRef.current?.focus());
    } catch (err) {
      if (scopeRef.current !== runScope) return;
      const e = err as Error & { status?: number; body?: { code?: string; error?: string; skipDetail?: string } };
      if (e.status === 409) {
        // 409 有两种：候选失效（需重新同步）/ 重算后闸门拦截（附 skipDetail）
        setError(e.body?.code === 'PRUNE_BLOCKED'
          ? `未生成候选：${e.body?.skipDetail ?? e.body?.error ?? '请稍后重试'}`
          : `源目录已变化，当前候选已失效。本页不能触发同步，请在命令行执行：ki datasource sync --scope ${runScope} 后重试。`);
        // 重新拉详情：让页面拿到最新的 blocked/stale 状态（不再显示旧 token 的假象）
        await queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', runScope] });
      } else {
        setError(`删除失败：${e.message}`);
      }
      setConfirming(false);
    } finally {
      setSubmitting(false);
    }
  };

  const triggerSync = async (targetScope: string, full = false): Promise<void> => {
    if (syncingScope !== null) return;
    setSyncingScope(targetScope);
    setRowSyncNotice(null);
    try {
      const result = await syncDataSource({ scope: targetScope, full });
      const message = `已提交${result.mode === 'full' ? '全量' : '增量'}同步（${targetScope}，任务 ${result.taskId.slice(0, 8)}）`;
      setRowSyncNotice({ tone: 'info', text: message });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', targetScope] }),
        queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
        queryClient.invalidateQueries({ queryKey: ['docList'] }),
      ]);
    } catch (err) {
      const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
      let message: string;
      if (e.status === 429) message = e.body?.error ?? '同步过于频繁，请稍后再试';
      else if (e.status === 409) message = e.body?.error ?? '已有同步任务在排队或执行中';
      else if (e.status === 403) message = '没有该知识库的同步权限';
      else message = `同步失败：${e.message}`;
      setRowSyncNotice({ tone: 'warn', text: message });
      await queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', targetScope] });
    } finally {
      setSyncingScope(null);
    }
  };

  // ── S-05：页面添加 Git URL 数据源 ──────────────────────
  const addBusy = addState.phase === 'submitting' || addState.phase === 'cloning';

  useEffect(() => {
    if (addState.phase !== 'cloning' || !addState.taskId) return undefined;
    const taskId = addState.taskId;
    let cancelled = false;
    let failures = 0;
    const tick = async (): Promise<void> => {
      try {
        const { task } = await getTask(taskId);
        if (cancelled) return;
        failures = 0;
        if (task.state === 'queued' || task.state === 'running' || task.state === 'unknown') {
          const progress = task.progress && task.progress.total > 0
            ? Math.min(100, Math.round((task.progress.done / task.progress.total) * 100))
            : undefined;
          setAddState((prev) => (prev.phase === 'cloning' ? { ...prev, progress } : prev));
          return;
        }
        if (task.state === 'succeeded') {
          const syncTaskId = task.result?.syncTaskId ?? null;
          const targetScope = task.scope;
          setAddState({
            phase: 'done',
            notice: syncTaskId
              ? `已登记 ${targetScope}；首次全量同步已入队（任务 ${syncTaskId.slice(0, 8)}）`
              : `已登记 ${targetScope}；首次同步入队失败，请执行 ki datasource sync --scope ${targetScope}`,
          });
          setAddOpen(false);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: ['dataSourceList'] }),
            queryClient.invalidateQueries({ queryKey: ['dataSourceDetail', targetScope] }),
          ]);
          navigate(`/datasource/${encodeURIComponent(targetScope)}`);
          return;
        }
        const detail = task.error ?? '添加失败';
        const code = task.result?.errorCode ? `（${task.result.errorCode}）` : '';
        setAddState({ phase: 'idle', error: `${detail}${code}${task.recoveryHint ? `；${task.recoveryHint}` : ''}` });
      } catch (err) {
        if (cancelled) return;
        failures += 1;
        // daemon 重启 / 任务 1h TTL 到期：任务可能已不存在，不能无限显示「克隆中」
        const e = err as Error & { status?: number };
        if (e.status === 404 || failures >= 3) {
          setAddState({
            phase: 'idle',
            error: '无法读取添加任务状态（可能 daemon 已重启或任务已过期）；请刷新页面确认是否已登记，必要时执行 ki datasource remove --scope <scope> --purge --yes 后重试',
          });
        }
      }
    };
    void tick();
    const timer = window.setInterval(() => { void tick(); }, 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [addState.phase, addState.taskId, navigate, queryClient]);

  const submitAdd = async (): Promise<void> => {
    if (addBusy) return;
    const targetScope = addForm.scope.trim();
    const url = addForm.url.trim();
    if (!targetScope) {
      setAddState({ phase: 'idle', error: '请选择要登记到的 scope' });
      return;
    }
    if (!url) {
      setAddState({ phase: 'idle', error: '请填写 Git 仓库地址' });
      return;
    }
    setAddState({ phase: 'submitting' });
    try {
      const result = await addRemoteDataSource({
        scope: targetScope,
        url,
        ...(addForm.branch.trim() ? { branch: addForm.branch.trim() } : {}),
        ...(addForm.subdir.trim() ? { subdir: addForm.subdir.trim() } : {}),
        group: addForm.group.trim() || null,
      });
      setAddState({ phase: 'cloning', taskId: result.taskId });
    } catch (err) {
      const e = err as Error & { status?: number; body?: { code?: string; error?: string } };
      let message: string;
      if (e.status === 403) message = '没有该知识库的操作权限';
      else if (e.status === 404) message = '当前 daemon 不支持页面添加 Git 数据源，请升级并重启 daemon';
      else message = e.body?.error ?? `添加失败：${e.message}`;
      setAddState({ phase: 'idle', error: message });
    }
  };

  return (
    <div className="ki-datasource-page">
      <div className="ki-page-head">
        <div>
          <p>{listSummary}</p>
        </div>
        <button
          type="button"
          ref={addTriggerRef}
          className="ki-btn ki-btn--secondary"
          aria-haspopup="dialog"
          aria-expanded={addOpen}
          onClick={() => {
            setAddForm({ scope: '', url: '', branch: '', subdir: '', group: '' });
            setAddScopeConfirmed(false);
            setAddState({ phase: 'idle' });
            setAddOpen(true);
          }}
        >添加 Git 数据源</button>
      </div>

      {addState.notice ? (
        <p className="ki-task-notice ki-task-notice--info">{addState.notice}</p>
      ) : null}
      {!addOpen && addState.error ? (
        <p className="ki-task-notice ki-task-notice--warn" role="alert">{addState.error}</p>
      ) : null}

      {addOpen ? (
        <div
          className="ki-overlay ki-overlay--show ki-overlay--front"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAddOpen(false);
          }}
        >
          <section ref={addDialogRef} className="ki-dialog ki-dialog--form" id="ki-ds-add-form" role="dialog" aria-modal="true" aria-labelledby="ki-ds-add-title" tabIndex={-1}>
            <header className="ki-dialog__head">
              <div>
                <h3 className="ki-dialog__title" id="ki-ds-add-title">添加 Git 数据源</h3>
                <p className="ki-ds-add__sub">服务端 clone 后自动开始首次全量同步</p>
              </div>
              <button type="button" className="ki-dialog__close" aria-label="关闭添加表单" onClick={() => setAddOpen(false)}>✕</button>
            </header>
            <div className="ki-dialog__body">
              <p className="ki-ds-add__hint">
                私有仓库使用 daemon 环境的 SSH agent / credential helper，本页不收集凭据。
                <br />
                本地目录请用 <code>ki datasource add --source &lt;目录&gt;</code>。
              </p>
              <div className="ki-ds-add__grid">
                <div className="ki-ds-add__scope">
                  <ScopePathSelect
                    hideLabel
                    value={addForm.scope}
                    confirmed={addScopeConfirmed}
                    currentScope={currentScope}
                    onChange={(value, confirmed) => {
                      setAddForm((prev) => (value !== prev.scope ? { ...prev, scope: value, group: '' } : { ...prev, scope: value }));
                      setAddScopeConfirmed(confirmed);
                    }}
                    onModeChange={() => setAddScopeConfirmed(false)}
                    autoConfirmNew
                    placeholder="按名称筛选已有 Scope，如：kafka"
                    hint="从已有 Scope 搜索选择；切到「新建 Scope」直接输入名称即可，无需再点创建。"
                    disabled={addBusy}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <label className="ki-form-label" htmlFor="ki-ds-add-url">Git 仓库地址 *</label>
                  <input
                    id="ki-ds-add-url"
                    className="ki-form-input"
                    type="text"
                    placeholder="https://github.com/org/repo.git 或 git@github.com:org/repo.git"
                    value={addForm.url}
                    disabled={addBusy}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, url: event.target.value }))}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <label className="ki-form-label" htmlFor="ki-ds-add-branch">分支</label>
                  <input
                    id="ki-ds-add-branch"
                    className="ki-form-input"
                    type="text"
                    placeholder="留空 = 默认分支"
                    value={addForm.branch}
                    disabled={addBusy}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, branch: event.target.value }))}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <label className="ki-form-label" htmlFor="ki-ds-add-subdir">仓库子目录</label>
                  <input
                    id="ki-ds-add-subdir"
                    className="ki-form-input"
                    type="text"
                    placeholder="如 docs/guide（留空 = 仓库根）"
                    value={addForm.subdir}
                    disabled={addBusy}
                    onChange={(event) => setAddForm((prev) => ({ ...prev, subdir: event.target.value }))}
                  />
                </div>

                <div className="ki-ds-add__field">
                  <span className="ki-form-label">落点 Group</span>
                  {addScopeConfirmed && addForm.scope ? (
                    <GroupPathSelect
                      scope={addForm.scope}
                      value={addForm.group}
                      onChange={(value) => setAddForm((prev) => ({ ...prev, group: value }))}
                      placeholder="搜索或输入新 Group，如：docs/guide"
                      hint="下拉来自当前 Scope；输入新路径可新建 Group。留空 = 按子目录自动。"
                      disabled={addBusy}
                    />
                  ) : (
                    <input className="ki-form-input" disabled placeholder="请先选择 Scope" />
                  )}
                </div>
              </div>
              {addState.error ? (
                <p className="ki-write-error" role="alert">{addState.error}</p>
              ) : null}
            </div>
            <footer className="ki-dialog__foot">
              <span className="ki-ds-add__status" aria-live="polite">
                {addState.phase === 'cloning'
                  ? `正在服务端 clone（任务 ${addState.taskId?.slice(0, 8) ?? ''}）；关闭弹窗不会取消任务`
                  : ''}
              </span>
              <button type="button" className="ki-btn ki-btn--secondary" onClick={() => setAddOpen(false)}>取消</button>
              <button
                type="button"
                className="ki-btn ki-btn--primary"
                disabled={addBusy || !addScopeConfirmed || !addForm.scope.trim() || !addForm.url.trim()}
                onClick={() => { void submitAdd(); }}
              >
                {addState.phase === 'cloning'
                  ? `克隆中${addState.progress !== undefined ? ` ${addState.progress}%` : '…'}`
                  : addState.phase === 'submitting' ? '提交中…' : '添加并开始首次同步'}
              </button>
            </footer>
          </section>
        </div>
      ) : null}

      <div className="ki-ds-callout" role="note">
        <span className="ki-ds-callout__icon" aria-hidden>ⓘ</span>
        <span>
          Git 仓库可在本页「添加 Git 数据源」（服务端 clone）；本地目录数据源通过命令行登记：<code className="ki-ds-callout__cmd">ki datasource add --scope &lt;scope&gt; --source &lt;目录&gt;</code>。
          <strong>同步可在本页触发</strong>（普通目录 30 分钟一次，CLI 可强制）。本页的删除仅针对待删候选，不动源目录文件。
        </span>
      </div>

      {rowSyncNotice ? (
        <p className={`ki-task-notice ki-task-notice--${rowSyncNotice.tone}`} role={rowSyncNotice.tone === 'warn' ? 'alert' : undefined}>
          {rowSyncNotice.text}
        </p>
      ) : null}

      {missing.map((item) => (
        <p key={item.scope} className="ki-task-notice ki-task-notice--warn">⚠ {item.scope} 目录不可读：{item.reason}</p>
      ))}
      {corrupt.map((item) => (
        <p key={item.scope} className="ki-task-notice ki-task-notice--warn">⚠ {item.scope} 登记损坏：{item.reason}</p>
      ))}

      <section className="ki-card">
        <div className="ki-card__body">
          {listQuery.isLoading ? (
            <p className="ki-ds-muted">加载中…</p>
          ) : listQuery.isError ? (
            /* 失败态与空态必须互斥（2026-10-21 PM 走查）：原先两块各自独立渲染，读取失败时
               「加载失败」与「还没有数据源」同屏出现，把故障伪装成"用户没登记过"。
               口径与结构照 BrowsePage 的「Group 加载失败」块，复用 .ki-empty 现成样式。 */
            <div className="ki-empty" style={{ padding: 24 }}>
              <div>
                <h3>数据源列表读取失败</h3>
                <p>{(listQuery.error as Error).message}</p>
                <div className="ki-empty__actions">
                  <button
                    className="ki-btn ki-btn--secondary ki-btn--small"
                    type="button"
                    disabled={listQuery.isFetching}
                    onClick={() => { void listQuery.refetch(); }}
                  >{listQuery.isFetching ? '重试中…' : '重试'}</button>
                </div>
              </div>
            </div>
          ) : sources.length === 0 ? (
            <div className="ki-empty">
              <p>还没有数据源。Git 仓库可用右上角「添加 Git 数据源」；本地目录通过命令行登记：</p>
              <code className="ki-ds-empty__cmd">{'ki datasource add\n  --scope <scope>\n  --source <目录>'}</code>
            </div>
          ) : (
            <>
              <table className="ki-ds-table" aria-label="数据源列表">
                <thead>
                  <tr className="ki-ds-table__head">
                    <th scope="col">Scope</th>
                    <th scope="col" className="ki-ds-col--type">类型</th>
                    <th scope="col">源目录</th>
                    <th scope="col" className="ki-ds-col--group">落点 Group</th>
                    <th scope="col" className="ki-ds-col--time">上次同步</th>
                    <th scope="col">状态</th>
                    <th scope="col" className="ki-ds-col--pending">待删</th>
                    <th scope="col" className="ki-ds-col--actions">操作</th>
                  </tr>
                </thead>
                <tbody>
                {pageSources.map((source) => {
                  const status = dataSourceStatusView({ activeState: source.activeState, running: source.running, lastSync: source.lastSync });
                  const pendingCount = source.lastSync?.pendingDelete.total ?? 0;
                  const lastSyncLabel = source.lastSync ? formatDateTime(source.lastSync.at) : null;
                  const rowAvailability = source.syncAvailability;
                  const rowSyncing = syncingScope === source.scope;
                  const rowCanSync = !source.running && rowAvailability?.allowed === true && syncingScope === null;
                  const rowTitle = rowSyncing
                    ? '正在提交同步请求'
                    : source.running
                      ? (source.activeState === 'queued' ? '同步已排队' : '同步进行中')
                      : rowAvailability === undefined
                        ? '当前 daemon 不支持页面同步，请升级并重启'
                        : rowAvailability.reason === 'cooldown'
                          ? `距上次成功同步不足 30 分钟；如需立即同步：ki datasource sync --scope ${source.scope}`
                          : '同步（Git 源为增量）';
                  const typeLabel = source.type === 'git' ? 'Git' : '目录';
                  return (
                  <tr
                    key={source.scope}
                    tabIndex={0}
                    data-ds-scope={source.scope}
                    aria-label={`${source.scope}，${typeLabel}，${source.dir}，${status.label}${lastSyncLabel ? `，上次同步 ${lastSyncLabel}` : ''}${pendingCount > 0 ? `，待删 ${pendingCount} 篇` : ''}`}
                    className={`ki-ds-table__row${scope === source.scope ? ' is-active' : ''}`}
                    onClick={() => navigate(`/datasource/${encodeURIComponent(source.scope)}`)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigate(`/datasource/${encodeURIComponent(source.scope)}`);
                      }
                    }}
                  >
                    <td>
                      <span className="ki-ds-table__scope" title={source.scope}>
                        <span className="ki-ds-table__scope-name">{source.scope}</span>
                      </span>
                    </td>
                    <td className="ki-ds-col--type">
                      <span className={`ki-ds-type-badge ki-ds-type-badge--${source.type === 'git' ? 'git' : 'dir'}`}>{typeLabel}</span>
                    </td>
                    <td className="ki-ds-table__dir" title={source.dir}>{source.dir}</td>
                    <td className="ki-ds-table__group ki-ds-col--group" title={source.group ?? '(自动)'}>{source.group ?? '(自动)'}</td>
                    <td className="ki-ds-col--time">{lastSyncLabel ?? '—'}</td>
                    <td>
                      <span
                        className={`ki-task-state ki-task-state--${status.tone}`}
                        title={status.state === 'running' ? '本次同步进行中' : status.state === 'queued' ? '等待同知识库的其他任务完成' : undefined}
                      >{status.label}</span>
                    </td>
                    <td className="ki-ds-col--pending">
                      {source.lastSync && source.lastSync.pendingDelete.total > 0
                        ? <span className="ki-ds-pending-badge">待删 {source.lastSync.pendingDelete.total}</span>
                        : '—'}
                    </td>
                    <td className="ki-ds-table__actions">
                      <button
                        type="button"
                        className="ki-btn ki-btn--secondary ki-btn--small ki-ds-sync-btn"
                        disabled={!rowCanSync}
                        title={rowTitle}
                        aria-label={`同步 ${source.scope}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          if (rowCanSync) void triggerSync(source.scope);
                        }}
                      >{rowSyncing ? '提交中…' : source.running ? (source.activeState === 'queued' ? '排队中' : '同步中') : '同步'}</button>
                    </td>
                  </tr>
                  );
                })}
                </tbody>
              </table>
              {/* 单页时不渲染分页栏（四个控件全禁用、"第 1/1 页"与副标题重复）。
                  ★ 但 `pageSize !== 默认` 时必须继续渲染 —— 否则用户把每页改成 100 后、
                    页数变 1，分页栏连同「每页」选择器一起消失，本会话内再也改不回 10。 */}
              {(pageCount > 1 || pageSize !== PAGE_SIZE_DEFAULT) ? (
                <div className="ki-ds-pager">
                  <span className="ki-ds-pager__info">第 {page} / {pageCount} 页 · 共 {total} 个</span>
                  <label className="ki-ds-pager__size">
                    每页
                    <select
                      value={pageSize}
                      onChange={(event) => { setPageSize(Number(event.target.value)); setPage(1); }}
                      aria-label="每页条数"
                    >
                      <option value={10}>10</option>
                      <option value={50}>50</option>
                      <option value={100}>100</option>
                    </select>
                    条
                  </label>
                  <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>上一页</button>
                  <button type="button" className="ki-btn ki-btn--secondary ki-btn--small" disabled={page >= pageCount} onClick={() => setPage((p) => p + 1)}>下一页</button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* 右侧详情：URL 驱动（/datasource/:scope），Esc / ✕ 关闭。
          ★ 非模态（2026-10-21 用户定稿 V3）：不铺遮罩、1px 描边分隔、面板常驻全高。
            列表保持可读可点 —— 直接点另一行即可切换数据源；代价是"点背景关闭"不再成立。 */}
      {scope ? (
        <>
          <aside className="ki-ds-drawer" role="region" aria-label={`数据源详情 ${scope}`}>
            <header className="ki-ds-drawer__head">
              <div className="ki-ds-drawer__identity">
                <div className="ki-ds-drawer__kicker">DATASOURCE</div>
                <h2 className="ki-ds-drawer__title">{scope}</h2>
              </div>
              {model ? <span className={`ki-task-state ki-task-state--${model.header.tone}`}>{model.header.stateLabel}</span> : null}
              <button
                type="button"
                ref={closeBtnRef}
                className="ki-ds-drawer__close"
                aria-label="关闭详情"
                onClick={() => navigate('/datasource')}
              >✕</button>
            </header>
            <div className="ki-ds-drawer__body">
              {detailQuery.isLoading ? <p className="ki-ds-muted">加载中…</p> : null}
              {detailQuery.isError ? (
                <div className="ki-empty">
                  读取详情失败：{(detailQuery.error as Error).message}
                  <button type="button" className="ki-btn ki-btn--small" onClick={() => { void detailQuery.refetch(); }}>重试</button>
                </div>
              ) : null}
              {model ? (
                <>
                  {model.notices.map((notice) => (
                    <p key={notice.text} className={`ki-task-notice ki-task-notice--${notice.tone}`}>{notice.text}</p>
                  ))}
                  {availability?.reason === 'cooldown' ? (
                    <p className="ki-task-notice ki-task-notice--info">
                      距上次成功同步不足 30 分钟（约 {Math.max(1, Math.ceil((availability.retryAfterSec ?? 0) / 60))} 分钟）。
                      如需立即同步：<code>ki datasource sync --scope {scope}</code>
                    </p>
                  ) : null}
                  {availability === undefined && detailQuery.data ? (
                    <p className="ki-task-notice ki-task-notice--warn">当前 daemon 不支持页面同步，请升级并重启。</p>
                  ) : null}
                  <SectionTitle>同步参数</SectionTitle>
                  <RowList rows={model.params} className="ki-ds-facts--stack" />

                  {model.results.length > 0 ? (
                    <>
                      <SectionTitle>{model.header.active ? '上次执行结果' : '执行结果'}</SectionTitle>
                      <RowList rows={model.results} className="ki-ds-facts--stack" />
                    </>
                  ) : null}
                  {model.details.failures.length > 0 ? (
                    <details className="ki-task-detail__details">
                      <summary>
                        失败明细 {model.details.failures.length}
                        {model.details.failureTotal > model.details.failures.length ? ` / 共 ${model.details.failureTotal}` : ''} 条
                      </summary>
                      <ul className="ki-task-tree ki-task-tree--list">
                        {model.details.failures.map((item) => (
                          <li key={`${item.title}-${item.meta ?? ''}`} className="ki-task-tree__row ki-task-tree__row--item">
                            <span className="ki-task-tree__path">{item.title}</span>
                            {item.meta ? <span className="ki-task-tree__meta">{item.meta}</span> : null}
                          </li>
                        ))}
                      </ul>
                      {model.details.failureTotal > model.details.failures.length ? (
                        <p className="ki-ds-pending__note">
                          仅显示前 {model.details.failures.length} 条；完整清单见 datasource.json 的 lastSync.result.failures。
                        </p>
                      ) : null}
                    </details>
                  ) : null}
                  {model.details.conflicts.length > 0 ? (
                    <details className="ki-task-detail__details">
                      <summary>冲突 / 覆盖明细 {model.details.conflicts.length} 条</summary>
                      <ul className="ki-task-tree ki-task-tree--list">
                        {model.details.conflicts.map((item) => (
                          <li key={`${item.title}-${item.meta ?? ''}`} className="ki-task-tree__row ki-task-tree__row--item">
                            <span className="ki-task-tree__path">{item.title}</span>
                            {item.meta ? <span className="ki-task-tree__meta">{item.meta}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  {model.pending.total > 0 || model.pending.blocked ? (
                    <section className="ki-ds-pending">
                      <SectionTitle>
                        {model.pending.blocked ? '待删除（未生成候选）' : `待删除 ${model.pending.total} 篇`}
                      </SectionTitle>
                      {model.pending.computedAt > 0 ? (
                        <p className="ki-ds-pending__from">由 {new Date(model.pending.computedAt).toLocaleString('zh-CN')} 同步算出</p>
                      ) : null}
                      {model.pending.blocked ? (
                        <p className="ki-task-notice ki-task-notice--warn">{model.pending.skipDetail ?? '未生成候选'}</p>
                      ) : (
                        <>
                          {active ? (
                            <p className="ki-task-notice ki-task-notice--info">
                              {activeState === 'queued'
                                ? '同步已排队，暂不能删除候选（避免与即将开始的同步冲突）。'
                                : '同步进行中，暂不能删除候选（避免与本次扫描冲突）。'}
                            </p>
                          ) : null}
                          <div className="ki-ds-pending__head">
                            <label className="ki-ds-pending__all">
                              <GroupCheckbox
                                checked={selectedCount > 0 && selectedCount >= visibleItems.length}
                                indeterminate={selectedCount > 0 && selectedCount < visibleItems.length}
                                disabled={!selectable}
                                onChange={toggleAllVisible}
                                label="全选待删候选"
                              />
                              全选（{visibleItems.length}）
                            </label>
                            <button
                              type="button"
                              ref={deleteBtnRef}
                              className="ki-btn ki-btn--danger ki-btn--small"
                              disabled={!selectable || selectedCount === 0 || submitting}
                              onClick={() => setConfirming(true)}
                            >
                              删除所选 {selectedCount} 篇…
                            </button>
                          </div>

                          {model.pending.groups.map((group) => {
                            const groupSelected = group.items.filter((item) => selected.has(keyOf(item))).length;
                            return (
                              <div key={group.group} className="ki-ds-pending__group">
                                <label className="ki-ds-pending__group-head">
                                  <GroupCheckbox
                                    checked={groupSelected > 0 && groupSelected === group.items.length}
                                    indeterminate={groupSelected > 0 && groupSelected < group.items.length}
                                    disabled={!selectable}
                                    onChange={() => toggleGroup(group.items)}
                                    label={`全选 ${group.group}`}
                                  />
                                  <span className="ki-ds-pending__group-name">{group.group}</span>
                                  <span className="ki-ds-pending__count">
                                    {group.count} 篇{group.untouched ? ' · ⚠ 本次未涉及，勾选即清空整组' : ''}
                                  </span>
                                </label>
                                <div className="ki-ds-pending__items">
                                  {group.items.map((item) => (
                                    <label key={keyOf(item)} className="ki-ds-pending__item">
                                      <input
                                        type="checkbox"
                                        checked={selected.has(keyOf(item))}
                                        disabled={!selectable}
                                        onChange={() => toggleOne(item)}
                                      />
                                      <span>{item.sourcePath ?? item.relation}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            );
                          })}

                          {confirming ? (
                            <div className="ki-ds-confirm" role="alertdialog" aria-label="确认删除">
                              <span>
                                将删除 {selectedCount} 篇{ratio !== null ? `（本数据源 ${model.pending.eligibleCount} 篇的 ${ratio}%）` : ''} · 不可恢复
                              </span>
                              <div className="ki-ds-confirm__acts">
                                <button type="button" className="ki-btn ki-btn--small" disabled={submitting} onClick={() => { setConfirming(false); requestAnimationFrame(() => deleteBtnRef.current?.focus()); }}>取消</button>
                                <button type="button" className="ki-btn ki-btn--danger ki-btn--small" disabled={submitting || !selectable} onClick={() => { void runPrune(); }}>
                                  {submitting ? '删除中…' : '确认删除'}
                                </button>
                              </div>
                            </div>
                          ) : null}
                          {ratio !== null && ratio > 20 ? (
                            <p className="ki-task-notice ki-task-notice--warn">本次将删除本数据源 {ratio}% 的文档，比例偏高，请确认源目录无误</p>
                          ) : null}
                          <p className="ki-ds-pending__note">删除不可恢复；执行时按当前源目录重新校验，目录变了会拒绝。只删知识库记录，不动源目录文件。</p>
                        </>
                      )}
                    </section>
                  ) : null}

                  {error ? <p className="ki-task-notice ki-task-notice--warn" role="alert">{error}</p> : null}
                  {receipt ? <p className="ki-ds-receipt">{receipt}</p> : null}

                  <SectionTitle>时间</SectionTitle>
                  <RowList rows={model.times} className="ki-ds-facts--stack" />
                </>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}
    </div>
  );
}
