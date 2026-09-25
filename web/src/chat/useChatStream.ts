/**
 * useChatStream —— 流式对话 hook（SSE 事件 → store 状态）
 *
 * ═══ 职责边界 ═══
 * · 只做**事件 → 状态**的搬运与生命周期管理；**不含**检索/生成业务（那在后端）
 * · 是**唯一**允许 dispatch `stream*` 动作的地方（单写者，保证同一时刻一个活跃流）
 *
 * ═══ 通用语义契约 ═══
 * · 前置：`config.enabled === true` 且 `ackRequired === false`（否则调用方应阻塞发送）
 * · 后置：流结束后 store 的 `streaming.active === false`，内容已并入 `messages`
 * · 空值：`abort()` 在无活跃流时**静默无操作**（不抛错）
 * · 错误：HTTP 层错 → 写入消息的错误态并提示可重试（N4）
 * · 中止：`abort()` → 后端发 `aborted` 事件 → UI 标记「已中止」并**保留已生成部分**（N6）
 * · 并发：单写者 —— 新流开始前必须 abort 旧流（切会话 / 重新生成 / 编辑重发均适用）
 * · 副作用：网络请求；**不落盘**
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9.1
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { streamEditMessage, streamMessage, streamRegenerate } from '@/api/chatApi';
import { DEGRADED_LABELS } from '@/api/chatContract';
import type { ChatEvent } from '@/api/chatContract';
import type { ChatStore, DegradedMark, ProgressStep } from './chatStore';

export interface ChatStreamApi {
  /** 发消息（API-08） */
  send(convId: string, text: string): Promise<void>;
  /** 重新生成（API-11，不新增 user 消息） */
  regenerate(convId: string): Promise<void>;
  /** 编辑并重发（API-12，后端原子截断） */
  editAndResend(convId: string, msgId: string, text: string): Promise<void>;
  /** 中止当前生成（N6：保留已生成部分并标记「已中止」） */
  abort(): void;
  /** 是否存在活跃流 */
  isStreaming(): boolean;
}

/** 本轮生成失败的错误态（N4）：挂在当轮 assistant 气泡尾部 */
export interface StreamError {
  code: string;
  message: string;
  retryable: boolean;
}

/**
 * 会话级错误槽（模块级，按 convId 索引）。
 *
 * 为什么不做成组件 state：错误必须与"流式累积态"同生命周期 ——
 * 关闭面板若导致错误丢失，重开后用户会以为上一轮成功了（静默失败）。
 * 放在模块级 Map 保证面板隐藏/重开期间错误依然可见。
 */
const errorsByConv = new Map<string, StreamError>();

/**
 * 消费 SSE 事件并更新 store。**事件分派规则见 `chatContract.ts` 的 `ChatEvent` 联合类型**。
 *
 * 实现要点（勿省）：
 * · `tool_start` / `tool_end` → `progress` 步骤（R11a 的"每一秒都有反馈"）
 * · `sources` → 挂到本轮 assistant 消息上（刷新后由后端落盘还原）
 * · `degraded` → 设置**可见**标记（N17，不得静默）
 * · `reasoning` → 只进内存态的 `reasoning` 字段（**不落盘**，D7）
 */
export function useChatStream(store: ChatStore): ChatStreamApi {
  /** 当前活跃流的 AbortController（单写者：同一时刻至多一个） */
  const ctrlRef = useRef<AbortController | null>(null);
  /** 已被主动 abort 的流 —— 用于区分"用户中止"与"网络中断"（N6 vs §5 流中断） */
  const abortedRef = useRef<Set<AbortController>>(new Set());

  /** 卸载或 AppShell 销毁时中止流（daemon 退出/页面关闭路径） */
  useEffect(() => {
    return () => {
      const ctrl = ctrlRef.current;
      if (ctrl) {
        abortedRef.current.add(ctrl);
        ctrl.abort();
        ctrlRef.current = null;
      }
    };
  }, []);

  /**
   * 消费一条事件流：事件 → store。
   *
   * ⚠️ **本函数不含 try/finally 之外的清理逻辑**：清理必须走 finally，
   * 否则"流中途抛错"会让 store 永久停在 `active: true`（UI 卡在"生成中"且无法再发送）。
   */
  const consume = useCallback(
    async (
      convId: string,
      ctrl: AbortController,
      makeStream: (signal: AbortSignal) => AsyncGenerator<ChatEvent>,
    ): Promise<void> => {
      let finishReason: string | undefined;
      let abortedEvent = false;

      errorsByConv.delete(convId);

      try {
        for await (const ev of makeStream(ctrl.signal)) {
          applyEvent(store, ev);

          if (ev.type === 'done') finishReason = ev.finishReason;
          if (ev.type === 'aborted') abortedEvent = true;

          // `done` / `aborted` / `error` 是终态事件：收到即结束本轮
          if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error') break;
        }
      } catch (err) {
        // §5 流中断：保留已渲染内容 + 标记「连接中断」+ 给重试入口（N4）
        if (!ctrl.signal.aborted) {
          errorsByConv.set(convId, {
            code: 'STREAM_INTERRUPTED',
            message: err instanceof Error ? err.message : '连接中断，请重试',
            retryable: true,
          });
        }
      } finally {
        // 无论成功/失败/中止，都必须收尾（否则 streaming.active 永久为 true）
        const userAborted = abortedRef.current.has(ctrl);
        abortedRef.current.delete(ctrl);
        if (ctrlRef.current === ctrl) ctrlRef.current = null;

        store.dispatch({ type: 'streamEnd' });
        void userAborted;
        void abortedEvent;
        void finishReason;
      }
    },
    [store],
  );

  /** 统一入口：先 abort 旧流（单写者），再起新流 */
  const run = useCallback(
    (convId: string, messageId: string, makeStream: (signal: AbortSignal) => AsyncGenerator<ChatEvent>) => {
      // 单写者：新流开始前必须中止旧流（切会话 / 重新生成 / 编辑重发均适用）
      store.dispatch({ type: 'streamStart', messageId });
      const prev = ctrlRef.current;
      if (prev) {
        abortedRef.current.add(prev);
        prev.abort();
      }
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      return consume(convId, ctrl, makeStream);
    },
    [consume, store],
  );

  const api = useMemo<ChatStreamApi>(() => {
    /** 本地临时 messageId：`meta` 到达前的占位（后端会在 meta 里给出真实 id） */
    const tempId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    return {
      async send(convId: string, text: string): Promise<void> {
        const placeholder = tempId();
        // 乐观显示 user 消息（不落盘乐观，只做 UI 立即反馈；失败的可重试入口在错误槽）
        const cur = store.getState();
        store.dispatch({
          type: 'setMessages',
          messages: [
            ...cur.messages,
            { id: `local-user-${placeholder}`, role: 'user', content: text, at: new Date().toISOString() },
          ],
        });
        await run(convId, placeholder, (signal) => streamMessage(convId, text, signal));
      },

      async regenerate(convId: string): Promise<void> {
        await run(convId, tempId(), (signal) => streamRegenerate(convId, signal));
      },

      async editAndResend(convId: string, msgId: string, text: string): Promise<void> {
        await run(convId, tempId(), (signal) => streamEditMessage(convId, msgId, text, signal));
      },

      abort(): void {
        const ctrl = ctrlRef.current;
        // 空值契约：无活跃流时静默无操作
        if (!ctrl) return;
        abortedRef.current.add(ctrl);
        ctrl.abort();
        ctrlRef.current = null;
      },

      isStreaming(): boolean {
        return store.getState().streaming.active;
      },
    };
  }, [run, store]);

  return api;
}

/**
 * 单个 SSE 事件 → store 动作。
 *
 * 拆成独立纯函数：事件分派表是本 hook 的核心知识，独立后可被直接阅读与（未来）单测，
 * 不必经过 React 渲染或网络环境。
 */
function applyEvent(store: ChatStore, ev: ChatEvent): void {
  switch (ev.type) {
    case 'meta':
      // `meta` 给出真实 messageId 与（API-12）被丢弃轮数；重置为后端 id
      store.dispatch({ type: 'streamStart', messageId: ev.messageId });
      return;

    case 'tool_start':
      store.dispatch({
        type: 'streamProgress',
        step: toolStartStep(ev.mode),
      });
      return;

    case 'tool_end':
      store.dispatch({
        type: 'streamProgress',
        step: toolEndStep(ev.hits, ev.error),
      });
      return;

    case 'sources':
      store.dispatch({ type: 'streamSources', sources: ev.sources });
      return;

    case 'degraded':
      store.dispatch({ type: 'streamDegraded', mark: degradedMark(ev.reason, ev.message) });
      return;

    case 'reasoning':
      // D7：只进内存态
      store.dispatch({ type: 'streamReasoning', text: ev.text });
      return;

    case 'content':
      store.dispatch({ type: 'streamContent', text: ev.text });
      return;

    case 'done':
      // `done.sources` 是落盘来源的权威副本（`sources` 事件可能因故未达）
      if (ev.sources && ev.sources.length > 0) {
        store.dispatch({ type: 'streamSources', sources: ev.sources });
      }
      return;

    // usage / aborted / error 不改变累积态：
    // · usage → 由 done 后重取会话详情获得（落盘字段）
    // · aborted → 已生成部分保留即可（N6），标记在收尾时统一处理
    // · error  → 走错误槽（见 consume 的 catch / API 层抛出）
    case 'usage':
    case 'aborted':
    case 'error':
      return;
  }
}

/** `tool_start` → 生成中状态文案（R11a：检索往返期间必须有可见进展） */
function toolStartStep(mode: string): ProgressStep {
  const label = mode === 'fulltext' ? '正在检索知识库…（全文）' : '正在检索知识库…（语义）';
  return { kind: 'tool', phase: 'start', label };
}

/** `tool_end` → 命中数或失败原因（必须成对，否则前端永久停留"正在检索…"） */
function toolEndStep(hits: number, error?: string): ProgressStep {
  const label = error ? `检索失败：${error}` : `已检索：命中 ${hits} 条`;
  return { kind: 'tool', phase: 'end', label };
}

/**
 * `degraded` 事件 → 可见标记（N17）。
 *
 * 文案优先取事件自带的 `message`（后端规范化文案），缺失时回退到本地 `DEGRADED_LABELS`——
 * 这样"标记必须可见"不依赖后端是否填了文案。
 */
function degradedMark(reason: DegradedMark['reason'], message: string): DegradedMark {
  return { reason, label: message || DEGRADED_LABELS[reason] };
}

/** 供视图层读取/清除本轮错误（N4 的重试入口与错误块） */
export function getStreamError(convId: string | null): StreamError | null {
  if (!convId) return null;
  return errorsByConv.get(convId) ?? null;
}

export function clearStreamError(convId: string | null): void {
  if (!convId) return;
  errorsByConv.delete(convId);
}
