/**
 * FindRefPanel.tsx —— 参考文档「AI 查找」卡内嵌面板（2026-11-17 改版 · 批 3）
 *
 * 由 `FindRefModal`（289 行遮罩弹窗）改造，产品语义不变：
 * **推荐 + 确认**，不是搜索框；不点就不加（R28/R29）。
 *
 * 与弹窗的差异：
 *   · 去掉遮罩与 `.gov-modal*` 外壳，改为 `.gov-ai-embed--auto`：过程区**只封 160px 上限**、
 *     内容少时按自然高度（I-16），不留空框；
 *   · 由父级条件渲染 + `open` 受控（卡头「AI 查找」开关），无 `onClose` 语义；
 *   · 底栏左侧补一句"只写引用记录"的说明（I-20），右侧 [取消] + [加入所选 N 篇]。
 *
 * 保留的三条契约：
 *   · 默认只勾 `score ≥ 0.6`；deep 通道按模型顺序**全勾**（score 可能全为 0）；
 *   · 0 候选按后端 `reason` 走 `emptyReasonText` 四句不同文案，并给「改用手动添加」退路；
 *   · 加入带 `addedBy:'ai'` + `score`，跨库候选必须带 `sourceScope`。
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

const DEFAULT_CHECK_SCORE = 0.6;

const VIS_TEXT: Record<Visibility, string> = {
  full: '语义+全文',
  'fts-only': '仅全文',
  hidden: '不可检索',
};

const VIS_CLASS: Record<Visibility, string> = { full: 'full', 'fts-only': 'fts', hidden: 'hidden' };

export interface FindRefPanelProps {
  scope: string;
  eventId: string;
  canWrite: boolean;
  context: AiProcessContext;
  /** 面板显隐（受控）：false 时不请求也不渲染 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 加入成功：父级做局部刷新，**不整页重载** */
  onAdded: (added: number, skipped: number) => void;
  /** 失败 / 0 候选时的退路：收起面板并打开「＋ 添加」 */
  onSwitchToManual: () => void;
  /** 就近入口，跳 AI 设置「查找」分组（该分组当前无生效点，本面板是确定性检索） */
  onOpenSettings?: () => void;
  /** 状态回抛：供卡头 chip 显示「检索中 ◐ / N 篇候选」（I-15） */
  onStatus?: (info: { state: 'loading' | 'done' | 'error'; count: number }) => void;
}

/** 勾选键 = 源库 + group + name（跨库同名文档不能共用勾选态） */
const keyOf = (c: { scope?: string; group: string; name: string }): string =>
  `${c.scope ?? ''}\u0000${c.group}\u0000${c.name}`;

function defaultPicked(cands: RefCandidate[]): Set<string> {
  const allDeep = cands.length > 0 && cands.every((c) => c.origin === 'deep');
  if (allDeep) return new Set(cands.map(keyOf));
  return new Set(cands.filter((c) => c.score >= DEFAULT_CHECK_SCORE).map(keyOf));
}

function errorText(err: unknown): string {
  const code = err instanceof GovernanceApiError && err.code ? `[${err.code}] ` : '';
  return `${code}${(err as Error).message}`;
}

export function FindRefPanel(args: FindRefPanelProps): JSX.Element | null {
  const { scope, eventId, canWrite, context, open, onOpenChange } = args;
  const [state, setState] = useState<'loading' | 'done' | 'error'>('loading');
  const [result, setResult] = useState<RefSearchResult | null>(null);
  const [error, setError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [mode, setMode] = useState<'fast' | 'deep'>('fast');
  const [stopped, setStopped] = useState(false);
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
      // 深度通道三段耗时：排队上限 20s + 执行硬超时 60s + 余量 → 客户端 95s
      const r = await findRefCandidates(scope, eventId, {
        mode,
        signal: ctrl.signal,
        timeoutMs: mode === 'deep' ? 95_000 : 15_000,
      });
      if (ctrl.signal.aborted) return;
      setResult(r);
      setPicked(defaultPicked(r.candidates));
      setState('done');
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setError(errorText(err));
      setState('error');
    }
  }, [scope, eventId, mode]);

  useEffect(() => {
    if (!open) return () => { ctrlRef.current?.abort(); };
    void run();
    return () => { ctrlRef.current?.abort(); };
  }, [open, run]);

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
  useEffect(() => {
    args.onStatus?.({ state, count: candidates.length });
  }, [state, candidates.length]);
  const multiScope = (result?.targets?.length ?? 1) > 1;
  const pickedDocs = candidates.filter((c) => picked.has(keyOf(c)));
  const isDeepResult = candidates.length > 0 && candidates.every((c) => c.origin === 'deep');

  const submit = async (): Promise<void> => {
    if (pickedDocs.length === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const r = await addRefs(
        scope,
        eventId,
        pickedDocs.map((c) => ({
          ...(c.scope && c.scope !== scope ? { sourceScope: c.scope } : {}),
          group: c.group,
          name: c.name,
          score: c.score,
        })),
        'ai',
      );
      args.onAdded(r.added, r.skipped.length);
      onOpenChange(false);
    } catch (err) {
      setSubmitError(errorText(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (!open) return null;

  const primaryLabel = state === 'loading'
    ? '检索中…'
    : state === 'error'
      ? '不可用'
      : pickedDocs.length === 0
        ? '未选择'
        : `加入所选 ${pickedDocs.length} 篇`;
  const primaryDisabled = state !== 'done' || pickedDocs.length === 0 || submitting || !canWrite;

  return (
    <div className="gov-ai-embed gov-ai-embed--auto">
      <div className="gov-ai-embed__bar">
        <button
          type="button"
          className={`gov-seg__btn${mode === 'fast' ? ' is-on' : ''}`}
          aria-pressed={mode === 'fast'}
          onClick={() => setMode('fast')}
        >
          快速查找
        </button>
        <button
          type="button"
          className={`gov-seg__btn${mode === 'deep' ? ' is-on' : ''}`}
          aria-pressed={mode === 'deep'}
          onClick={() => setMode('deep')}
        >
          深度查找（AI）
        </button>
        <span className="gov-hint gov-ai-embed__barhint">
          {mode === 'deep'
            ? '深度查找会让模型多轮检索与读正文，耗时更长、消耗 AI 配额；随时可停。'
            : '确定性检索：同一事件总能得到同一批候选，可复现。'}
        </span>
      </div>

      {state === 'loading' && mode === 'deep' ? (
        <div className="gov-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px' }}>
          <span>正在深度查找（模型多轮检索，最长约 1 分半；同一事件会排队）…</span>
          <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={stop}>
            停止
          </button>
        </div>
      ) : null}

      {stopped ? (
        <p className="gov-hint" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px' }}>
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
          {...(result?.unconfirmed ? { unconfirmed: result.unconfirmed } : {})}
          context={context}
        />
      )}

      {state === 'done' && candidates.length > 0 ? (
        <>
          <div className="gov-cand-list">
            {candidates.map((c) => {
              const key = keyOf(c);
              const checked = picked.has(key);
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
          <p className="gov-hint" style={{ padding: '0 12px' }}>
            {isDeepResult
              ? '深度查找已按模型给出的顺序列出，默认全部勾选；分数是它在该库内最后一次检索的命中分，0 不代表无关。'
              : '默认只勾选高相关项；分数是本批次内的相对分位（最高 1.00、最低 0.00），不是绝对相似度。'}
          </p>
        </>
      ) : null}

      {/* 「已停止」不是「没有命中」：停止后不要弹四态空文案，只留上面的「重新查找」 */}
      {state === 'done' && candidates.length === 0 && !stopped ? (
        <p className="gov-hint" style={{ padding: '6px 12px' }}>
          {emptyReasonText(result?.reason, context)}
          {' '}
          <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={args.onSwitchToManual}>
            改用手动添加
          </button>
        </p>
      ) : null}

      {submitError ? <span className="gov-error">{submitError}</span> : null}
      {state === 'done' && !canWrite ? (
        <span className="gov-hint" style={{ padding: '0 12px' }}>当前账号为只读，只能查看候选，加入需要写权限。</span>
      ) : null}

      <div className="gov-ai-embed__foot">
        <span className="gov-ai-embed__stat">加入后只写引用记录，不改这些文档的分类与可见性</span>
        <span style={{ flex: 1 }} />
        {args.onOpenSettings ? (
          <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={args.onOpenSettings}>
            ⚙ 提示词设置
          </button>
        ) : null}
        <button type="button" className="gov-btn gov-btn--sm" onClick={() => onOpenChange(false)}>
          取消
        </button>
        <button
          type="button"
          className="gov-btn gov-btn--sm gov-btn--primary"
          disabled={primaryDisabled}
          title={!canWrite ? '需要写权限' : undefined}
          onClick={() => void submit()}
        >
          {submitting ? '加入中…' : primaryLabel}
        </button>
      </div>
    </div>
  );
}
