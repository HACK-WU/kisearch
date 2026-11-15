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

import { useCallback, useEffect, useMemo, useState } from 'react';
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
}

const keyOf = (c: { group: string; name: string }): string => `${c.group}\u0000${c.name}`;

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

  const run = useCallback(async (): Promise<void> => {
    setState('loading');
    setError('');
    setSubmitError('');
    try {
      const r = await findRefCandidates(args.scope, args.eventId);
      setResult(r);
      setPicked(new Set(r.candidates.filter((c) => c.score >= DEFAULT_CHECK_SCORE).map(keyOf)));
      setState('done');
    } catch (err) {
      setError(errorText(err));
      setState('error');
    }
  }, [args.scope, args.eventId]);

  useEffect(() => {
    void run();
  }, [run]);

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
  const pickedDocs = candidates.filter((c) => picked.has(keyOf(c)));

  const submit = async (): Promise<void> => {
    if (pickedDocs.length === 0) return;
    setSubmitting(true);
    setSubmitError('');
    try {
      const r = await addRefs(
        args.scope,
        args.eventId,
        pickedDocs.map((c) => ({ group: c.group, name: c.name, score: c.score })),
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
        </div>

        <div className="gov-modal__body">
          {state === 'error' ? (
            <div className="gov-ai-error">
              <span>{error}</span>
              <div className="gov-ai-error__actions">
                <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={() => void run()}>
                  重试
                </button>
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
              context={args.context}
            />
          )}

          {state === 'done' && candidates.length > 0 ? (
            <>
              <div className="gov-cand-list">
                {candidates.map((c) => {
                  const key = keyOf(c);
                  const checked = picked.has(key);
                  return (
                    <label key={key} className="gov-cand gov-cand--ai">
                      <input type="checkbox" checked={checked} onChange={() => toggle(c)} />
                      <span>
                        <span className="gov-cand__name">{c.name}</span>
                        <span className="gov-cand__meta">
                          {c.group}
                          {' · '}
                          <span className={`gov-vis gov-vis--${VIS_CLASS[c.visibility]}`}>
                            <span className="gov-vis__dot" />
                            {VIS_TEXT[c.visibility]}
                          </span>
                          {c.chunkHits > 1 ? ` · ${c.chunkHits} 处命中` : ''}
                          {candidates.length === 1 ? ' · 唯一命中' : ''}
                        </span>
                        <p className="gov-cand__why">{c.why}</p>
                      </span>
                      <span className={`gov-cand__score${c.weak ? ' gov-cand__score--weak' : ''}`}>
                        {c.score.toFixed(2)}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="gov-hint">
                默认只勾选高相关项。加入后只建立<b>引用</b> —— 不会修改这些文档的分类、可见性，也不会删它们。
                <br />
                分数是<b>本批次内的相对分位</b>（最高恒为 1.00、最低恒为 0.00），不是绝对相似度；
                只有条数太少时分数会显得极端，判断仍以「为什么相关」为准。
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
