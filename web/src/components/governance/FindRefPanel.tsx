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
  findRefCandidatesStream,
  saveFindSummary,
  type RefSearchCall,
  type RefSearchStepEvent,
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
  /**
   * 加入成功后回调。
   *
   * `summary` 一并带出（2026-11-19）：模型写的整体结论原本只活在面板内部，
   * 面板一关（`onOpenChange(false)` 卸载）就丢了 —— 用户看到的是"确认后总结消失"。
   * 交给父级保存，才能在收起态继续展示。
   */
  onAdded: (added: number, skipped: number, summary?: string, uncertainties?: string[]) => void;
  /**
   * 查找出结果时回调（**不论有没有候选**，2026-11-19）。
   *
   * 0 候选时用户点不了「加入」，若只在 `onAdded` 里保存，总结就永远落不了盘 ——
   * 而这正是「没找到」最需要被记住的场景（下次别再查一遍）。
   * `uncertainties`（判断不了的点）一并带出：收起态要能回看，不能只有总结一句话。
   */
  onSummary?: (summary: string, uncertainties?: string[]) => void;
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
  /** 只有模型通道（REQ-20261118-004）：不再有快速/深度切换 */
  const mode = 'deep' as const;
  const [stopped, setStopped] = useState(false);
  /**
   * 流式过程中的工具调用（2026-11-19）：非流式时这一段是空的，
   * 面板回退到 `result.steps`（服务端聚合好的那份）。
   */
  const [liveCalls, setLiveCalls] = useState<RefSearchCall[]>([]);
  /**
   * 总结的落盘状态（2026-11-19）：此前失败被静默吞掉，用户无法判断"到底存没存"。
   * 现在三态可见 —— 这也是排查"daemon 没重启导致接口 404"的唯一线索。
   */
  const [summarySave, setSummarySave] = useState<
    { state: 'idle' } | { state: 'saving' } | { state: 'saved'; at: string } | { state: 'error'; message: string }
  >({ state: 'idle' });
  const ctrlRef = useRef<AbortController | null>(null);

  const run = useCallback(async (): Promise<void> => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setState('loading');
    setError('');
    setSubmitError('');
    setStopped(false);
    setLiveCalls([]);
    try {
      const onStep = (step: RefSearchStepEvent): void => {
        setLiveCalls((prev) => [...prev, {
          kind: 'tool',
          name: step.name,
          label: step.label ?? step.name,
          ms: step.ms,
          args: JSON.stringify(step.args).slice(0, 300),
          ...(step.ok ? {} : { note: '调用返回错误' }),
        }]);
      };
      // 流式：边跑边把工具调用推给过程区（深度通道要 25~35s，非流式整段空白）
      // 深度通道三段耗时：排队上限 20s + 执行硬超时 45s + 余量 → 客户端 95s
      const r = await findRefCandidatesStream(scope, eventId, {
        signal: ctrl.signal,
        onStep,
        timeoutMs: 95_000,
      });
      if (ctrl.signal.aborted) return;
      setResult(r);
      /*
       * 出结果就固定（不再等「确认加入」）：0 候选场景下没有确认动作，
       * 而「这次查了什么、为什么没有」恰恰是最该留下来的信息。
       */
      if (r.summary) void fixSummary(r.summary, r.uncertainties);
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

  /**
   * 固定本次结论（手动按钮 + 出结果自动各调一次，幂等）。
   *
   * 为什么要有手动入口：0 候选时底栏只有一个「取消」，用户找不到"确认"——
   * 而"这次查了什么、为什么没有"恰恰是最该留下的信息。
   */
  const fixSummary = (summary: string, uncertainties?: string[]): Promise<boolean> => {
    args.onSummary?.(summary, uncertainties);
    setSummarySave({ state: 'saving' });
    return saveFindSummary(scope, eventId, summary, uncertainties)
      .then(() => {
        setSummarySave({ state: 'saved', at: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) });
        return true;
      })
      .catch((err: unknown) => {
        setSummarySave({ state: 'error', message: err instanceof Error ? err.message : String(err) });
        return false;
      });
  };

  /**
   * 底栏主按钮：
   * · 有勾选 → 加入这些候选（写引用记录，总结随 `onAdded` 交给父级保存）
   * · 无勾选（含 0 候选）→ **只确认并固定本次结论**，不写引用记录（2026-11-19）
   *
   * 为什么允许"0 选择也确认"：AI 查找的价值不只在"加了哪几篇"，
   * 「查了什么、为什么没找到」同样要能落盘；原先 0 选中时按钮叫「未选择」且禁用，
   * 用户只剩「取消」一条路，等于否认这次查找发生过。
   */
  const submit = async (): Promise<void> => {
    setSubmitError('');
    if (pickedDocs.length === 0) {
      // 自动固定已成功 / 正在进行的直接收起；还没开始或失败过就当场再试一次 ——
      // 失败时**不关面板**，把「总结未能固定」留在原地（fail-loud，不假装存好了）
      const summary = result?.summary;
      if (summary && (summarySave.state === 'idle' || summarySave.state === 'error')) {
        const ok = await fixSummary(summary, result?.uncertainties);
        if (!ok) return;
      }
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
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
      args.onAdded(r.added, r.skipped.length, result?.summary, result?.uncertainties);
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
        ? '确认'
        : `加入所选 ${pickedDocs.length} 篇`;
  /** 0 选中也可点（只固定结论）；只读账号仍拦 —— 固定总结本身是写操作 */
  const primaryDisabled = state !== 'done' || submitting || !canWrite;

  return (
    <div className="gov-ai-embed gov-ai-embed--auto">
      <div className="gov-ai-embed__bar">
        <span className="gov-hint gov-ai-embed__barhint">
          {mode === 'deep'
            ? '深度查找会让模型多轮检索与读正文，耗时更长、产生更多模型调用；随时可停。'
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
            <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={args.onSwitchToManual}>
              改用手动添加
            </button>
          </div>
        </div>
      ) : (
        <AiProcessPanel
          state={state}
          steps={state === 'loading' && liveCalls.length > 0
            ? [{
              name: 'tools',
              ms: 0,
              metrics: { calls: liveCalls.length, ok: liveCalls.length },
              calls: liveCalls,
            }]
            : (result?.steps ?? [])}
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

      {/*
        查找总结（2026-11-19）：与 `ki_recall` 的 `summary` 同源 —— 模型在给出候选前，
        本来就要写「最该先读什么 + 为什么」；MCP 侧一直在展示，面板侧此前丢掉了。
        配色刻意与「AI 分析」的紫色结论卡区分（这里用品牌绿）。
      */}
      {state === 'done' && result?.summary ? (
        <div className="gov-ai-final gov-ai-final--find">
          <div className="gov-ai-final__head">查找总结</div>
          <p className="gov-ai-final__text">{result.summary}</p>
          {result.uncertainties && result.uncertainties.length > 0 ? (
            <div className="gov-ai-final__uncertain">
              <div className="gov-ai-final__uncertain-head">判断不了的点 · {result.uncertainties.length}</div>
              <ul className="gov-ai-final__uncertain-list">
                {result.uncertainties.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </div>
          ) : null}
          {/*
            总结与候选不一致时要说清原因（2026-11-19 实测）：模型可能在 summary 里写
            「可采纳 N 篇」，但那几篇没读全正文、被「必须读正文」规则剔除 —— 用户看到
            「说有一篇、列表却是空的」会以为是 bug。这里如实交代差在哪。
          */}
          <p className="gov-ai-final__save" data-state={summarySave.state}>
            {summarySave.state === 'saving' ? '正在固定这份总结…' : null}
            {summarySave.state === 'saved' ? `总结已固定 · ${summarySave.at}（刷新后仍在）` : null}
            {summarySave.state === 'error' ? `总结未能固定：${summarySave.message}（若为 404，请先重启 daemon）` : null}
            {summarySave.state === 'idle' ? '总结将在出结果时自动固定' : null}
          </p>
          {candidates.length === 0 && result.droppedCount ? (
            <p className="gov-ai-final__warn">
              模型提到 {result.droppedCount} 篇，但未读全正文（或与已读清单重复），按「必须读正文」规则未列入候选。
            </p>
          ) : null}
        </div>
      ) : null}

      {state === 'done' && candidates.length > 0 ? (
        <>
          <div className="gov-cand-list gov-cand-list--embed">
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
        <span className="gov-hint" style={{ padding: '0 12px' }}>当前账号为只读，只能查看候选；加入与固定总结都需要写权限。</span>
      ) : null}

      <div className="gov-ai-embed__foot">
        <span className="gov-ai-embed__stat">加入后只写引用记录，不改这些文档的分类与可见性</span>
        <span style={{ flex: 1 }} />
        {args.onOpenSettings ? (
          <button type="button" className="gov-btn gov-btn--ghost gov-btn--sm" onClick={args.onOpenSettings}>
            ⚙ 提示词设置
          </button>
        ) : null}
        {state === 'done' && result?.summary && summarySave.state !== 'saved' ? (
          <button
            type="button"
            className="gov-btn gov-btn--ghost gov-btn--sm"
            disabled={summarySave.state === 'saving'}
            onClick={() => { if (result.summary) void fixSummary(result.summary, result.uncertainties); }}
          >
            {summarySave.state === 'saving' ? '固定中…' : '固定总结'}
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
