import { useState } from 'react';
import type { ConfirmedCodeLocation, EventAnalysis, EventView } from '@/api/governanceApi';
import { AiAnalyzePanel } from '@/components/governance/AiAnalyzePanel';
import { CodeLocRow } from './CodeLocRow';
import { ConclusionChain } from './ConclusionChain';
import { AskBlock } from './AskBlock';

/**
 * AI 分析卡（2026-11-17 改版 · 批 2）。
 *
 * 检查点：D-01~D-06（卡头与 chip）、E-01（无遮罩）、G-03（确认后整卡保留）、F-15（运行中不出现候选）。
 * · 卡头只放状态徽标，入口统一在概要卡（D-04）；
 * · 卡片**默认不渲染**：无草稿且无已确认位置时不出现（D-02），有历史结果时也渲染（D-03）；
 * · 结论区随 B1 上线（Q10：未就绪整块不渲染，不做占位说明）。
 */
export interface EventAnalysisCardProps {
  scope: string;
  event: EventView;
  analysis: EventAnalysis | null;
  canWrite: boolean;
  /** 追问提问权限（knowledge.ask）：与写权限分开，viewer 也有 */
  canAsk: boolean;
  busy: boolean;
  readOnlyHint?: string;
  /** 递增触发一次分析（由概要卡「AI 分析」按钮驱动） */
  startSignal: number;
  onUpdated: (next: EventAnalysis) => void;
  onOpenSettings: () => void;
  onRemoveLocation: (loc: ConfirmedCodeLocation) => void;
}

type ChipTone = 'idle' | 'run' | 'ok' | 'warn' | 'err';

function chipOf(analysis: EventAnalysis | null): { tone: ChipTone; text: string } {
  const draft = analysis?.draft ?? null;
  const confirmed = analysis?.confirmed ?? [];
  if (draft?.status === 'running') return { tone: 'run', text: '分析中 ◐' };
  if (draft && draft.candidates.length > 0 && draft.candidates.every(
    (c) => confirmed.some((x) => x.file === c.file && x.line === c.line),
  )) return { tone: 'ok', text: `已确认 ${confirmed.length} 处` };
  if (draft?.errorCode === 'ANALYSIS_CANCELED') return { tone: 'warn', text: '已停止' };
  if (draft?.status === 'failed') return { tone: 'err', text: '失败' };
  if (draft && draft.candidates.length > 0) return { tone: 'warn', text: `草稿 ${draft.candidates.length} 处` };
  if (confirmed.length > 0) return { tone: 'ok', text: `已确认 ${confirmed.length} 处` };
  // 跑完但一条候选都没有：说「未定位到」，别让它显示成「未开始」（会让人以为没跑过）。
  // running 已在第 36 行返回，走到这里 draft.status 必非 running，无需再判。
  if (draft) return { tone: 'idle', text: '未定位到' };
  return { tone: 'idle', text: '未开始' };
}

export function EventAnalysisCard(props: EventAnalysisCardProps): JSX.Element | null {
  const { scope, event, analysis, canWrite, canAsk, busy, startSignal, onUpdated, onOpenSettings, onRemoveLocation } = props;
  const draft = analysis?.draft ?? null;
  const confirmed = analysis?.confirmed ?? [];
  /*
   * 结论链：空数组表示"这版没分层"（旧事件 / 模型没给），此时回退纯文本结论。
   * `?? []` 不能省 —— 老接口返回的旧 draft 里没有这个字段。
   */
  const chain = draft?.chain ?? [];
  /** 可多行同时展开（I-28） */
  const [openLocs, setOpenLocs] = useState<string[]>([]);

  /*
   * D-02 / D-03：无草稿且无已确认位置 → 整卡不渲染。
   * 例外：用户刚点了「AI 分析」（startSignal > 0）时必须渲染 —— 否则信号没有接收者，
   * 点了没反应，连"启动失败"的报错都没地方显示（真机 2026-11-17）。
   */
  if (!draft && confirmed.length === 0 && startSignal === 0) return null;

  const chip = chipOf(analysis);
  const running = draft?.status === 'running';

  return (
    <section className={`gov-dcard gov-dcard--analysis${running ? ' gov-dcard--live' : ''}`}>
      <div className="gov-dcard__head">
        <span className="gov-dcard__icon" aria-hidden="true">✦</span>
        <span className="gov-dcard__title">AI 分析</span>
        <span className="gov-dcard__hint">基于事件描述与类型，分析原因与结论</span>
        <span className="gov-dcard__actions">
          <span className={`gov-dchip gov-dchip--${chip.tone}`}>{chip.text}</span>
        </span>
      </div>

      <div className="gov-dcard__body">
        {/*
         * 分析结论：未就绪（无草稿）时不渲染；**已跑完但没有结论时必须显式说明**。
         * 原先只在有 conclusion 时渲染，导致「分析完成但未定位到」时整块空白，
         * 用户分不清是没跑、还在跑、还是确实没找到。
         */}
        {chain.length > 0 ? (
          <ConclusionChain summary={draft?.conclusion ?? null} chain={chain} confirmed={confirmed} />
        ) : draft?.conclusion ? (
          <div className="gov-conclusion">
            <div className="gov-conclusion__head">分析结论</div>
            <p className="gov-conclusion__text">{draft.conclusion}</p>
          </div>
        ) : draft && !running && draft.status !== 'failed' ? (
          <div className="gov-conclusion">
            <div className="gov-conclusion__head">分析结论</div>
            <p className="gov-conclusion__text gov-conclusion__text--empty">
              未定位到可证实的代码位置。已排查的方向与缺的证据记在下方「未确认点」里。
            </p>
          </div>
        ) : null}

        {/*
         * 未确认点：独立区块，**不随过程区折叠、也不随已确认消失**（2026-11-18 用户反馈）。
         * 此前它挂在过程区内且条件是 `!committed || procOpen` —— 确认完再收起过程就彻底看不见了，
         * 而这些"没找到证据的部分"恰恰是读结论时最需要一起看的信息。
         */}
        {draft && draft.status !== 'running' && draft.unconfirmed.length > 0 ? (
          <div className="gov-unconfirmed">
            <div className="gov-unconfirmed__head">未确认点 · {draft.unconfirmed.length} 项</div>
            <ul className="gov-unconfirmed__list">
              {draft.unconfirmed.map((item, i) => (
                <li key={`unconfirmed-${i}`}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {confirmed.length > 0 ? (
          <div className="gov-confirmed">
            <div className="gov-confirmed__head">已确认的相关位置 · {confirmed.length} 处</div>
            <div className="gov-codelist">
              {confirmed.map((loc) => (
                <CodeLocRow
                  key={loc.id}
                  loc={loc}
                  open={openLocs.includes(loc.id)}
                  onToggle={() => setOpenLocs((prev) => (prev.includes(loc.id) ? prev.filter((x) => x !== loc.id) : [...prev, loc.id]))}
                  canRemove={!busy && canWrite}
                  onRemove={() => onRemoveLocation(loc)}
                />
              ))}
            </div>
          </div>
        ) : null}

        {/* 无草稿但刚点了「AI 分析」：也要挂载面板，由它发起并在失败时显示原因 */}
        {draft || startSignal > 0 ? (
          <AiAnalyzePanel
            scope={scope}
            event={event}
            analysis={analysis}
            canWrite={canWrite}
            startSignal={startSignal}
            onUpdated={onUpdated}
            onOpenSettings={onOpenSettings}
          />
        ) : null}

        {/* 追问区：运行中不渲染；无历史且非终态时父级本就不会挂载卡片（Q10 / H-11） */}
        {draft && (draft.status === 'ready' || draft.status === 'partial') ? (
          <AskBlock scope={scope} eventId={event.id} canAsk={canAsk} canWrite={canWrite} activeRunId={draft.runId} />
        ) : null}
      </div>
    </section>
  );
}
