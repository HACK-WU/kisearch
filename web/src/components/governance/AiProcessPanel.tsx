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
  /** 配置里存在但本次被剔除的库（无权限 / 已不存在 / 视图无成员） */
  skippedTargets?: Array<{ name: string; reason: 'forbidden' | 'missing' | 'view-members-changed' }>;
  /** 部分库检索失败（其余结果仍有效）——「查不了」必须与「没内容」分开说 */
  targetErrors?: Array<{ name: string; error: string }>;
  /** 深度通道：因轮次 / 超时提前结束（结果不完整，必须让用户知道） */
  partial?: { reason: 'rounds' | 'timeout'; usedRounds: number };
  /** 深度通道：模型给出但被校验剔除的条数 */
  unconfirmedCount?: number;
  /** 深度通道：模型输出是否可解析（false = 模型没给出结果，不是"没有相关文档"） */
  parsed?: boolean;
  /** 深度通道：被剔除的明细（可折叠，供排障） */
  unconfirmed?: Array<{ group: string; name: string; sourceScope?: string; reason: string }>;
  context: AiProcessContext;
}

const STEP_TITLES: Record<RefSearchStep['name'], string> = {
  understand: '理解事件',
  extract: '提取线索',
  search: '语义检索',
  exclude: '排除已用文档',
  rank: '排序取候选',
  // 深度通道（REQ-20261116-005）的两步：快速通道不会出现，但面板共用同一套标题表
  tools: '工具调用',
  verify: '校验候选',
};

/** 范围剔除原因 → 人话（不要给用户看 `forbidden` 这种机器码） */
/** 校验剔除原因 → 人话（机器码不直接给用户看） */
const UNCONFIRMED_TEXT: Record<string, string> = {
  'out-of-scope': '不在检索范围',
  'not-found': '文档不存在',
  'already-used': '已关联或已加入',
  malformed: '格式不合法',
  truncated: '超出候选上限',
};

const SKIP_TEXT: Record<'forbidden' | 'missing' | 'view-members-changed', string> = {
  forbidden: '无访问权限',
  missing: '库已不存在',
  'view-members-changed': '视图已无成员',
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
    case 'understand': {
      // 深度通道可能有排队等待：把它单独说出来，避免用户把"排队"误当成"检索慢"
      const queuedMs = numOf(step.metrics.queuedMs);
      const queuedText = queuedMs > 0 ? ` · 排队等待 ${(queuedMs / 1000).toFixed(1)}s` : '';
      return `理解事件：#${ctx.shortId ?? '—'} ${ctx.title}${ctx.typeName ? ` · ${ctx.typeName}` : ''} · 当前「${ctx.stageName}」${queuedText}`;
    }
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
    case 'tools':
      return `第 ${numOf(step.metrics.round)} 轮：调用 ${numOf(step.metrics.calls)} 个只读工具`;
    case 'verify':
      // 深度通道没有检索分，不在这里编"相关度"；只说校验结果
      return numOf(step.metrics.parsed) === 1
        ? `校验模型给出的候选：通过 ${numOf(step.metrics.confirmed)} 条，剔除 ${numOf(step.metrics.unconfirmed)} 条`
        : `模型没有给出可解析的候选数组（剔除 ${numOf(step.metrics.unconfirmed)} 条）`;
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

      {/* 范围被收窄（无权限 / 已不存在 / 视图无成员）与「部分库失败」都要如实说：
          「查不了」与「没内容」是两件事，混成一句会让用户以为库里真的没有 */}
      {args.skippedTargets !== undefined && args.skippedTargets.length > 0 ? (
        <p className="gov-ai-proc__degraded">
          已按权限/可用性收窄范围，本次未检索：
          {args.skippedTargets.map((t) => `${t.name}（${SKIP_TEXT[t.reason]}）`).join('、')}
        </p>
      ) : null}
      {args.targetErrors !== undefined && args.targetErrors.length > 0 ? (
        <p className="gov-ai-proc__degraded">
          部分库本次检索失败（其余库结果正常）：
          {args.targetErrors.map((t) => `${t.name}（${t.error}）`).join('、')}
        </p>
      ) : null}
      {args.partial !== undefined ? (
        <p className="gov-ai-proc__degraded">
          {args.partial.reason === 'timeout'
            ? `深度查找超时（已用 ${args.partial.usedRounds} 轮），下面的候选不完整；可缩小检索范围或改用快速查找。`
            : `深度查找已用满 ${args.partial.usedRounds} 轮，模型提前收尾，下面的候选不完整。`}
        </p>
      ) : null}
      {args.unconfirmedCount !== undefined && args.unconfirmedCount > 0 ? (
        <p className="gov-ai-proc__degraded">
          {args.parsed === false
            ? `模型没有给出可解析的候选数组（另有 ${args.unconfirmedCount} 条没通过校验）；可重试，或改用快速查找。`
            : `另有 ${args.unconfirmedCount} 条模型给出的候选没通过校验（不存在 / 不在范围内 / 已加入），已剔除。`}
        </p>
      ) : null}
      {args.parsed === false && (args.unconfirmedCount ?? 0) === 0 ? (
        <p className="gov-ai-proc__degraded">模型没有给出可解析的候选数组；可重试，或改用快速查找。</p>
      ) : null}
      {args.unconfirmed !== undefined && args.unconfirmed.length > 0 ? (
        <details className="gov-ai-proc__unconfirmed">
          <summary>查看被剔除的 {args.unconfirmed.length} 条（供排障）</summary>
          <ul>
            {args.unconfirmed.map((u, i) => (
              <li key={`${u.sourceScope ?? ''}-${u.group}-${u.name}-${i}`}>
                {u.sourceScope ? `${u.sourceScope} · ` : ''}
                {u.group}/{u.name} —— {UNCONFIRMED_TEXT[u.reason] ?? u.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {open && args.steps.length > 0 ? (
        <ol className="gov-ai-proc__steps">
          {args.steps.map((step, i) => {
            const expandable = step.detail !== undefined;
            const expanded = openStep === i;
            // 深度通道每轮一条 `tools` 步骤：只用 name 做 key 会重复，必须带序号
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
