import { useCallback, useEffect, useRef, useState } from 'react';
import {
  askEventAnalysis,
  askEventAnalysisStream,
  clearEventAnalysisAsk,
  GovernanceApiError,
  listEventAnalysisAsk,
  type AnalysisAskTurn,
} from '@/api/governanceApi';

/**
 * 追问这次分析（2026-11-17 · 批 6 / B2 前端，真机走查后补：流式输出）。
 *
 * 检查点：H-01~H-13。
 * · **流式**：`POST /analysis/ask/stream`（SSE over fetch），拿到一段渲染一段；
 *   流不可用（旧后端 / 代理缓冲）且一字未收到时，自动回退到普通 POST，用户无感；
 * · 记录服务端持久化（M-06），刷新/换设备仍在（H-06）；
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
}

export function AskBlock(props: AskBlockProps): JSX.Element {
  const { scope, eventId, canAsk, canWrite, activeRunId } = props;
  const [turns, setTurns] = useState<AnalysisAskTurn[]>([]);
  /** 正在流式输出的这一轮（先上屏问题，再逐段填答案） */
  const [pending, setPending] = useState<{ question: string; answer: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState('');
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

  // 新内容到达时贴底（只在已贴底时跟随，避免打断回看）
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

    let received = '';
    try {
      const res = await askEventAnalysisStream(scope, eventId, {
        question: text,
        ...(activeRunId ? { runId: activeRunId } : {}),
      }, (delta) => {
        if (seqRef.current !== seq) return;
        received += delta;
        setPending({ question: text, answer: received });
      });
      if (seqRef.current !== seq) return;
      setTurns((prev) => [...prev, res.turn]);
      setPending(null);
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

  const askTitle = canAsk ? undefined : '当前账号没有提问权限（需要 knowledge.ask）';

  return (
    <div className="gov-ask">
      <div className="gov-ask__head">
        <span className="gov-ask__icon" aria-hidden="true">◌</span>
        <span className="gov-ask__title">追问这次分析</span>
        <span className="gov-ask__hint">只基于本次分析结果回答，不会重新读仓库</span>
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
              <div className="gov-ask__msg gov-ask__msg--user">
                <div className="gov-ask__bubble">{t.question}</div>
              </div>
              <div className="gov-ask__msg">
                <div className="gov-ask__bubble">
                  {t.answer}
                  {t.truncated ? <span className="gov-hint">（回答超时，已保留已完成部分）</span> : null}
                </div>
              </div>
            </div>
          ))}
          {pending ? (
            <div className="gov-ask__thread">
              <div className="gov-ask__msg gov-ask__msg--user">
                <div className="gov-ask__bubble">{pending.question}</div>
              </div>
              <div className="gov-ask__msg">
                <div className="gov-ask__bubble">
                  {pending.answer || '正在基于本次分析结果作答…'}
                  {pending.answer ? <span className="gov-ask__cursor" aria-hidden="true" /> : null}
                </div>
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
