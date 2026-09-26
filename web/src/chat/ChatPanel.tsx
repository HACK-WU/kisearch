/**
 * ChatPanel —— 右侧常驻对话面板（**视图**）
 *
 * ═══ ★ 两条硬约束（D15）═══
 * 1. **关闭 = 隐藏，不卸载、不中止生成**：本组件在 `open === false` 时返回 `null`
 *    （组件仍在树中，**未卸载**），且状态全在 `chatStore`（AppShell 级）→ 不丢内容
 * 2. **本组件不持有业务状态**：所有状态从 `store` 读；组件只是视图
 *
 * ⚠️ 因此本文件**不得**出现累积型 `useState`（如 `content` / `reasoning` / 工具步骤）。
 *    一旦把累积态放进组件，关闭面板即丢内容并可能连带 abort —— 正是 D15 要防的。
 *    下列 `useState` 只承载**纯瞬时的输入框文本**与**用户手动展开意图**，它们不随流式推进而累积。
 *
 * ═══ 布局契约（S03）═══
 * · 落位：`ki-shell`（flex 容器）的新 flex 子项，插在 `ki-main` **之后**
 * · 宽度：360~420px；窄屏降级为浮层抽屉（阈值待前置门② 的真实基线补测）
 * · `ki-main` 已是 `flex:1; min-width:0` → 不会破坏现有页面
 * · 全屏阅读器（`ki-drawer--fullscreen`）打开时**自动收起**本面板（避免空间与层级冲突）
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ackDisclosure,
  createConversation,
  getChatConfig,
  getConversation,
  listConversations,
} from '@/api/chatApi';
import type { ChatConfigOk, ChatMessage, ConversationSummary, SourceRef } from '@/api/chatContract';
import { useScopeValue } from '@/lib/scopeContext';
import { kiGetModuleInfo } from '@/api/mcpClient';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import type { ChatStore, DegradedMark, ProgressStep } from './chatStore';
import { SourcesList } from './SourcesList';
import { clearStreamError, getStreamError, useChatStream } from './useChatStream';
import { ConversationList } from './ConversationList';

export interface ChatPanelProps {
  store: ChatStore;
  /** 由 AppShell 控制（对应顶部开关按钮，D15） */
  open: boolean;
}

/**
 * 窄屏降级阈值（初值）。
 *
 * ⚠️ **待校准**：前置门②（真实页面布局基线 1280/1440/1600）未清，
 * 此处取保守初值 1400px —— **不得据此声称已达成 R3 的窄屏降级验收**。
 * 真实 `/browse` 基线测定后回填（见 `design/S03` §3.2 的算式）。
 */
const CHAT_DOCK_MIN_VIEWPORT = 1400;

const MAX_SEND_CHARS = 20000;

export function ChatPanel({ store, open }: ChatPanelProps): JSX.Element | null {
  const scope = useScopeValue();
  const stream = useChatStream(store);

  // ── 订阅常驻 store（订阅式而非快照：流式推进需要组件重渲染）──
  const state = useSyncExternalStoreCompat(store);

  const [config, setConfig] = useState<ChatConfigOk | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 用户手动展开过的「思考块」消息 id（不因新 chunk 强制收起，见 S05 §3.1） */
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, boolean>>({});
  /** 来源引用点击后打开的原文（R20） */
  const [viewing, setViewing] = useState<{
    module: string;
    group: string;
    /** 命中片段 → 复用 ModuleDrawer 既有的 `highlightQuery`（不新建高亮机制） */
    query: string;
  } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── 会话列表与当前会话（P0-3：历史会话管理）──
  const [convs, setConvs] = useState<ConversationSummary[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  const [convError, setConvError] = useState<string | null>(null);
  /** T12 确认请求进行中（防重复点击） */
  const [ackBusy, setAckBusy] = useState(false);
  /**
   * 发送 / 建会话的并发闸门。
   *
   * ★ 为什么需要 `sendLockRef`：`blocked` 是**渲染期快照**，而 `streaming.active` 要到
   *   `streamStart`（在 `await createNewConversation()` **之后**）才变 true ——
   *   中间这段"网络往返窗口"内连点两次发送，会各自建出一条会话（首屏无会话时尤其明显）。
   * ★ `creatingRef` 存**在途 promise**（而非布尔）：并发调用直接复用同一次创建，天然去重。
   */
  const sendLockRef = useRef(false);
  const creatingRef = useRef<Promise<string> | null>(null);

  /**
   * 切换会话：**必须先 abort 进行中的流**（设计：abort 时机 = 切会话 / 删会话 / daemon 退出）。
   */
  const openConversation = useCallback(
    async (id: string): Promise<void> => {
      const s = store.getState();
      if (s.activeConvId === id && s.messages.length > 0) return;
      stream.abort();
      store.dispatch({ type: 'setActiveConv', convId: id });
      const d = await getConversation(id);
      // 取数期间用户可能又切走了 → 只在仍是目标会话时落状态
      if (store.getState().activeConvId === id) {
        store.dispatch({ type: 'setMessages', messages: d.conv.messages });
      }
    },
    [store, stream],
  );

  /** 新建会话并切过去（首次发送时若当前无会话会调用）。**并发调用复用同一次创建**。 */
  const createNewConversation = useCallback((): Promise<string> => {
    if (creatingRef.current) return creatingRef.current;

    const pending = (async (): Promise<string> => {
      const r = await createConversation(scope, {});
      const id = r.conv.id;
      stream.abort();
      store.dispatch({ type: 'setActiveConv', convId: id });
      setConvs((prev) => [
        {
          id,
          scope,
          title: r.conv.title,
          archived: false,
          updatedAt: r.conv.updatedAt,
          messageCount: 0,
          lastMessagePreview: '',
          corrupted: false,
        },
        ...prev,
      ]);
      return id;
    })().finally(() => {
      creatingRef.current = null;
    });

    creatingRef.current = pending;
    return pending;
  }, [scope, store, stream]);

  /** 仅重取列表（发送完成后刷新标题/预览，不改变选中） */
  const refreshConversations = useCallback(async (): Promise<void> => {
    setConvLoading(true);
    try {
      const r = await listConversations(scope, { limit: 50 });
      setConvs(r.items);
      setConvError(null);
    } catch (err) {
      setConvError(err instanceof Error ? err.message : '会话列表读取失败');
    } finally {
      setConvLoading(false);
    }
  }, [scope]);

  /**
   * 生成结束后**以服务端落盘为准**重取当前会话。
   *
   * 作用有二：① 把乐观 user 消息的临时 id（`local-user-*`）换成服务端真实 id，
   * 否则后续「编辑重发 / 重新生成」无法定位该消息；② 中止场景对齐尾部若干 chunk。
   * 重取失败时**保留本地内容**（S03 §5：不因重取失败丢内容）。
   */
  const reloadActive = useCallback(
    async (convId: string): Promise<void> => {
      try {
        const d = await getConversation(convId);
        if (store.getState().activeConvId !== convId) return;
        store.dispatch({ type: 'setMessages', messages: d.conv.messages });
      } catch {
        /* 保留本地内容 */
      }
    },
    [store],
  );

  // ── 配置：面板可用性 / 模型名 / 是否需要隐私确认（T12）──
  useEffect(() => {
    let alive = true;
    getChatConfig()
      .then((cfg) => {
        if (alive) {
          setConfig(cfg);
          setConfigError(null);
        }
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setConfigError(err instanceof Error ? err.message : '配置读取失败');
      });
    return () => {
      alive = false;
    };
  }, []);

  // ── 首次进入 / 切 scope：拉会话列表并自动选中最近一条 ──
  //   ★ **不自动新建**：否则每次进页面都会产生一个空会话（列表很快被空会话淹没）。
  //     新建改为「首次发送时惰性创建」（见 handleSend），空会话不落盘。
  useEffect(() => {
    let alive = true;
    setConvLoading(true);
    void (async () => {
      try {
        const r = await listConversations(scope, { limit: 50 });
        if (!alive) return;
        setConvs(r.items);
        setConvError(null);
        const pick = r.items.find((c) => !c.corrupted);
        if (pick) await openConversation(pick.id);
      } catch (err) {
        if (alive) setConvError(err instanceof Error ? err.message : '会话列表读取失败');
      } finally {
        if (alive) setConvLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [scope, openConversation]);

  // ── 自动滚底（仅面板展开时）──
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [open, state.messages.length, state.streaming.content, state.streaming.progress.length]);

  // ── 发送可用性：enabled / 隐私确认 / 生成中 / 空白输入 ──
  const blocked = useMemo(() => {
    if (configError) return '服务未就绪';
    if (!config) return '正在读取配置…';
    if (!config.enabled) return '未配置模型';
    // T12：ackRequired 时**阻塞发送**并给出确认入口（不静默降级为"不检索"）
    if (config.ackRequired) return '需先确认内容外发';
    if (state.streaming.active) return '生成中…';
    if (!draft.trim()) return '请输入内容';
    return null;
  }, [config, configError, draft, state.streaming.active]);

  /** 切首页以外的窄屏 → 浮层态（阈值初值 1400，待基线校准） */
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < CHAT_DOCK_MIN_VIEWPORT);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * 全屏阅读器打开时自动收起面板（避免空间/层级冲突）。
   *
   * 这里只读取"是否存在 `.ki-drawer--fullscreen`"并隐藏 UI ——
   * **不触碰 ModuleDrawer 自身**（既有组件，改动会影响 5 个页面，属越界）。
   */
  const [fullscreenReader, setFullscreenReader] = useState(false);
  useEffect(() => {
    if (!open) return;
    const check = (): void => setFullscreenReader(Boolean(document.querySelector('.ki-drawer--fullscreen')));
    check();
    const timer = window.setInterval(check, 500);
    return () => window.clearInterval(timer);
  }, [open]);

  // ★ 硬约束：隐藏而非卸载（返回 null 不触发组件卸载，store 状态与进行中的流均保留）
  if (!open) return null;
  if (fullscreenReader) return null;

  /** 本轮生成失败的错误态（N4 / S03 §5「连接中断 + 重试入口」）：按 convId 索引的模块级错误槽 */
  const streamError = getStreamError(state.activeConvId);

  const handleSend = (): void => {
    const text = draft.trim();
    // `sendLockRef` 覆盖"await 期间连点"的窗口（`blocked` 只是渲染期快照）
    if (!text || blocked || sendLockRef.current) return;
    sendLockRef.current = true;
    setDraft(''); // 清空输入框（失败时可按错误块重试，见 N4）
    void (async () => {
      try {
        // ★ 惰性建会话：当前无会话时先建一条。
        //   原先直接用 `state.activeConvId ?? ''` → 打到 /conversations//messages（必然失败）。
        const convId = store.getState().activeConvId ?? (await createNewConversation());
        const persisted = await stream.send(convId, text);
        // ★ 只有收到 `done`（服务端确已落盘）才"以服务端为准"重取：
        //   error / aborted / 中断路径下服务端可能没有新内容 → 重取会把刚渲染的回答**覆盖成旧的**
        //   （用户看到回答凭空消失且无提示）。失败路径改由错误槽 + 重试入口承担。
        if (persisted) await reloadActive(convId);
        void refreshConversations();
      } catch (err) {
        setConvError(err instanceof Error ? err.message : '发送失败');
      } finally {
        sendLockRef.current = false;
      }
    })();
  };

  /** 停止生成：本地保留已生成部分并标记「已中止」（服务端对齐由下次重取完成） */
  const handleStop = (): void => {
    stream.abort();
  };

  /**
   * 重试本轮生成（N4）。
   *
   * 用 `regenerate` 而非重发文本：用户消息在**上游调用前**就已落盘（route 的锁内前置写），
   * 故重新生成 = 对最后一条 user 重新作答，不会重复插入 user 消息。
   */
  const handleRetry = (): void => {
    const convId = store.getState().activeConvId;
    if (!convId) return;
    clearStreamError(convId);
    void (async () => {
      try {
        const persisted = await stream.regenerate(convId);
        if (persisted) await reloadActive(convId);
      } catch (err) {
        setConvError(err instanceof Error ? err.message : '重试失败');
      }
    })();
  };

  const handleSelectConversation = (id: string): void => {
    void openConversation(id).catch((err: unknown) => {
      setConvError(err instanceof Error ? err.message : '切换会话失败');
    });
  };

  const handleCreateConversation = (): void => {
    void createNewConversation().catch((err: unknown) => {
      setConvError(err instanceof Error ? err.message : '新建会话失败');
    });
  };

  /**
   * T12 隐私确认：调用 API-13 落盘 `llm.kbDisclosureAck: true` → 刷新配置解除阻塞。
   * 契约：该接口幂等；错误码透传（`ChatApiError.code`），失败时保留阻塞并提示。
   */
  const handleAck = (): void => {
    if (ackBusy) return;
    setAckBusy(true);
    void (async () => {
      try {
        await ackDisclosure();
        const cfg = await getChatConfig();
        setConfig(cfg);
        setConfigError(null);
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : '确认失败，请重试');
      } finally {
        setAckBusy(false);
      }
    })();
  };

  const handleOpenSource = (ref: SourceRef): void => {
    // 复用既有 ModuleDrawer 的高亮定位能力（R20 要求"不新建高亮机制"）：
    // 把引用摘要作为 `highlightQuery` 传入 → 打开原文即定位/高亮命中片段。
    setViewing({ module: ref.doc, group: ref.group, query: ref.snippet });
  };

  return (
    <>
      <aside
        className={`ki-chat-panel${narrow ? ' ki-chat-panel--overlay' : ''}`}
        aria-label="AI 对话面板"
        data-narrow={narrow ? 'true' : 'false'}
      >
        <header className="ki-chat-panel__head">
          <span>AI 对话</span>
          {config?.model ? <span className="ki-chat-panel__model">{config.model}</span> : null}
        </header>

        {/* 会话管理：列表（最近）+ 新建 + 刷新（P0-3：历史会话管理） */}
        <ConversationList
          items={convs}
          activeId={state.activeConvId}
          loading={convLoading}
          error={convError}
          onSelect={handleSelectConversation}
          onCreate={handleCreateConversation}
          onRefresh={() => void refreshConversations()}
        />

        {/* 未配置模型 → fail-loud（R12/N3：不静默失败、不伪装成"模型没答"） */}
        {config && !config.enabled ? (
          <div className="ki-chat-panel__banner" role="status">
            未配置模型
            <span className="ki-chat-panel__path">{config.configPath}</span>
            {config.reason ? <span className="ki-chat-panel__reason">{config.reason}</span> : null}
          </div>
        ) : null}

        {configError ? (
          <div className="ki-chat-panel__banner ki-chat-panel__banner--err" role="alert">
            服务未就绪：{configError}
          </div>
        ) : null}

        <div className="ki-chat-panel__body" ref={listRef}>
          {state.messages.length === 0 && !state.streaming.active ? (
            <p className="ki-chat-panel__empty">在任意页面提问，回答会附带知识库来源。</p>
          ) : null}

          {state.messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              // N17：降级标记随消息留存（不进冻结的 ChatMessage，见 chatStore.degradedByMessage）
              degraded={state.degradedByMessage[m.id] ?? null}
              onOpenSource={handleOpenSource}
              reasoning={
                m.id === state.streaming.messageId ? state.streaming.reasoning : undefined
              }
              reasoningOpen={Boolean(reasoningExpanded[m.id])}
              onToggleReasoning={(next) =>
                setReasoningExpanded((prev) => ({ ...prev, [m.id]: next }))
              }
            />
          ))}

          {/* 生成中：降级标记（N17 必须可见）+ 工具步骤/思考/作答（R11a 每一秒都有反馈） */}
          {state.streaming.active ? (
            <StreamingBubble
              content={state.streaming.content}
              reasoning={state.streaming.reasoning}
              progress={state.streaming.progress}
              degradedLabel={state.streaming.degraded?.label ?? null}
            />
          ) : null}
        </div>

        <footer className="ki-chat-panel__foot">
          {/* 本轮生成失败（N4 / S03 §5）：保留已生成内容并给出重试入口，不静默 */}
          {streamError ? (
            <div className="ki-chat-panel__notice ki-chat-panel__notice--err" role="alert">
              <span>{streamError.message}</span>
              {streamError.retryable ? (
                <button type="button" className="ki-chat-panel__ack" onClick={handleRetry}>
                  重试
                </button>
              ) : null}
            </div>
          ) : null}

          {/* `done.warning` 落地（S03 §5：会话过长 / 检索轮次耗尽 —— 原先前端零消费） */}
          {state.notice ? (
            <div className="ki-chat-panel__notice ki-chat-panel__notice--info" role="status">
              {state.notice}
            </div>
          ) : null}

          {/* T12：既阻塞也**给出解除入口** —— 只阻塞不给出口会让面板在 ackRequired 下永久不可用 */}
          {config?.ackRequired ? (
            <div className="ki-chat-panel__notice" role="alert">
              <span>提问内容与检索到的知识库片段将发送至外部模型服务，确认后方可发送。</span>
              <button
                type="button"
                className="ki-chat-panel__ack"
                onClick={handleAck}
                disabled={ackBusy}
              >
                {ackBusy ? '确认中…' : '我已知悉，同意'}
              </button>
            </div>
          ) : null}

          <textarea
            className="ki-chat-panel__input"
            value={draft}
            maxLength={MAX_SEND_CHARS}
            placeholder={blocked ?? '输入问题，Enter 发送（Shift+Enter 换行）'}
            disabled={Boolean(config && !config.enabled)}
            /* ⚠️ 不标记 data-ki-search-input：否则 AppShell 的 Ctrl+F 会聚焦到这里而非页面搜索框 */
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
          />

          {state.streaming.active ? (
            <button type="button" className="ki-chat-panel__btn" onClick={handleStop}>
              停止
            </button>
          ) : (
            <button
              type="button"
              className="ki-chat-panel__btn"
              onClick={handleSend}
              disabled={Boolean(blocked)}
            >
              发送
            </button>
          )}

          {blocked ? <span className="ki-chat-panel__hint">{blocked}</span> : null}
        </footer>
      </aside>

      {/* 来源引用点击 → 打开原文并高亮（复用既有 ModuleDrawer） */}
      {viewing ? (
        <ModuleDrawer
          // key 含 query：同一文档的不同引用片段能重新挂载 → 重新定位/高亮
          key={`${scope}:${viewing.group}:${viewing.module}:${viewing.query}`}
          scope={scope}
          module={viewing.module}
          group={viewing.group}
          highlightQuery={viewing.query}
          onClose={() => setViewing(null)}
          fetcher={kiGetModuleInfo}
        />
      ) : null}
    </>
  );
}

/** 单条已落盘消息（user / assistant 分支） */
function MessageBubble({
  message,
  degraded,
  reasoning,
  reasoningOpen,
  onToggleReasoning,
  onOpenSource,
}: {
  message: ChatMessage;
  /** N17：本条的降级标记（来自 store.degradedByMessage；生成结束后仍保留，回看历史可见） */
  degraded?: DegradedMark | null;
  reasoning?: string;
  reasoningOpen: boolean;
  onToggleReasoning: (next: boolean) => void;
  onOpenSource: (ref: SourceRef) => void;
}): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`ki-chat-msg ki-chat-msg--${message.role}`}>
      {/* N17：降级标记必须可见，不得静默（气泡顶部，与生成中的 StreamingBubble 位置一致） */}
      {!isUser && degraded ? (
        <div className="ki-chat-msg__degraded" role="status">
          {degraded.label}
        </div>
      ) : null}

      {!isUser && reasoning ? (
        <ReasoningBlock text={reasoning} streaming={false} open={reasoningOpen} onToggle={onToggleReasoning} />
      ) : null}

      <div className="ki-chat-msg__body">
        {isUser ? (
          // 用户输入是纯文本：不渲染 Markdown（避免把用户输入的 markdown 当富文本执行）
          <p className="ki-chat-msg__text">{message.content}</p>
        ) : (
          <MarkdownPreview text={message.content} />
        )}
      </div>

      {message.aborted ? <span className="ki-chat-msg__aborted">已中止</span> : null}

      {/* 来源引用（R20）：空数组时 SourcesList 自身渲染 null */}
      {!isUser ? <SourcesList sources={message.sources ?? []} onOpen={onOpenSource} /> : null}
    </div>
  );
}

/**
 * `ProgressStep` → 单行用户可见文案（R11a 的"当前在做什么"）。
 *
 * 三分支联合不能直接取 `.label` —— tool 分支带 label，另两支按 kind 给固定文案。
 */
function progressStepLabel(step: ProgressStep): string {
  switch (step.kind) {
    case 'tool':
      return step.label;
    case 'reasoning':
      return '思考中…';
    case 'answering':
      return '正在作答…';
  }
}

/** 生成中的临时气泡（内容全部来自 store.streaming，**不落盘**） */
function StreamingBubble({
  content,
  reasoning,
  progress,
  degradedLabel,
}: {
  content: string;
  reasoning: string;
  progress: ProgressStep[];
  degradedLabel: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  // `ProgressStep` 是三分支联合：只有 tool 分支带 label，其余按 kind 给固定文案
  const last = progress.length > 0 ? progressStepLabel(progress[progress.length - 1]!) : null;

  return (
    <div className="ki-chat-msg ki-chat-msg--assistant ki-chat-msg--streaming">
      {/* N17：降级标记必须可见，不得静默 */}
      {degradedLabel ? (
        <div className="ki-chat-msg__degraded" role="status">
          {degradedLabel}
        </div>
      ) : null}

      {reasoning ? (
        <ReasoningBlock text={reasoning} streaming open={open} onToggle={setOpen} />
      ) : null}

      {/* R11a：没有 content 时也必须显示进展（工具步骤 / 思考中），不得出现无反馈空白 */}
      {!content && last ? (
        <p className="ki-chat-msg__progress" role="status">
          {last}
        </p>
      ) : null}
      {!content && !last && reasoning === '' ? (
        <p className="ki-chat-msg__progress" role="status">
          正在思考…
        </p>
      ) : null}

      {content ? (
        <div className="ki-chat-msg__body">
          <MarkdownPreview text={content} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * 思考块（S05）—— `<details>` 折叠，默认收起，正文纯文本等宽（不做 Markdown 渲染）。
 *
 * 展开状态由父层持有（`onToggle`），因此流式推进时**不会强制收起**用户已展开的块。
 */
function ReasoningBlock({
  text,
  streaming,
  open,
  onToggle,
}: {
  text: string;
  streaming: boolean;
  open: boolean;
  onToggle: (next: boolean) => void;
}): JSX.Element {
  const TRUNCATE_AT = 20000;
  const truncated = text.length > TRUNCATE_AT;
  const shown = truncated ? text.slice(0, TRUNCATE_AT) : text;
  // 字数用 Array.from 计，避免 emoji/代理对按 UTF-16 单元重复计数
  const chars = Array.from(text).length;

  return (
    <details
      className="ki-reason"
      open={open}
      onToggle={(e) => {
        // 只在用户主动交互时上报（合成 toggle 事件不改变用户意图）
        if (e.currentTarget.open !== open) onToggle(e.currentTarget.open);
      }}
    >
      <summary title="思考内容仅本次会话可见，留存于页面内存，不写入记录">
        {streaming ? '思考中' : '思考过程'} · {chars} 字
      </summary>
      <div className="ki-reason__body">
        {shown}
        {truncated ? <p className="ki-reason__truncated">思考内容过长，已截断显示</p> : null}
      </div>
    </details>
  );
}

/**
 * `useSyncExternalStore` 的本地封装。
 *
 * 为什么不用 `store.getState()` 直接读：它是**快照**，流式推进时组件不会重渲染，
 * 面板会一直停在发送那一刻的内容（R11a 直接失效）。
 * 这里只订阅、不引入外部状态库（避免为单个 store 增加依赖）。
 */
function useSyncExternalStoreCompat(store: ChatStore) {
  const [, force] = useState(0);
  useEffect(() => store.subscribe(() => force((n) => n + 1)), [store]);
  return store.getState();
}
