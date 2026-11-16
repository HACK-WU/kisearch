/**
 * AiAnalyzeModal.tsx —— 事件「AI 分析」过程与代码位置确认弹窗（REQ-20261113-003 · S-05）
 *
 * 复用 `FindRefModal` / `AiProcessPanel` 视觉语言（`.gov-ai-proc*` + `.ki-chat-tl__node*`），
 * 支持：
 *   · 异步触发 `POST /analyze` + `1500ms` 轮询 `GET /analysis`；
 *   · `[后台继续]` 关窗不中断后端分析；
 *   · 真实工具调用胶囊（`fs_*` / `ki_*` / `use_skill`，绝不伪造不存在的 skill）；
 *   · 复选框勾选确认写入 `confirmed`（带 `expectedRunId`）、丢弃草稿、覆盖重跑；
 *   · 前置配置错误（未配目标目录/工具全关/隐私未确认）直接高亮前往 `/ai-settings?cap=analysis`。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
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

export interface AiAnalyzeModalProps {
  scope: string;
  event: EventView;
  analysis: EventAnalysis | null;
  canWrite: boolean;
  onClose: () => void;
  onUpdated: (next: EventAnalysis) => void;
  onOpenSettings: () => void;
}

export function AiAnalyzeModal(args: AiAnalyzeModalProps): JSX.Element {
  const [draft, setDraft] = useState<AnalysisDraft | null>(args.analysis?.draft ?? null);
  const [confirmed, setConfirmed] = useState(args.analysis?.confirmed ?? []);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<{ code?: string; message: string } | null>(null);
  const [actionError, setActionError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  /** 已点「停止」、等后台落终态（期间禁用按钮，避免连点） */
  const [stopping, setStopping] = useState(false);
  const [procOpen, setProcOpen] = useState(true);
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(
    (args.analysis?.draft?.candidates ?? [])
      .filter((c) => shouldDefaultCheckCandidate(c.confidence))
      .map((c) => c.id),
  ));

  const syncFromAnalysis = useCallback((next: EventAnalysis, resetPicked: boolean) => {
    setDraft(next.draft);
    setConfirmed(next.confirmed);
    args.onUpdated(next);
    if (resetPicked && next.draft) {
      setPicked(new Set(
        next.draft.candidates.filter((c) => shouldDefaultCheckCandidate(c.confidence)).map((c) => c.id),
      ));
    }
  }, [args]);

  const triggerStart = useCallback(async (forceOverwrite = false): Promise<void> => {
    if (!args.canWrite) return;
    setStarting(true);
    setStartError(null);
    setActionError('');
    setProcOpen(true);
    try {
      const res = await startEventAnalysis(args.scope, args.event.id, { forceOverwrite });
      syncFromAnalysis(res.analysis, true);
    } catch (err) {
      setStartError(formatError(err));
    } finally {
      setStarting(false);
    }
  }, [args.scope, args.event.id, args.canWrite, syncFromAnalysis]);

  // 首次打开：若无任何草稿，自动启动一次分析；若已有 running/ready/partial/failed，则先展示现状
  useEffect(() => {
    if (!args.analysis?.draft && args.canWrite) {
      void triggerStart(false);
    }
    // 仅挂载时自动触发一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // running 态轮询（1500ms）
  const isRunning = draft?.status === 'running';
  useEffect(() => {
    if (!isRunning) return;
    let alive = true;
    const poll = async (): Promise<void> => {
      try {
        const res = await getEventAnalysis(args.scope, args.event.id);
        if (!alive) return;
        const finishedNow = res.draft && res.draft.status !== 'running';
        syncFromAnalysis({ draft: res.draft, confirmed: res.confirmed }, Boolean(finishedNow));
        if (finishedNow) setProcOpen(false);
      } catch {
        // 单次轮询失败不中断，下一轮继续
      }
    };
    const timer = window.setInterval(() => { void poll(); }, 1500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [isRunning, args.scope, args.event.id, syncFromAnalysis]);

  /*
   * 终态到达后必须复位 stopping：停止按钮只在 running 期间渲染，撤销后 state 仍留着 true，
   * 下次「重新分析」再进 running 时它会是「停止中…」且被 disabled —— 用户再也停不了。
   */
  useEffect(() => {
    if (!isRunning) setStopping(false);
  }, [isRunning]);

  const candidates = useMemo(() => draft?.candidates ?? [], [draft]);
  const pickedIds = useMemo(
    () => candidates.filter((c) => picked.has(c.id)).map((c) => c.id),
    [candidates, picked],
  );

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
      const res = await confirmEventAnalysis(args.scope, args.event.id, {
        candidateIds: pickedIds,
        expectedRunId: draft.runId,
        discardDraft: true,
      });
      syncFromAnalysis({ draft: res.draft, confirmed: res.confirmed }, true);
      args.onClose();
    } catch (err) {
      setActionError(formatError(err).message);
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * 停止分析：后端置 abort 标记，**终态由后台任务落盘**（可能还有 1~2s 延迟），
   * 所以这里只把按钮切成「停止中…」，由既有的 running 轮询接管后续状态。
   */
  const handleStop = async (): Promise<void> => {
    setStopping(true);
    setActionError('');
    try {
      const res = await cancelEventAnalysis(args.scope, args.event.id);
      syncFromAnalysis(res.analysis, false);
      // 后台此刻已经收尾（canceled:false）或刚好处在收尾窗口：按钮必须能复原，
      // 否则会永久停在「停止中…」直到僵尸恢复把状态改掉。
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
      const res = await discardEventAnalysisDraft(args.scope, args.event.id);
      syncFromAnalysis({ draft: res.draft, confirmed: res.confirmed }, true);
      args.onClose();
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

  /*
   * 判据用 `errorCode` 而不是 `status`：主动停止**有候选**时状态落的是 `partial`
   * （草稿仍可确认），只判 status 会把它显示成「分析完成 · 找到 N 处候选」—— 而那批
   * 候选是半截的，说"完成"会误导用户。
   */
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

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal gov-modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>AI 分析 · 仓库源码定位</div>
          <div className="gov-hint">
            事件「#{args.event.shortId} {args.event.title}」
            {draft?.targetDir ? ` · 目标目录：${draft.targetDir}` : ''}
            {draft?.commit ? ` (${draft.commit})` : ''}
          </div>
        </div>

        <div className="gov-modal__body">
          {startError ? (
            <div className="gov-ai-error">
              <span>{startError.message}</span>
              <div className="gov-ai-error__actions">
                {settingsFirst ? (
                  <button type="button" className="gov-btn gov-btn--sm gov-btn--primary" onClick={args.onOpenSettings}>
                    ⚙ 前往 AI 分析设置
                  </button>
                ) : null}
                <button
                  type="button"
                  className="gov-btn gov-btn--ghost gov-btn--sm"
                  disabled={starting || !args.canWrite}
                  onClick={() => void triggerStart(Boolean(draft))}
                >
                  重试
                </button>
              </div>
            </div>
          ) : null}

          {draft ? (
            <div className="gov-ai-proc">
              <button
                type="button"
                className="gov-ai-proc__head"
                aria-expanded={procOpen}
                onClick={() => setProcOpen((v) => !v)}
              >
                <span className="gov-ai-proc__spin" data-done={!isRunning ? '' : undefined} />
                <span className="gov-ai-proc__title">{procTitle}</span>
                <span className="gov-ai-proc__time">
                  {steps.length} 步 · {callCount} 次调用 · {elapsedSec}s
                  {draft.stats.tokens > 0 ? ` · ${draft.stats.tokens} tok` : ''}
                </span>
                <span className="gov-ai-proc__chev" aria-hidden="true">▾</span>
              </button>

              {draft.errorMessage ? (
                <p className="gov-ai-proc__degraded">
                  {/* 主动停止不是错误：不挂 `[ANALYSIS_*]` 前缀，免得用户以为出错了不敢确认候选 */}
                  {draft.errorCode && draft.errorCode !== 'ANALYSIS_CANCELED' ? `[${draft.errorCode}] ` : ''}
                  {draft.errorMessage}
                </p>
              ) : null}

              {procOpen && steps.length > 0 ? (
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
              ) : null}
            </div>
          ) : null}

          {!isRunning && candidates.length > 0 ? (
            <div className="gov-cand-list">
              {candidates.map((c) => {
                const checked = picked.has(c.id);
                return (
                  <label key={c.id} className="gov-cand gov-cand--ai">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!args.canWrite}
                      onChange={() => toggleCandidate(c.id)}
                    />
                    <span>
                      <span className="gov-cand__name gov-codeloc__path">
                        {c.file}:{c.line}{c.endLine ? `-${c.endLine}` : ''}
                      </span>
                      <span className="gov-cand__why">{c.why}</span>
                      {c.snippet ? <pre className="gov-codeloc__snip">{c.snippet}</pre> : null}
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
            <div className="gov-rowbox gov-codeloc__unconfirmed">
              <span className="gov-hint">
                <b>未确认点：</b>
                {draft.unconfirmed.join('；')}
              </span>
            </div>
          ) : null}

          {draft && !isRunning ? (
            <p className="gov-hint">
              本次只读 · {draft.stats.turns} 轮工具调用 · 读取 {draft.stats.filesRead} 个文件
              {confirmed.length > 0 ? ` · 当前事件已确认 ${confirmed.length} 处代码位置` : ''}
            </p>
          ) : null}

          {isRunning ? (
            <p className="gov-hint">
              分析正在后台执行（最长 90s）：点「停止」可立即中止（已完成的步骤与候选会保留）；
              也可以点「后台继续」关闭弹窗先处理其他事务，结果会保留在事件详情页。
            </p>
          ) : null}

          {actionError ? <span className="gov-error">{actionError}</span> : null}
        </div>

        <div className="gov-modal__foot">
          <button type="button" className="gov-btn gov-btn--sm gov-btn--ghost" onClick={args.onOpenSettings}>
            ⚙ AI 分析设置
          </button>
          <span style={{ flex: 1 }} />
          {draft && !isRunning ? (
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--ghost"
              disabled={starting || submitting || !args.canWrite}
              onClick={() => void triggerStart(true)}
            >
              重新分析
            </button>
          ) : null}
          {draft && !isRunning ? (
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--danger-ghost"
              disabled={submitting || !args.canWrite}
              onClick={() => void handleDiscard()}
            >
              丢弃草稿
            </button>
          ) : null}
          {isRunning ? (
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--danger-ghost"
              disabled={stopping || !args.canWrite}
              onClick={() => void handleStop()}
            >
              {stopping ? '停止中…' : '停止'}
            </button>
          ) : null}
          {isRunning ? (
            <button type="button" className="gov-btn gov-btn--sm gov-btn--primary" onClick={args.onClose}>
              后台继续
            </button>
          ) : (
            <button type="button" className="gov-btn gov-btn--sm" onClick={args.onClose}>
              关闭
            </button>
          )}
          {!isRunning && candidates.length > 0 ? (
            <button
              type="button"
              className="gov-btn gov-btn--sm gov-btn--primary"
              disabled={submitting || pickedIds.length === 0 || !args.canWrite}
              onClick={() => void handleConfirm()}
            >
              {submitting ? '写入中…' : pickedIds.length === 0 ? '未选择' : `确认加入 ${pickedIds.length} 处`}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
