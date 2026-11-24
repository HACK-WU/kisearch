import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askEventAnalysis,
  askEventAnalysisStream,
  cancelEventAsk,
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
import type { AnalysisAskRunningDto } from '@/api/governanceContract';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { ThinkingBlock } from '../ToolCallRow';
import { AnalysisProposalModal } from './AnalysisProposalModal';

/**
 * 运行中追问的轮询间隔（#82）。
 *
 * 追问是一条 SSE 流，切页 / 刷新会断开连接，而服务端**不会**因此中止（它不监听 close），
 * 仍会跑完并落库。2s 一次读运行态：既能及时显示半截答案，也不至于把 GET 打成高频请求。
 */
const REMOTE_POLL_MS = 2000;

/**
 * 是否该「接续」服务端那一轮：`runId` 不一致说明分析被重跑过，
 * 拿它的半截答案接着展示会让人以为是新结论的回答（口径同 REVISION_CONFLICT）。
 */
function shouldResume(
  running: AnalysisAskRunningDto | null,
  activeRunId: string | null,
): AnalysisAskRunningDto | null {
  if (!running) return null;
  if (running.runId && activeRunId && running.runId !== activeRunId) return null;
  return running;
}

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
 * · 能看历史 ≠ 能提问：提问看 `canAsk`（knowledge.ask，viewer 也有），清空看 `canWrite`；
 * · **可停止**（2026-11-24）：运行中（本地流式 `asking` / 服务端接续 `remote`）发送键换成
 *   停止键，走 `POST /analysis/ask/cancel`（服务端 abort）。停止不是错误 —— 用中性
 *   `notice` 而非红色 `error`，且**绝不落进「回退普通 POST」**（那会重跑一遍）。
 */
export interface AskBlockProps {
  scope: string;
  eventId: string;
  canAsk: boolean;
  canWrite: boolean;
  /** 当前草稿的 runId：用于分组与"拿新结论回答老问题"的防护 */
  activeRunId: string | null;
  /**
   * 递增 = 父级刚重新取过详情（事件列表刷新按钮，2026-11-24）。
   *
   * 追问记录是挂载时读一次、之后只靠「运行中 2s 轮询」更新的，刷新按钮刷不到它
   * —— 别的标签页刚追问完，这里会一直停在旧问答上。
   */
  reloadSignal?: number;
  /**
   * 覆盖成功后把新 doc 交给父级（S03）。
   *
   * 只传 draft/confirmed 两块：`resumeAvailable` 之类的字段由卡片自己合并，
   * 追问组件不持有整份 `EventAnalysis`，也就不该假装能重建它（Q2 的教训）。
   */
  onAnalysisUpdated?: (next: { draft: AnalysisDraft | null; confirmed: ConfirmedCodeLocation[] }) => void;
}

export function AskBlock(props: AskBlockProps): JSX.Element {
  const { scope, eventId, canAsk, canWrite, activeRunId, reloadSignal = 0, onAnalysisUpdated } = props;
  const [turns, setTurns] = useState<AnalysisAskTurn[]>([]);
  /**
   * 服务端认为「还在跑」的那一轮（#82）：
   * 切页 / 刷新回来后按它先把问题、半截答案与过程渲染出来，再轮询到落库。
   */
  const [remote, setRemote] = useState<AnalysisAskRunningDto | null>(null);
  /** 正在流式输出的这一轮（先上屏问题，再逐段填答案） */
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null);
  /** 本轮过程步骤（按 id upsert，累积展示，像 AI 分析过程区那样实时增长） */
  const [steps, setSteps] = useState<AskStep[]>([]);
  const stepsRef = useRef<AskStep[]>([]);
  /** 已完成追问的过程快照（按 turn id；本会话内保留，刷新后由服务端记录接管答案） */
  const [turnSteps, setTurnSteps] = useState<Record<string, AskStep[]>>({});
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  /** 已发出停止请求、正在等服务端收口（2026-11-24）：期间按钮显示「停止中…」并禁用 */
  const [stopping, setStopping] = useState(false);
  /** 中性提示（灰字）：停止成功这类「不是错误的状态变化」不走红色 `error` */
  const [notice, setNotice] = useState('');
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
  /** 本轮补丁建议（S03）：流式结束时才弹框，避免打断阅读 */
  const [proposal, setProposal] = useState<AskProposalEvent | null>(null);
  const [applyingProposal, setApplyingProposal] = useState(false);
  const [proposalError, setProposalError] = useState('');
  /** 流式过程中先收下，落库后再交给 state */
  const proposalRef = useRef<AskProposalEvent | null>(null);
  const seqRef = useRef(0);
  /**
   * 本轮是否被用户主动停止（2026-11-24）。
   *
   * 停止时「有半截内容」的服务端会正常落库并回 `done`（不是错误路径），
   * 前端拿不到任何"这是被停止的"信号 —— 只能在本地记一笔，
   * 收口后补一句「已停止」，否则用户会以为是自己看错了。
   */
  const stoppedRef = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);

  /**
   * 读记录请求的序号（与流式的 `seqRef` 分开：那个管「哪一轮追问」，这个管「哪一次读记录」）。
   *
   * 首屏与 2s 轮询打的是同一个接口，网络慢时晚到的旧响应会盖掉新数据
   * （turns 少一条，或把已结束的运行态又写回来）。只认最后一次请求的结果。
   */
  const loadSeqRef = useRef(0);
  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++loadSeqRef.current;
    try {
      const res = await listEventAnalysisAsk(scope, eventId);
      if (seq !== loadSeqRef.current) return;
      setTurns(res.turns);
      // 运行态只在「确实是我这版结论的追问」时才接续（分析被重跑则丢弃）
      setRemote(shouldResume(res.running ?? null, activeRunId));
    } catch {
      // 读不到则保持现状：首屏是空列表；轮询中保留占位，让下一轮再试
    }
  }, [scope, eventId, activeRunId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * 刷新按钮（2026-11-24）：父级刚重新取过详情，这里跟着重读一次记录。
   *
   * 用 ref 比对而不是把 `reloadSignal` 塞进 `refresh` 的依赖：后者会让首次挂载
   * 与每次刷新各多读一次；而且正在流式输出时不该因为父级刷新而重读（`asking` 期间
   * 服务端记录还没落库，读回来是空的，会被误当成"记录没了"）。
   */
  const reloadSigRef = useRef(reloadSignal);
  useEffect(() => {
    if (reloadSignal === reloadSigRef.current) return;
    reloadSigRef.current = reloadSignal;
    if (asking) return;
    void refresh();
  }, [reloadSignal, asking, refresh]);

  /**
   * 运行中追问的续接轮询（2026-11-23 · #82）。
   *
   * 场景：追问回答到一半切走 / 刷新 → SSE 断开、组件内存态没了，但服务端仍在跑。
   * 回来时首屏已拿到运行态，这里每 2s 再读一次：`running` 变 `null` 说明那一轮已落库
   * （turns 同时更新），占位自动换成正式问答；服务短暂不可用时保留占位，下一轮再试。
   */
  const pollingRemote = remote !== null;
  useEffect(() => {
    if (!pollingRemote) return undefined;
    const timer = window.setInterval(() => { void refresh(); }, REMOTE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [pollingRemote, refresh]);

  /**
   * 「停止中…」的解锁条件（2026-11-24）：本地流式结束 **且** 服务端没有在跑的轮次。
   *
   * 不能一发出停止请求就解锁 —— abort 只是信号，服务端可能还在工具执行段里收尾
   * （此时 `.ask.running.json` 还在）。这期间若让用户再发一条，就有两轮同时写
   * 同一份运行态（后写覆盖前写），回来看到的半截答案会张冠李戴。
   */
  useEffect(() => {
    if (!asking && !remote && stopping) setStopping(false);
  }, [asking, remote, stopping]);

  // 新内容到达时贴底（只在已贴底时跟随，避免打断回看）；过程区内部自己贴底（AskProcess）
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 24) el.scrollTop = el.scrollHeight;
  }, [turns.length, pending?.answer]);

  const send = async (): Promise<void> => {
    const text = question.trim();
    // `remote` 非空 = 上一轮还在服务端跑（切页回来会走这里）：再发会并出两条追问
    if (!text || asking || !canAsk || remote) return;
    const seq = seqRef.current + 1;
    seqRef.current = seq;
    setAsking(true);
    setError('');
    setNotice('');
    setQuestion('');
    // 新一轮开跑：上一轮的「已停止」标记必须清掉（否则这一轮的 done 会显示成被停止）
    stoppedRef.current = false;
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
      /*
       * 「停止时有半截内容」走的是**正常结束**（服务端把已生成部分落库成正式记录），
       * 前端拿不到停止信号，只能靠本地标记补一句，否则这一轮看起来跟正常答完一样。
       */
      if (stoppedRef.current) setNotice('已停止本轮追问 · 已生成的部分已保留');
      // 补丁建议落库后才弹框（turnId 此时才可靠）
      const suggestion = proposalRef.current;
      proposalRef.current = null;
      if (suggestion) setProposal(suggestion);
      stepsRef.current = [];
      setSteps([]);
    } catch (err) {
      if (seqRef.current !== seq) return;
      const code = err instanceof GovernanceApiError ? err.code : undefined;
      /*
       * 主动停止（2026-11-24）：服务端 abort 后流以 `error` 结束。
       * **必须挡在「回退普通 POST」之前** —— 那条兜底会重新发一次完整追问，
       * 等于把用户刚停掉的这一轮又跑一遍（既费钱又违背他的意图）。
       */
      if (stoppedRef.current || code === 'ANALYSIS_ASK_CANCELED') {
        setPending(null);
        /*
         * 文案**不承诺"没生成内容"**：`ANALYSIS_ASK_CANCELED` 只保证"这一轮没落库"，
         * 而落库失败（磁盘/锁）也会走到这里 —— 那时实际上生成过内容、只是没存住。
         * 说成"尚未生成内容"会把"数据没存住"伪装成"你没等到东西"，用户不会去查。
         */
        setNotice('已停止本轮追问');
        setQuestion('');
        void refresh();
        return;
      }
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
      // `code` 在 catch 开头已算过（停止分支要用），这里不能重复声明
      if (code === 'REVISION_CONFLICT') {
        setError('分析结果已更新，请刷新后重新提问');
        void refresh();
      } else {
        setError((err as Error).message || '提问失败，请重试');
      }
    } finally {
      if (seqRef.current === seq) setAsking(false);
    }
  };

  /**
   * 停止正在跑的那一轮追问（2026-11-24）。
   *
   * 交互与 AI 分析卡的「停止」一致：发出请求后进「停止中…」并禁用，**不立刻解锁**。
   * 原因见上面的解锁 effect —— abort 只是信号，服务端可能还在工具执行段；
   * 早解锁会让新一轮与旧一轮的收尾同时写同一份运行态。
   *
   * `canceled:false` 是**正常结果**（那一轮刚好已经结束），不是失败：
   * 只刷新记录，不显示红色错误。
   */
  const stop = async (): Promise<void> => {
    if (stopping) return;
    setStopping(true);
    setError('');
    try {
      const res = await cancelEventAsk(scope, eventId);
      if (!res.canceled) {
        /*
         * `canceled:false` 有两种含义，必须分开说：
         *   · 本地已经没有流式了 → 真的结束了；
         *   · 本地**还在流式**（`asking`）→ 是竞态：服务端那一轮还没注册
         *     （请求刚发出/在排队），此时说"已经结束"会和随后涌出的回答自相矛盾。
         *     让按钮恢复可点，用户再点一次就能停掉。
         */
        setNotice(asking ? '服务端暂未找到这一轮，可稍后重试停止' : '这一轮追问已经结束');
        setStopping(false);
        void refresh();
        return;
      }
      stoppedRef.current = true;
      setNotice('已停止本轮追问');
    } catch (err) {
      setError((err as Error).message || '停止失败，请重试');
      setStopping(false);
    }
  };

  const clear = async (): Promise<void> => {
    // `remote` 兜底：按钮已禁用，但清空正在写的那轮会让服务端落到一半的记录失去对应问答
    if (clearing || !canWrite || turns.length === 0 || remote) return;
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
        /*
         * 数据链路（2026-11-24 · S03 §3.1）：**补丁里没有该字段就不传**。
         * 不传 = 服务端保留旧链路（补丁缺省语义），传空串则会把链路清掉 ——
         * 所以这里必须是条件展开，不能无条件 `dataFlow: p.patch.dataFlow`。
         */
        ...(p.patch.dataFlow ? { dataFlow: p.patch.dataFlow } : {}),
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
          disabled={clearing || !canWrite || turns.length === 0 || Boolean(remote)}
          title={!canWrite
            ? '需要写权限'
            : remote
              ? '这一轮追问仍在进行，完成后才能清空'
              : '清空本事件的追问记录（不可恢复）'}
          onClick={() => void clear()}
        >
          {clearing ? '清空中…' : '清空对话'}
        </button>
      </div>

      {turns.length > 0 || pending || remote ? (
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
          {/*
            接续服务端的运行中那一轮（#82）：切页 / 刷新回来后本地 pending 已不存在，
            这里用服务端的半截快照顶上，并在轮询到落库后自动换成正式问答。
            `!pending` 是硬条件：本地流式进行中时服务端也在写运行态，两个都渲染会重复一遍。
          */}
          {remote && !pending ? (
            <div className="gov-ask__thread" data-ask-remote="1">
              <AskQuestion text={remote.question} />
              <AskProcess key="remote-proc" steps={remote.steps} running />
              {remote.answer ? <AskAnswer text={remote.answer} streaming /> : null}
              <div className="gov-hint">
                这一轮追问仍在进行（已从服务端接续，离开页面不会丢）；完成后会自动出现在上方记录里
              </div>
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
          placeholder={remote
            ? '上一轮仍在回答，可点停止中断'
            : asking
              ? '正在回答，可点停止中断'
              : canAsk ? '就这次分析追问一句，回车发送' : '当前账号无提问权限'}
          disabled={!canAsk || asking || Boolean(remote)}
          title={askTitle}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
            e.preventDefault();
            void send();
          }}
        />
        {/*
          运行中（本地流式 / 服务端接续）把「发送」换成「停止」（2026-11-24）：
          与分析卡同一个位置语义（底栏右侧的终止入口），样式也复用 `danger-ghost`。
          两种运行形态都必须能停 —— 接续态下发起人可能已在别的标签页走了。
        */}
        {asking || remote ? (
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--danger-ghost"
            disabled={!canAsk || stopping}
            title={!canAsk
              ? askTitle
              : stopping
                /*
                 * 「停止中…」可能持续一阵：abort 在工具执行段收不到，最坏要等这一轮工具返回。
                 * 说清楚比让人以为按钮卡死强，也解释了为什么还不能马上再问。
                 */
                ? '正在停止：等当前这一轮收口，工具调用进行中时可能要等它返回'
                : '停止这一轮追问（已生成的内容会保留）'}
            onClick={() => void stop()}
          >
            {stopping ? '停止中…' : '停止'}
          </button>
        ) : (
          <button
            type="button"
            className="gov-btn gov-btn--sm gov-btn--primary"
            disabled={!canAsk || !question.trim()}
            title={askTitle}
            onClick={() => void send()}
          >
            发送
          </button>
        )}
      </div>

      {error ? <span className="gov-error">{error}</span> : null}
      {notice ? <span className="gov-hint">{notice}</span> : null}
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
