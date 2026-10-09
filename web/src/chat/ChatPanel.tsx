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

import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
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
import { CHAT_REF_MAX_COUNT, CHAT_REF_TEXT_MAX, CHAT_REF_TOTAL_MAX, type ChatConfigOk, type ChatMessage, type ChatProgressStep, type ChatRef, type ConversationSummary, type SourceRef } from '@/api/chatContract';
import { useScopeValue } from '@/lib/scopeContext';
import { kiGetModuleInfo } from '@/api/mcpClient';
import { ModuleDrawer } from '@/components/ModuleDrawer';
import { ChatToggleButton } from './ChatToggleButton';
import { ReaderLinkComposer } from '@/components/ReaderLinkComposer';
import { MarkdownPreview, renderMarkdownBlocks, type MarkdownBlock } from '@/components/MarkdownPreview';
import type { ChatStore, DegradedMark, ProgressStep, ReasoningSegment } from './chatStore';
import { buildTimeline, mergeInterleaveItems, layoutAnswerFlow, type TimelineNode } from './answerFlow';
import { SourcesList } from './SourcesList';
import { clearStreamError, getStreamError, toolEndStep, toolStartStep, useChatStream } from './useChatStream';
import { ConversationList } from './ConversationList';
import { PromptConfigLayer } from './PromptConfigLayer';

export interface ChatPanelProps {
  store: ChatStore;
  /** 由 AppShell 控制（对应顶部开关按钮，D15） */
  open: boolean;
  /** 仅隐藏面板，保留当前对话、草稿与进行中的生成。 */
  onClose: () => void;
  /**
   * 呈现变体（REQ-20261008-001）：
   * · `dock`（默认）：右侧 380px 常驻面板（窄屏转浮层），头部含标题/会话胶囊/关闭钮
   * · `page`：独立对话页（/chat）——双栏（左：常驻会话列表；右：对话区限宽 880px 居中），
   *   头部裁掉（页面 H1 已承担），配置入口移至上下文条；会话深链 /chat/:convId 由本组件同步
   */
  variant?: 'dock' | 'page';
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

export function ChatPanel({ store, open, onClose, variant = 'dock' }: ChatPanelProps): JSX.Element | null {
  const isPage = variant === 'page';
  const scope = useScopeValue();
  const stream = useChatStream(store);
  // ── 会话深链（page 专属，URL 契约见 REQ-20261008-001 design/ui-design.md §2.4）──
  const { convId: urlConvId } = useParams<{ convId?: string }>();
  const navigate = useNavigate();

  // ── 订阅常驻 store（订阅式而非快照：流式推进需要组件重渲染）──
  const state = useSyncExternalStoreCompat(store);

  const [config, setConfig] = useState<ChatConfigOk | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  /** 按消息 id + 思考段 key 独立保存展开态，不因新 chunk 强制收起（S05 §3.1）。 */
  const [reasoningExpanded, setReasoningExpanded] = useState<Record<string, Record<string, boolean>>>({});
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
  /** 对话配置层开合（纯瞬时 UI 态，符合本文件"不得累积业务态"的约束） */
  const [cfgOpen, setCfgOpen] = useState(false);
  /** 引用选择器开合（纯瞬时 UI 态，REQ-20261009-002 需求 B） */
  const [refPickerOpen, setRefPickerOpen] = useState(false);
  /**
   * 「加入引用」待选模式（用户走查修正：**不再弹模态框**，直接在正在读的正文里划选）。
   *
   * 范式与文档编辑器「添加链接」一致：先点按钮 → 再选内容 → 自动加入。
   * ⚠️ 本状态与下方 effect 都必须在 `if (!open) return null` **早退之前**（Rules of Hooks）。
   */
  const [refArmed, setRefArmed] = useState(false);

  /**
   * 引用相关轻提示（**3s 自动消失**）。
   *
   * 为什么不复用 store 的 `notice`：那是"需要用户处置"的**常驻**提示（`done.warning` 的
   * 「本轮回答可能不完整」也走它），自动消失会让用户错过；而「已加入引用」只是即时反馈
   * —— 用户走查反馈：该提示不会自动消失，一直挡在输入框上方。
   */
  const [refToast, setRefToast] = useState('');
  useEffect(() => {
    if (!refToast) return;
    const t = window.setTimeout(() => setRefToast(''), 3000);
    return () => window.clearTimeout(t);
  }, [refToast]);

  useEffect(() => {
    if (!refArmed) return;
    const onUp = (): void => {
      const sel = window.getSelection();
      const raw = sel?.toString().trim() ?? '';
      if (!raw) return;
      const anchor = sel?.anchorNode ?? null;
      const el = anchor instanceof Element ? anchor : (anchor?.parentElement ?? null);
      // 选区必须落在阅读器正文里：在面板内选字、或在别处选字，都不算引用
      const drawer = el?.closest('.ki-drawer') ?? null;
      if (!drawer) return;
      const doc = drawer.getAttribute('data-ki-doc-name') ?? '';
      const grp = drawer.getAttribute('data-ki-doc-group') ?? '';
      if (!doc) return;
      const cur = store.getState().pendingRefs;
      if (cur.length >= CHAT_REF_MAX_COUNT) {
        setRefToast(`一次提问最多引用 ${CHAT_REF_MAX_COUNT} 段内容，请先移除一条`);
        return;
      }
      const text = raw.length > CHAT_REF_TEXT_MAX ? raw.slice(0, CHAT_REF_TEXT_MAX) : raw;
      // 总量守卫：只限条数与单条长度时，5 × 2000 可合法凑出 10000 字，而后端
      // `CHAT_REF_TOTAL_MAX`（6000）会直接 400 —— 必须在前端拦住并说明原因，避免"操作合法但发送必失败"
      const usedChars = cur.reduce((n, r) => n + r.text.length, 0);
      if (usedChars + text.length > CHAT_REF_TOTAL_MAX) {
        setRefToast(`引用内容合计不得超过 ${CHAT_REF_TOTAL_MAX} 字（当前 ${usedChars} 字），请先移除部分引用`);
        return;
      }
      if (cur.some((r) => r.group === grp && r.doc === doc && r.text === text)) {
        setRefToast(`这段内容已在引用中：${doc}`);
        return;
      }
      store.dispatch({ type: 'setRefs', refs: [...cur, { group: grp, doc, text }] });
      setRefToast(
        raw.length > CHAT_REF_TEXT_MAX
          ? `已加入引用（超长已截断至 ${CHAT_REF_TEXT_MAX} 字）：${doc}`
          : `已加入引用：${doc}（${text.length} 字）`,
      );
      setRefArmed(false);
      sel?.removeAllRanges();
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [refArmed, store, setRefToast]);
  /** 左栏会话抽屉开合（page 窄屏 <1024px 专用，瞬时 UI 态） */
  const [sideOpen, setSideOpen] = useState(false);
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
  const creatingScopeRef = useRef<string | null>(null);
  const selectionSeqRef = useRef(0);
  const operationSeqRef = useRef(0);
  const [readyScope, setReadyScope] = useState<string | null>(null);
  const [openingConv, setOpeningConv] = useState(false);
  /**
   * 当前 scope 的镜像 ref —— 用于丢弃"上一个 scope 的迟到响应"。
   *
   * ★ 为什么需要：切 scope 后旧请求仍在飞行，回来后 `setConvs` 会把旧 scope 的列表
   *   覆盖到新 scope 上，用户就能从浮层点开别的 scope 的会话（后端按 id 跨 scope 解析）。
   */
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  useLayoutEffect(() => {
    selectionSeqRef.current += 1;
    operationSeqRef.current += 1;
    sendLockRef.current = false;
    creatingRef.current = null;
    creatingScopeRef.current = null;
    stream.abort();
    store.dispatch({ type: 'setActiveConv', convId: null });
    setReadyScope(null);
    setOpeningConv(false);
    setConvs([]);
    setArchivedConvs([]);
    setEditing(null);
    setViewing(null);
    setDraft('');
    // 引用随 scope 清空（REQ-20261009-002 R10：绝不把 A scope 的文档名带入 B scope）
    store.dispatch({ type: 'setRefs', refs: [] });
    setSendError(null);
    setConvError(null);
    setAtBottom(true);
  }, [scope, store, stream]);

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
      const reqScope = scopeRef.current;
      const selection = ++selectionSeqRef.current;
      const s = store.getState();
      if (s.activeConvId === id && s.messages.length > 0 && !s.messages.some((m) => m.id.startsWith('local-user-'))) return;
      stream.abort();
      store.dispatch({ type: 'setActiveConv', convId: id });
      // 用户主动切会话 → 引用清空（需求 R10：引用属当前对话框）。
      // 与「首次发送惰性建会话」区分：后者不清（见 chatStore.setActiveConv 处的说明）
      store.dispatch({ type: 'setRefs', refs: [] });
      setOpeningConv(true);
      try {
        const d = await getConversation(id);
        // A late history response cannot replace a new stream or a different selection.
        if (scopeRef.current === reqScope && selectionSeqRef.current === selection && store.getState().activeConvId === id && !store.getState().streaming.active) {
          store.dispatch({ type: 'setMessages', messages: d.conv.messages });
          clearStreamError(id);
        }
      } finally {
        if (scopeRef.current === reqScope && selectionSeqRef.current === selection) setOpeningConv(false);
      }
    },
    [store, stream]
  );

  /**
   * page 深链守卫（challenger 质疑修复，REQ-20261008-001）：会话必须属于**当前 scope**。
   * 深链 /chat/:convId 绕过了"从当前 scope 列表选"的天然约束，直接按 id 打开会把
   * 其他 scope 的会话载入——随后提问写进旧 scope 的会话文件、检索也按旧 scope 执行
   * （S03 §5 明确要防的事故）。守卫失败抛错，由调用方落 convError 并提示。
   * （多一次 getConversation：深链是低频路径，换取判定准确性）
   */
  const openConversationGuarded = useCallback(
    async (id: string): Promise<void> => {
      const d = await getConversation(id);
      if (d.conv.scope !== scopeRef.current) {
        throw new Error(`该会话属于 ${d.conv.scope}，与当前知识库（${scopeRef.current}）不同，已拒绝打开`);
      }
      await openConversation(id);
    },
    [openConversation]
  );

  /** 新建会话并切过去（首次发送时若当前无会话会调用）。**并发调用复用同一次创建**。 */
  const createNewConversation = useCallback((): Promise<string> => {
    if (creatingRef.current && creatingScopeRef.current === scope) return creatingRef.current;
    const reqScope = scope;
    const selection = ++selectionSeqRef.current;
    creatingScopeRef.current = reqScope;
    // A pending manual creation must not leave the previous conversation writable.
    stream.abort();
    store.dispatch({ type: 'setActiveConv', convId: null });
    setOpeningConv(true);

    const pending = (async (): Promise<string> => {
      const r = await createConversation(scope, {});
      const id = r.conv.id;
      if (scopeRef.current !== reqScope || selectionSeqRef.current !== selection) throw new Error('已切换会话，请重新发送');
      stream.abort();
      store.dispatch({ type: 'setActiveConv', convId: id });
      setReadyScope(reqScope);
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
      if (creatingRef.current === pending) creatingRef.current = null;
      if (scopeRef.current === reqScope && selectionSeqRef.current === selection) setOpeningConv(false);
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
   * dock 重新打开时刷新会话列表（challenger 质疑#3 修复，REQ-20261008-001）：
   * 独立页（page 实例）里的重命名/归档/删除/新建只更新了 page 自己的列表 state，
   * dock 这份会陈旧——双实例各自组件 state 的固有代价（store 只共享会话内容，
   * 列表是组件级）。跳过挂载首次（初始 effect 已拉取，避免重复请求）。
   */
  const dockReopenRef = useRef(false);
  useEffect(() => {
    if (isPage) return;
    if (!dockReopenRef.current) { dockReopenRef.current = true; return; }
    if (open) void refreshConversations();
  }, [isPage, open, refreshConversations]);

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
        const snapshot = store.getState().messages;
        const d = await getConversation(convId);
        if (store.getState().activeConvId !== convId || store.getState().streaming.active || store.getState().messages !== snapshot) return;
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
    let selection = selectionSeqRef.current;
    // 切 scope：两个列表都属于旧 scope，先清空再取 —— 否则浮层里能点开旧 scope 的会话
    setConvs([]);
    setArchivedConvs([]);
    void (async () => {
      try {
        const r = await listConversations(scope, { limit: 50 });
        if (!alive || scopeRef.current !== scope || selectionSeqRef.current !== selection) return;
        setReadyScope(scope);
        setConvs(r.items);
        setConvError(null);
        const pick = r.items.find((c) => !c.corrupted) ?? null;
        if (isPage) {
          // page（/chat）选中口径：**URL 深链 > 现状保留 > 最近一条**（URL 契约 §2.4）。
          // 不得套用 dock 的"强制对齐最近一条"——否则深链进入 /chat/:convId 会被改写成别的会话。
          const current = store.getState().activeConvId;
          const target = urlConvId ?? current ?? pick?.id ?? null;
          if (target && target !== current) {
            selection = selectionSeqRef.current + 1;
            try {
              // 深链入口必须过 scope 守卫（质疑#2：防把其他 scope 会话打开并写入）
              await openConversationGuarded(target);
            } catch (openErr) {
              // 深链 id 无效（已删除/跨 scope）：回落列表态并提示（契约：无效 id 回落 /chat）
              if (urlConvId) navigate('/chat', { replace: true });
              // ★ 必须在此就地落错误：守卫在 openConversation 之前 throw 时 selectionSeqRef
              //   未递增，外层 catch 的序号校验会把 setConvError 丢弃（用户看不到拒绝原因）
              if (scopeRef.current === scope) setConvError(openErr instanceof Error ? openErr.message : '打开会话失败');
              return;
            }
          } else if (!target) {
            store.dispatch({ type: 'setActiveConv', convId: null });
          }
        } else {
          if (store.getState().activeConvId !== pick?.id) {
            stream.abort();
            store.dispatch({ type: 'setActiveConv', convId: pick?.id ?? null });
          }
          if (pick) {
            selection = selectionSeqRef.current + 1;
            await openConversation(pick.id);
          }
        }
      } catch (err) {
        if (!alive || scopeRef.current !== scope || selectionSeqRef.current !== selection) return;
        setReadyScope(scope);
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
    // stream 只在 abort 时使用（引用稳定），列入依赖以避免闭包过期。
    // urlConvId 故意不列依赖：本 effect 只在挂载/切 scope 时按"当时的 URL"做初始选中，
    // URL 后续变化由下方「URL → store」专用 effect 承接（防双重打开）。
    // ★ navigate 也故意不列依赖：react-router v7 的 navigate 引用**随导航变化**（实测），
    //   列入会死循环——「选中会话 → store→URL 导航 → navigate 变 → 本 effect 重跑 →
    //   setConvs([]) 清空列表 → 异步完成时序号已变被丢弃 → 列表永远为空」。
    //   本 effect 的 navigate 调用以执行期闭包为准即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, openConversation, openConversationGuarded, store, stream, isPage]);

  // Keep the user's sticky-bottom intent separate from programmatic growth/scroll events.
  const stickyBottomRef = useRef(true);
  useEffect(() => {
    stickyBottomRef.current = atBottom;
    if (!open || !atBottom) return;
    const el = listRef.current;
    if (!el) return;
    let frame = 0;
    const follow = () => {
      if (!stickyBottomRef.current) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (stickyBottomRef.current) el.scrollTop = el.scrollHeight;
      });
    };
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    if (el.firstElementChild) observer?.observe(el.firstElementChild);
    follow();
    return () => { observer?.disconnect(); cancelAnimationFrame(frame); };
  }, [open, atBottom, state.activeConvId]);

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

  // ── page 窄屏抽屉：Esc 关闭（点击遮罩关闭在 JSX onClick 上）──
  useEffect(() => {
    if (!sideOpen) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setSideOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [sideOpen]);

  // ── 会话深链同步（page 专属；dock 无任何 URL 语义，现有行为零变化）──
  // ⚠️ 必须位于下方 `if (!open) return null` 早退**之前**：open 切换时 hooks 数量
  //   必须恒定（Rules of Hooks），守卫写在回调内部而不是不写 hook。
  // store → URL：当前会话变化即写回地址栏。用 replace：会话切换是"状态定位"而非"页面跳转"，
  //   每次切换都 push 会让后退键变成"逐条回放任一会话"。
  useEffect(() => {
    if (!isPage) return;
    const active = state.activeConvId;
    if (active === (urlConvId ?? null)) return;
    navigate(active ? `/chat/${active}` : '/chat', { replace: true });
  }, [isPage, state.activeConvId, urlConvId, navigate]);

  // URL → store：用户改地址栏 / 前进后退 / 外部深链进入。
  // 列表未就绪（readyScope !== scope）时跳过——初始 effect 已按"当时的 URL"做选中，避免双重打开。
  useEffect(() => {
    if (!isPage || !urlConvId) return;
    if (readyScope !== scope) return;
    if (urlConvId === store.getState().activeConvId) return;
    // 深链入口必须过 scope 守卫（质疑#2）；守卫拒绝（跨 scope/已删除）→ 提示并回落列表态，
    // store→URL effect 随后会把地址栏归位到当前真实会话
    void openConversationGuarded(urlConvId).catch((err: unknown) => {
      setConvError(err instanceof Error ? err.message : '切换会话失败');
      navigate('/chat', { replace: true });
    });
    // openConversationGuarded 是同文件回调（执行期解析，闭包无 TDZ）；此处只对 urlConvId 就绪态响应
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPage, urlConvId, readyScope, scope]);

  // ── 发送可用性：enabled / 隐私确认 / 生成中 / 空白输入 ──
  const blocked = useMemo(() => {
    if (configError) return '服务未就绪';
    if (!config) return '正在读取配置…';
    if (!config.enabled) return '未配置模型';
    // T12：ackRequired 时**阻塞发送**并给出确认入口（不静默降级为"不检索"）
    if (config.ackRequired) return '需先确认内容外发';
    if (readyScope !== scope) return '正在切换知识库…';
    if (openingConv) return '正在准备会话…';
    if (state.streaming.active) return '生成中…';
    if (state.messages.some((m) => m.id.startsWith('local-user-'))) return '提问保存状态待确认，请重新打开会话';
    if (!draft.trim()) return '请输入内容';
    return null;
  }, [config, configError, draft, readyScope, scope, openingConv, state.streaming.active, state.messages]);

  // 走查 #5：空草稿的「请输入内容」已由 placeholder 承担；提示行若重复显示，
  // 视觉上就成了"两个输入框"错觉（用户截图）。提示行只在**真阻塞**时让位给原因。
  const hint = !blocked || blocked === '请输入内容' ? 'Enter 发送 · Shift+Enter 换行' : blocked;

  /** 切首页以外的窄屏 → 浮层态（阈值初值 1400，待基线校准） */
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const onResize = (): void => setNarrow(window.innerWidth < CHAT_DOCK_MIN_VIEWPORT);
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  /**
   * REQ-20261009-002（需求 A）：此处原先会轮询检测 `.ki-drawer--fullscreen` 并把整个面板
   * 藏起来（理由"避免空间与层级冲突"）。该行为已按用户拍板**移除**：
   * 全屏阅读器改为让出面板宽度、两者并排（见 ki.css「E. 全屏阅读器与 AI 面板共存」段），
   * 面板开合完全由用户意图决定。轮询随之删除——它还会带来最多 500ms 的"开了又自己关"抖动。
   */

  /**
   * 输入区随内容自动增高（用户反馈：多行草稿时高度不涨，最新一行把顶部内容滚出可视区）。
   *
   * · 先归零再按 `scrollHeight` 设高：高度随内容**可增可减**（不归零则删行后收不回去）；
   *   上下限仍由 ki.css 的 `min-height: 46px / max-height: 176px` 钳制，超限后转为内部滚动。
   *   ⚠️ 上限只认 ki.css（此处不硬编码）；demo/chat-tools-config/index.html 的 `syncComposer`
   *   把 176 写死在 JS 里，改 ki.css 的 max-height 时须同步该 demo，否则两处高度上限漂移。
   * · 挂载即校准：`open` 重开 / 全屏阅读器收起时 textarea 会重新挂到 DOM，此刻 draft 可能
   *   已有多行 → 用 ref 回调在挂载瞬间补一次（否则要等下一次输入才撑开）。
   * · 宽度变化（dock ↔ 窄屏浮层、page 变体、窗口缩放）会改变折行数 → ResizeObserver 兜底；
   *   回调里只比较宽度：改高度同样会触发回调，不比宽度会自激循环。
   */
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const taRoRef = useRef<ResizeObserver | null>(null);
  const syncComposerHeight = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
  }, []);
  const bindComposer = useCallback((el: HTMLTextAreaElement | null) => {
    // 重挂载/卸载：先断旧观察器，避免观察已移除的节点
    taRoRef.current?.disconnect();
    taRoRef.current = null;
    taRef.current = el;
    if (!el) return;
    syncComposerHeight();
    if (typeof ResizeObserver === 'undefined') return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      syncComposerHeight();
    });
    ro.observe(el);
    taRoRef.current = ro;
  }, [syncComposerHeight]);
  // 内容驱动（含程序化改草稿：发送后清空、发送失败回填、切 scope 重置）
  useLayoutEffect(() => {
    syncComposerHeight();
  }, [draft, syncComposerHeight]);

  // ★ 硬约束：隐藏而非卸载（返回 null 不触发组件卸载，store 状态与进行中的流均保留）
  if (!open) return null;

  /** 本轮生成失败的错误态（N4 / S03 §5「连接中断 + 重试入口」）：按 convId 索引的模块级错误槽 */
  const streamError = getStreamError(state.activeConvId);

  /**
   * 加入一条引用（选择器回调）：同 group/doc/text 视为重复，不重复加入。
   *
   * ⚠️ 必须是**普通函数而非 useCallback**：本组件在 `if (!open) return null` 早退之后
   * 不允许再出现 hook（Rules of Hooks）—— 这两处曾误包 useCallback，导致
   * 「点开面板的瞬间整页崩」（React #310：Rendered more hooks than during the previous render），
   * 因为 open=false 时早退不执行它们、open=true 时执行，hook 数量前后不一致。
   */
  const handleAddRef = (ref: ChatRef): void => {
    const cur = store.getState().pendingRefs;
    if (cur.length >= CHAT_REF_MAX_COUNT) return;
    if (cur.some((r) => r.group === ref.group && r.doc === ref.doc && r.text === ref.text)) return;
    // 总量守卫（与正文划选路径同口径）：三条限制必须两两相容，
    // 不能出现"UI 放行、后端 400"的组合
    const usedChars = cur.reduce((n, r) => n + r.text.length, 0);
    if (usedChars + ref.text.length > CHAT_REF_TOTAL_MAX) {
      setRefToast(`引用内容合计不得超过 ${CHAT_REF_TOTAL_MAX} 字（当前 ${usedChars} 字），请先移除部分引用`);
      return;
    }
    store.dispatch({ type: 'setRefs', refs: [...cur, ref] });
    // 成功反馈与「正文划选」路径保持一致（否则两条入口一个提示一个静默）
    setRefToast(`已加入引用：${ref.doc}（${ref.text.length} 字）`);
  };

  /** 移除一条待发送引用（需求 B：已加入的引用必须可单独删除） */
  const handleRemoveRef = (index: number): void => {
    store.dispatch({ type: 'setRefs', refs: store.getState().pendingRefs.filter((_, i) => i !== index) });
  };

  const handleSend = (): void => {
    const text = draft.trim();
    // `sendLockRef` 覆盖"await 期间连点"的窗口（`blocked` 只是渲染期快照）
    if (!text || blocked || sendLockRef.current) return;
    sendLockRef.current = true;
    const operation = ++operationSeqRef.current;
    const reqScope = scope;
    // 引用快照：本轮用「点发送那一刻」的引用（异步等待期间用户可能仍在增删）
    const reqRefs = store.getState().pendingRefs;
    setSendError(null);
    setDraft(''); // 清空输入框（失败时可按错误块重试，见 N4）
    setAtBottom(true); // 新提问必须把视图带回底部（用户此前往上翻过历史时也要跟随）
    void (async () => {
      try {
        // ★ 惰性建会话：当前无会话时先建一条。
        //   原先直接用 `state.activeConvId ?? ''` → 打到 /conversations//messages（必然失败）。
        const convId = store.getState().activeConvId ?? (await createNewConversation());
        if (scopeRef.current !== reqScope || operationSeqRef.current !== operation) return;
        // ★ 引用**发送后不清空**：Q3 拍板「当前对话框内有效」= 同一会话的多轮提问持续携带，
        //   直到用户主动删除，或切换会话 / 切换 scope（清空点见 chatStore.setActiveConv 与本文件 scope effect）
        const persisted = await stream.send(convId, text, reqRefs);
        // ★ 只有收到 `done`（服务端确已落盘）才"以服务端为准"重取：
        //   error / aborted / 中断路径下服务端可能没有新内容 → 重取会把刚渲染的回答**覆盖成旧的**
        //   （用户看到回答凭空消失且无提示）。失败路径改由错误槽 + 重试入口承担。
        if (persisted) await reloadActive(convId);
        else if (getStreamError(convId)?.accepted === false && scopeRef.current === reqScope && operationSeqRef.current === operation) setDraft((cur) => cur || text);
        void refreshConversations();
      } catch (err) {
        if (scopeRef.current === reqScope && operationSeqRef.current === operation) {
          setSendError(err instanceof Error ? err.message : '发送失败');
          setDraft((cur) => cur || text);
        }
      } finally {
        if (operationSeqRef.current === operation) sendLockRef.current = false;
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
    const operation = ++operationSeqRef.current;
    void (async () => {
      try {
        const persisted = await stream.regenerate(convId);
        if (persisted) await reloadActive(convId);
      } catch (err) {
        if (operationSeqRef.current === operation) setSendError(err instanceof Error ? err.message : '重新生成失败');
      } finally {
        if (operationSeqRef.current === operation) sendLockRef.current = false;
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
    const operation = ++operationSeqRef.current;
    void (async () => {
      try {
        const persisted = await stream.editAndResend(convId, msgId, text.trim());
        if (persisted) await reloadActive(convId);
        void refreshConversations();
      } catch (err) {
        if (operationSeqRef.current === operation) setSendError(err instanceof Error ? err.message : '编辑重发失败');
      } finally {
        if (operationSeqRef.current === operation) sendLockRef.current = false;
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
    setConvError(null);
    const reqScope = scope;
    const pending = openConversation(id);
    const selection = selectionSeqRef.current;
    void pending.catch((err: unknown) => {
      if (scopeRef.current === reqScope && selectionSeqRef.current === selection) setConvError(err instanceof Error ? err.message : '切换会话失败');
    });
  };

  const handleCreateConversation = (): void => {
    setConvPopOpen(false);
    setConvError(null);
    const reqScope = scope;
    const pending = createNewConversation();
    const selection = selectionSeqRef.current;
    void pending.catch((err: unknown) => {
      if (scopeRef.current === reqScope && selectionSeqRef.current === selection) setConvError(err instanceof Error ? err.message : '新建会话失败');
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

  /**
   * 统一渲染路径（2026-09-30 用户裁决："生成中看到的东西，完成后位置、样式什么都不要变"）。
   *
   * 流式气泡不再是独立组件 + 独立 JSX 槽位，而是以**虚拟消息**追加进同一消息数组：
   * 同组件、同列表位置、同 key —— `streamEnd` 时只是数据源从 `streaming` 切到
   * 落盘消息与内存留存（progress/reasoningSegs/degraded，内容逐字相同），
   * React 原地复用 DOM：零重挂载、零元素增减。
   */
  const st = state.streaming;
  const bubbles: Array<{ message: ChatMessage; live: boolean; idx: number }> = state.messages
    .map((m, idx) => ({ message: m, live: false, idx }))
    // 重新生成 / 编辑重发：同 id 旧消息让位给虚拟气泡（收尾时 finalizeStream 原位替换）
    .filter((b) => !(st.active && (b.message.id === st.messageId || b.message.id === st.replacingId)));
  if (st.active) {
    bubbles.push({
      message: {
        id: st.messageId ?? '__pending__',
        role: 'assistant',
        content: st.content,
        at: st.startedAt,
        aborted: st.aborted,
        ...(st.sources.length > 0 ? { sources: st.sources } : {}),
      },
      live: true,
      idx: state.messages.length,
    });
  }

  /* ── dock 头部：标题 + 会话胶囊（切换器触发）+ 新建/配置/关闭（page 不渲染：页面 H1 与左栏已承担） ── */
  const dockHeader = (
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
            {/* 对话配置入口（.ki-chat-cfg__entry 由配置层样式提供；面板头空间紧，样式类已禁压缩折行） */}
            <button
              type="button"
              className="ki-chat-cfg__entry"
              title="对话配置"
              aria-haspopup="dialog"
              aria-expanded={cfgOpen}
              onClick={() => setCfgOpen(true)}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M2.6 5.4h10.8M2.6 10.6h10.8" />
                <circle cx="6.2" cy="5.4" r="1.7" />
                <circle cx="9.8" cy="10.6" r="1.7" />
              </svg>
              <span>配置</span>
            </button>
            <button
              type="button"
              className="ki-chat-iconbtn"
              title="关闭 AI 对话"
              aria-label="关闭 AI 对话"
              onClick={() => {
                setConvPopOpen(false);
                setCfgOpen(false);
                onClose();
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="m4 4 8 8M12 4l-8 8" />
              </svg>
            </button>
          </span>
    </header>
  );

  /* ── 主列：上下文条 + 横幅 + 消息流 + 输入区（dock / page 共用；page 在 ctx 注入抽屉钮与配置入口） ── */
  const mainColumn = (
    <>
      {/* ── 上下文条：模型 / 状态（取代原先只读地挂在标题右侧的模型名）── */}
      <div className="ki-chat-ctx">
        {isPage ? (
          <button
            type="button"
            className="ki-chat-iconbtn ki-chatpage__convbtn"
            title="会话列表"
            aria-label="打开会话列表"
            onClick={() => setSideOpen(true)}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h7" /></svg>
          </button>
        ) : null}
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
        {isPage ? (
          <>
            <span className="ki-chatpage__ctx-spacer" />
            <button
              type="button"
              className="ki-chat-cfg__entry"
              title="对话配置"
              aria-haspopup="dialog"
              aria-expanded={cfgOpen}
              onClick={() => setCfgOpen(true)}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
                <path d="M2.6 5.4h10.8M2.6 10.6h10.8" />
                <circle cx="6.2" cy="5.4" r="1.7" />
                <circle cx="9.8" cy="10.6" r="1.7" />
              </svg>
              <span>配置</span>
            </button>
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
            // Content growth is observed separately; only an actual scroll changes sticky intent.
            const next = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            stickyBottomRef.current = next;
            setAtBottom(next);
          }}
        >
          <div className="ki-chat-panel__content">
          {state.messages.length === 0 && !state.streaming.active ? (
            <div className="ki-chat-empty">
              <span className="ki-chat-empty__ic" aria-hidden="true">
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><path d="M2.6 4.2A1.6 1.6 0 0 1 4.2 2.6h7.6a1.6 1.6 0 0 1 1.6 1.6v5a1.6 1.6 0 0 1-1.6 1.6H7.4L4.2 13.4v-2.6H4.2a1.6 1.6 0 0 1-1.6-1.6z" /></svg>
              </span>
              <p className="ki-chat-empty__t">在任意页面提问</p>
              <p className="ki-chat-empty__d">回答会附带知识库来源，点击可回原文并高亮命中片段。</p>
            </div>
          ) : null}

          {bubbles.map(({ message: m, live, idx }) => (
            <MessageBubble
              key={m.id}
              message={m}
              live={live}
              // 兜底：meta/done 校正真实 id 引发重挂载时不播入场动画（防"闪一下"）
              instant={m.id === state.lastStreamedId}
              // N17：降级标记随消息留存（不进冻结的 ChatMessage，见 chatStore.degradedByMessage）；
              // 生成中直读 streaming.degraded，收尾后同一数据经 degradedByMessage 留存 → 显示无缝
              degraded={live ? st.degraded : state.degradedByMessage[m.id] ?? null}
              // 检索痕迹留存（2026-09-30 二次修正）：生成中直读 streaming，刚结束走内存态，
              // 刷新/切会话走落盘的 message.progress；渲染在正文原位（interleave），收尾不跳位、不消失
              progress={live ? st.progress : state.progressByMessage[m.id] ?? chatProgressToSteps(m.progress)}
              // 思考分段（统一渲染路径）：生成中直读 streaming，收尾后走内存留存；
              // 思考不落盘（D7），刷新后历史消息无此数据 → 只剩工具行（口径不变）
              reasoningSegs={live ? st.reasoningSegs : state.reasoningSegsByMessage[m.id]}
              // R24：编辑重发会原子截断该消息之后的全部消息 → 明示条数
              discardCount={state.messages.length - idx - 1}
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
              reasoningExpanded={reasoningExpanded[m.id] ?? {}}
              onToggleReasoning={(segmentKey, next) =>
                setReasoningExpanded((prev) => ({
                  ...prev,
                  [m.id]: { ...prev[m.id], [segmentKey]: next },
                }))
              }
            />
          ))}
          </div>
        </div>

        {/* ── 输入区：分级提示 + composer 卡片 ── */}
        <footer className="ki-chat-panel__foot">
          {atBottom ? null : (
            <button
              type="button"
              className="ki-chat-jump"
              aria-label="回到底部"
              title="回到底部"
              onClick={() => {
                const el = listRef.current;
                if (el) el.scrollTop = el.scrollHeight;
                setAtBottom(true);
              }}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M12 5v14m-6-6 6 6 6-6" />
              </svg>
            </button>
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
            {/* 引用区（REQ-20261009-002 需求 B）：入口常驻可见，已加入的以标签呈现、点标签即移除。
                交互范式对齐文档编辑器「添加链接」：先点按钮 → **在当前打开的文档正文里划选** → 自动加入。
                （用户走查修正：不再先弹模态框；仅当没有打开的文档时才回退到选择器弹层） */}
            {/* 轻提示：3s 自动消失（用户走查反馈：原提示不会自动消失，一直挡在输入框上方） */}
            {refToast ? (
              <div className="ki-chat-refbar__toast" role="status">{refToast}</div>
            ) : null}
            <div className="ki-chat-refbar">
              {state.pendingRefs.map((r, i) => (
                <button
                  key={`${r.group}/${r.doc}/${i}`}
                  type="button"
                  className="ki-chat-refbar__chip"
                  onClick={() => handleRemoveRef(i)}
                  title={`移除引用：${r.group} / ${r.doc}\n${r.text.slice(0, 60)}${r.text.length > 60 ? '…' : ''}`}
                >
                  <span className="ki-chat-refbar__no">{i + 1}</span>
                  <span className="ki-chat-refbar__doc">{r.doc}</span>
                  <span className="ki-chat-refbar__x" aria-hidden="true">✕</span>
                </button>
              ))}
              <button
                type="button"
                className={`ki-chat-refbar__add${refArmed ? ' ki-chat-refbar__add--armed' : ''}`}
                onClick={() => {
                  if (refArmed) {
                    setRefArmed(false);
                    return;
                  }
                  // 有打开的文档 → 直接在正文里划选（用户口径）；没有可划选的内容时才回退到选择器弹层
                  if (document.querySelector('.ki-drawer')) {
                    setRefArmed(true);
                    setRefToast('在正文中划选要引用的内容（再点按钮取消）');
                  } else {
                    setRefPickerOpen(true);
                  }
                }}
                disabled={!(config?.enabled ?? false) || state.pendingRefs.length >= CHAT_REF_MAX_COUNT}
                title={
                  state.pendingRefs.length >= CHAT_REF_MAX_COUNT
                    ? `一次提问最多引用 ${CHAT_REF_MAX_COUNT} 段内容`
                    : refArmed
                      ? '点击取消引用模式'
                      : '点击后，在打开的文档正文里划选要引用的内容'
                }
              >{refArmed ? '在正文中划选…' : '+ 加入引用'}</button>
            </div>
            <textarea
              className="ki-chat-composer__ta"
              ref={bindComposer}
              value={draft}
              maxLength={MAX_SEND_CHARS}
              placeholder={blocked ?? '输入问题，Enter 发送（Shift+Enter 换行）'}
              disabled={Boolean(config && !config.enabled)}
              /* ⚠️ 不标记 data-ki-search-input：否则 AppShell 的 Ctrl+F 会聚焦到这里而非页面搜索框 */
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  handleSend();
                }
              }}
            />
            <div className="ki-chat-composer__bar">
              <span className="ki-chat-composer__hint">{hint}</span>
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
    </>
  );

  /* ── page 左栏：常驻会话列表（inline 变体；搜索/重命名/归档/删除二次确认全部复用浮层版能力） ── */
  const sideList = (
    <ConversationList
      variant="inline"
      open
      items={allConvs}
      activeId={state.activeConvId}
      loading={convLoading}
      error={convError}
      onClose={() => undefined}
      onSelect={(id) => { handleSelectConversation(id); setSideOpen(false); }}
      onCreate={() => { handleCreateConversation(); setSideOpen(false); }}
      onRefresh={() => void refreshConversations()}
      onRename={handleRename}
      onArchive={handleArchive}
      onDelete={handleDelete}
    />
  );

  return (
    <>
      {isPage ? (
        <aside className="ki-chat-panel ki-chat-panel--page" aria-label="AI 对话页面">
          <div className="ki-chatpage__side" data-open={sideOpen ? 'true' : 'false'}>
            {sideList}
          </div>
          <div
            className="ki-chatpage__mask"
            data-open={sideOpen ? 'true' : 'false'}
            onClick={() => setSideOpen(false)}
            aria-hidden="true"
          />
          <section className="ki-chatpage__main">
            {mainColumn}
            {/* ── 对话配置层：absolute inset:0 相对 .ki-chat-panel，page 下覆盖整个双栏区 ── */}
            {cfgOpen && <PromptConfigLayer onClose={() => setCfgOpen(false)} />}
          </section>
        </aside>
      ) : (
        <aside
          className={`ki-chat-panel${narrow ? ' ki-chat-panel--overlay' : ''}`}
          aria-label="AI 对话面板"
          data-narrow={narrow ? 'true' : 'false'}
        >
          {dockHeader}
          {mainColumn}
          {/* ── 对话配置层：面板内层（absolute inset:0）；编辑模态由它 portal 到 body ── */}
          {cfgOpen && <PromptConfigLayer onClose={() => setCfgOpen(false)} />}
        </aside>
      )}

      {/* 引用选择器（需求 B）：**复用「添加链接」的文档选择模态（ReaderLinkComposer mode="ref"）**
          ——用户拍板不另起炉灶；portal 到 body，双栏选择器放不进 380px 面板。
          initialDoc 取当前正在读的原文，用户不必再从树里找一遍 */}
      {refPickerOpen ? (
        <ReaderLinkComposer
          mode="ref"
          scope={scope}
          currentRefs={state.pendingRefs}
          initialDoc={viewing ? { group: viewing.group, doc: viewing.module } : undefined}
          onAddRef={handleAddRef}
          onClose={() => setRefPickerOpen(false)}
        />
      ) : null}

      {/* 来源引用点击 → 打开原文并高亮（复用既有 ModuleDrawer） */}
      {viewing ? (
        <ModuleDrawer
          // key 含 query：同一文档的不同引用片段能重新挂载 → 重新定位/高亮
          key={`${scope}:${viewing.group}:${viewing.module}:${viewing.query}`}
          scope={scope}
          module={viewing.module}
          group={viewing.group}
          highlightQuery={viewing.query}
          fullscreenActions={<ChatToggleButton />}
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
  live,
  degraded,
  progress,
  reasoningSegs,
  discardCount,
  reasoningExpanded,
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
  instant,
}: {
  message: ChatMessage;
  /** 生成中的虚拟消息（store.streaming 直读）：与完成态共用本组件，收尾仅换数据源 */
  live?: boolean;
  /** N17：本条的降级标记（来自 store.degradedByMessage；生成结束后仍保留，回看历史可见） */
  degraded?: DegradedMark | null;
  /** 本条的检索过程（原位渲染在正文流中；生成结束后不消失，与流式期间同一位置） */
  progress?: ProgressStep[];
  /** 本条的思考分段（live 直读 streaming；收尾后走 reasoningSegsByMessage 内存留存） */
  reasoningSegs?: ReasoningSegment[];
  /** R24：编辑重发将截断其后的消息条数（0 表示无截断） */
  discardCount: number;
  reasoningExpanded: Record<string, boolean>;
  onToggleReasoning: (segmentKey: string, next: boolean) => void;
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
  /** 刚从流式收尾重挂载的消息：跳过入场动画（防"完成后闪一下"，见 chatStore.lastStreamedId） */
  instant?: boolean;
}): JSX.Element {
  const isUser = message.role === 'user';
  return (
    <div className={`ki-chat-msg ki-chat-msg--${message.role}${live ? ' ki-chat-msg--streaming' : ''}${instant ? ' ki-chat-msg--instant' : ''}`}>
      {/* 元信息行：角色 / 时间 / 状态徽标（原先只有气泡，看不出谁说的、什么时候、是否完整） */}
      <div className="ki-chat-msg__meta">
        {!isUser ? <span className="ki-chat-avatar" aria-hidden="true">k</span> : null}
        {!isUser ? <span className="ki-chat-msg__role">kisearch</span> : null}
        {/* startedAt 未注入（如纯 reducer 场景）时兜底"刚刚"；落盘消息恒为真实时间 */}
        <span className="ki-chat-msg__at">{formatMsgTime(message.at) || '刚刚'}</span>
        {message.id.startsWith('local-assistant-') ? <span className="ki-chat-msg__badge ki-chat-msg__badge--abort">未保存的部分回答</span> : null}
        {isUser && message.id.startsWith('local-user-') && canEdit ? <span className="ki-chat-msg__badge ki-chat-msg__badge--abort">保存状态待确认</span> : null}
        {message.aborted ? <span className="ki-chat-msg__badge ki-chat-msg__badge--abort">已中止</span> : null}
        {!isUser && degraded ? (
          <span className="ki-chat-msg__badge ki-chat-msg__badge--degrade">{degraded.label}</span>
        ) : null}
      </div>

      {/* N17：降级标记必须可见，不得静默 */}
      {!isUser && degraded ? (
        <div className="ki-chat-msg__degraded" role="status">{degraded.label}</div>
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
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && (e.metaKey || e.ctrlKey)) onEditSubmit(e.currentTarget.value);
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
      ) : isUser ? (
        <div className="ki-chat-msg__body">
          {/* 用户输入是纯文本：不渲染 Markdown（避免把用户输入的 markdown 当富文本执行） */}
          <p className="ki-chat-msg__text">{message.content}</p>
          {/* 本轮提问引用的文档片段（REQ-20261009-002 R11）：刷新 / 切回会话后仍可见 */}
          {message.refs && message.refs.length > 0 ? (
            <ul className="ki-chat-refs" aria-label={`本轮引用了 ${message.refs.length} 段内容`}>
              {message.refs.map((r, i) => (
                <li key={`${r.group}/${r.doc}/${i}`} className="ki-chat-refs__item" title={r.text}>
                  <span className="ki-chat-refs__no">{i + 1}</span>
                  <span className="ki-chat-refs__doc">{r.doc}</span>
                  <span className="ki-chat-refs__group">{r.group}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : (
        /* 统一渲染路径（2026-09-30 四次修正，用户裁决："完成后什么都不要变"）：
           生成中与完成态走同一个 AnswerFlow——正文段、思考块、检索行按 afterChars
           锚点交错；收尾仅数据源从 streaming 换为留存（内容逐字相同），DOM 原地复用 */
        <AnswerFlow
          content={message.content}
          steps={progress ?? []}
          segs={reasoningSegs ?? []}
          live={Boolean(live)}
          reasoningExpanded={reasoningExpanded}
          onToggleReasoning={onToggleReasoning}
        />
      )}

      {/* 来源引用（R20）：空数组时 SourcesList 自身渲染 null */}
      {!isUser ? <SourcesList sources={message.sources ?? []} onOpen={onOpenSource} /> : null}

      {/* 消息级操作条：最后一条常驻可见，其余 hover / 键盘聚焦时出现；
          生成中的回答不出现（2026-09-30 用户裁决），收尾后随完成态一并显示 */}
      {live && !isUser ? null : (
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
            // 直接发起 API-12 必然 404；meta 确认真实 id 或重取历史后才可编辑。
            disabled={!canEdit || message.id.startsWith('local-user-')}
            title={
              message.id.startsWith('local-user-') ? (canEdit ? '保存状态待确认，请重新打开会话' : '提问确认后可编辑重发')
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
      )}
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
/** 落盘的步骤摘要 → 时间线步骤（刷新 / 切会话后仍能在原位回看检索过程） */
function chatProgressToSteps(steps: readonly ChatProgressStep[] | undefined): ProgressStep[] | undefined {
  if (!steps || steps.length === 0) return undefined;
  // 复用 useChatStream 的同一套文案函数 → "生成中看到的"与"刷新后回看的"措辞一致；
  // 摘要字段（name/mode/hits/durationMs/error）一并透传，供时间线行与卡片渲染
  return steps.map((s) =>
    s.phase === 'end'
      ? { ...toolEndStep(s.hits ?? 0, s.error, { name: s.name, mode: s.mode, durationMs: s.durationMs, response: s.response }), afterChars: s.afterChars }
      : { ...toolStartStep(s.mode, s.name), afterChars: s.afterChars },
  );
}

/**
 * assistant 回答主体 —— **生成中与完成态的唯一渲染路径**（统一渲染路径重构）。
 *
 * 正文段、思考块、检索痕迹按 afterChars 锚点交错（用户裁决：在哪句话之后发生，
 * 就显示在哪句话下面）。live（生成中）与完成态**结构完全一致**，仅两处语义差：
 * · aria 标记（role=status 播报只属于进行中的反馈）
 * · 无任何内容时的占位行（N10 不得出现无反馈空白，只在 live 出现）
 * 收尾时数据源从 streaming 换为内存留存（内容逐字相同）→ DOM 原地复用，零增减。
 */
function AnswerFlow({
  content,
  steps,
  segs,
  live,
  reasoningExpanded,
  onToggleReasoning,
}: {
  content: string;
  steps: ProgressStep[];
  segs: ReasoningSegment[];
  live: boolean;
  reasoningExpanded: Record<string, boolean>;
  onToggleReasoning: (segmentKey: string, next: boolean) => void;
}): JSX.Element {
  const previousBlocks = useRef<MarkdownBlock[]>([]);
  const blocks = useMemo(() => {
    const next = renderMarkdownBlocks(content, previousBlocks.current);
    previousBlocks.current = next;
    return next;
  }, [content]);
  const items = mergeInterleaveItems(buildTimeline(steps), segs);
  if (live && !content && items.length === 0) return (
    <div className="ki-chat-tl" role="status" aria-live="polite">
      <div className="ki-chat-tl__node ki-chat-tl__node--run"><span className="ki-chat-tl__label">正在连接模型…</span></div>
    </div>
  );
  const liveAttrs: { role?: 'status'; 'aria-live'?: 'polite' } =
    live ? { role: 'status', 'aria-live': 'polite' } : {};
  return (
    <>
      {layoutAnswerFlow(blocks, items).map((seg) => (
        seg.kind === 'markdown'
          ? (
            <div key={seg.block.key} className="ki-chat-msg__body">
              <MarkdownPreview text={seg.block.raw} renderedHtml={seg.block.html} deferMermaid={live && !seg.block.complete} />
            </div>
          )
          : (
            <Fragment key={seg.key}>
              {seg.items.map((it) => (
                it.kind === 'reason'
                  ? (
                    <ReasoningBlock
                      key={it.key}
                      text={it.text}
                      streaming={!it.closed}
                      open={Boolean(reasoningExpanded[it.key])}
                      onToggle={(next) => onToggleReasoning(it.key, next)}
                    />
                  )
                  : (
                    <div key={it.key} className="ki-chat-tl" {...liveAttrs}>
                      {it.kind === 'tool'
                        ? <ToolRow n={it} />
                        : (
                          <div className={`ki-chat-tl__node ki-chat-tl__node--${it.kind}${it.running ? ' ki-chat-tl__node--run' : ''}`}>
                            <span className="ki-chat-tl__label">{it.label}</span>
                          </div>
                        )}
                    </div>
                  )
              ))}
            </Fragment>
          )
      ))}
    </>
  );
}

/** 时间线工具行（demo D9）：动作名 + 工具胶囊 + 状态 + 展开卡；无摘要字段时退化为纯文本行 */
function ToolRow({ n }: { n: TimelineNode }): JSX.Element {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(n.name || n.mode || n.query || n.hits !== undefined || n.error || n.response);
  if (!hasDetail) {
    // 退化行（无摘要字段的旧数据）：不带 --tool 类 —— 否则 D9 的 cursor:pointer + hover
    // 会暗示可点击，而它其实没有展开内容
    return (
      <div className={`ki-chat-tl__node${n.running ? ' ki-chat-tl__node--run' : ''}`}>
        <span className="ki-chat-tl__label">{n.label}</span>
      </div>
    );
  }
  const stat = n.error
    ? '失败'
    : n.running
      ? `${n.mode ? `${n.mode} · ` : ''}检索中…`
      : n.hits !== undefined
        ? `${n.mode ? `${n.mode} · ` : ''}${n.hits} 命中${n.durationMs !== undefined ? ` · ${n.durationMs}ms` : ''}`
        : n.label;
  const toggle = (): void => setOpen((v) => !v);
  return (
    <>
      <div
        className={`ki-chat-tl__node ki-chat-tl__node--tool${n.running ? ' ki-chat-tl__node--run' : ''}${n.error ? ' ki-chat-tl__node--tool-fail' : ''}`}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        title={open ? '收起调用详情' : '展开调用详情'}
        onClick={toggle}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
      >
        <span className="ki-chat-tl__label ki-chat-tl__act">检索知识库</span>
        {n.name ? <span className="ki-chat-tl__tool">{n.name}</span> : null}
        <span className="ki-chat-tl__stat">{stat}</span>
        <svg className="ki-chat-tl__chev" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="M6.5 4 10.5 8 6.5 12" />
        </svg>
      </div>
      {open ? <ToolCard n={n} /> : null}
    </>
  );
}

/**
 * 展开卡片：原样展示后端统一限长的实际返回文本；旧记录明确标记正文缺失。
 */
function ToolCard({ n }: { n: TimelineNode }): JSX.Element {
  const args: Record<string, string> = {};
  if (n.query) args.query = n.query;
  if (n.mode) args.mode = n.mode;
  const hasQuery = Object.keys(args).length > 0;
  const hasArgs = hasQuery || Boolean(n.args);
  return (
    <div className="ki-chat-tool">
      {hasArgs ? (
        <section className="ki-chat-tool__sec">
          <div className="ki-chat-tool__label">入参{n.mode ? <em>mode {n.mode}</em> : null}</div>
          {hasQuery ? <JsonCode obj={args} /> : null}
          {n.args ? <pre className="ki-chat-tool__code">{n.args}</pre> : null}
        </section>
      ) : null}
      {n.response ? (
        <section className="ki-chat-tool__sec">
          <div className="ki-chat-tool__label">响应<em>{n.hits} 命中{n.durationMs !== undefined ? ` · ${n.durationMs}ms` : ''}</em></div>
          {n.response.truncated ? <p className="ki-chat-tool__note ki-chat-tool__note--warn">原返回 {n.response.originalChars} 字符，超过 10000 字符已截断。AI 收到相同内容。</p> : null}
          <pre className="ki-chat-tool__code ki-chat-tool__code--response">{n.response.text}</pre>
        </section>
      ) : n.hits !== undefined && !n.error ? (
        <section className="ki-chat-tool__sec">
          <div className="ki-chat-tool__label">响应摘要</div>
          <p className="ki-chat-tool__note">命中 {n.hits} 条。旧记录未保存工具返回正文。</p>
        </section>
      ) : null}
      {n.error ? (
        <section className="ki-chat-tool__sec">
          <div className="ki-chat-tool__label">错误<em>未产生检索结果</em></div>
          <pre className="ki-chat-tool__err">{n.error}</pre>
          <p className="ki-chat-tool__note ki-chat-tool__note--warn">这一步没有检索结果，回答未引用其内容。</p>
        </section>
      ) : null}
      {n.running ? <p className="ki-chat-tool__note">本步骤进行中，完成后回写命中与耗时。</p> : null}
    </div>
  );
}

/** 扁平 JSON 着色渲染（demo ki-chat-tool__code 的 .k/.s/.n 同款） */
function JsonCode({ obj }: { obj: Record<string, string | number | boolean> }): JSX.Element {
  const entries = Object.entries(obj);
  return (
    <pre className="ki-chat-tool__code">
      {'{\n'}
      {entries.map(([k, v], i) => (
        <span key={k}>
          {'  '}<span className="k">&quot;{k}&quot;</span>:{' '}
          {typeof v === 'number' || typeof v === 'boolean'
            ? <span className="n">{String(v)}</span>
            : <span className="s">&quot;{v}&quot;</span>}
          {i < entries.length - 1 ? ',' : ''}{'\n'}
        </span>
      ))}
      {'}'}
    </pre>
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

  return (
    <div className="ki-chat-reason">
      <button
        type="button"
        className="ki-chat-reason__toggle"
        aria-expanded={open}
        title="思考内容仅本次会话可见，留存于页面内存，不写入记录"
        onClick={() => onToggle(!open)}
      >
        {/* 不显示字数（2026-09-30 用户裁决）：生成中只挂加载动画，完成后标题保持干净 */}
        {open ? '收起' : '展开'}{streaming ? '思考中' : '思考过程'}
        {streaming ? <span className="ki-chat-reason__spin" aria-hidden="true" /> : null}
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
  const subscribe = useCallback((listener: () => void) => {
    let frame = 0;
    const unsubscribe = store.subscribe(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => { frame = 0; listener(); });
    });
    return () => { unsubscribe(); cancelAnimationFrame(frame); };
  }, [store]);
  return useSyncExternalStore(subscribe, store.getState, store.getState);
}
