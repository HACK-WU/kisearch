import { useState } from 'react';
import type { ConfirmedCodeLocation, EventAnalysis, EventView } from '@/api/governanceApi';
import { AiAnalyzePanel } from '@/components/governance/AiAnalyzePanel';
import { CodeLocRow } from './CodeLocRow';
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
  return { tone: 'idle', text: '未开始' };
}

export function EventAnalysisCard(props: EventAnalysisCardProps): JSX.Element | null {
  const { scope, event, analysis, canWrite, canAsk, busy, startSignal, onUpdated, onOpenSettings, onRemoveLocation } = props;
  const draft = analysis?.draft ?? null;
  const confirmed = analysis?.confirmed ?? [];
  /** 可多行同时展开（I-28） */
  const [openLocs, setOpenLocs] = useState<string[]>([]);

  // D-02 / D-03：无草稿且无已确认位置 → 整卡不渲染
  if (!draft && confirmed.length === 0) return null;

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
        {/* 分析结论：B1 未就绪（无值）时整块不渲染，不做占位说明（Q10） */}
        {draft?.conclusion ? (
          <div className="gov-conclusion">
            <div className="gov-conclusion__head">分析结论</div>
            <p className="gov-conclusion__text">{draft.conclusion}</p>
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

        {draft ? (
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
