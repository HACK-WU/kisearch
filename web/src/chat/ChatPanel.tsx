/**
 * ChatPanel —— 右侧常驻对话面板（**视图**）
 *
 * ═══ ★ 两条硬约束（D15）═══
 * 1. **关闭 = 隐藏，不卸载、不中止生成**：本组件在 `open === false` 时返回 `null`
 *    （组件仍在树中，**未卸载**），且状态全在 `chatStore`（AppShell 级）→ 不丢内容
 * 2. **本组件不持有业务状态**：所有业务态从 `store` 读；组件只是视图
 *
 * ⚠️ 因此本文件**不得**出现累积型 `useState`（如 `content` / `reasoning` / 工具步骤）。
 *    一旦把累积态放进组件，关闭面板即丢内容并可能连带 abort —— 正是 D15 要防的。
 *    下列 `useState` 只承载**纯瞬时 UI 态**（输入框文本、浮层开合、编辑草稿、用户展开意图），
 *    它们不随流式推进而累积。
 *
 * ═══ 布局契约（S03）═══
 * · 落位：`ki-shell`（flex 容器）的新 flex 子项，插在 `ki-main` **之后**
 * · 宽度：360~420px；窄屏降级为浮层抽屉（阈值待前置门② 的真实基线补测）
 * · `ki-main` 已是 `flex:1; min-width:0` → 不会破坏现有页面
 * · 全屏阅读器（`ki-drawer--fullscreen`）打开时**自动收起**本面板（避免空间与层级冲突）
 *
 * ═══ 本版界面结构调整（2026-09-28 重设计）═══
 * 走查结论「折叠感重、不像聊天应用」→ 三处 `<details>` 全部换成对话产品构件：
 * · 会话列表 → 头部**会话胶囊 + 切换器浮层**（搜索 / 分组 / 重命名 / 归档 / 删除）
 * · 来源引用 → **编号 chip + 悬停摘要预览**
 * · 思考块与工具进度 → **生成期时间线**（每一步一个节点，进行中带脉冲）
 * 另补：消息级操作条（复制 / 重新生成 / 编辑重发）、空态提问引导、回到底部、提示分级。
 *
 * @see design/S03_前端对话面板与流式对话_DESIGN.md
 * @see demo/chat-panel-redesign/index.html（视觉基准 demo，token 与状态以此为准）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ackDisclosure,
  archiveConversation,
  createConversation,
  deleteConversation,
  getChatConfig,
  getConversation,
  listConversations,
  patchConversation,
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

/** 空态提问引导（点击填入输入框）；措辞对齐知识库问答的真实用法 */
const EMPTY_HINTS = [
  '这个知识库的写入链路是怎么走的？',
  'scopeMode=strict 时未注册 scope 会怎样？',
  'daemon 的写锁和 OperationCoordinator 是什么关系？',
];

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
  /** 已归档会话：默认列表接口不含，打开浮层时按需拉（见 loadArchived） */
  const [archivedConvs, setArchivedConvs] = useState<ConversationSummary[]>([]);
  const [convLoading, setConvLoading] = useState(true);
  /** 会话区错误（列表读取 / 切换 / 新建 / 删除失败）——渲染在浮层内，不再与发送失败混用 */
  const [convError, setConvError] = useState<string | null>(null);
  /** 发送 / 生成失败的错误提示（N4）：与 convError 分开，避免串到会话列表槽 */
  const [sendError, setSendError] = useState<string | null>(null);
  /** 会话切换器浮层开合（瞬时 UI 态，不进 store） */
  const [convPopOpen, setConvPopOpen] = useState(false);
  const chipRef = useRef<HTMLDivElement>(null);
  /** T12 确认请求进行中（防重复点击） */
  const [ackBusy, setAckBusy] = useState(false);
  /** 编辑重发（R24）：正在编辑的 user 消息 id 与草稿 */
  const [editing, setEditing] = useState<{ msgId: string; text: string } | null>(null);
  /** 复制反馈（消息 id → 已复制） */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  /** 用户是否已滚离底部（决定「回到底部」浮标是否出现） */
  const [atBottom, setAtBottom] = useState(true);
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
   * 当前 scope 的镜像 ref —— 用于丢弃"上一个 scope 的迟到响应"。
   *
   * ★ 为什么需要：切 scope 后旧请求仍在飞行，回来后 `setConvs` 会把旧 scope 的列表
   *   覆盖到新 scope 上，用户就能从浮层点开别的 scope 的会话（后端按 id 跨 scope 解析）。
   */
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);

  /** 列表 + 已归档合并（浮层分组与当前会话名都从这份取） */
  const allConvs = useMemo(() => [...convs, ...archivedConvs], [convs, archivedConvs]);
  /** 当前会话的展示名（胶囊上显示）：优先列表里的标题，回落到预览或占位 */
  const activeConv = useMemo(
    () => allConvs.find((c) => c.id === state.activeConvId) ?? null,
    [allConvs, state.activeConvId]
  );
  /**
   * 「重新生成」只对**最后一条 assistant** 开放。
   *
   * ★ API-11 的语义是"定位最后一条 user 重新作答并替换其后的 assistant"（R23，
   *   `messageCount` 不变）。挂在历史气泡上会让用户以为重跑的是那一条，
   *   实际悄悄重跑了最新一轮 —— 语义错配比没有入口更糟。
   */
  const lastAssistantId = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i]!.role === 'assistant') return state.messages[i]!.id;
    }
    return null;
  }, [state.messages]);
  const activeConvTitle = activeConv
    ? (activeConv.title.trim() || activeConv.lastMessagePreview.trim() || '（空会话）')
    : state.activeConvId ? '当前会话' : '未选择会话';

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
    [store, stream]
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
    const reqScope = scope;
    setConvLoading(true);
    try {
      const r = await listConversations(reqScope, { limit: 50 });
      if (scopeRef.current !== reqScope) return;   // 迟到响应属于旧 scope，丢弃
      setConvs(r.items);
      setConvError(null);
    } catch (err) {
      if (scopeRef.current !== reqScope) return;
      setConvError(err instanceof Error ? err.message : '会话列表读取失败');
    } finally {
      if (scopeRef.current === reqScope) setConvLoading(false);
    }
  }, [scope]);

  /**
   * 拉取已归档会话（API-02 `archived=1`）。
   *
   * ★ 只在**打开浮层时**按需拉：默认列表接口只返回未归档会话，
   *   不单独取就会出现"已归档分组永远为空"；而每轮发送都取两遍又会把
   *   列表接口的全目录扫描翻倍（daemon 主线程同步读盘）。
   */
  const loadArchived = useCallback(async (): Promise<void> => {
    const reqScope = scope;
    try {
      const r = await listConversations(reqScope, { archived: true, limit: 50 });
      if (scopeRef.current !== reqScope) return;
      setArchivedConvs(r.items);
    } catch {
      /* 归档分组拉取失败不阻塞主列表，静默保持空分组 */
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
    [store]
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
  //   ★ **必须无条件对齐 activeConvId**（含"新 scope 一条会话都没有"的情况）：
  //     只在有会话时切、无会话时什么都不做，会让 activeConvId 停留在**上一个 scope** 的会话，
  //     下一次提问就被写进旧 scope 的会话、检索也按旧 scope 的知识库执行（界面却显示新 scope）。
  //     设计口径见 S03 §5「切 scope → 关闭当前面板会话」。
  useEffect(() => {
    let alive = true;
    setConvLoading(true);
    // 切 scope：两个列表都属于旧 scope，先清空再取 —— 否则浮层里能点开旧 scope 的会话
    setConvs([]);
    setArchivedConvs([]);
    void (async () => {
      try {
        const r = await listConversations(scope, { limit: 50 });
        if (!alive) return;
        setConvs(r.items);
        setConvError(null);
        const pick = r.items.find((c) => !c.corrupted) ?? null;
        if (store.getState().activeConvId !== pick?.id) {
          stream.abort();
          store.dispatch({ type: 'setActiveConv', convId: pick?.id ?? null });
        }
        if (pick) await openConversation(pick.id);
      } catch (err) {
        if (!alive) return;
        setConvError(err instanceof Error ? err.message : '会话列表读取失败');
        // ★ 拉取失败同样必须归零 activeConvId：否则它停留在**上一个 scope** 的会话上，
        //   下一次提问被写进旧 scope 的会话文件（落盘不可逆），检索也按旧 scope 执行。
        stream.abort();
        store.dispatch({ type: 'setActiveConv', convId: null });
      } finally {
        if (alive) setConvLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // stream 只在 abort 时使用（引用稳定），列入依赖以避免闭包过期
  }, [scope, openConversation, store, stream]);

  // ── 自动滚底：仅在用户本就贴着底部时跟随（否则会把用户正在看的历史拽走）──
  useEffect(() => {
    if (!open) return;
    const el = listRef.current;
    if (!el || !atBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [open, atBottom, state.messages.length, state.streaming.content, state.streaming.progress.length]);

  // ── 浮层：点击外部 / Esc 关闭 ──
  //   ★ Esc 必须挂在 document：点完胶囊后焦点仍留在按钮上，而浮层的 onKeyDown 只覆盖
  //     它自己子树，挂在浮层上的 Esc 实际永远不会触发（onClose 成了死路径）。
  useEffect(() => {
    if (!convPopOpen) return;
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (chipRef.current?.contains(t)) return;
      if ((t as HTMLElement).closest?.('.ki-chat-convpop')) return;
      setConvPopOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setConvPopOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [convPopOpen]);

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
    setAtBottom(true); // 新提问必须把视图带回底部（用户此前往上翻过历史时也要跟随）
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
        setSendError(err instanceof Error ? err.message : '发送失败');
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
   * 重试 / 重新生成本轮回答（N4 / R23）。
   *
   * 用 `regenerate` 而非重发文本：用户消息在**上游调用前**就已落盘（route 的锁内前置写），
   * 故重新生成 = 对最后一条 user 重新作答，不会重复插入 user 消息。
   * ★ 必须过 `sendLockRef` 闸门：错误块在下一轮生成期间仍可能挂着，
   *   不闸门就会 `streamStart` 清掉在跑的累积态并撞上后端 409。
   */
  const handleRegenerate = (): void => {
    const convId = store.getState().activeConvId;
    if (!convId || state.streaming.active || sendLockRef.current) return;
    clearStreamError(convId);
    setSendError(null);
    sendLockRef.current = true;
    void (async () => {
      try {
        const persisted = await stream.regenerate(convId);
        if (persisted) await reloadActive(convId);
      } catch (err) {
        setSendError(err instanceof Error ? err.message : '重新生成失败');
      } finally {
        sendLockRef.current = false;
      }
    })();
  };

  /**
   * 编辑并重发（R24 / API-12）：服务端在**同一把会话锁内原子截断**该消息之后的全部消息。
   *
   * ★ 提交前必须明示"将丢弃其后 N 条"（R24 验收标准原文），不做静默截断。
   */
  const handleEditResend = (msgId: string, text: string): void => {
    const convId = store.getState().activeConvId;
    const idx = state.messages.findIndex((m) => m.id === msgId);
    if (!convId || idx < 0 || !text.trim() || sendLockRef.current) return;
    setEditing(null);
    sendLockRef.current = true;
    void (async () => {
      try {
        const persisted = await stream.editAndResend(convId, msgId, text.trim());
        if (persisted) await reloadActive(convId);
        void refreshConversations();
      } catch (err) {
        setSendError(err instanceof Error ? err.message : '编辑重发失败');
      } finally {
        sendLockRef.current = false;
      }
    })();
  };

  const handleCopy = (msg: ChatMessage): void => {
    if (!navigator.clipboard) { setCopiedId('unsupported'); return; }
    void navigator.clipboard.writeText(msg.content).then(() => {
      setCopiedId(msg.id);
      window.setTimeout(() => setCopiedId((cur) => (cur === msg.id ? null : cur)), 1200);
    }).catch(() => setCopiedId('failed'));
    window.setTimeout(() => setCopiedId((cur) => (cur === 'failed' || cur === 'unsupported' ? null : cur)), 1500);
  };

  /** 会话管理：重命名（API-05）/ 归档与恢复（API-06）/ 删除（API-07） */
  const handleRename = (id: string, title: string): void => {
    void patchConversation(id, { title })
      // 归档项存在于 archivedConvs，只改 convs 会让归档会话的改名毫无反应
      .then(() => setConvs((prev) => prev.map((c) => (c.id === id ? { ...c, title } : c))))
      .then(() => { if (archivedConvs.some((c) => c.id === id)) void loadArchived(); })
      .catch((err: unknown) => setConvError(err instanceof Error ? err.message : '重命名失败'));
  };
  const handleArchive = (id: string, archived: boolean): void => {
    void archiveConversation(id, archived)
      .then(async () => {
        // 归档**当前**会话 → 必须切走，否则下一次提问继续写进一条已归档的会话
        if (archived && store.getState().activeConvId === id) {
          const r = await listConversations(scope, { limit: 50 });
          if (scopeRef.current !== scope) return;
          setConvs(r.items);
          const next = r.items.find((c) => c.id !== id && !c.corrupted) ?? null;
          if (next) await openConversation(next.id);
          else store.dispatch({ type: 'setActiveConv', convId: null });
        } else {
          // 归档会在主列表与归档列表之间移动条目 → 两边都重取
          void refreshConversations();
          void loadArchived();
        }
      })
      .catch((err: unknown) => setConvError(err instanceof Error ? err.message : '归档操作失败'));
  };
  const handleDelete = (id: string): void => {
    // ★ 先 abort 再删：后端删除路由不判 generating，生成中删除会与"落 assistant 尾写"竞态
    if (store.getState().activeConvId === id) stream.abort();
    void deleteConversation(id)
      .then(async () => {
        // 删的是当前会话 → 必须切到下一条或归零，否则下一次提问打到已不存在的 id
        if (store.getState().activeConvId === id) {
          const rest = allConvs.filter((c) => c.id !== id && !c.archived && !c.corrupted);
          if (rest[0]) await openConversation(rest[0].id);
          else store.dispatch({ type: 'setActiveConv', convId: null });
        }
        await refreshConversations();
        void loadArchived();
      })
      .catch((err: unknown) => setConvError(err instanceof Error ? err.message : '删除会话失败'));
  };

  const handleSelectConversation = (id: string): void => {
    setConvPopOpen(false);
    void openConversation(id).catch((err: unknown) => {
      setConvError(err instanceof Error ? err.message : '切换会话失败');
    });
  };

  const handleCreateConversation = (): void => {
    setConvPopOpen(false);
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

  const draftChars = Array.from(draft).length;

  return (
    <>
      <aside
        className={`ki-chat-panel${narrow ? ' ki-chat-panel--overlay' : ''}`}
        aria-label="AI 对话面板"
        data-narrow={narrow ? 'true' : 'false'}
      >
        {/* ── 头部：标题 + 会话胶囊（切换器触发）+ 新建 ── */}
        <header className="ki-chat-panel__head">
          <span className="ki-chat-panel__title">AI 对话</span>
          <div className="ki-chat-chipwrap" ref={chipRef}>
            <button
              type="button"
              className="ki-chat-chip"
              aria-expanded={convPopOpen}
              aria-haspopup="dialog"
              onClick={() => {
                const next = !convPopOpen;
                setConvPopOpen(next);
                if (next) void loadArchived();
              }}
            >
              <svg className="ki-chat-chip__ic" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" />
              </svg>
              <span className="ki-chat-chip__name">{activeConvTitle}</span>
              {activeConv ? <span className="ki-chat-chip__count">{activeConv.messageCount}</span> : null}
              <svg className="ki-chat-chip__caret" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
                <path d="M4 6.5 8 10.5 12 6.5" />
              </svg>
            </button>
            <ConversationList
              open={convPopOpen}
              items={allConvs}
              activeId={state.activeConvId}
              loading={convLoading}
              error={convError}
              onClose={() => setConvPopOpen(false)}
              onSelect={handleSelectConversation}
              onCreate={handleCreateConversation}
              onRefresh={() => void refreshConversations()}
              onRename={handleRename}
              onArchive={handleArchive}
              onDelete={handleDelete}
            />
          </div>
          <span className="ki-chat-panel__tools">
            <button
              type="button"
              className="ki-chat-iconbtn"
              title="新建会话"
              aria-label="新建会话"
              onClick={handleCreateConversation}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
            </button>
          </span>
        </header>

        {/* ── 上下文条：模型 / 状态（取代原先只读地挂在标题右侧的模型名）── */}
        <div className="ki-chat-ctx">
          <span className={`ki-chat-ctx__dot${config && !config.enabled ? ' ki-chat-ctx__dot--off' : config?.ackRequired ? ' ki-chat-ctx__dot--warn' : ''}`} />
          <span className="ki-chat-ctx__model">{config?.model ?? '未配置模型'}</span>
          {config && config.enabled ? (
            <>
              <span className="ki-chat-ctx__sep">·</span>
              <span>
                {state.streaming.active ? '生成中' : config.ackRequired ? '外发未确认' : config.supportsTools ? '工具检索就绪' : '预检索模式'}
              </span>
            </>
          ) : null}
        </div>

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

        {/* ── 消息流 ── */}
        <div
          className="ki-chat-panel__body"
          ref={listRef}
          onScroll={(e) => {
            const el = e.currentTarget;
            setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
        >
          {state.messages.length === 0 && !state.streaming.active ? (
            <div className="ki-chat-empty">
              <span className="ki-chat-empty__ic" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.6 4.2A1.6 1.6 0 0 1 4.2 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H7.4L4.2 13.4v-2.6H4.2a1.6 1.6 0 0 1-1.6-1.6z" /></svg>
              </span>
              <p className="ki-chat-empty__t">在任意页面提问</p>
              <p className="ki-chat-empty__d">回答会附带知识库来源，点击可回原文并高亮命中片段。</p>
              <div className="ki-chat-empty__hints">
                {EMPTY_HINTS.map((h) => (
                  <button key={h} type="button" className="ki-chat-q" onClick={() => { setDraft(h); }}>{h}</button>
                ))}
              </div>
            </div>
          ) : null}

          {state.messages.map((m, i) => (
            <MessageBubble
              key={m.id}
              message={m}
              // N17：降级标记随消息留存（不进冻结的 ChatMessage，见 chatStore.degradedByMessage）
              degraded={state.degradedByMessage[m.id] ?? null}
              // R24：编辑重发会原子截断该消息之后的全部消息 → 明示条数
              discardCount={state.messages.length - i - 1}
              onOpenSource={handleOpenSource}
              onCopy={() => handleCopy(m)}
              copyState={
                copiedId === m.id ? 'copied'
                  : copiedId === 'failed' ? 'failed'
                  : copiedId === 'unsupported' ? 'unsupported'
                  : 'idle'
              }
              onRegenerate={handleRegenerate}
              canRegenerate={!state.streaming.active && Boolean(state.activeConvId) && m.id === lastAssistantId}
              canEdit={!state.streaming.active && Boolean(state.activeConvId)}
              editing={editing?.msgId === m.id ? editing.text : null}
              onEditStart={() => setEditing({ msgId: m.id, text: m.content })}
              onEditChange={(text) => setEditing((e) => (e ? { ...e, text } : e))}
              onEditSubmit={(text) => handleEditResend(m.id, text)}
              onEditCancel={() => setEditing(null)}
              reasoning={m.id === state.streaming.messageId ? state.streaming.reasoning : undefined}
              reasoningOpen={Boolean(reasoningExpanded[m.id])}
              onToggleReasoning={(next) =>
                setReasoningExpanded((prev) => ({ ...prev, [m.id]: next }))
              }
            />
          ))}

          {/* 生成中：降级标记（N17 必须可见）+ 时间线（R11a 每一秒都有反馈）+ 正文 */}
          {state.streaming.active ? (
            <StreamingBubble
              content={state.streaming.content}
              reasoning={state.streaming.reasoning}
              progress={state.streaming.progress}
              degradedLabel={state.streaming.degraded?.label ?? null}
              reasoningOpen={Boolean(reasoningExpanded[state.streaming.messageId ?? ''])}
              onToggleReasoning={(next) => {
                const id = state.streaming.messageId ?? '';
                setReasoningExpanded((prev) => ({ ...prev, [id]: next }));
              }}
            />
          ) : null}
        </div>

        {/* ── 输入区：分级提示 + composer 卡片 ── */}
        <footer className="ki-chat-panel__foot">
          {atBottom ? null : (
            <button
              type="button"
              className="ki-chat-jump"
              onClick={() => {
                const el = listRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setAtBottom(true);
              }}
            >回到底部</button>
          )}

          {/* 本轮生成失败（N4 / S03 §5）：保留已生成内容并给出重试入口，不静默 */}
          {streamError || sendError ? (
            <div className="ki-chat-alert ki-chat-alert--err" role="alert">
              <span className="ki-chat-alert__body">
                <b>{streamError ? '生成中断' : '操作失败'}</b>
                <span>{streamError?.message ?? sendError}</span>
              </span>
              <span className="ki-chat-alert__acts">
                <button
                  type="button"
                  className="ki-chat-btn ki-chat-btn--ghost"
                  onClick={() => {
                    clearStreamError(state.activeConvId);
                    setSendError(null);
                  }}
                >忽略</button>
                {/* 「重试」只对**生成失败**成立：sendError 可能来自重命名/删除/编辑重发，
                    拿它去走 regenerate 做的不是用户以为的那件事 */}
                {streamError && streamError.retryable !== false ? (
                  <button type="button" className="ki-chat-btn" onClick={handleRegenerate} disabled={state.streaming.active}>
                    重试
                  </button>
                ) : null}
              </span>
            </div>
          ) : null}

          {/* `done.warning` 落地（S03 §5：会话过长 / 检索轮次耗尽 —— 原先前端零消费） */}
          {state.notice ? (
            <div className="ki-chat-alert ki-chat-alert--notice" role="status">
              <span>{state.notice}</span>
              <button
                type="button"
                className="ki-chat-alert__x"
                aria-label="关闭提示"
                onClick={() => store.dispatch({ type: 'notice', text: null })}
              >×</button>
            </div>
          ) : null}

          {/* T12：既阻塞也**给出解除入口** —— 只阻塞不给出口会让面板在 ackRequired 下永久不可用 */}
          {config?.ackRequired ? (
            <div className="ki-chat-alert ki-chat-alert--ack" role="alert">
              <span className="ki-chat-alert__body">
                <b>内容将发送至外部模型服务</b>
                <span>
                  提问内容与检索到的知识库片段都会发往 <code>{config.baseURLHost ?? '外部服务'}</code>，确认后方可发送。
                </span>
              </span>
              <span className="ki-chat-alert__acts">
                <button
                  type="button"
                  className="ki-chat-btn"
                  onClick={handleAck}
                  disabled={ackBusy}
                >{ackBusy ? '确认中…' : '我已知悉'}</button>
              </span>
            </div>
          ) : null}

          <div className="ki-chat-composer">
            <textarea
              className="ki-chat-composer__ta"
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
            <div className="ki-chat-composer__bar">
              <span className="ki-chat-composer__hint">{blocked ?? 'Enter 发送 · Shift+Enter 换行'}</span>
              <span className={`ki-chat-composer__count${draftChars > MAX_SEND_CHARS * 0.9 ? ' ki-chat-composer__count--over' : ''}`}>
                {draftChars}/{MAX_SEND_CHARS}
              </span>
              {state.streaming.active ? (
                <button type="button" className="ki-chat-btn ki-chat-btn--stop" onClick={handleStop}>
                  停止
                </button>
              ) : (
                <button
                  type="button"
                  className="ki-chat-btn"
                  onClick={handleSend}
                  disabled={Boolean(blocked)}
                >
                  发送
                </button>
              )}
            </div>
          </div>
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

/** 单条已落盘消息（user / assistant 分支 + 消息级操作条） */
function MessageBubble({
  message,
  degraded,
  discardCount,
  reasoning,
  reasoningOpen,
  onToggleReasoning,
  onOpenSource,
  onCopy,
  copyState,
  onRegenerate,
  canRegenerate,
  canEdit,
  editing,
  onEditStart,
  onEditChange,
  onEditSubmit,
  onEditCancel,
}: {
  message: ChatMessage;
  /** N17：本条的降级标记（来自 store.degradedByMessage；生成结束后仍保留，回看历史可见） */
  degraded?: DegradedMark | null;
  /** R24：编辑重发将截断其后的消息条数（0 表示无截断） */
  discardCount: number;
  reasoning?: string;
  reasoningOpen: boolean;
  onToggleReasoning: (next: boolean) => void;
  onOpenSource: (ref: SourceRef) => void;
  onCopy: () => void;
  /** 复制反馈态（非安全上下文下 clipboard 不可用，也要给出原因，不能点了没反应） */
  copyState: 'idle' | 'copied' | 'failed' | 'unsupported';
  onRegenerate: () => void;
  /** 仅最后一条 assistant 为 true（API-11 只重跑最新一轮，见 lastAssistantId） */
  canRegenerate: boolean;
  /** 编辑重发（API-12 按 msgId 定位，任意一条 user 都可编辑，只要不在生成中） */
  canEdit: boolean;
  /** 非 null 表示该 user 消息正处于编辑态，值即草稿 */
  editing: string | null;
  onEditStart: () => void;
  onEditChange: (text: string) => void;
  onEditSubmit: (text: string) => void;
  onEditCancel: () => void;
}): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`ki-chat-msg ki-chat-msg--${message.role}`}>
      {/* 元信息行：角色 / 时间 / 状态徽标（原先只有气泡，看不出谁说的、什么时候、是否完整） */}
      <div className="ki-chat-msg__meta">
        {!isUser ? <span className="ki-chat-msg__role">kisearch</span> : null}
        <span className="ki-chat-msg__at">{formatMsgTime(message.at)}</span>
        {message.aborted ? <span className="ki-chat-msg__badge ki-chat-msg__badge--abort">已中止</span> : null}
        {!isUser && degraded ? (
          <span className="ki-chat-msg__badge ki-chat-msg__badge--degrade">{degraded.label}</span>
        ) : null}
      </div>

      {/* N17：降级标记必须可见，不得静默 */}
      {!isUser && degraded ? (
        <div className="ki-chat-msg__degraded" role="status">{degraded.label}</div>
      ) : null}

      {!isUser && reasoning ? (
        <ReasoningBlock text={reasoning} streaming={false} open={reasoningOpen} onToggle={onToggleReasoning} />
      ) : null}

      {isUser && editing !== null ? (
        <div className="ki-chat-edit">
          <textarea
            className="ki-chat-edit__ta"
            value={editing}
            rows={3}
            autoFocus
            onChange={(e) => onEditChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onEditCancel();
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onEditSubmit(e.currentTarget.value);
            }}
          />
          {/* R24 验收：截断前明示"将丢弃其后 N 条"，不做静默截断 */}
          <p className="ki-chat-edit__warn">
            {discardCount > 0 ? `重发将丢弃其后 ${discardCount} 条消息` : '重发后该回答会被替换'}
          </p>
          <div className="ki-chat-edit__acts">
            <button type="button" className="ki-chat-btn ki-chat-btn--ghost" onClick={onEditCancel}>取消</button>
            <button
              type="button"
              className="ki-chat-btn"
              disabled={!editing.trim()}
              onClick={() => onEditSubmit(editing)}
            >保存并重发</button>
          </div>
        </div>
      ) : (
        <div className="ki-chat-msg__body">
          {isUser ? (
            // 用户输入是纯文本：不渲染 Markdown（避免把用户输入的 markdown 当富文本执行）
            <p className="ki-chat-msg__text">{message.content}</p>
          ) : (
            <MarkdownPreview text={message.content} />
          )}
        </div>
      )}

      {/* 来源引用（R20）：空数组时 SourcesList 自身渲染 null */}
      {!isUser ? <SourcesList sources={message.sources ?? []} onOpen={onOpenSource} /> : null}

      {/* 消息级操作条：最后一条常驻可见，其余 hover / 键盘聚焦时出现 */}
      <div className="ki-chat-msg__acts">
        <button type="button" className="ki-chat-act" onClick={onCopy}>
          {copyState === 'copied' ? '已复制'
            : copyState === 'failed' ? '复制失败'
            : copyState === 'unsupported' ? '需 HTTPS 或 localhost'
            : '复制'}
        </button>
        {isUser ? (
          <button
            type="button"
            className="ki-chat-act"
            // 乐观 user 消息的临时 id（local-user-*）服务端不存在，
            // 直接发起 API-12 必然 404 —— 等本轮落盘重取回填真实 id 后才可编辑
            disabled={!canEdit || message.id.startsWith('local-user-')}
            title={
              message.id.startsWith('local-user-') ? '本轮结束后才能编辑重发'
                : !canEdit ? '生成中不可编辑'
                : '编辑后重发（会丢弃其后消息）'
            }
            onClick={onEditStart}
          >编辑重发</button>
        ) : canRegenerate ? (
          <button
            type="button"
            className="ki-chat-act"
            title="对上一个提问重新作答（不新增提问）"
            onClick={onRegenerate}
          >重新生成</button>
        ) : null}
      </div>
    </div>
  );
}

/** `at`（ISO 8601）→ 消息时间戳；跨年补年份 */
function formatMsgTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const md = `${d.getMonth() + 1}-${d.getDate()}`;
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()}-${md}`;
}

/**
 * `ProgressStep` → 时间线节点。
 *
 * 三分支联合不能直接取 `.label` —— 只有 tool 分支带 label，另两支按 kind 给固定文案；
 * tool 的 `start` 阶段算「进行中」，`end` 与其余分支按已完成/进行中呈现。
 */
function progressNodes(steps: ProgressStep[]): Array<{ key: string; label: string; running: boolean; kind: 'tool' | 'think' | 'answer' }> {
  return steps.map((s, i) => {
    if (s.kind === 'tool') {
      return { key: `t${i}`, label: s.label, running: s.phase === 'start', kind: 'tool' as const };
    }
    if (s.kind === 'reasoning') return { key: `r${i}`, label: '思考中…', running: true, kind: 'think' as const };
    return { key: `a${i}`, label: '正在回答…', running: true, kind: 'answer' as const };
  });
}

/** 生成中的临时气泡（内容全部来自 store.streaming，**不落盘**） */
function StreamingBubble({
  content,
  reasoning,
  progress,
  degradedLabel,
  reasoningOpen,
  onToggleReasoning,
}: {
  content: string;
  reasoning: string;
  progress: ProgressStep[];
  degradedLabel: string | null;
  reasoningOpen: boolean;
  onToggleReasoning: (next: boolean) => void;
}): JSX.Element {
  const nodes = progressNodes(progress);
  const showThinking = reasoning !== '' && nodes.length === 0;

  return (
    <div className="ki-chat-msg ki-chat-msg--assistant ki-chat-msg--streaming">
      <div className="ki-chat-msg__meta">
        <span className="ki-chat-msg__role">kisearch</span>
        <span className="ki-chat-msg__at">刚刚</span>
        {degradedLabel ? (
          <span className="ki-chat-msg__badge ki-chat-msg__badge--degrade">{degradedLabel}</span>
        ) : null}
      </div>

      {/* N17：降级标记必须可见，不得静默 */}
      {degradedLabel ? (
        <div className="ki-chat-msg__degraded" role="status">{degradedLabel}</div>
      ) : null}

      {/* R11a：生成期每一步都要有可见反馈 —— 时间线取代了原先的单行 progress 文本 */}
      <div className="ki-chat-tl" role="status" aria-live="polite">
        {nodes.map((n) => (
          <div key={n.key} className={`ki-chat-tl__node ki-chat-tl__node--${n.kind}${n.running ? ' ki-chat-tl__node--run' : ''}`}>
            <span className="ki-chat-tl__label">{n.label}</span>
          </div>
        ))}
        {showThinking ? (
          <div className="ki-chat-tl__node ki-chat-tl__node--think ki-chat-tl__node--run">
            <span className="ki-chat-tl__label">正在思考…</span>
          </div>
        ) : null}
        {/* 尚无任何进展时也要有兜底文案（N10 不得出现无反馈空白） */}
        {nodes.length === 0 && !showThinking ? (
          <div className="ki-chat-tl__node ki-chat-tl__node--run">
            <span className="ki-chat-tl__label">正在连接模型…</span>
          </div>
        ) : null}
      </div>

      {reasoning ? (
        <ReasoningBlock text={reasoning} streaming open={reasoningOpen} onToggle={onToggleReasoning} />
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
 * 思考块（S05）—— 受控展开，默认收起，正文纯文本等宽（不做 Markdown 渲染）。
 *
 * ★ 不再用 `<details>`：面板里已经有会话列表与来源两处折叠条，再加一条就是"三层折叠"，
 *   走查结论是"不像聊天应用"。这里用 button + 条件渲染，展开态由父层持有（`onToggle`），
 *   因此流式推进时**不会强制收起**用户已展开的块（S05 §3.1 语义不变）。
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
    <div className="ki-chat-reason">
      <button
        type="button"
        className="ki-chat-reason__toggle"
        aria-expanded={open}
        title="思考内容仅本次会话可见，留存于页面内存，不写入记录"
        onClick={() => onToggle(!open)}
      >
        {open ? '收起' : '展开'}{streaming ? '思考中' : '思考过程'} · {chars} 字
      </button>
      {open ? (
        <div className="ki-chat-reason__body">
          {shown}
          {truncated ? <p className="ki-chat-reason__truncated">思考内容过长，已截断显示</p> : null}
        </div>
      ) : null}
    </div>
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
