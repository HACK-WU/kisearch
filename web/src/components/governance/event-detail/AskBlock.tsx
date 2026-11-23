import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askEventAnalysis,
  askEventAnalysisStream,
  clearEventAnalysisAsk,
  GovernanceApiError,
  listEventAnalysisAsk,
  saveEventAnalysisEdits,
  type AnalysisAskTurn,
  type AnalysisDraft,
  type AskProposalEvent,
  type AskStep,
  type ConfirmedCodeLocation,
} from '@/api/governanceApi';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { ThinkingBlock } from '../ToolCallRow';
import { AnalysisProposalModal } from './AnalysisProposalModal';

/**
 * 追问这次分析（2026-11-17 · 批 6 / B2 前端，真机走查后补：流式输出）。
 * 2026-11-19 改版：**过程与回答直接复用 AI 分析的展示与逻辑**，不再用对话气泡。
 *
 * 检查点：H-01~H-13。
 * · **流式**：`POST /analysis/ask/stream`（SSE over fetch），拿到一段渲染一段；
 *   流不可用（旧后端 / 代理缓冲）且一字未收到时，自动回退到普通 POST，用户无感；
 * · **不是聊天窗口**：提问平铺成一行（无气泡）；过程复用 AI 分析的过程区
 *   （折叠头 + 步骤列表 + 思考块 + 贴底跟随）；回答复用其结论块（`.gov-ai-final`）。
 *   追问是"卡内执行日志 + 回答"，套气泡会让人以为这里是第二个对话页；
 * · 过程步骤只在**本会话**保留（不落盘），刷新后由服务端记录接管答案（H-06）；
 * · 回车发送 + `isComposing` 保护（中文选词回车不误发，H-04/H-05）；
 * · 请求序号 + `eventId` 闭包：切事件后晚到的增量直接丢弃（H-13）；
 * · 能看历史 ≠ 能提问：提问看 `canAsk`（knowledge.ask，viewer 也有），清空看 `canWrite`。
 */
export interface AskBlockProps {
  scope: string;
  eventId: string;
  canAsk: boolean;
  canWrite: boolean;
  /** 当前草稿的 runId：用于分组与"拿新结论回答老问题"的防护 */
  activeRunId: string | null;
  /**
   * 覆盖成功后把新 doc 交给父级（S03）。
   *
   * 只传 draft/confirmed 两块：`resumeAvailable` 之类的字段由卡片自己合并，
   * 追问组件不持有整份 `EventAnalysis`，也就不该假装能重建它（Q2 的教训）。
   */
  onAnalysisUpdated?: (next: { draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }) => void;
}

export function AskBlock(props: AskBlockProps): JSX.Element {
  const { scope, eventId, canAsk, canWrite, activeRunId, onAnalysisUpdated } = props;
  const [turns, setTurns] = useState<AnalysisAskTurn[]>([]);
  /** 正在流式输出的这一轮（先上屏问题，再逐段填答案） */
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null);
  /** 本轮过程步骤（按 id upsert，累积展示，像 AI 分析过程区那样实时增长） */
  const [steps, setSteps] = useState<AskStep[]>([]);
  const stepsRef = useRef<AskStep[]>([]);
  /** 已完成追问的过程快照（按 turn id；本会话内保留，刷新后由服务端记录接管答案） */
  const [turnSteps, setTurnSteps] = useState<Record<string, AskStep[]>>({});
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  /** 本轮补丁建议（S03）：流式结束时才弹框，避免打断阅读 */
  const [proposal, setProposal] = useState<AskProposalEvent | null>(null);
  const [applyingProposal, setApplyingProposal] = useState(false);
  const [proposalError, setProposalError] = useState('');
  /** 流式过程中先收下，落库后再交给 state */
  const proposalRef = useRef<AskProposalEvent | null>(null);
  const seqRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await listEventAnalysisAsk(scope, eventId);
      setTurns(res.turns);
    } catch {
      // 读不到就按空列表展示，不阻塞卡片
    }
  }, [scope, eventId]);

  useEffect(() => { void load(); }, [load]);

  // 新内容到达时贴底（只在已贴底时跟随，避免打断回看）；过程区内部自己贴底（AskProcess）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) el.scrollTop = el.scrollHeight;
  }, [turns.length, pending?.answer]);

  const send = async (): Promise<void> => {
    const text = question.trim();
    if (!text || asking || !canAsk) return;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setAsking(true);
    setError('');
    setQuestion('');
    setPending({ question: text, answer: '' });
    stepsRef.current = [];
    setSteps([]);
    // 新一轮提问时丢掉上一轮未被采纳的建议（避免张冠李戴）
    proposalRef.current = null;
    setProposal(null);
    setProposalError('');

    let received = '';
    try {
      const res = await askEventAnalysisStream(scope, eventId, {
        question: text,
        ...(activeRunId ? { runId: activeRunId } : {}),
      }, (delta) => {
        if (seqRef.current !== seq) return;
        received += delta;
        setPending({ question: text, answer: received });
      }, (event) => {
        if (seqRef.current !== seq) return;
        if (event.type === 'step') {
          // 同 id upsert：后端传的是累积全文，直接覆盖
          const next = [...stepsRef.current];
          const idx = next.findIndex((s) => s.id === event.step.id);
          if (idx >= 0) next[idx] = event.step;
          else next.push(event.step);
          stepsRef.current = next;
          setSteps(next);
        } else if (event.type === 'proposal') {
          /*
           * 补丁建议先收下，**等 done 之后再弹框**：流式中途弹框会打断阅读，
           * 而且此时 turn 还没落库，`turnId` 也不完整。
           */
          proposalRef.current = event;
        } else if (event.type === 'tool' || event.type === 'thinking') {
          // 旧后端原子事件兜底（没有 step 时至少能提示在动）
          if (stepsRef.current.length === 0) {
            const fallback: AskStep = event.type === 'tool'
              ? { id: `fb-tool-${event.name}`, kind: 'tool', label: event.label || event.name, text: '正在查证据…', at: Date.now() }
              : { id: 'fb-think', kind: 'thinking', label: '思考中', text: event.text, at: Date.now() };
            stepsRef.current = [fallback];
            setSteps([fallback]);
          }
        }
      });
      if (seqRef.current !== seq) return;
      if (stepsRef.current.length > 0) {
        setTurnSteps((prev) => ({ ...prev, [res.turn.id]: stepsRef.current }));
      }
      setTurns((prev) => [...prev, res.turn]);
      setPending(null);
      // 补丁建议落库后才弹框（turnId 此时才可靠）
      const suggestion = proposalRef.current;
      proposalRef.current = null;
      if (suggestion) setProposal(suggestion);
      stepsRef.current = [];
      setSteps([]);
    } catch (err) {
      if (seqRef.current !== seq) return;
      // 一字未收到 → 回退普通 POST（兼容不支持流式/代理缓冲的环境）
      if (!received) {
        try {
          const res = await askEventAnalysis(scope, eventId, {
            question: text,
            ...(activeRunId ? { runId: activeRunId } : {}),
          });
          if (seqRef.current !== seq) return;
          setTurns((prev) => [...prev, res.turn]);
          setPending(null);
          return;
        } catch (err2) {
          // 回退也失败：以回退的错误为准（它才是"真实最后一道"），继续走下面的错误展示
          err = err2;
        }
      }
      /*
       * 有部分内容就留在屏幕上（半截答案比整段消失更可解释），没有才收起占位；
       * 顺便把问题还回输入框，失败后不必重打。
       */
      if (!received) setPending(null);
      setQuestion((q) => (q ? q : text));
      const code = err instanceof GovernanceApiError ? err.code : undefined;
      if (code === 'REVISION_CONFLICT') {
        setError('分析结果已更新，请刷新后重新提问');
        void load();
      } else {
        setError((err as Error).message || '提问失败，请重试');
      }
    } finally {
      if (seqRef.current === seq) setAsking(false);
    }
  };

  const clear = async (): Promise<void> => {
    if (clearing || !canWrite || turns.length === 0) return;
    setClearing(true);
    setError('');
    try {
      await clearEventAnalysisAsk(scope, eventId);
      setTurns([]);
    } catch (err) {
      setError((err as Error).message || '清空失败');
    } finally {
      setClearing(false);
    }
  };

  /**
   * 用补丁覆盖结论（S03 R-22）。
   *
   * 走的是**同一个写入口** `PATCH /analysis`：`expectedRunId` 取当前 runId，
   * 冲突时后端 409，这里只把错误显示在弹框里、**不关框不丢差异**（N15）。
   */
  const applyProposal = async (): Promise<void> => {
    const p = proposal;
    if (!p || !p.valid || !p.patch || applyingProposal) return;
    setProposalError('');
    setApplyingProposal(true);
    try {
      const res = await saveEventAnalysisEdits(scope, eventId, {
        expectedRunId: activeRunId ?? null,
        conclusion: p.patch.conclusion,
        chain: p.patch.chain,
        ...(p.turnId ? { acceptedProposalTurnId: p.turnId } : {}),
      });
      setProposal(null);
      onAnalysisUpdated?.({ draft: res.draft, confirmed: res.confirmed });
    } catch (err) {
      setProposalError((err as Error).message || '覆盖失败，请重试');
    } finally {
      setApplyingProposal(false);
    }
  };

  const askTitle = canAsk ? undefined : '当前账号没有提问权限（需要 knowledge.ask）';

  return (
    <div className="gov-ask">
      {/* 覆盖遮罩用 fixed 定位，挂在卡片内也能正常覆盖全屏（同「重置分析」弹框） */}
      {proposal ? (
        <AnalysisProposalModal
          proposal={proposal}
          canWrite={canWrite}
          saving={applyingProposal}
          {...(proposalError ? { error: proposalError } : {})}
          onConfirm={() => void applyProposal()}
          onCancel={() => { setProposal(null); setProposalError(''); }}
        />
      ) : null}
      <div className="gov-ask__head">
        <span className="gov-ask__icon" aria-hidden="true">◌</span>
        <span className="gov-ask__title">追问这次分析</span>
        <span className="gov-ask__hint">可调用只读工具重新核查（源码 / 知识库）</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="gov-ask__clear"
          disabled={clearing || !canWrite || turns.length === 0}
          title={canWrite ? '清空本事件的追问记录（不可恢复）' : '需要写权限'}
          onClick={() => void clear()}
        >
          {clearing ? '清空中…' : '清空对话'}
        </button>
      </div>

      {turns.length > 0 || pending ? (
        <div className="gov-ask__list" ref={listRef}>
          {turns.map((t) => (
            <div key={t.id} className="gov-ask__thread">
              <AskQuestion text={t.question} />
              {/* key 必须带轮次 id：否则 pending → 完成时 React 会复用同一实例，展开态卡在上一次的 true */}
              {turnSteps[t.id]?.length ? (
                <AskProcess key={`${t.id}-proc`} steps={turnSteps[t.id]!} running={false} />
              ) : null}
              <AskAnswer text={t.answer} truncated={t.truncated} />
              {t.toolCalls && t.toolCalls.length > 0 && !turnSteps[t.id]?.length ? (
                <div className="gov-ask__audit gov-hint">本次查证：{t.toolCalls.length} 次工具调用</div>
              ) : null}
            </div>
          ))}
          {pending ? (
            <div className="gov-ask__thread">
              <AskQuestion text={pending.question} />
              <AskProcess key="pending-proc" steps={steps} running />
              {pending.answer ? <AskAnswer text={pending.answer} streaming /> : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="gov-ask__input">
        <input
          className="gov-input"
          type="text"
          value={question}
          maxLength={4000}
          placeholder={canAsk ? '就这次分析追问一句，回车发送' : '当前账号无提问权限'}
          disabled={!canAsk || asking}
          title={askTitle}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void send();
          }}
        />
        <button
          type="button"
          className="gov-btn gov-btn--sm gov-btn--primary"
          disabled={!canAsk || asking || !question.trim()}
          title={askTitle}
          onClick={() => void send()}
        >
          {asking ? '回答中…' : '发送'}
        </button>
      </div>

      {error ? <span className="gov-error">{error}</span> : null}
    </div>
  );
}

/** 提问行：平铺成一行（**不套气泡**）—— 追问区是卡内执行日志，不是聊天窗口 */
function AskQuestion({ text }: { text: string }): JSX.Element {
  return (
    <div className="gov-ask__q">
      <span className="gov-ask__q-mark" aria-hidden="true">问</span>
      <span className="gov-ask__q-text">{text}</span>
    </div>
  );
}

/**
 * 一轮追问的过程区：**直接复用 AI 分析的过程区**（折叠头 + 步骤列表 + 思考块 + 贴底跟随）。
 *
 * 只做两件追问侧的事：
 * · 不套 `.gov-ai-embed` 那层卡片 —— 追问区自己已是容器，再套一层就成了气泡；
 * · 过滤 `answer` 步骤 —— 它的正文就是下方回答，渲染出来会重复一遍。
 *
 * 展开逻辑与分析卡一致：运行中展开并贴底；一轮结束组件重挂，`open` 初值 false 即自动收起
 * （留折叠头「N 步 · M 次工具调用 / 查看过程」，想看再点开）。
 */
function AskProcess({ steps, running }: { steps: AskStep[]; running: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(running);
  const listRef = useRef<HTMLOListElement>(null);
  /** 用户是否贴着底部（回看时不让新步骤把视图拽回去） */
  const stickRef = useRef(true);
  const visible = steps.filter((s) => s.kind !== 'answer');
  const toolCount = visible.filter((s) => s.kind === 'tool').length;
  /** 只在最后一轮仍在生成的思考上标「思考中 ◐」，已定稿的不标（与分析卡同口径） */
  const liveThinking = running && visible.length > 0 && visible[visible.length - 1]!.kind === 'thinking'
    ? visible[visible.length - 1]!.id
    : null;

  useEffect(() => {
    if (!running) return;
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [running, steps]);

  // 已完成的轮次且没有过程（老记录 / 回退到非流式）：整块不渲染
  if (visible.length === 0 && !running) return null;

  return (
    <div className="gov-ask__proc">
      <button
        type="button"
        className="gov-ai-proc__head"
        aria-expanded={open}
        title={open ? '收起过程' : '展开过程'}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="gov-ai-proc__spin" data-done={running ? undefined : ''} />
        <span className="gov-ai-proc__title">{running ? '正在核对结论与证据…' : '本轮过程'}</span>
        <span className="gov-ai-proc__time">
          {running ? `已走 ${visible.length} 步` : `${visible.length} 步 · ${toolCount} 次工具调用`}
        </span>
        <span className="gov-ai-proc__toggle">{open ? '收起' : '查看过程'}</span>
        <span className="gov-ai-proc__chev" aria-hidden="true">▾</span>
      </button>

      {open ? (
        visible.length > 0 ? (
          <ol
            className="gov-ai-proc__steps gov-ask__proc-steps"
            ref={listRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8;
            }}
          >
            {visible.map((s) => (
              <li key={s.id} className="gov-ai-step is-done">
                <span className="gov-ai-step__mark" aria-hidden="true">✓</span>
                <div className="gov-ai-step__body">
                  <span className="gov-ai-step__text"><b>{s.label}</b></span>
                  {s.kind === 'thinking' ? (
                    <ThinkingBlock text={s.text} live={s.id === liveThinking} />
                  ) : s.text ? (
                    <span className="gov-ask__step-text">{s.text}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className="gov-ask__proc-empty">正在读取事件上下文与已确认位置…</p>
        )
      ) : null}
    </div>
  );
}

/** 回答块：复用 AI 分析「最终结论」的排版（`.gov-ai-final`），正文仍走 Markdown */
function AskAnswer(props: { text: string; truncated?: boolean; streaming?: boolean }): JSX.Element {
  const { text, truncated, streaming } = props;
  return (
    <div className="gov-ai-final gov-ask__answer">
      <div className="gov-ai-final__head">回答</div>
      <MarkdownPreview text={text} deferMermaid />
      {streaming ? <span className="gov-ask__cursor" aria-hidden="true" /> : null}
      {truncated ? <span className="gov-hint">（回答超时，已保留已完成部分）</span> : null}
    </div>
  );
}
