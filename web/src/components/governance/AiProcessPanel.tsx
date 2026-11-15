/**
 * AiProcessPanel.tsx —— AI 查找的 5 步执行过程（REQ-20261113-004 · S-07 §10.3）
 *
 * 三条硬约束（来自 S-05 §3.3 / S-07 决策 6）：
 *   1. **每个数字都来自后端 `steps`**，本组件不推算、不美化；
 *   2. **不做逐步回放**：后端是一次请求、无中间事件，逐帧演只能靠定时器伪造时序，
 *      还会让用户先等请求再等动画。这里等响应到达后一次性渲染，真实耗时由 loading 承载；
 *   3. **不标 skill / MCP 调用 chip**：真实实现只有 1 次检索 + 本地计算，标 4 次调用属造假。
 *
 * 折叠行为：结果出来后自动折叠（用户先看候选），需要复核过程时再点开。
 */

import { useEffect, useState } from 'react';
import type { RefSearchReason, RefSearchStep } from '@/api/governanceApi';

export interface AiProcessContext {
  /** 事件标题（understand 步骤要复述"我在理解什么"） */
  title: string;
  shortId?: number;
  typeName?: string;
  stageName: string;
  /** 关联文档数（extract 步骤的 sources） */
  assocCount: number;
  scope: string;
}

export interface AiProcessPanelProps {
  state: 'loading' | 'done' | 'error';
  steps: RefSearchStep[];
  durationMs: number;
  candidateCount: number;
  reason?: RefSearchReason;
  /** 实际检索模式；`fulltext` 表示语义侧不可用已降级，必须如实提示 */
  mode?: 'hybrid' | 'fulltext';
  degradedReason?: string;
  context: AiProcessContext;
}

const STEP_TITLES: Record<RefSearchStep['name'], string> = {
  understand: '理解事件',
  extract: '提取线索',
  search: '语义检索',
  exclude: '排除已用文档',
  rank: '排序取候选',
};

function numOf(value: number | string | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value) || 0;
  return 0;
}

/** 亚毫秒步显示 `<1ms`（后端不夹到 1ms，否则就是面板上编数字） */
function msText(ms: number): string {
  return ms <= 0 ? '<1ms' : `${ms}ms`;
}

/** `detail` 里的值可能是数组 / 对象，统一压成一行可读文本 */
function detailText(value: unknown): string {
  if (Array.isArray(value)) return value.map((v) => String(v)).join(' · ');
  if (value && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** 把一步的 metrics 翻成一句人话（数字全部取自 metrics，不臆造） */
function stepSentence(step: RefSearchStep, ctx: AiProcessContext, keywordCount: number): string {
  switch (step.name) {
    case 'understand':
      return `理解事件：#${ctx.shortId ?? '—'} ${ctx.title}${ctx.typeName ? ` · ${ctx.typeName}` : ''} · 当前「${ctx.stageName}」`;
    case 'extract':
      return `从标题与 ${numOf(step.metrics.sources)} 篇关联文档提取线索 ${numOf(step.metrics.keywords)} 个`;
    case 'search':
      return keywordCount === 0
        ? '无线索词，跳过检索'
        : `在 ${ctx.scope} 检索 ${numOf(step.metrics.total)} 篇 → 命中 ${numOf(step.metrics.hits)} 个片段（${numOf(step.metrics.docs)} 篇文档）`;
    case 'exclude':
      return `排除 ${numOf(step.metrics.associated)} 篇已关联、${numOf(step.metrics.added)} 篇已加入 → 剩 ${numOf(step.metrics.remaining)} 篇`;
    case 'rank':
      return `按相关度排序取前 ${numOf(step.metrics.candidates)} 篇（默认勾选阈值 ${numOf(step.metrics.threshold)}）`;
    default:
      return step.name;
  }
}

/** 空态文案：四种 reason 对用户意味着完全不同的下一步 */
export function emptyReasonText(reason: RefSearchReason | undefined, context: AiProcessContext): string {
  switch (reason) {
    case 'no-keywords':
      return '标题与关联文档都没能提出线索词。可以给事件换个更具体的标题，或直接用「＋ 添加」按名查找。';
    case 'empty-scope':
      return `库「${context.scope}」里没有任何文档。事件与知识文档可能不在同一个 scope —— 先确认顶部的 scope 选择。`;
    case 'no-hits':
      return '检索跑完了但没有命中。相关文档可能还没入库，或换个说法存在库里。';
    case 'all-excluded':
      return '命中的文档都已作为关联文档或参考文档挂在这个事件上，没有新的可加。';
    default:
      return '没有新的相关文档了。';
  }
}

export function AiProcessPanel(args: AiProcessPanelProps): JSX.Element {
  const [open, setOpen] = useState(true);
  const [openStep, setOpenStep] = useState<number | null>(null);

  // 结果到达即折叠：用户此行的目的是看候选，过程是"要复核时才展开"的东西
  useEffect(() => {
    if (args.state === 'done') setOpen(false);
  }, [args.state]);

  const keywordCount = numOf(args.steps.find((s) => s.name === 'extract')?.metrics.keywords);
  // 调用次数按**真实 calls 累加**（不写死、也不把本地计算算成调用）
  const callCount = args.steps.reduce((n, s) => n + (s.calls?.length ?? 0), 0);
  const seconds = (args.durationMs / 1000).toFixed(1);

  const title = args.state === 'loading'
    ? '正在检索…'
    : args.state === 'error'
      ? '检索失败'
      : args.candidateCount > 0
        ? `检索完成 · 找到 ${args.candidateCount} 篇候选`
        : '检索完成 · 没有新的相关文档';

  return (
    <div className="gov-ai-proc">
      <button
        type="button"
        className="gov-ai-proc__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        disabled={args.state === 'loading'}
      >
        <span className="gov-ai-proc__spin" data-done={args.state === 'done' ? '' : undefined} />
        <span className="gov-ai-proc__title">{title}</span>
        <span className="gov-ai-proc__time">
          {args.state === 'done' ? `${args.steps.length} 步 · ${callCount} 次调用 · ${seconds}s` : ''}
        </span>
        <span className="gov-ai-proc__chev" aria-hidden="true">▾</span>
      </button>

      {args.mode === 'fulltext' ? (
        <p className="gov-ai-proc__degraded">
          本次为<b>全文检索</b>：语义检索不可用已降级
          {args.degradedReason ? `（${args.degradedReason}）` : ''}
        </p>
      ) : null}

      {open && args.steps.length > 0 ? (
        <ol className="gov-ai-proc__steps">
          {args.steps.map((step, i) => {
            const expandable = step.detail !== undefined;
            const expanded = openStep === i;
            return (
              <li key={step.name} className="gov-ai-step is-done">
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
                      {STEP_TITLES[step.name]}：
                      <b>{stepSentence(step, args.context, keywordCount)}</b>
                      <span className="gov-ai-step__ms">{msText(step.ms)}</span>
                    </span>
                    {expandable ? <span className="gov-ai-step__chev" aria-hidden="true">▾</span> : null}
                  </button>

                  {/*
                    真实调用行：**直接复用 AI 对话的工具行**（`.ki-chat-tl__node--tool` +
                    工具名胶囊 + 耗时），视觉与对话页一致，也不新造一套样式。
                    只有真调了东西的步骤才有 chips —— demo 里的 `event-context` /
                    `relevance-rank` 两个 skill 在本功能里不存在，标上去就是伪造。
                  */}
                  {step.calls && step.calls.length > 0 ? (
                    <div className="gov-ai-calls">
                      {step.calls.map((call) => (
                        <div
                          key={`${step.name}-${call.name}`}
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
                          <span className="ki-chat-tl__stat">{msText(call.ms)}</span>
                          {call.note ? <span className="gov-ai-call__note">{call.note}</span> : null}
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {expandable && expanded ? (
                    <div className="gov-ai-step__detail">
                      <dl>
                        {Object.entries(step.detail ?? {}).map(([k, v]) => (
                          <div key={k}>
                            <dt>{k}</dt>
                            <dd>{detailText(v)}</dd>
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
  );
}
