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
  /**
   * 发消息（API-08）。
   *
   * @returns 是否收到 `done`（= 服务端已落盘）。**调用方据此决定能否"以服务端为准"重取**：
   *          为 `false`（error / aborted / 中断）时服务端内容可能缺失，重取会覆盖掉本地已渲染内容。
   */
  send(convId: string, text: string): Promise<boolean>;
  /** 重新生成（API-11，不新增 user 消息）；返回语义同 `send` */
  regenerate(convId: string): Promise<boolean>;
  /** 编辑并重发（API-12，后端原子截断）；返回语义同 `send` */
  editAndResend(convId: string, msgId: string, text: string): Promise<boolean>;
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
  /**
   * ★ 流序号令牌 —— **"谁有权收尾"的唯一依据**。
   *
   * 为什么必须有：`abort()` 只让**旧流**的读取中断，而旧流 `consume` 的 `finally`
   * 是**后续微/宏任务**才执行的（`dispatch` 同步改变不了它的触发时机；若旧流正卡在
   * `runKbSearch` 这类不接收 signal 的等待里，还会被显著推迟）。旧流 finally 里的
   * `streamEnd` 会把**新流**的 `streaming` 重置为初始态（`messageId=null`），
   * 于是新流后续的 `content` 在收尾时被 `finalizeStream` 整段丢弃（实测：`messages: []`）。
   * 场景：检索进行中切会话 / 点重新生成。
   */
  const seqRef = useRef(0);

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
      mySeq: number,
    ): Promise<boolean> => {
      let finishReason: string | undefined;
      let abortedEvent = false;
      /**
       * 是否收到 `done`（= 服务端**已落盘**）。
       *
       * ★ 调用方据此决定"能否以服务端为准重取"：`error` / `aborted` / 中断路径下服务端
       *   可能没有（或只有部分）新内容，此时重取会把刚渲染出来的回答**覆盖成旧的** —— 
       *   用户会看到回答"凭空消失"且无任何提示。
       */
      let sawDone = false;

      errorsByConv.delete(convId);

      try {
        for await (const ev of makeStream(ctrl.signal)) {
          applyEvent(store, ev, mySeq);

          if (ev.type === 'done') {
            finishReason = ev.finishReason;
            sawDone = true;
          }
          if (ev.type === 'aborted') abortedEvent = true;
          // ★ 流内 `error` 事件必须落进错误槽（N4）。
          //   原先只被 `applyEvent` 当"无操作"丢弃 → `LLM_TIMEOUT` / `LLM_UPSTREAM_ERROR` /
          //   `CHAT_WRITE_FAILED` 等失败对用户**完全不可见**（错误槽只在 JS 异常路径被写）。
          if (ev.type === 'error') {
            errorsByConv.set(convId, {
              code: ev.code,
              message: ev.error,
              retryable: ev.retryable !== false,
            });
          }

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

        // ★ 只有"当前流"有权收尾（**双层判定**，缺一不可）：
        //   ① hook 令牌：被新流取代的旧流在此返回，否则它的 streamEnd 会把**新流**的
        //      streaming 重置为初始态（messageId=null），新流后续 content 收尾时被整段丢弃。
        //   ② store 令牌：切会话会把 streaming 重置为 `seq: undefined`，
        //      此时这条流的收尾动作（含下面的 aborted 标记）不得再落到新会话的状态上。
        const stillCurrent = seqRef.current === mySeq && store.getState().streaming.seq === mySeq;
        if (!stillCurrent) return false;

        // N6 兜底：用户主动中止但 `aborted` 事件未达（如中途网络中断）→ 在此补标记，
        //   保证「已中止」与「正常完成」在 UI 上可区分。
        if (userAborted && !abortedEvent) store.dispatch({ type: 'streamAborted' });

        // 带令牌收尾：reducer 会校验它仍是"当前流"（双保险，见 chatStore 的 streamEnd 守门）
        store.dispatch({ type: 'streamEnd', seq: mySeq });
        void finishReason;
      }

      return sawDone;
    },
    [store],
  );

  /** 统一入口：先 abort 旧流（单写者），再起新流 */
  const run = useCallback(
    (convId: string, messageId: string, makeStream: (signal: AbortSignal) => AsyncGenerator<ChatEvent>) => {
      // ★ 先取令牌：流内所有动作（`streamStart` 与最终 `streamEnd`）都要带上它，
      //   `streamEnd` 会据此校验"只有当前流能收尾"（见 seqRef 注释）
      const mySeq = ++seqRef.current;
      // 单写者：新流开始前必须中止旧流（切会话 / 重新生成 / 编辑重发均适用）
      store.dispatch({ type: 'streamStart', messageId, seq: mySeq });
      const prev = ctrlRef.current;
      if (prev) {
        abortedRef.current.add(prev);
        prev.abort();
      }
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      return consume(convId, ctrl, makeStream, mySeq);
    },
    [consume, store],
  );

  const api = useMemo<ChatStreamApi>(() => {
    /** 本地临时 messageId：`meta` 到达前的占位（后端会在 meta 里给出真实 id） */
    const tempId = () => `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

    return {
      async send(convId: string, text: string): Promise<boolean> {
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
        return run(convId, placeholder, (signal) => streamMessage(convId, text, signal));
      },

      async regenerate(convId: string): Promise<boolean> {
        return run(convId, tempId(), (signal) => streamRegenerate(convId, signal));
      },

      async editAndResend(convId: string, msgId: string, text: string): Promise<boolean> {
        return run(convId, tempId(), (signal) => streamEditMessage(convId, msgId, text, signal));
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
function applyEvent(store: ChatStore, ev: ChatEvent, mySeq: number): void {
  switch (ev.type) {
    case 'meta':
      // `meta` 给出真实 messageId 与（API-12）被丢弃轮数；重置为后端 id
      // ★ 必须带上令牌：否则 `streaming.seq` 会被清成 undefined，收尾守门随即失效
      store.dispatch({ type: 'streamStart', messageId: ev.messageId, seq: mySeq });
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
      // ★ 先用服务端落盘后的**真实 messageId** 校正本地 id：`meta` 给的是预估值
      //   （`conv.seq + messages.length + 1`），与落盘后的 `m{seq}` 可能不同。
      //   不校正会让本地消息 id 与磁盘不一致（重取/刷新后错位、来源引用挂不上去）。
      if (ev.messageId) store.dispatch({ type: 'streamMessageId', messageId: ev.messageId });
      // `done.sources` 是落盘来源的权威副本（`sources` 事件可能因故未达）
      if (ev.sources && ev.sources.length > 0) {
        store.dispatch({ type: 'streamSources', sources: ev.sources });
      }
      // `done.warning` 必须落地：它是"本轮回答可能不完整"的唯一通道（S03 §5）
      store.dispatch({ type: 'notice', text: warningNotice(ev.warning) });
      return;

    case 'aborted':
      // ★ N6：标记"本轮被中止" → 收尾时写进消息的 `aborted`，UI 显示「已中止」
      //   （原先该事件落进下面的无操作分支 → 标记永远不显示，中止与正常完成外观相同）
      store.dispatch({ type: 'streamAborted' });
      // 中止路径同样给出**服务端落盘后的真实 id**（有内容落盘时）；空串表示未落盘 → 跳过
      if (ev.messageId) store.dispatch({ type: 'streamMessageId', messageId: ev.messageId });
      return;

    // usage / error 不改变累积态：
    // · usage → 由 done 后重取会话详情获得（落盘字段）
    // · error  → 走错误槽（见 consume 的 catch / API 层抛出）
    case 'usage':
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

/**
 * `done.warning` → 用户可见提示（S03 §5：会话过长 → 输入区上方提示「建议新建会话」）。
 *
 * 为什么必须有：该字段是"本轮回答可能不完整"的**唯一通道** —— 后端已产出，
 * 前端不消费即等于零反馈（原实现即如此，warning 连路由层都没透传）。
 */
function warningNotice(
  warning: 'tool-rounds-exhausted' | 'conversation-too-long' | undefined,
): string | null {
  if (warning === 'tool-rounds-exhausted') {
    return '已达检索轮次上限，本轮回答可能未覆盖全部相关信息';
  }
  if (warning === 'conversation-too-long') return '会话过长，建议新建会话';
  return null;
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
