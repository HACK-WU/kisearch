/**
 * FindRefModal.tsx —— 参考文档「AI 查找」弹窗（REQ-20261113-004 · S-07 §10）
 *
 * 产品语义：不是搜索框，是**推荐 + 确认**。系统以事件为种子去库里找"还该被引用的文档"，
 * 人只做一次勾选确认 —— 所以这里没有输入框，也**不会**点一下就自动加入（R28/R29）。
 *
 * 三条契约：
 *   · 默认只勾 `score ≥ 0.6`，低分（weak）照常展示、可勾 —— 阈值只决定"默认勾不勾"；
 *   · 0 候选按后端 `reason` 写四句不同文案（`empty-scope` 要提示换 scope）；
 *   · 加入时带 `addedBy:'ai'` + `score`，只写引用记录，不碰被引文档（A13）。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  addRefs,
  findRefCandidates,
  GovernanceApiError,
  type RefCandidate,
  type RefSearchResult,
  type Visibility,
} from '@/api/governanceApi';
import { AiProcessPanel, emptyReasonText, type AiProcessContext } from './AiProcessPanel';

/** 默认勾选阈值：**批次内相对分位**，不是绝对相似度（后端同值 0.6） */
const DEFAULT_CHECK_SCORE = 0.6;

const VIS_TEXT: Record<Visibility, string> = {
  full: '语义+全文',
  'fts-only': '仅全文',
  hidden: '不可检索',
};

const VIS_CLASS: Record<Visibility, string> = { full: 'full', 'fts-only': 'fts', hidden: 'hidden' };

export interface FindRefModalProps {
  scope: string;
  eventId: string;
  /** 只读账号：可以查可以看，但「加入」禁用（后端仍 403 兜底） */
  canWrite: boolean;
  context: AiProcessContext;
  onClose: () => void;
  /** 加入成功：父级做局部刷新，**不整页重载** */
  onAdded: (added: number, skipped: number) => void;
  /** 失败时的一键退路：关掉本弹窗、打开「＋ 添加」 */
  onSwitchToManual: () => void;
  /**
   * 就近入口（2026-11-15）：跳到 AI 设置的「查找」分组。
   * 该分组当前**无生效点**（本弹窗是确定性检索、不调 LLM），入口只为"提前设计"提供落点。
   */
  onOpenSettings?: () => void;
}

/**
 * 勾选态的键 = **源库 + group + name**。
 * 不带库会让「A 库和 B 库的同名文档」共用同一个勾选态：勾一篇等于勾两篇。
 */
const keyOf = (c: { scope?: string; group: string; name: string }): string =>
  `${c.scope ?? ''}\u0000${c.group}\u0000${c.name}`;

/**
 * 默认勾选策略按通道区分（S-04 §3.4）：
 *   · `fast`：沿用 `score >= 0.6`（分数是检索真实产出，可直接当相关度）；
 *   · `deep`：模型已筛过一轮，**按输出顺序全勾** —— deep 的 score 可能全是 0（模型没走检索），
 *     按分数会把它们全变成"不勾"，用户得逐条手动勾。
 */
function defaultPicked(cands: RefCandidate[]): Set<string> {
  const allDeep = cands.length > 0 && cands.every((c) => c.origin === 'deep');
  if (allDeep) return new Set(cands.map(keyOf));
  return new Set(cands.filter((c) => c.score >= DEFAULT_CHECK_SCORE).map(keyOf));
}

function errorText(err: unknown): string {
  const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
  return `${code}${(err as Error).message}`;
}

export function FindRefModal(args: FindRefModalProps): JSX.Element {
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');
  const [result, setResult] = useState<RefSearchResult | null>(null);
  const [error, setError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  /** 查找通道：默认快速（深度要调模型，成本可见才选，见 requirement §8 P2） */
  const [mode, setMode] = useState<'fast' | 'deep'>('fast');
  /** 用户点了「停止」：与出错区分开，别报成失败 */
  const [stopped, setStopped] = useState(false);

  /** 当前在途请求：切模式 / 重试 / 关弹窗都要能中断（深度通道可能等 45s） */
  const ctrlRef = useRef<AbortController | null>(null);

  const run = useCallback(async (): Promise<void> => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState('loading');
    setError('');
    setSubmitError('');
    setStopped(false);
    try {
      /*
       * 深度通道的三段耗时相加：排队上限 20s + 执行硬超时 60s + 余量。
       * 客户端超时必须比后端更宽，否则后端还没放弃、前端先报"请求超时"（旧值 75s 不够排队）。
       */
      const r = await findRefCandidates(args.scope, args.eventId, {
        mode,
        signal: ctrl.signal,
        timeoutMs: mode === 'deep' ? 95_000 : 15_000,
      });
      if (ctrl.signal.aborted) return;
      setResult(r);
      setPicked(defaultPicked(r.candidates));
      setState('done');
    } catch (err) {
      // 主动取消（关弹窗 / 点停止 / 切模式）静默；超时与真失败才提示
      if (ctrl.signal.aborted) return;
      setError(errorText(err));
      setState('error');
    }
  }, [args.scope, args.eventId, mode]);

  useEffect(() => {
    void run();
    return () => { ctrlRef.current?.abort(); };
  }, [run]);

  /** 停止：中止在途请求并把界面切回可重试状态（不落成"失败"，停止不是错误） */
  const stop = (): void => {
    ctrlRef.current?.abort();
    setResult(null);
    setPicked(new Set());
    setStopped(true);
    setState('done');
  };

  const toggle = (c: RefCandidate): void => {
    const key = keyOf(c);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const candidates = useMemo(() => result?.candidates ?? [], [result]);
  /** 多库时才显示库名与库内排名：单库查找是绝大多数场景，常驻库名等于噪声 */
  const multiScope = (result?.targets?.length ?? 1) > 1;
  const pickedDocs = candidates.filter((c) => picked.has(keyOf(c)));
  /** 整批都来自深度通道（混批只可能是快速通道的补位，按快速口径解释更稳） */
  const isDeepResult = candidates.length > 0 && candidates.every((c) => c.origin === 'deep');

  const submit = async (): Promise<void> => {
    if (pickedDocs.length === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const r = await addRefs(
        args.scope,
        args.eventId,
        // 跨库候选必须带 sourceScope，否则后端会按事件库去查/写（写错库或报不存在）
        pickedDocs.map((c) => ({
          ...(c.scope && c.scope !== args.scope ? { sourceScope: c.scope } : {}),
          group: c.group,
          name: c.name,
          score: c.score,
        })),
        'ai',
      );
      args.onAdded(r.added, r.skipped.length);
      args.onClose();
    } catch (err) {
      setSubmitError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  const primaryLabel = state === 'loading'
    ? '检索中…'
    : state === 'error'
      ? '不可用'
      : pickedDocs.length === 0
        ? '未选择'
        : `加入所选 ${pickedDocs.length} 篇`;

  const primaryDisabled = state !== 'done' || pickedDocs.length === 0 || submitting || !args.canWrite;

  return (
    <div className="gov-modal-mask" onClick={args.onClose}>
      <div className="gov-modal" onClick={(e) => e.stopPropagation()}>
        <div className="gov-modal__head gov-modal__head--stack">
          <div>AI 查找相关文档</div>
          <div className="gov-hint">
            基于事件标题与 {args.context.assocCount} 篇关联文档检索知识库
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className={`gov-btn gov-btn--sm ${mode === 'fast' ? 'gov-btn--primary' : 'gov-btn--ghost'}`}
              aria-pressed={mode === 'fast'}
              onClick={() => setMode('fast')}
            >
              快速查找
            </button>
            <button
              type="button"
              className={`gov-btn gov-btn--sm ${mode === 'deep' ? 'gov-btn--primary' : 'gov-btn--ghost'}`}
              aria-pressed={mode === 'deep'}
              onClick={() => setMode('deep')}
            >
              深度查找（AI）
            </button>
          </div>
          <div className="gov-hint">
            {mode === 'deep'
              ? '深度查找会让模型多轮检索与读正文，耗时更长、消耗 AI 配额；随时可停。'
              : '确定性检索：同一事件总能得到同一批候选，可复现。'}
          </div>
        </div>

        <div className="gov-modal__body">
          {state === 'loading' && mode === 'deep' ? (
            <div className="gov-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>正在深度查找（模型多轮检索，最长约 1 分半；同一事件会排队）…</span>
              <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={stop}>
                停止
              </button>
            </div>
          ) : null}
          {stopped ? (
            <p className="gov-hint" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>已停止本次查找。</span>
              <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => void run()}>
                重新查找
              </button>
            </p>
          ) : null}
          {state === 'error' ? (
            <div className="gov-ai-error">
              <span>{error}</span>
              <div className="gov-ai-error__actions">
                <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => void run()}>
                  重试
                </button>
                {/* 深度失败多半是模型 / 工具链问题：给一条不依赖模型的退路，而不是只让用户"再试一次" */}
                {mode === 'deep' ? (
                  <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => setMode('fast')}>
                    改用快速查找
                  </button>
                ) : null}
                <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={args.onSwitchToManual}>
                  改用手动添加
                </button>
              </div>
            </div>
          ) : (
            <AiProcessPanel
              state={state}
              steps={result?.steps ?? []}
              durationMs={result?.durationMs ?? 0}
              candidateCount={candidates.length}
              {...(result?.reason ? { reason: result.reason } : {})}
              {...(result?.mode ? { mode: result.mode } : {})}
              {...(result?.degradedReason ? { degradedReason: result.degradedReason } : {})}
              {...(result?.skippedTargets ? { skippedTargets: result.skippedTargets } : {})}
              {...(result?.targetErrors ? { targetErrors: result.targetErrors } : {})}
              {...(result?.partial ? { partial: result.partial } : {})}
              {...(result?.unconfirmedCount !== undefined ? { unconfirmedCount: result.unconfirmedCount } : {})}
              {...(result?.parsed !== undefined ? { parsed: result.parsed } : {})}
              context={args.context}
            />
          )}

          {state === 'done' && candidates.length > 0 ? (
            <>
              <div className="gov-cand-list">
                {candidates.map((c) => {
                  const key = keyOf(c);
                  const checked = picked.has(key);
                  /** 已被**收口事件**锁在不可检索阶段：加了也永远读不到，直接禁勾（后端仍 409 兜底） */
                  const locked = c.visibility === 'hidden' && c.visibilityReason?.kind === 'event-closed';
                  return (
                    <label key={key} className="gov-cand gov-cand--ai">
                      <input type="checkbox" checked={checked} disabled={locked} onChange={() => toggle(c)} />
                      <span>
                        <span className="gov-cand__name">{c.name}</span>
                        <span className="gov-cand__meta">
                          {multiScope ? `${c.scope} · ` : ''}
                          {c.group}
                          {' · '}
                          <span className={`gov-vis gov-vis--${VIS_CLASS[c.visibility]}`}>
                            <span className="gov-vis__dot" />
                            {VIS_TEXT[c.visibility]}
                          </span>
                          {c.chunkHits > 1 ? ` · ${c.chunkHits} 处命中` : ''}
                          {multiScope && c.rankInScope !== undefined ? ` · 库内 #${c.rankInScope}` : ''}
                          {candidates.length === 1 ? ' · 唯一命中' : ''}
                        </span>
                        <p className="gov-cand__why">{c.why}</p>
                        {locked ? (
                          <p className="gov-cand__why">
                            被已收口事件{c.visibilityReason ? ` #${c.visibilityReason.shortId}` : ''}锁定，加入后 AI 也读不到
                          </p>
                        ) : null}
                        {!locked && c.visibilityReason ? (
                          <p className="gov-cand__why">
                            当前不可检索（事件 #{c.visibilityReason.shortId} 进行中），该事件流转到可检索阶段后即可用
                          </p>
                        ) : null}
                      </span>
                      <span className={`gov-cand__score${c.weak ? ' gov-cand__score--weak' : ''}`}>
                        {c.score.toFixed(2)}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="gov-hint">
                {isDeepResult
                  ? '深度查找已按模型给出的顺序列出，默认全部勾选；分数是它在该库内最后一次检索的命中分，'
                    + '0 不代表无关（模型可能没走检索而直接按清单判断），跨库不可比。'
                  : '默认只勾选高相关项。'}
                <br />
                加入后只建立<b>引用</b> —— 不会修改这些文档的分类、可见性，也不会删它们。
                {isDeepResult ? null : ' 分数是本批次内的相对分位（最高恒为 1.00、最低恒为 0.00），不是绝对相似度；判断仍以「为什么相关」为准。'}
              </p>
            </>
          ) : null}

          {state === 'done' && candidates.length === 0 ? (
            <p className="gov-hint">{emptyReasonText(result?.reason, args.context)}</p>
          ) : null}

          {submitError ? <span className="gov-error">{submitError}</span> : null}
          {state === 'done' && !args.canWrite ? (
            <span className="gov-hint">当前账号为只读，只能查看候选，加入需要写权限。</span>
          ) : null}
        </div>

        <div className="gov-modal__foot">
          {args.onOpenSettings ? (
            <button type="button" className="gov-btn gov-btn--ghost" onClick={args.onOpenSettings}>
              ⚙ 提示词设置
            </button>
          ) : null}
          <button type="button" className="gov-btn gov-btn--ghost" onClick={args.onClose}>
            取消
          </button>
          <button
            type="button"
            className="gov-btn gov-btn--primary"
            disabled={primaryDisabled}
            title={!args.canWrite ? '需要写权限' : undefined}
            onClick={() => void submit()}
          >
            {submitting ? '加入中…' : primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
