/**
 * chatStore.ts —— **AppShell 级常驻状态**（D15 硬约束的落点）
 *
 * ═══ ★ 为什么必须在 AppShell 级 ═══
 * D15：关闭面板 = **隐藏，不卸载、不中止生成**。
 * 若流式累积态（content / reasoning / 工具步骤）与"当前会话"存在 **面板组件内部**，
 * 关闭面板 → 组件卸载 → 状态丢失 + 可能连带 abort —— 正是 D15 要防的。
 *
 * 因此：**store 实例在 `AppShell` 创建（常驻），面板组件只是视图**。
 *
 * ═══ 通用语义契约 ═══
 * · 生命周期：随 AppShell 挂载创建，随其卸载销毁（本应用 AppShell 是唯一 layout → 事实上全程存活）
 * · 空值：无活动会话 → `activeConvId: null` + `messages: []`
 * · 并发：同一会话的流式状态**单写者**（由 `useChatStream` 保证同一时刻只有一个活跃流）
 * · abort 时机：仅「切会话 / 删会话 / daemon 退出」中止；**关闭面板不中止**
 * · 副作用：不落盘（落盘归后端）；纯内存态
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md §9.3 · S05 §9.2
 */

import type { ChatMessage, ChatRef, ChatToolResponse, ContextCharsParts, ConversationCompaction, SourceRef } from '@/api/chatContract';

/** 生成期间的动态反馈条目（按时间序，供 R11a 展示） */
export type ProgressStep =
  /**
   * 工具步骤。走查 #4：除 label 外透传事件摘要字段（name/mode/query/args/hits/durationMs/error），
   * 供时间线行做「动作名 + 工具胶囊 + 状态」双轨展示与展开卡片；
   * 实际返回正文由后端统一限制为最多 10000 字符，生成与历史共用。
   */
  | { kind: 'tool'; phase: 'start' | 'end'; label: string; name?: string; query?: string; mode?: string; args?: string; hits?: number; durationMs?: number; error?: string; response?: ChatToolResponse;
      /** interleave 锚点：本步发生时已发出的正文字符数（reducer 统一捕获，渲染方不必传） */
      afterChars?: number; order?: number }
  /**
   * skill 加载步骤（2026-10-13）。**单事件 = 单步**（无 start/end 配对）——
   * 与工具行的区别只在 kind：渲染层据此换样式（配色 / 措辞 / 展开卡片），不共享"检索中…"文案。
   */
  | { kind: 'skill'; phase: 'end'; label: string; name: string; skillId: string; skillDescription?: string; chars?: number; alreadyLoaded?: boolean; error?: string; afterChars?: number; order?: number }
  | { kind: 'reasoning'; text: string }
  | { kind: 'answering' };

export interface ReasoningSegment { afterChars: number; text: string; closed: boolean; order?: number }

/** 降级标记（**必须可见，不得静默** —— N17） */
export interface DegradedMark {
  reason: 'tools-unsupported' | 'retrieval-unavailable' | 'semantic-degraded';
  label: string;
}

/** 流式累积态（生成期间实时变化） */
export interface StreamingState {
  /** 是否正在生成 */
  active: boolean;
  failed?: boolean;
  /**
   * 本轮流序号（由 `useChatStream` 的令牌注入，`streamStart` 时写入）。
   *
   * ★ 用途：让 `streamEnd` 具备"**只有当前流能收尾**"的守门能力。
   *   被取代的旧流其 `finally` 中的 `streamEnd{seq: 旧值}` 会被 reducer 直接忽略，
   *   不会把新流的累积态重置为初始态（竞态见 `useChatStream` 的 seqRef 注释）。
   *   `undefined` = 不带令牌（向后兼容：纯 reducer 单测可不传）。
   */
  seq: number | undefined;
  /** 本次 assistant 消息 id（`meta` 事件给出） */
  messageId: string | null;
  /** Existing answer hidden while regenerating; retained if no replacement content arrives. */
  replacingId?: string;
  /**
   * 本轮开始时间（ISO）。流式气泡在消息列表里以**虚拟消息**渲染（与完成态同一组件），
   * 时间戳用它 → 收尾后由 finalizeStream 的落盘时间接管，同一分钟内显示不变。
   */
  startedAt: string;
  content: string;
  /** 思考内容 —— **仅内存，不落盘**（D7）；刷新/切会话即失 */
  reasoning: string;
  /**
   * 思考分段（interleave 锚点，2026-09-30 用户裁决：思考过程也要"在哪想的就在哪显示"）。
   *
   * 切段规则：连续 reasoning 增量并入同段；一旦正文输出或工具调用发生 → 封段，
   * 之后的思考是新一段（afterChars = 封段前已发出的正文长度）。
   * 与 `reasoning` 并存：`reasoning` 保持全量串（"正在思考"判据等既有语义不变）。
   */
  reasoningSegs: ReasoningSegment[];
  /** 工具步骤 + 生成中状态（R11a：每一秒都要有可见反馈） */
  progress: ProgressStep[];
  /** 降级标记 */
  degraded: DegradedMark | null;
  /**
   * 本轮是否被**中止**。
   *
   * 为什么必须有：`finalizeStream` 要把该标记写进并入 `messages` 的那条消息
   * （`ChatMessage.aborted`）——否则「用户主动停止」与「正常完成」在 UI 上外观完全相同
   * （「已中止」徽标永不显示，N6 失效）。
   *
   * 置位来源：`aborted` 事件（正常路径）/ 用户 abort 但事件未达（网络中断兜底）。
   */
  aborted: boolean;
  /**
   * 本轮来源引用缓冲（内部字段，**不扩大冻结的 `ChatAction` 形状**）。
   *
   * 为什么必须有：`sources` 事件到达时 assistant 消息**尚未写进 `messages`**
   * （消息在 `streamEnd` 才并入），此时"挂到消息上"无处可挂。
   * 因此先缓冲在 streaming 里，`streamEnd` 时一次性并入消息 —— 否则来源引用会静默丢失。
   */
  sources: SourceRef[];
  /**
   * 本轮上下文用量基数（**字符口径**，REQ-20261013-001）。
   *
   * 来自 `context` 事件（每轮上游请求**之前**发出，可多次 → 取最后一次）。
   * 展示值 = 本基数 + `content.length`（正在生成的正文会成为下一轮历史）——
   * 因此流式期间数字会**逐字上涨**，这正是"实时"的落地方式。
   * 收尾后清空，改由落盘消息的 `contextChars` 承担（刷新/回看同一口径）。
   */
  context: { chars: number; parts: ContextCharsParts } | null;
}

export interface ChatUiState {
  /** 面板是否展开（D15：false 仅代表隐藏，不代表卸载） */
  open: boolean;
  activeConvId: string | null;
  /** 已落盘的消息（当前会话） */
  messages: ChatMessage[];
  /**
   * 输入框里待发送的**用户手动引用**（REQ-20261009-002 需求 B，会话级）。
   *
   * · 生命周期：当前会话内持续有效；切会话（`setActiveConv`）时清空；
   *   切 scope 由 ChatPanel 的 scope effect 清空（与 `draft` 同处处理）
   * · 为什么放 store 而非组件 state：dock 与 /chat page 是**两个同时挂载的实例**，
   *   组件 state 不共享 —— 会出现"面板里加了、独立页看不见"
   */
  pendingRefs: ChatRef[];
  /** 生成中累积态 */
  streaming: StreamingState;
  /**
   * **已完成消息的降级标记**（键 = `messageId`）。
   *
   * 为什么不挂在 `ChatMessage` 上：`ChatMessage` 形状在 `chatContract.ts` 里**冻结**
   * （前端副本与后端 SSOT 由 `contract-parity` 机械比对），无 `degraded` 字段。
   * 而 N17 要求标记"必须可见、不得静默"——若只存在 `streaming.degraded`，
   * 生成结束（`streamEnd` 清空累积态）后标记即消失，回看历史时用户会把
   * 「没检索」当成「检索了但没找到」。
   *
   * 因此放在会话级 UI 态里：**不扩冻结契约**，但生成结束后标记仍可见。
   * （刷新后由后端落盘内容还原——契约无该字段，故刷新后不保留，属已知边界。）
   */
  degradedByMessage: Record<string, DegradedMark>;
  /**
   * 每条 assistant 消息的**工具步骤**（键 = messageId）。
   *
   * 生成结束后 MCP 调用痕迹必须留存（用户可回看"检索了几次 / 有没有真调工具"）。
   * 2026-09-30 二次修正：撤销的只是「跳到底部」的呈现 —— 现在渲染在**消息顶部原位**
   * （与流式气泡同一位置），收尾不跳位、不消失。
   *
   * 为什么不进 `ChatMessage`：契约冻结（骨架期一字不改），与 `degradedByMessage` 同款
   * **旁挂 map** 方案。**仅内存**；刷新/切会话后由落盘的 `message.progress` 还原。
   */
  progressByMessage: Record<string, ProgressStep[]>;
  /**
   * **已完成消息的思考分段**（键 = `messageId`，值 = 收尾时的 `streaming.reasoningSegs`）。
   *
   * 为什么必须有：统一渲染路径后（2026-09-30 用户裁决："生成中看到的东西完成后一点都不能变"），
   * 思考块在收尾时不得消失。与 `progressByMessage` 同款**仅内存**留存——
   * 思考内容本就不落盘（D7），刷新/切会话后回看只剩工具行，口径不变。
   */
  reasoningSegsByMessage: Record<string, StreamingState['reasoningSegs']>;
  /**
   * 一次性提示文案（当前为 `done.warning` 的落地，如「会话过长，建议新建会话」）。
   *
   * 为什么要有：`done.warning`（`tool-rounds-exhausted` / `conversation-too-long`）是
   * 唯一告知用户"本轮回答可能不完整"的通道；不消费它 = 前端零反馈（S03 §5 要求提示）。
   * 生命周期：`streamStart` / 切会话时清空（属"本轮"提示，不跨轮残留）。
   */
  notice: string | null;
  /**
   * 刚从流式收尾并入 messages 的那条消息 id（`streamEnd` 写入，`streamStart`/切会话清空）。
   *
   * 为什么要有：收尾瞬间 StreamingBubble 卸载、MessageItem 以**另一棵组件树**重挂载同一内容，
   * 而 `.ki-chat-msg` 的 `ki-msg-in` 入场动画会随挂载重播 → 用户看到回答完成后"闪一下"。
   * 该 id 命中的消息跳过入场动画（内容无缝接续）；历史回看新插入的消息不受影响、照常播放。
   */
  lastStreamedId: string | null;
  /**
   * 当前会话的手动压缩记录（REQ-20261013-001 R8）。
   *
   * 为什么放 store 而不是组件 state：dock 与 `/chat` page 是**两个同时挂载的实例**，
   * 组件 state 不共享 —— 在抽屉里压缩完，独立页会仍显示"未压缩"。
   * 数据源始终是服务端会话文件（`conversation.compaction`），本字段只是缓存。
   */
  compaction: ConversationCompaction | null;
}

/**
 * 初始值（面板默认**关闭**：用户定案「由用户点击『AI 对话』打开」）。
 *
 * REQ-20261009-002：`open` 此前是无任何消费者的死状态（AppShell 另有一份 useState），
 * 现收敛到 store —— 全屏阅读器内的开关（`ChatToggleButton`）与顶栏开关分别位于两个
 * 组件树分支、props 够不着，必须共享同一份开合态。`reset` 保留用户当前选择。
 */
export const INITIAL_CHAT_STATE: ChatUiState = {
  open: false,
  activeConvId: null,
  messages: [],
  streaming: {
    active: false,
    seq: undefined,
    messageId: null,
    startedAt: '',
    content: '',
    reasoning: '',
    reasoningSegs: [],
    progress: [],
    degraded: null,
    aborted: false,
    sources: [],
    context: null,
  },
  degradedByMessage: {},
  progressByMessage: {},
  reasoningSegsByMessage: {},
  notice: null,
  lastStreamedId: null,
  pendingRefs: [],
  compaction: null,
};

/** 动作（视图层只通过这些动作改状态） */
export type ChatAction =
  | { type: 'setOpen'; open: boolean }
  | { type: 'setActiveConv'; convId: string | null }
  | { type: 'setMessages'; messages: ChatMessage[] }
  /** 整体替换待发送引用（加入 / 删除 / 清空共用：UI 侧算好新数组，reducer 保持纯净） */
  | { type: 'setRefs'; refs: ChatRef[] }
  /** 会话压缩记录（服务端 `conversation.compaction` 的缓存；`null` = 未压缩 / 已撤销） */
  | { type: 'setCompaction'; compaction: ConversationCompaction | null }
  /** `seq`：本轮流序号（可选，见 `StreamingState.seq`）；`at`：本轮开始时间（调用方注入，reducer 保持纯净） */
  | { type: 'streamStart'; messageId: string; seq?: number; at?: string; replacingId?: string }
  | { type: 'streamContent'; text: string }
  | { type: 'streamReasoning'; text: string }
  | { type: 'streamProgress'; step: ProgressStep }
  | { type: 'streamDegraded'; mark: DegradedMark }
  | { type: 'streamSources'; sources: SourceRef[] }
  /** 上下文用量（字符口径；每轮可多次 → 后到者覆盖先到者，取最新基数） */
  | { type: 'streamContext'; chars: number; parts: ContextCharsParts }
  /** 本轮被中止（收到 `aborted` 事件，或用户 abort 而事件未达）→ 收尾时写进消息标记（N6） */
  | { type: 'streamAborted' }
  | { type: 'streamFailed' }
  /**
   * 校正本轮 assistant 消息 id（`done` / `aborted` 事件携带**服务端落盘后的真实 id**）。
   * `meta` 给的是预估值，与落盘后的 `m{seq}` 可能不同 → 不校正会造成本地/磁盘 id 错位。
   */
  | { type: 'streamMessageId'; messageId: string }
  /** `seq`：仅当与 `StreamingState.seq` 一致时才收尾（可选，向后兼容纯 reducer 单测） */
  | { type: 'streamEnd'; seq?: number }
  /** 一次性提示（`done.warning` 落地）；`null` = 清除 */
  | { type: 'notice'; text: string | null }
  | { type: 'reset' };

/**
 * 纯函数 reducer（**无副作用**，便于测试与并发推理）。
 *
 * 关键约定：
 * · `streamEnd` 后 `content`/`reasoning`/`progress`/`aborted` 清空（已并入 `messages`）
 * · `setActiveConv` 视为"切会话" → **调用方负责 abort 进行中的流**（reducer 不做副作用），
 *   并清空该会话的降级标记表
 * · **"谁能收尾"由调用方把关**：被取代的旧流不得再 dispatch `streamEnd`
 *   （见 `useChatStream` 的流序号令牌）—— 否则它会把新流的累积态重置为初始态
 */
export function chatReducer(state: ChatUiState, action: ChatAction): ChatUiState {
  switch (action.type) {
    case 'setOpen':
      return { ...state, open: action.open };
    case 'setActiveConv':
      return {
        ...state,
        activeConvId: action.convId,
        messages: [],
        streaming: INITIAL_CHAT_STATE.streaming,
        degradedByMessage: {},
        progressByMessage: {},
        reasoningSegsByMessage: {},
        notice: null,
        lastStreamedId: null,
        compaction: null,
        // ⚠️ 引用**不在此处清空**：`setActiveConv` 同样被「首次发送时惰性建会话」调用，
        //    在这里清会让"刚加入引用就发送"的第一条消息把引用标签清掉（实测缺陷）。
        //    清空职责改由**用户主动切会话**的路径（`ChatPanel.openConversation`）与切 scope 承担。
      };
    case 'setRefs':
      return { ...state, pendingRefs: action.refs };
    case 'setCompaction':
      return { ...state, compaction: action.compaction };
    case 'reset':
      return { ...INITIAL_CHAT_STATE, open: state.open };

    // ▼ 消息本体：整体替换当前会话的已落盘消息（无活动的 assistant 占位）
    case 'setMessages':
      return { ...state, messages: action.messages };

    // ▼ 一次性提示（`done.warning`）：不改消息、不改累积态
    case 'notice':
      return { ...state, notice: action.text };

    // ▼ 流式动作：全部只改 streaming，不触碰 messages（消息在 streamEnd 时一次性并入）
    case 'streamStart': {
      // ★ 防「迟到且携带旧令牌的 streamStart」把守门复位：
      //   若允许更小的 seq 覆写 `streaming.seq`，被取代的旧流其 `streamEnd{seq: 旧值}`
      //   会**重新通过**守门 → 又回到"旧流重置新流累积态、新回答整段丢失"的原始缺陷。
      //   （唯一可能携带旧 seq 的来源是旧流迟到的 `meta` 事件。）
      //   `undefined`（未带令牌的纯 reducer 单测）不参与比较，保持向后兼容。
      if (
        action.seq !== undefined &&
        state.streaming.seq !== undefined &&
        action.seq < state.streaming.seq
      ) {
        return state;
      }
      // 新流开始：清空上一轮的累积态与一次性提示，避免交错（切会话 / 重新生成 / 编辑重发都走这里）
      return {
        ...state,
        notice: null,
        lastStreamedId: null,
        streaming: {
          active: true,
          seq: action.seq,
          messageId: action.messageId,
          replacingId: action.replacingId,
          // meta 事件会再次 streamStart 校正 id：已开始的轮保留原开始时间（时间戳不跳）
          startedAt: state.streaming.active && state.streaming.startedAt
            ? state.streaming.startedAt
            : (action.at ?? state.streaming.startedAt),
          content: '',
          reasoning: '',
          reasoningSegs: [],
          progress: [],
          degraded: null,
          aborted: false,
          sources: [],
          // 新一轮从头统计（`context` 事件到达后填入本轮基数）
          context: null,
        },
      };
    }

    case 'streamContent':
      // 增量追加（SSE 逐帧语义）；单写者由 useChatStream 保证
      // 正文开始输出 → 封当前思考段（之后的思考属于新位置，见 reasoningSegs）
      return {
        ...state,
        streaming: {
          ...state.streaming,
          content: state.streaming.content + action.text,
          reasoningSegs: closeLastReasoningSeg(state.streaming.reasoningSegs),
        },
      };

    case 'streamReasoning':
      // D7：只进内存态，不落盘、不写进 messages
      // 同时按锚点续段/起段：未封尾段 → 追加；否则以当前正文长度起新段（interleave 用）
      return {
        ...state,
        streaming: {
          ...state.streaming,
          reasoning: state.streaming.reasoning + action.text,
          reasoningSegs: appendReasoningSeg(state.streaming.reasoningSegs, action.text, state.streaming.content.length, state.streaming.progress.length + state.streaming.reasoningSegs.length),
        },
      };

    case 'streamProgress':
      // ★ tool / skill 步骤在此统一捕获 afterChars = 当前已渲染正文长度（"在哪句话之后调的"），
      //   渲染层据此把调用痕迹插回正文原位（interleave），而不是全部堆在消息顶部。
      //   落盘还原路径由服务端 progress.afterChars 提供，两路口径一致（同一事件流同一时刻）。
      //   ⚠️ 新增 kind 必须一并纳入下面的锚点补全，否则它会以 afterChars=0 排到正文最前面。
      return {
        ...state,
        streaming: {
          ...state.streaming,
          progress: [
            ...state.streaming.progress,
            action.step.kind === 'tool' || action.step.kind === 'skill'
              ? { ...action.step, afterChars: state.streaming.content.length, order: state.streaming.progress.length + state.streaming.reasoningSegs.length }
              : action.step,
          ],
          // 工具调用 / skill 加载发生 → 同样封当前思考段（其后的思考是新一段）
          reasoningSegs: closeLastReasoningSeg(state.streaming.reasoningSegs),
        },
      };

    case 'streamDegraded':
      // N17：标记必须可见，不得静默。degraded 三类互斥且至多一次（由后端保证），
      // 故后到者不覆盖先到者——保留最先触发的原因，避免把"没检索"显示成"检索降级"。
      return {
        ...state,
        streaming: { ...state.streaming, degraded: state.streaming.degraded ?? action.mark },
      };

    case 'streamSources':
      // ★ 缓冲到 streaming（不是直接挂 messages）：`sources` 事件到达时本轮 assistant
      //   消息尚未并入 `messages`，此时无处可挂 → 直接挂会静默丢失来源引用。
      //   若重生成场景下该消息已存在，则同步挂上，避免"已有气泡看不到来源"。
      return {
        ...state,
        streaming: { ...state.streaming, sources: action.sources },
        messages: attachSources(state.messages, state.streaming.messageId, action.sources),
      };

    case 'streamContext':
      // REQ-20261013-001：上下文用量基数（字符口径）。**后到者覆盖**——
      // 工具轮次后 messages 变大，最后一次才是"下一轮将发送"的真实规模。
      return {
        ...state,
        streaming: { ...state.streaming, context: { chars: action.chars, parts: action.parts } },
      };

    case 'streamFailed':
      return { ...state, streaming: { ...state.streaming, failed: true } };

    case 'streamAborted':
      // N6：把"本轮被中止"记进累积态 → 收尾时随消息一起落进 `ChatMessage.aborted`
      //     （原先该字段恒为 false，「已中止」徽标永不显示）
      return {
        ...state,
        streaming: { ...state.streaming, aborted: true },
      };

    case 'streamMessageId':
      // 用服务端真实 id 覆盖 `meta` 的预估值；**只改 id，不动内容/累积态**
      // 同步预置免动画标记：id 校正使列表 key 变化、气泡重挂载一次，
      // 不带 instant 会重播入场动画（统一渲染路径下这是唯一的极端 remount 点）
      return {
        ...state,
        lastStreamedId: action.messageId,
        streaming: { ...state.streaming, messageId: action.messageId },
      };

    case 'streamEnd':
      // ★ 守门：带令牌时必须是"当前流"才能收尾。
      //   被取代的旧流（其 finally 迟于新流开始）在此被忽略 —— 否则它会把**新流**的
      //   streaming 重置为初始态（messageId=null），新流后续 content 收尾时整段丢弃。
      //   `action.seq === undefined` 表示不带令牌（纯 reducer 单测）→ 放行，保持向后兼容。
      if (action.seq !== undefined && action.seq !== state.streaming.seq) return state;
      // 收尾：把累积内容并入 messages，并清空流式态
      // （约定：content / reasoning / progress / aborted 清空）
      // · 无内容的流（如"中止且 content 为空"）不产生空气泡
      // · 已存在同 id 消息时做替换（重新生成的语义：替换而非追加重复）
      return {
        ...state,
        messages: finalizeStream(state.messages, state.streaming),
        // ★ 刚收尾的消息 id 记下来：ChatPanel 据此跳过入场动画（防"完成后闪一下"）；
        //   无内容时 finalizeStream 不产生消息 → 一并清空
        lastStreamedId: state.streaming.content && state.streaming.messageId
          ? state.streaming.messageId
          : null,
        // ★ N17：降级标记随消息**留存**（不进冻结的 ChatMessage，理由见 degradedByMessage 注释）。
        //   原先只落在 streaming.degraded，streamEnd 一清空 → 生成结束后回看历史看不到标记。
        degradedByMessage: retainDegraded(state.degradedByMessage, state.streaming),
        // ★ 同理留存工具步骤：生成结束后痕迹不消失（原位渲染在消息顶部，见 ChatPanel）
        progressByMessage: retainProgress(state.progressByMessage, state.streaming),
        // 统一渲染路径（2026-09-30）：思考分段同机制留存 → 收尾后思考块不消失
        reasoningSegsByMessage: retainReasoningSegs(state.reasoningSegsByMessage, state.streaming),
        streaming: INITIAL_CHAT_STATE.streaming,
      };
  }
}

/** 收尾时把本轮降级标记留存到 `degradedByMessage`（键 = messageId）；无标记/无 id/无内容时原样返回 */
function retainDegraded(
  prev: Record<string, DegradedMark>,
  streaming: StreamingState,
): Record<string, DegradedMark> {
  const { degraded, messageId, content } = streaming;
  // 无内容 → `finalizeStream` 不会产生消息，标记无处可挂
  if (!degraded || !messageId || !content) return prev;
  return { ...prev, [streaming.failed && !streaming.aborted ? `local-assistant-${messageId}-${streaming.seq ?? 0}` : messageId]: degraded };
}

/** reasoning 增量续段：尾段未封 → 追加；否则以当前正文长度为锚起新段 */
function appendReasoningSeg(
  segs: StreamingState['reasoningSegs'],
  text: string,
  afterChars: number,
  order: number,
): StreamingState['reasoningSegs'] {
  const last = segs[segs.length - 1];
  if (last && !last.closed) {
    return [...segs.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...segs, { afterChars, text, closed: false, order }];
}

/** 正文输出 / 工具调用发生时封住尾段（之后的 reasoning 属于新锚点） */
function closeLastReasoningSeg(
  segs: StreamingState['reasoningSegs'],
): StreamingState['reasoningSegs'] {
  const last = segs[segs.length - 1];
  if (!last || last.closed) return segs;
  return [...segs.slice(0, -1), { ...last, closed: true }];
}

/**
 * 收尾时把本轮工具步骤留存到 `progressByMessage`（键 = messageId）。
 *
 * 与 `retainDegraded` 同款判据：无内容 → `finalizeStream` 不产生消息，步骤无处可挂；
 * 无步骤 → 无需留存（省内存，也让"没有工具调用的普通问答"不产生空条目）。
 */
function retainProgress(
  prev: Record<string, ProgressStep[]>,
  streaming: StreamingState,
): Record<string, ProgressStep[]> {
  const { progress, messageId, content } = streaming;
  if (!progress.length || !messageId || !content) return prev;
  return { ...prev, [streaming.failed && !streaming.aborted ? `local-assistant-${messageId}-${streaming.seq ?? 0}` : messageId]: progress };
}

/**
 * 收尾时把本轮思考分段留存到 `reasoningSegsByMessage`（键 = messageId）。
 *
 * `closed` 统一置 true：生成已结束，思考块标签从"思考中"变"思考过程"是**语义修正**，
 * 不影响块的位置与高度（无视觉跳变）。判据与 retainProgress 同款（无内容不产生消息）。
 */
function retainReasoningSegs(
  prev: Record<string, StreamingState['reasoningSegs']>,
  streaming: StreamingState,
): Record<string, StreamingState['reasoningSegs']> {
  const { reasoningSegs, messageId, content } = streaming;
  if (!reasoningSegs.length || !messageId || !content) return prev;
  return {
    ...prev,
    [streaming.failed && !streaming.aborted ? `local-assistant-${messageId}-${streaming.seq ?? 0}` : messageId]: reasoningSegs.map((s) => ({ ...s, closed: true })),
  };
}

/** 把本轮来源引用挂到指定 messageId 上；id 为空或无匹配时不改消息（来源仍由 done 事件兜底） */
function attachSources(
  messages: ChatMessage[],
  messageId: string | null,
  sources: SourceRef[],
): ChatMessage[] {
  if (!messageId) return messages;
  return messages.map((m) => (m.id === messageId ? { ...m, sources } : m));
}

/**
 * 流结束时的合并：把 streaming 累积态并入 messages。
 *
 * 为什么放在 reducer 里而不是调用方：D15 下"关闭面板"不应影响内容归属，
 * 把合并做成纯函数可以让"先关面板再结束"与"一直开着"走完全相同的代码路径。
 */
function finalizeStream(messages: ChatMessage[], streaming: StreamingState): ChatMessage[] {
  const { messageId, content, sources, aborted, failed } = streaming;
  // 无内容 → 不新增消息（对齐 messages.md：中止且 content 为空时不落盘空气泡）
  if (!content) return messages;
  if (!messageId) return messages;

  // 来源引用随消息一起并入（★ 否则 sources 事件的内容会在收尾时丢失，R20 失效）
  const merged: SourceRef[] | undefined = sources.length > 0 ? sources : undefined;

  // Error content is useful evidence, but is not part of the persisted conversation memory.
  const localOnly = failed && !aborted;
  const finalId = localOnly ? `local-assistant-${messageId}-${streaming.seq ?? 0}` : messageId;
  const existing = localOnly ? -1 : messages.findIndex((m) => m.id === messageId || m.id === streaming.replacingId);
  if (existing >= 0) {
    // 重新生成：替换原 assistant 消息内容（来源与中止标记同步覆盖）
    const next = messages.slice();
    next[existing] = {
      id: messageId,
      role: 'assistant',
      content,
      at: streaming.startedAt ?? new Date().toISOString(),
      aborted,
      ...(merged ? { sources: merged } : {}),
    };
    return next;
  }

  return [
    ...messages,
    {
      id: finalId,
      role: 'assistant',
      content,
      at: new Date().toISOString(),
      // ★ N6：中止标记来自本轮 `aborted`（原先恒写 false → 「已中止」徽标永不显示）；
      //   "中止也要保留已生成部分"这条硬要求不变。
      aborted,
      ...(merged ? { sources: merged } : {}),
    },
  ];
}

/** store 句柄（在 AppShell 创建，通过 Context 下发给面板） */
export interface ChatStore {
  getState(): ChatUiState;
  dispatch(action: ChatAction): void;
  subscribe(listener: () => void): () => void;
}

/**
 * 创建常驻 store（★ 在 `AppShell` 内调用一次，**不要在 `ChatPanel` 内调用**）。
 *
 * 骨架期即为**完整实现**：它是纯内存订阅容器，不含业务逻辑，无实现价值空间。
 * 业务逻辑在 `chatReducer` 的数据动作与 `useChatStream` 中（那些才是抛错点）。
 */
export function createChatStore(initialOpen?: boolean): ChatStore {
  // 初始开合由调用方注入（AppShell 从**本标签页 URL** 的 `chat=1` 读，见 lib/chatOpenUrl）：
  // 缺省仍是「关闭」—— 首次使用不受影响；刷新按本标签页自己的地址恢复，且**不跨标签页共享**
  // （2026-10-14 用户裁决；此前用 localStorage，一个标签页关面板会连带关掉另一个标签页的）。
  // reducer 语义不变，只换初始值来源。
  let state = initialOpen === undefined
    ? INITIAL_CHAT_STATE
    : { ...INITIAL_CHAT_STATE, open: initialOpen };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch: (action: ChatAction) => {
      state = chatReducer(state, action);
      for (const l of listeners) l();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
