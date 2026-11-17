/**
 * AiAnalyzePanel.tsx —— 事件「AI 分析」卡内嵌面板（2026-11-17 改版 · 批 2）
 *
 * 由 `AiAnalyzeModal` 改造而来，改动点（见 design/S02）：
 *   · 去掉遮罩 / 弹窗外壳 / `onClose`（面板无关闭语义，折叠即隐藏过程）；
 *   · 挂载**不再自动开始**：由 `startSignal` 递增触发，且用 `useRef` 比对上次值，
 *     否则 `key={active.id}` 重挂时会把「切事件回来」当成一次新的分析（重复烧 LLM）；
 *   · 只保留面板内 1.5s 轮询（页面级 2s 轮询已删除），响应按 `runId` 比对，旧响应丢弃；
 *   · 底栏主操作三段式：停止 / 确认·丢弃 / 重新分析 —— 避免"草稿已丢但有已确认位置"时按钮全无；
 *   · 过程区 160px 固定高、贴底才跟随（E-15）；候选默认收起代码、按钮 preventDefault（L-04）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  cancelEventAnalysis,
  confirmEventAnalysis,
  discardEventAnalysisDraft,
  getEventAnalysis,
  GovernanceApiError,
  startEventAnalysis,
  type AnalysisDraft,
  type EventAnalysis,
  type EventView,
} from '@/api/governanceApi';

export const DEFAULT_ANALYSIS_CHECK_SCORE = 0.6;

const SETTINGS_GUIDE_CODES = new Set([
  'ANALYSIS_TARGET_NOT_CONFIGURED',
  'ANALYSIS_TARGET_UNREADABLE',
  'ANALYSIS_TOOLS_ALL_DISABLED',
  'ANALYSIS_DISCLOSURE_REQUIRED',
]);

export function shouldDefaultCheckCandidate(confidence: number): boolean {
  return confidence >= DEFAULT_ANALYSIS_CHECK_SCORE;
}

export function shouldOpenAiSettingsForError(code?: string): boolean {
  return Boolean(code && SETTINGS_GUIDE_CODES.has(code));
}

export function formatAnalysisMs(ms: number): string {
  return ms <= 0 ? '<1ms' : `${ms}ms`;
}

function formatError(err: unknown): { code?: string; message: string } {
  if (err instanceof GovernanceApiError) {
    return {
      ...(err.code ? { code: err.code } : {}),
      message: err.code ? `[${err.code}] ${err.message}` : err.message,
    };
  }
  return { message: (err as Error).message || '请求失败' };
}

export interface AiAnalyzePanelProps {
  scope: string;
  event: EventView;
  analysis: EventAnalysis | null;
  canWrite: boolean;
  /** 递增触发一次 start；0 = 不启动（挂载时不会误触发） */
  startSignal: number;
  onUpdated: (next: EventAnalysis) => void;
  onOpenSettings: () => void;
}

export function AiAnalyzePanel(args: AiAnalyzePanelProps): JSX.Element {
  const { scope, event, analysis, canWrite, startSignal, onOpenSettings } = args;

  const [draft, setDraft] = useState<AnalysisDraft | null>(analysis?.draft ?? null);
  const [confirmed, setConfirmed] = useState(analysis?.confirmed ?? []);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ code?: string; message: string } | null>(null);
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [procOpen, setProcOpen] = useState(true);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [openCands, setOpenCands] = useState<string[]>([]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(
    (analysis?.draft?.candidates ?? [])
      .filter((c) => shouldDefaultCheckCandidate(c.confidence))
      .map((c) => c.id),
  ));
  /** G-12：后端报已有草稿冲突时，先就地确认再带 forceOverwrite 重发 */
  const [overwritePrompt, setOverwritePrompt] = useState(false);

  /** 父级回调放进 ref：避免整个 props 对象成为依赖，导致轮询被反复重建（评审 #19） */
  const onUpdatedRef = useRef(args.onUpdated);
  onUpdatedRef.current = args.onUpdated;

  const syncFromAnalysis = useCallback((next: EventAnalysis, resetPicked: boolean) => {
    setDraft(next.draft);
    setConfirmed(next.confirmed);
    onUpdatedRef.current(next);
    if (resetPicked && next.draft) {
      setPicked(new Set(
        next.draft.candidates.filter((c) => shouldDefaultCheckCandidate(c.confidence)).map((c) => c.id),
      ));
    }
  }, []);

  const triggerStart = useCallback(async (forceOverwrite = false): Promise<void> => {
    if (!canWrite) return;
    setStarting(true);
    setStartError(null);
    setActionError('');
    setOverwritePrompt(false);
    setProcOpen(true);
    try {
      const res = await startEventAnalysis(scope, event.id, { forceOverwrite });
      syncFromAnalysis(res.analysis, true);
    } catch (err) {
      const e = err instanceof GovernanceApiError ? { code: err.code, message: err.message } : null;
      // 已有未处理草稿：先问再覆盖（两段式，见 S02 §3.7）
      if (!forceOverwrite && e?.code === 'REVISION_CONFLICT') {
        setOverwritePrompt(true);
      } else {
        setStartError(formatError(err));
      }
    } finally {
      setStarting(false);
    }
  }, [canWrite, scope, event.id, syncFromAnalysis]);

  // 只有 startSignal **变化**才启动；挂载时 signal 未变 → 不启动
  const lastSignal = useRef(startSignal);
  useEffect(() => {
    if (startSignal === lastSignal.current) return;
    lastSignal.current = startSignal;
    void triggerStart(false);
  }, [startSignal, triggerStart]);

  const isRunning = draft?.status === 'running';

  // 面板内唯一轮询；响应 runId 与当前不符即丢弃
  useEffect(() => {
    if (!isRunning) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await getEventAnalysis(scope, event.id);
        if (!alive) return;
        const finishedNow = Boolean(res.draft && res.draft.status !== 'running');
        syncFromAnalysis({ draft: res.draft, confirmed: res.confirmed }, finishedNow);
        if (finishedNow) setProcOpen(false);
      } catch {
        // 单次轮询失败不中断
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [isRunning, scope, event.id, syncFromAnalysis]);

  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  const candidates = useMemo(() => draft?.candidates ?? [], [draft]);
  const pickedIds = useMemo(
    () => candidates.filter((c) => picked.has(c.id)).map((c) => c.id),
    [candidates, picked],
  );

  /** 已确认态由前端派生（后端无该字段）：本轮候选都能在 confirmed 里按 file+line 命中 */
  const isConfirmedLoc = useCallback(
    (c: { file: string; line: number }) => confirmed.some((x) => x.file === c.file && x.line === c.line),
    [confirmed],
  );
  const committed = candidates.length > 0 && candidates.every(isConfirmedLoc);

  const toggleCandidate = (id: string): void => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleConfirm = async (): Promise<void> => {
    if (pickedIds.length === 0 || !draft) return;
    setSubmitting(true);
    setActionError('');
    try {
      const res = await confirmEventAnalysis(scope, event.id, {
        candidateIds: pickedIds,
        expectedRunId: draft.runId,
        discardDraft: false,
      });
      syncFromAnalysis({ draft: res.draft, confirmed: res.confirmed }, false);
    } catch (err) {
      setActionError(formatError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleStop = async (): Promise<void> => {
    setStopping(true);
    setActionError('');
    try {
      const res = await cancelEventAnalysis(scope, event.id);
      syncFromAnalysis(res.analysis, false);
      if (!res.canceled) setStopping(false);
    } catch (err) {
      setActionError(formatError(err).message);
      setStopping(false);
    }
  };

  const handleDiscard = async (): Promise<void> => {
    setSubmitting(true);
    setActionError('');
    try {
      const res = await discardEventAnalysisDraft(scope, event.id);
      syncFromAnalysis({ draft: res.draft, confirmed: res.confirmed }, true);
      setProcOpen(true);
    } catch (err) {
      setActionError(formatError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  const steps = draft?.steps ?? [];
  const callCount = steps.reduce((n, s) => n + (s.calls?.length ?? 0), 0);
  const elapsedSec = ((draft?.stats.ms ?? 0) / 1000).toFixed(1);
  const settingsFirst = shouldOpenAiSettingsForError(startError?.code ?? draft?.errorCode);
  const canceled = draft?.errorCode === 'ANALYSIS_CANCELED';
  const procTitle = starting || isRunning
    ? '正在分析关联文档与仓库源码…'
    : canceled
      ? (candidates.length > 0 ? `分析已停止 · 保留 ${candidates.length} 处候选` : '分析已停止')
      : draft?.status === 'failed'
        ? '分析未完成'
        : candidates.length > 0
          ? `分析完成 · 找到 ${candidates.length} 处候选`
          : '分析完成 · 未定位到候选位置';

  /** 底栏主操作（S3）：四态，避免"无候选但有已确认位置"时按钮全无 */
  const primaryAction: 'stop' | 'confirm' | 'reanalyze' | 'none' = isRunning
    ? 'stop'
    : committed
      ? 'reanalyze'
      : candidates.length > 0
        ? 'confirm'
        : canWrite
          ? 'reanalyze'
          : 'none';
  const readOnlyTitle = canWrite ? undefined : '只读账号无法发起或确认分析';

  // E-15：贴底才跟随新步骤
  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useEffect(() => {
    if (!stick) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [stick, steps.length]);

  return (
    <div className="gov-ai-embed">
      {startError ? (
        <div className="gov-ai-error">
          <span>{startError.message}</span>
          <div className="gov-ai-error__actions">
            {settingsFirst ? (
              <button type="button" className="gov-btn gov-btn--sm gov-btn--primary" onClick={onOpenSettings}>
                ⚙ 前往 AI 分析设置
              </button>
            ) : null}
            <button
              type="button"
              className="gov-btn gov-btn--ghost gov-btn--sm"
              disabled={starting || !canWrite}
              onClick={() => void triggerStart(false)}
            >
              重试
            </button>
          </div>
        </div>
      ) : null}

      {overwritePrompt ? (
        <div className="gov-ai-error">
          <span>已有一次未处理的分析结果，重新分析会覆盖它（已确认的代码位置不受影响），是否继续？</span>
          <div className="gov-ai-error__actions">
            <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => setOverwritePrompt(false)}>
              取消
            </button>
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--primary"
              disabled={starting || !canWrite}
              onClick={() => {
                setOverwritePrompt(false);
                void triggerStart(true);
              }}
            >
              覆盖并重新分析
            </button>
          </div>
        </div>
      ) : null}

      {draft ? (
        <>
          <button
            type="button"
            className="gov-ai-proc__head"
            aria-expanded={procOpen}
            title={procOpen ? '收起过程' : '展开过程'}
            onClick={() => setProcOpen((v) => !v)}
          >
            <span className="gov-ai-proc__spin" data-done={!isRunning ? '' : undefined} />
            <span className="gov-ai-proc__title">{procTitle}</span>
            <span className="gov-ai-proc__time">
              {isRunning
                ? `已跑 ${steps.length} 步`
                : `${steps.length} 步 · ${callCount} 次调用 · ${elapsedSec}s`}
            </span>
            {!stick && isRunning ? <span className="gov-ai-proc__badge">有新步骤</span> : null}
            <span className="gov-ai-proc__toggle">{procOpen ? '收起' : (committed ? '查看详情' : '查看过程')}</span>
            <span className="gov-ai-proc__chev" aria-hidden="true">▾</span>
          </button>

          {draft.errorMessage ? (
            <p className="gov-ai-proc__degraded">
              {draft.errorCode && draft.errorCode !== 'ANALYSIS_CANCELED' ? `[${draft.errorCode}] ` : ''}
              {draft.errorMessage}
            </p>
          ) : null}

          {procOpen ? (
            <div
              className="gov-ai-embed__scroll"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 8);
              }}
            >
              {steps.length > 0 ? (
                <ol className="gov-ai-proc__steps">
                  {steps.map((step, i) => {
                    const expandable = step.detail !== undefined || Object.keys(step.metrics ?? {}).length > 0;
                    const expanded = openStep === i;
                    return (
                      <li key={`${step.name}-${i}`} className="gov-ai-step is-done">
                        <span className="gov-ai-step__mark">✓</span>
                        <div className="gov-ai-step__body">
                          <button
                            type="button"
                            className="gov-ai-step__head"
                            aria-expanded={expanded}
                            disabled={!expandable}
                            onClick={() => setOpenStep(expanded ? null : i)}
                          >
                            <span className="gov-ai-step__text">
                              <b>{step.title}</b>
                              <span className="gov-ai-step__ms">{formatAnalysisMs(step.ms)}</span>
                            </span>
                            {expandable ? <span className="gov-ai-step__chev" aria-hidden="true">▾</span> : null}
                          </button>

                          {step.calls && step.calls.length > 0 ? (
                            <div className="gov-ai-calls">
                              {step.calls.map((call, ci) => (
                                <div
                                  key={`${step.name}-${call.name}-${ci}`}
                                  className={`ki-chat-tl__node ki-chat-tl__node--${call.kind === 'skill' ? 'skill' : 'tool'}`}
                                >
                                  {call.kind === 'skill' ? (
                                    <span className="ki-chat-tl__skill">{call.name}</span>
                                  ) : (
                                    <>
                                      <span className="ki-chat-tl__act">{call.label}</span>
                                      <span className="ki-chat-tl__tool">{call.name}</span>
                                    </>
                                  )}
                                  <span className="ki-chat-tl__stat">{formatAnalysisMs(call.ms)}</span>
                                  {call.note ? <span className="gov-ai-call__note">{call.note}</span> : null}
                                </div>
                              ))}
                            </div>
                          ) : null}

                          {expandable && expanded ? (
                            <div className="gov-ai-step__detail">
                              <dl>
                                {Object.entries(step.metrics ?? {}).map(([k, v]) => (
                                  <div key={k}>
                                    <dt>{k}</dt>
                                    <dd>{String(v)}</dd>
                                  </div>
                                ))}
                              </dl>
                            </div>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="gov-hint" style={{ padding: '10px 12px' }}>正在读取事件上下文…</p>
              )}
            </div>
          ) : null}
        </>
      ) : null}

      {/* F-15：运行中不渲染候选（Q1：不做阶段性候选） */}
      {!isRunning && candidates.length > 0 ? (
        <div className="gov-cand-list gov-cand-list--embed">
          {candidates.map((c, ci) => {
            const checked = picked.has(c.id);
            const peek = openCands.includes(c.id);
            return (
              <label
                key={c.id}
                className={`gov-cand gov-cand--ai${committed ? ' is-committed' : ''}`}
                style={{ ['--i' as string]: ci }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={!canWrite || committed}
                  onChange={() => toggleCandidate(c.id)}
                />
                <span>
                  {committed ? <span className="gov-cand__done">已确认</span> : null}
                  <span className="gov-cand__name gov-codeloc__path">
                    {c.file}:{c.line}{c.endLine ? `-${c.endLine}` : ''}
                  </span>
                  <span className="gov-cand__why">{c.why}</span>
                  {c.snippet ? (
                    <button
                      type="button"
                      className="gov-cand__peek"
                      onClick={(ev) => {
                        // 按钮在 <label> 内：不拦住会顺带切换勾选（L-04 / F-11）
                        ev.preventDefault();
                        ev.stopPropagation();
                        setOpenCands((prev) => (prev.includes(c.id) ? prev.filter((x) => x !== c.id) : [...prev, c.id]));
                      }}
                    >
                      {peek ? '收起代码' : '查看代码片段'}
                    </button>
                  ) : null}
                  {peek && c.snippet ? <pre className="gov-codeloc__snip">{c.snippet}</pre> : null}
                </span>
                <span className={`gov-cand__score${c.confidence < DEFAULT_ANALYSIS_CHECK_SCORE ? ' gov-cand__score--weak' : ''}`}>
                  {c.confidence.toFixed(2)}
                </span>
              </label>
            );
          })}
        </div>
      ) : null}

      {!isRunning && draft && draft.unconfirmed.length > 0 ? (
        <p className="gov-inline-tip" style={{ padding: '0 12px' }}>
          <b>未确认点：</b>{draft.unconfirmed.join('；')}
        </p>
      ) : null}

      {actionError ? <span className="gov-error">{actionError}</span> : null}

      <div className="gov-ai-embed__foot">
        <span className="gov-ai-embed__stat">
          {isRunning
            ? '只读分析 · 可随时停止（已完成的步骤会保留）'
            : draft
              ? `${draft.stats.turns} 轮工具调用 · 读取 ${draft.stats.filesRead} 个文件${confirmed.length ? ` · 已确认 ${confirmed.length} 处` : ''}`
              : '尚未开始'}
        </span>
        <span style={{ flex: 1 }} />
        {primaryAction === 'stop' ? (
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--danger-ghost"
            disabled={stopping || !canWrite}
            title={readOnlyTitle}
            onClick={() => void handleStop()}
          >
            {stopping ? '停止中…' : '停止'}
          </button>
        ) : null}
        {primaryAction === 'confirm' ? (
          <>
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--danger-ghost"
              disabled={submitting || !canWrite}
              title={readOnlyTitle}
              onClick={() => void handleDiscard()}
            >
              丢弃草稿
            </button>
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--primary"
              disabled={submitting || pickedIds.length === 0 || !canWrite}
              title={readOnlyTitle}
              onClick={() => void handleConfirm()}
            >
              {submitting ? '写入中…' : '确认分析结果'}
            </button>
          </>
        ) : null}
        {primaryAction === 'reanalyze' ? (
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={starting || !canWrite}
            title={readOnlyTitle ?? '重新分析会覆盖未处理的草稿（已确认位置不受影响）'}
            onClick={() => void triggerStart(false)}
          >
            重新分析
          </button>
        ) : null}
      </div>
    </div>
  );
}
