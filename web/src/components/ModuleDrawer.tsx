/**
 * ModuleDrawer.tsx —— 原文查看抽屉（右侧滑出 + scrim + 复制）
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type CompositionEvent as ReactCompositionEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { ReaderLinkComposer, type ReaderLinkSelection } from '@/components/ReaderLinkComposer';
import { anchorBlock, findAnchorBlocks } from '@/lib/kiLinks';
import { selectHighlightTerms } from '@/lib/searchText';
import { useDocumentEditor } from '@/lib/documentEditorContext';
import {
  DOC_FIND_DEBOUNCE_MS,
  DOC_FIND_MARK_LIMIT,
  DOC_FIND_OPEN_EVENT,
  DOC_FIND_QUERY_MAX,
  type DocFindOpenDetail,
  buildFindTerms,
  clampFindQuery,
  describeFindLimit,
  describeFindMiss,
  formatFindCount,
  pickFindSeed,
  stepFindIndex,
} from '@/lib/docFind';

/** 头部导航箭头（描边 SVG，替代此前易显粗糙的文本箭头 → / ←） */
const ICON_DRAWER_COLLAPSE = (
  <svg className="ki-drawer__close-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 6.5 15 12l-5.5 5.5" />
  </svg>
);

const ICON_NAV_PREV = (
  <svg className="ki-drawer__nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14.5 6.5 9 12l5.5 5.5" />
  </svg>
);

const ICON_NAV_NEXT = (
  <svg className="ki-drawer__nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M9.5 6.5 15 12l-5.5 5.5" />
  </svg>
);

/** 文档内查找入口（放大镜） */
const ICON_FIND = (
  <svg className="ki-drawer__find-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-3.7-3.7" />
  </svg>
);

/**
 * 「本文档内查找」模式的图标（文档 + 放大镜）。
 * 与「搜索全库文档」共用同一个输入框，图标是肉眼区分当前范围的三个信号之一
 * （另两个：placeholder 文案、右侧分段的选中态）。
 */
const ICON_SEARCH_DOC = (
  <svg className="ki-drawer__search-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
    <path d="M14 3v5h5" />
    <circle cx="11.5" cy="14" r="2.6" />
    <path d="m13.6 16.1 1.9 1.9" />
  </svg>
);

/** 「搜索全库文档」模式的图标（纯放大镜，与外层图标同形） */
const ICON_SEARCH_GLOBAL = (
  <svg className="ki-drawer__search-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-3.7-3.7" />
  </svg>
);

/** 正文快速滚动按钮图标 */
const ICON_SCROLL_TOP = (
  <svg className="ki-scroll-nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 14.5 12 8.5l6 6" />
  </svg>
);

const ICON_SCROLL_BOTTOM = (
  <svg className="ki-scroll-nav__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9.5 12 15.5l6-6" />
  </svg>
);

const ICON_OUTLINE = (
  <svg className="ki-document-outline__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 6h12" />
    <path d="M8 12h12" />
    <path d="M8 18h12" />
    <path d="M3.5 6h.01" />
    <path d="M3.5 12h.01" />
    <path d="M3.5 18h.01" />
  </svg>
);

const ICON_OUTLINE_COLLAPSE = (
  <svg className="ki-document-outline__toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m15 6-6 6 6 6" />
  </svg>
);

const ICON_OUTLINE_EXPAND = (
  <svg className="ki-document-outline__toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const DOC_HIGHLIGHT_CLASS = 'ki-doc-highlight';
const DOC_HIGHLIGHT_ACTIVE_CLASS = 'ki-doc-highlight--active';

/**
 * 命中应用后的复扫时点（ms）。
 *
 * Markdown 里的 mermaid / 代码块是**异步渲染**的，会在首轮应用之后替换子树，
 * 把手动插入的 `mark` 一并丢掉 —— 表现为「计数 200、DOM 只剩 196」（既有偏差，2026-10-14 实测复现）。
 * 这两个时点各复扫一次：确实少了就重新应用（`applyDocumentHighlights` 幂等），
 * 仍少于统计值则把计数收敛到 DOM 实际值（R4：计数必须等于可导航命中数）。
 */
const DOC_HIGHLIGHT_RESCAN_DELAYS = [400, 1200];

function escapeHighlightRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 正文高亮词表有两个来源，由调用方决定（都经本函数构造成一条 OR 正则）：
 *
 * - **外部 `highlightQuery`**（检索命中 / AI 引用片段）：用 `selectHighlightTerms`，即检索口径
 *   （中文 2~4 字滑窗 + 停用词 + 按全文频次剔除 2 字泛词）——保持既有行为不变；
 * - **用户主动查找**：用 `lib/docFind::buildFindTerms` 的**字面词表**（不做泛词剔除），
 *   对齐浏览器 Ctrl+F 的心智：输 `ku` 就要看到所有 `ku`（见 docFind.ts 顶部注释的实测缺陷说明）。
 */
function buildHighlightPattern(terms: string[]): RegExp | null {
  const escaped = terms
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length)
    .map(escapeHighlightRegExp);
  return escaped.length > 0 ? new RegExp(`(${escaped.join('|')})`, 'gi') : null;
}

function clearDocumentHighlights(root: HTMLElement): void {
  const touched = new Set<Node>();
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(`mark.${DOC_HIGHLIGHT_CLASS}`))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    touched.add(parent);
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
  }
  /*
   * 合并被高亮切碎的相邻文本节点。
   *
   * 匹配是**逐文本节点**做的（见 applyDocumentHighlights），若只把 mark 的子节点原样插回而不合并，
   * 先前的高亮会把词永久拆碎：搜过 `contex` 之后，正文里的 `context` 变成 `"contex"` + `"t"`
   * 两个相邻文本节点，再搜 `context` 两个碎片都匹配不到 ⇒ 计数 0、显示「未找到」，且**重新输入无法自愈**。
   * 用户逐字打字（c → co → con → …）会不断累积碎片，最终必然踩到。
   * normalize 只合并相邻文本节点、不改元素结构（实测 2026-10-14 复现与修复验证）。
   */
  for (const node of touched) node.normalize();
}

interface DocumentHighlightResult {
  /** 实际包裹的命中数（=== 此刻 DOM 中可导航的 mark 数） */
  count: number;
  /** 是否因命中上限提前停止（确认还有未显示的命中） */
  truncated: boolean;
}

interface DocumentHighlightOptions {
  /** 命中词表；缺省时按检索口径（selectHighlightTerms）从 query + 全文统计推导 */
  terms?: string[];
  /** 命中上限（默认 DOC_FIND_MARK_LIMIT） */
  limit?: number;
}

/**
 * 在已安全渲染的 Markdown 文本节点上包裹 mark，不拼接原始 HTML。
 *
 * 与历史实现的唯一差别是**上限**（R8）：单字查询在长文档里可命数千处，无上限时每次重算都要
 * 建/删同样数量的 mark 并触发整页重排。达到上限即停止包裹，并只多扫一跳用于确认「确实还有更多」。
 */
function applyDocumentHighlights(
  root: HTMLElement,
  query: string,
  options: DocumentHighlightOptions = {},
): DocumentHighlightResult {
  const { terms, limit = DOC_FIND_MARK_LIMIT } = options;
  clearDocumentHighlights(root);

  const textNodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const parent = text.parentElement;
    // 页面生成的复制控件与查找栏本身不是原文，不能参与命中计数/自动定位；
    // 多语言代码块里**未显示**的语言同理——合成 TreeWalker 不看 CSS 可见性，不显式排除就会
    // 出现「命中数比看得见的多、点『下一条』跳到一片空白」（原型 temp/code-group-demo 实测 5 个文本节点）。
    if (text.nodeValue && parent
      && !parent.closest('script,style,svg,button,[aria-live],.ki-drawer__findbar,.ki-code-panel[hidden]')) textNodes.push(text);
    node = walker.nextNode();
  }

  // 未显式给出词表时按检索口径自适应（先收集文本再建 pattern：泛词剔除依赖整篇的出现频次）
  const pattern = buildHighlightPattern(
    terms ?? selectHighlightTerms(query, textNodes.map((text) => text.nodeValue ?? '').join('\n')),
  );
  if (!pattern) return { count: 0, truncated: false };

  let count = 0;
  let truncated = false;
  for (const textNode of textNodes) {
    if (truncated) break;
    const value = textNode.nodeValue ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let matched = false;
    const fragment = root.ownerDocument.createDocumentFragment();
    while ((match = pattern.exec(value)) !== null) {
      if (count >= limit) { truncated = true; break; }
      matched = true;
      if (match.index > lastIndex) fragment.appendChild(root.ownerDocument.createTextNode(value.slice(lastIndex, match.index)));
      const mark = root.ownerDocument.createElement('mark');
      mark.className = DOC_HIGHLIGHT_CLASS;
      mark.textContent = match[0];
      fragment.appendChild(mark);
      count += 1;
      lastIndex = match.index + match[0].length;
    }
    if (!matched) continue;
    if (lastIndex < value.length) fragment.appendChild(root.ownerDocument.createTextNode(value.slice(lastIndex)));
    textNode.replaceWith(fragment);
  }
  return { count, truncated };
}

/**
 * 定位第 index 个命中，并在 `scroll` 为真时滚动居中；**返回 DOM 中此刻实际存在的 mark 数**。
 *
 * 返回值供调用方校正计数：查找时统计到的命中数可能多于此刻 DOM 里的 mark
 * （React 重渲染某棵子树会把手动插入的 mark 一并丢掉）。若计数只认统计值，
 * 用户就会看到「5/200」却跳不动 —— 那是一条错误的用户可见事实（R4）。
 *
 * `scroll=false`：只切 active 标记、不移动视口（混合检索"高亮但不跳转"，REQ-20261014-003 Q8）。
 */
function focusDocumentHighlight(body: HTMLDivElement, index: number, behavior: ScrollBehavior, scroll = true): number {
  const marks = Array.from(body.querySelectorAll<HTMLElement>(`mark.${DOC_HIGHLIGHT_CLASS}`));
  marks.forEach((mark, markIndex) => mark.classList.toggle(DOC_HIGHLIGHT_ACTIVE_CLASS, markIndex === index));
  const target = marks[index];
  if (target && scroll) {
    const bodyRect = body.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = body.scrollTop + targetRect.top - bodyRect.top - (body.clientHeight - targetRect.height) / 2;
    body.scrollTo({ top: Math.max(0, top), behavior });
  }
  return marks.length;
}

interface OutlineHeading {
  id: string;
  level: number;
  label: string;
}

interface DocumentOutlineProps {
  headings: OutlineHeading[];
  collapsed: boolean;
  onToggle: () => void;
  onNavigate: (id: string) => void;
}

function DocumentOutline({ headings, collapsed, onToggle, onNavigate }: DocumentOutlineProps): JSX.Element {
  return (
    <nav
      className={`ki-document-outline${collapsed ? ' ki-document-outline--collapsed' : ''}`}
      aria-label="文档大纲"
    >
      <button
        className="ki-document-outline__toggle"
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-label={collapsed ? '展开文档大纲' : '折叠文档大纲'}
        title={collapsed ? '展开文档大纲' : '折叠文档大纲'}
      >
        {ICON_OUTLINE}
        {!collapsed && <span className="ki-document-outline__title">大纲</span>}
        {collapsed ? ICON_OUTLINE_EXPAND : ICON_OUTLINE_COLLAPSE}
      </button>
      {!collapsed && (
        <ol className="ki-document-outline__list">
          {headings.map((heading) => (
            <li key={heading.id}>
              <button
                className="ki-document-outline__item"
                type="button"
                onClick={() => onNavigate(heading.id)}
                title={heading.label}
                style={{ paddingLeft: `${8 + Math.max(0, heading.level - 1) * 14}px` }}
              >
                {heading.label}
              </button>
            </li>
          ))}
        </ol>
      )}
    </nav>
  );
}

interface ModuleDrawerProps {
  scope: string;
  module: string;
  /** Group 路径（fetcher 需要时传入） */
  group?: string;
  initialContent?: string;
  /** 完整原文不可用时展示的搜索命中片段。 */
  fallbackContent?: string;
  /** 全文检索上下文；缺省时为普通阅读，不显示命中导航。 */
  highlightQuery?: string;
  /**
   * 打开文档时是否**自动滚动**到首个命中（缺省 `true` = 既有行为）。
   *
   * 混合检索（语义召回）传 `false`（REQ-20261014-003 Q8）：命中照常全部标记、工具条照常给
   * `1/N` 计数，但视口停在文档顶部不跳转；用户**主动**跳转（「下一个命中」/ 查找栏输入）后恢复滚动。
   * 全文检索与 AI 引用片段保持缺省 —— 那两条链路的语义就是"定位到命中"（J1 / J2），不得改变。
   */
  highlightAutoScroll?: boolean;
  targetAnchor?: string;
  editable?: boolean;
  onClose: () => void;
  fetcher?: (scope: string, group: string, relation: string) => Promise<{ content?: string; error?: string; hint?: string }>;
  onLocalLink?: (href: string) => boolean;
  canGoBack?: boolean;
  onBack?: () => void;
  canGoForward?: boolean;
  onForward?: () => void;
  /** 受控全屏状态；传入后由外层 BrowsePage 保留状态，切换文档不会丢失。 */
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  /** 受控大纲折叠状态；传入后由外层页面保留同一全屏会话内的选择。 */
  outlineCollapsed?: boolean;
  onOutlineCollapsedChange?: (collapsed: boolean) => void;
  /** 全屏时显示在阅读正文左侧的导航工作区（Group 树）。 */
  fullscreenNavigation?: ReactNode;
  /** 全屏时显示在头部中央的工具区（如全库搜索框）。 */
  fullscreenToolbar?: ReactNode;
  /**
   * 全屏时显示在头部动作区最前的动作节点（如「AI 对话」开关）。
   *
   * REQ-20261009-002 需求 A：全屏层（z-index 1000）会盖住顶栏开关，面板未打开时
   * 用户在全屏中没有任何 AI 入口 → 由页面注入一个开关。
   * 本组件不依赖 chat 模块，节点由调用方提供（保持 components 与 chat 解耦）。
   */
  fullscreenActions?: ReactNode;
  /** 常驻模式（浏览页双栏的右栏）：不渲染遮罩与 dialog 语义，容器改为内联定位，隐藏关闭按钮。 */
  inline?: boolean;
  /**
   * 内联阅读态：头部常驻搜索框**左侧**的页级控件（浏览页的标签过滤器）。
   *
   * 2026-10-16 一行化：浏览页阅读态原为**两行**头部（页面的 `.ki-reader-toolbar` 55px +
   * 本组件的 `.ki-drawer__head` 71.5px = 126.5px，占阅读区 16% 且不随滚动消失）。
   * 传入 `inlineSearch` 时本组件接管整行：`[nav][inlineBar][搜索框+模式分段][inlineActions][动作]`，
   * 标题与 meta 不再占用头部（文档身份由左栏选中态与正文首块承担）。
   */
  inlineBar?: ReactNode;
  /**
   * 内联阅读态头部的**常驻搜索框**（「全库」侧受控）。
   *
   * 为什么由本组件渲染而不是页面插槽传入：同一个输入框要同时承担「文档内查找」，
   * 而后者依赖组件内部的高亮内核（`applyDocumentHighlights` / 计数 / ↑↓ 导航）；
   * 若由页面渲染、状态分居两处，模式与命中计数必然漂移。
   *
   * 传入后：
   * - 「全库」模式 = 本接口受控（值即浏览页检索词），输入交由页面驱动结果列表；
   * - 「本文」模式 = 复用既有查找内核（`findOpen`），输入即在正文高亮并可 ↑↓ 导航；
   * - 内联态的标题/meta 与动作区里的放大镜（就地展开查找栏）**不再渲染**（模式分段取代其入口）；
   * - Ctrl+F 判定链不变：查看器内一律进「本文」模式并聚焦本框（有选中文本则带入）。
   */
  inlineSearch?: {
    /** 「全库」模式的输入值（页面受控） */
    value: string;
    onChange: (value: string) => void;
    /** 「清空」按钮（常驻在「全库|本文」右侧）：清空检索词与标签筛选，由页面执行 */
    onClear?: () => void;
    placeholder?: string;
  };
  /** 内联阅读态动作区**最前**的页级动作（浏览页的「居中/铺满」正文宽度切换）。 */
  inlineActions?: ReactNode;
  /**
   * 用**页级内容**替换正文区（浏览页把「全库搜索结果列表」交给本组件承载）。
   *
   * 为什么不让页面"卸载查看器、换回自己的工具栏"：那会让头部整体换一套 DOM，
   * 用户看到的是「一开始全库搜索，头部样式就大变样」（2026-10-16 反馈）。
   * 保持挂载后头部**完全连续**，只是文档动作按钮因为"当前没有可操作的正文"而禁用。
   * ⚠️ 传入时：文档内查找（Ctrl+F / 「本文」）不响应 —— 正文此刻不是文档，搜它没有意义。
   */
  bodySlot?: ReactNode;
}

export function ModuleDrawer({
  scope,
  module,
  group,
  initialContent,
  fallbackContent,
  highlightQuery,
  highlightAutoScroll = true,
  targetAnchor,
  editable = false,
  onClose,
  fetcher,
  onLocalLink,
  canGoBack = false,
  onBack,
  canGoForward = false,
  onForward,
  fullscreen: controlledFullscreen,
  onFullscreenChange,
  outlineCollapsed: controlledOutlineCollapsed,
  onOutlineCollapsedChange,
  fullscreenNavigation,
  fullscreenToolbar,
  fullscreenActions,
  inline = false,
  inlineBar,
  inlineSearch,
  inlineActions,
  bodySlot,
}: ModuleDrawerProps): JSX.Element {
  const [content, setContent] = useState<string | null>(initialContent ?? null);
  const [error, setError] = useState<string | null>(null);
  const showingFallback = content === null && error !== null && Boolean(fallbackContent);
  const displayedContent = content ?? (showingFallback ? fallbackContent ?? null : null);
  const [anchorWarning, setAnchorWarning] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [savedNotice, setSavedNotice] = useState('');
  const savedNoticeTimer = useRef<number | undefined>(undefined);
  const [readerLinkSelection, setReaderLinkSelection] = useState<ReaderLinkSelection | null>(null);
  const [readerLinkComposerOpen, setReaderLinkComposerOpen] = useState(false);
  /** 「添加链接」待选模式：点按钮后等待用户在正文中选中片段，选中即自动弹面板（用户要求的新顺序） */
  const [linkArmed, setLinkArmed] = useState(false);
  /**
   * 窄容器下的「⋯」更多动作菜单（把「添加链接 / 编辑文档 / 复制」收进浮层）。
   *
   * 为什么需要：这三个动作平铺时占约 200px，而手机宽度下容器可用宽只有 ~330px
   * ⇒ 一行头部会被折成 **3 行 135px**，反而高于改造前的 126.5px（实测，见 .plans 台账偏差 #4）。
   * 收起后 375px 回到 2 行 91px，窄窗（AI 面板打开，容器 557px）甚至回到 1 行。
   *
   * ⚠️ 这**不是**把功能藏起来：菜单就是它们的入口，功能仍可达（执行护栏 #4）。
   * 宽容器下 `⋯` 按钮自身 `display: none`（菜单不可达），动作照旧平铺 —— 模式切换纯由容器宽度决定。
   */
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [selectionWarning, setSelectionWarning] = useState('');
  const selectionWarningTimer = useRef<number | undefined>(undefined);
  const editor = useDocumentEditor();
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const fullscreen = controlledFullscreen ?? internalFullscreen;
  const [highlightEnabled, setHighlightEnabled] = useState(Boolean(highlightQuery?.trim()));
  const [highlightCount, setHighlightCount] = useState(0);
  const [highlightIndex, setHighlightIndex] = useState(0);
  /** 文档内查找栏是否展开（Ctrl+F / 工具条入口；移动端没有 Ctrl 键，必须有可见入口） */
  const [findOpen, setFindOpen] = useState(false);
  /** 输入框受控值：逐键更新（IME 组词期间的中间态也照常回显） */
  const [findDraft, setFindDraft] = useState('');
  /** 已生效的查找词：防抖结束 / compositionend 后才从 draft 同步 */
  const [findApplied, setFindApplied] = useState('');
  /** 查找栏即时提示（查询被截断） */
  const [findNotice, setFindNotice] = useState('');
  /** 命中是否被上限截断（计数文案补 `+` 并给提示） */
  const [findTruncated, setFindTruncated] = useState(false);
  const [outlineHeadings, setOutlineHeadings] = useState<OutlineHeading[]>([]);
  /** 非受控兜底：大纲默认折叠（与两个页面的受控初值一致），需要时手动展开 */
  const [internalOutlineCollapsed, setInternalOutlineCollapsed] = useState(true);
  /** 全屏正文宽度：默认铺满（用户 2026-10-02 要求）；切「居中」时收窄到 770px 阅读轴 */
  const [fullscreenWide, setFullscreenWide] = useState(true);

  const outlineCollapsed = controlledOutlineCollapsed ?? internalOutlineCollapsed;
  const highlightScrollBehavior = useRef<ScrollBehavior>('auto');
  /**
   * 是否允许"自动滚动到命中"。初值取 `highlightAutoScroll`（混合检索传 false = 打开时不跳转），
   * **只在挂载时取一次**：已打开的文档不因外部 prop 变化改变滚动行为（REQ-20261014-003 N3）。
   * 用户**主动**跳转（「下一个命中」/「上一个命中」/ 查找栏输入生效）后置 true ——
   * 主动行为必须滚动，否则会出现"点了下一个命中、视口纹丝不动"的死按钮。
   */
  const autoScrollRef = useRef(highlightAutoScroll);
  /** 正文滚动容器 */
  const bodyRef = useRef<HTMLDivElement>(null);
  /** 查找栏输入框（Ctrl+F / 工具条入口展开后聚焦） */
  const findInputRef = useRef<HTMLInputElement>(null);
  /** IME 组词中：期间不重算，待 compositionend 统一生效（N8） */
  const findComposingRef = useRef(false);
  const findDebounceRef = useRef<number | undefined>(undefined);
  /** 本次展开是否已预填过：避免输入过程中被 effect 反复聚焦 / 全选 */
  const findSeededRef = useRef(false);
  /** 查看器根节点：用于判断本实例是否可见（Ctrl+F 事件可能被多个实例同时收到） */
  const drawerRef = useRef<HTMLElement>(null);
  /** 全屏切换前记下的阅读位置（正文容器会换父节点被重建，切换后按此恢复） */
  const savedScrollRef = useRef<number | null>(null);

  /**
   * 保存成功提示：3.5s 后自动消失。
   * 原先各处只 setSavedNotice、从不清除 → 提示会一直挂在正文上方（用户反馈「显示时间太长了，并不会自动消失」）。
   */
  const showSavedNotice = useCallback((message: string): void => {
    window.clearTimeout(savedNoticeTimer.current);
    setSavedNotice(message);
    savedNoticeTimer.current = window.setTimeout(() => {
      setSavedNotice('');
      savedNoticeTimer.current = undefined;
    }, 3500);
  }, []);

  const clearSelectionWarning = useCallback((): void => {
    window.clearTimeout(selectionWarningTimer.current);
    selectionWarningTimer.current = undefined;
    setSelectionWarning('');
  }, []);

  const showSelectionWarning = useCallback((message: string): void => {
    window.clearTimeout(selectionWarningTimer.current);
    setSelectionWarning(message);
    selectionWarningTimer.current = window.setTimeout(() => {
      setSelectionWarning('');
      selectionWarningTimer.current = undefined;
    }, 3000);
  }, []);

  useEffect(() => () => {
    window.clearTimeout(selectionWarningTimer.current);
    window.clearTimeout(savedNoticeTimer.current);
    window.clearTimeout(findDebounceRef.current);
  }, []);

  useEffect(() => {
    setHighlightEnabled(Boolean(highlightQuery?.trim()));
    setHighlightIndex(0);
    highlightScrollBehavior.current = 'auto';
  }, [highlightQuery]);

  /**
   * 选区种子的写入序号：每写入一次 +1，供下方「聚焦」effect 监听。
   *
   * 为什么不直接在写入时 rAF 聚焦：本写入发生在 **window 事件处理器**里，而 React 对
   * 非 React 事件的批处理更新不保证在同帧提交 —— 实测（2026-10-15 验证脚本 A4）
   * 处理器内注册的 rAF 会在输入框挂载**之前**执行，聚焦 / 全选静默失效。
   * 改走 effect（提交后执行）与既有「展开时预填」effect 同款时序。
   */
  const [findSeedSeq, setFindSeedSeq] = useState(0);

  /**
   * 把一段文本作为查找词写入并**立即生效**（Ctrl+F 带入选区，2026-10-15）。
   *
   * 与「展开时预填」effect 的分工：本函数置 `findSeededRef`，使那个 effect 不再用
   * `highlightQuery`（上次检索词）覆盖本次写入 —— 用户刚选中的文本优先于旧检索词。
   * 聚焦 + 全选交给下方按序号触发的 effect：查找栏**已展开**时那个预填 effect 不会重跑
   * （它只在展开那一刻跑一次），而"已展开状态下再选一段字按 Ctrl+F"是最常见的换词路径。
   */
  const applyFindSeed = useCallback((seed: string): void => {
    const value = clampFindQuery(seed).value;
    if (!value) return;
    findSeededRef.current = true;
    setFindDraft(value);
    setFindApplied(value);
    // 与预填同款要求：写入即代表「用户正在查找」，必须同时恢复高亮开关 ——
    // 否则此前点过「取消高亮」会让正文里明明有该词却显示「未找到」（同款缺陷已修过一次）
    setHighlightEnabled(true);
    setFindSeedSeq((n) => n + 1);
  }, []);

  /** 选区种子写入后聚焦 + 全选（放 effect 里 = 提交后执行，见 `findSeedSeq` 的说明） */
  useEffect(() => {
    if (findSeedSeq === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const input = findInputRef.current;
      if (!input) return;
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [findSeedSeq]);

  /** Ctrl+F 判定链①（AppShell 侧）派发事件 → 查看器展开查找栏；组件不依赖任何页面路由 */
  useEffect(() => {
    const handler = (event: Event): void => {
      // 多实例防护：页面可能同时挂载多个查看器（AI 引用预览 + 浏览页阅读区，前者窄屏时被
      // display:none 隐藏）。只有**可见**的那个响应，否则按一次 Ctrl+F 会弹出两个查找栏。
      const el = drawerRef.current;
      if (el && el.offsetWidth === 0 && el.offsetHeight === 0) return;
      // 正文被页级内容（全库搜索结果）替换时没有"文档"可搜 —— 让位给浏览器原生查找
      if (bodySlot) return;
      // 带选区种子（2026-10-15）：直接写入并立即查找；不带则维持「展开后预填 highlightQuery」
      const seed = (event as CustomEvent<DocFindOpenDetail>).detail?.query ?? '';
      setFindOpen(true);
      if (seed.trim()) applyFindSeed(seed);
    };
    window.addEventListener(DOC_FIND_OPEN_EVENT, handler);
    return () => window.removeEventListener(DOC_FIND_OPEN_EVENT, handler);
  }, [applyFindSeed, bodySlot]);

  /**
   * 查找栏展开时聚焦输入框，并在输入为空时**预填当前生效词**（外部高亮词可直接续用 / 清除）。
   * 用 findSeededRef 保证「每次展开只做一次」——否则输入过程中本 effect 会反复全选输入框。
   */
  useEffect(() => {
    if (!findOpen) {
      findSeededRef.current = false;
      return;
    }
    if (findSeededRef.current) return;
    findSeededRef.current = true;
    const frame = window.requestAnimationFrame(() => {
      const input = findInputRef.current;
      if (!input) return;
      const seeded = clampFindQuery(highlightQuery ?? '').value;
      if (seeded) {
        setFindDraft(seeded);
        setFindApplied(seeded);
        // 预填即代表「用户正在查找」：必须同时恢复高亮开关，否则「先点取消高亮、再打开查找框」
        // 会让核心 effect 走 else 分支把计数清零 ⇒ 正文里明明有该词却显示「未找到」（实测复现）
        setHighlightEnabled(true);
      }
      input.focus();
      input.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [findOpen, highlightQuery]);

  /** 从实际渲染的标题生成当前文档大纲，普通抽屉也保留折叠入口。 */
  const collectOutlineHeadings = useCallback((): void => {
    // 命中片段只用于回源失败时保底阅读，不代表完整文档结构，不能据此生成大纲。
    if (content === null) {
      setOutlineHeadings([]);
      return;
    }
    const root = bodyRef.current?.querySelector<HTMLElement>('.ki-markdown--drawer');
    if (!root) {
      setOutlineHeadings([]);
      return;
    }
    const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
      .map((heading, index) => {
        const id = `ki-outline-${index}`;
        heading.dataset.kiOutlineTarget = id;
        return {
          id,
          level: Number(heading.tagName.slice(1)),
          label: heading.textContent?.trim() ?? '',
        };
      })
      .filter((heading) => heading.label.length > 0);
    setOutlineHeadings(headings);
  }, [content]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(collectOutlineHeadings);
    return () => window.cancelAnimationFrame(frame);
  // 全屏切换会重建正文容器；重新为新 DOM 标记标题供大纲跳转使用。
  }, [collectOutlineHeadings, loading, fullscreen]);

  useEffect(() => {
    if (!targetAnchor || content === null || loading) return;
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      const root = body?.querySelector<HTMLElement>('.ki-markdown--drawer');
      if (!body || !root) return;
      const blocks = findAnchorBlocks(root);
      const matches = blocks.filter((block) => block.anchor === targetAnchor);
      if (matches.length !== 1) {
        setAnchorWarning(matches.length === 0 ? '目标段落已变化或不存在' : '目标段落不唯一，未自动定位');
        return;
      }
      setAnchorWarning(null);
      const element = matches[0].element;
      let details = element.closest('details');
      while (details) {
        details.open = true;
        details = details.parentElement?.closest('details') ?? null;
      }
      const top = body.scrollTop + element.getBoundingClientRect().top - body.getBoundingClientRect().top - 24;
      body.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
      element.classList.add('ki-anchor-target');
      window.setTimeout(() => element.classList.remove('ki-anchor-target'), 2400);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [targetAnchor, content, loading, fullscreen]);

  const updateOutlineCollapsed = useCallback((collapsed: boolean): void => {
    if (controlledOutlineCollapsed === undefined) setInternalOutlineCollapsed(collapsed);
    onOutlineCollapsedChange?.(collapsed);
  }, [controlledOutlineCollapsed, onOutlineCollapsedChange]);

  const scrollToOutlineHeading = useCallback((id: string): void => {
    const body = bodyRef.current;
    if (!body) return;
    const target = Array.from(body.querySelectorAll<HTMLElement>('[data-ki-outline-target]'))
      .find((heading) => heading.dataset.kiOutlineTarget === id);
    if (!target) return;
    const bodyRect = body.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const top = body.scrollTop + targetRect.top - bodyRect.top - 20;
    body.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, []);

  const updateFullscreen = useCallback((next: boolean): void => {
    // 必须在切换前记录：重建后 ref 已指向新节点，读不到旧位置
    savedScrollRef.current = bodyRef.current?.scrollTop ?? null;
    setReaderLinkSelection(null);
    setReaderLinkComposerOpen(false);
    if (controlledFullscreen === undefined) setInternalFullscreen(next);
    updateOutlineCollapsed(!next);
    onFullscreenChange?.(next);
  }, [controlledFullscreen, onFullscreenChange, updateOutlineCollapsed]);

  useEffect(() => {
    if (content !== null || !fetcher) return;
    if (!group) {
      setError('无法定位完整文档');
      return;
    }
    setLoading(true);
    setError(null);
    fetcher(scope, group, module)
      .then((res) => {
        if (res.content) setContent(res.content);
        else {
          const details = [res.error, res.hint]
            .filter((detail): detail is string => typeof detail === 'string' && detail.trim().length > 0)
            .join('；');
          setError(details || '未找到原文内容');
        }
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [scope, module, group, content, fetcher, loadAttempt]);

  const retryLoad = useCallback((): void => {
    setContent(null);
    setError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  /**
   * 生效查找词：用户输入优先（findApplied），否则回落到打开文档时带入的 highlightQuery
   * —— 外部链路（AI 引用片段 / 检索命中）的语义因此完全不变（J1/J2）。
   */
  const activeFindQuery = findApplied.trim() || highlightQuery?.trim() || '';

  /** 内容渲染后把生效查找词应用到 Markdown 文本节点，并自动定位首个命中。 */
  useEffect(() => {
    /** 复扫定时器（异步渲染可能丢掉 mark）：effect 重跑或卸载时一并清理 */
    const timers: number[] = [];
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      const root = body?.querySelector<HTMLElement>('.ki-markdown--drawer');
      if (!body || !root) {
        setHighlightCount(0);
        setFindTruncated(false);
        return;
      }
      if (highlightEnabled && activeFindQuery) {
        // 用户主动查找用字面词表（对齐 Ctrl+F）；外部 highlightQuery 沿用检索口径（既有行为不变）
        const userTerms = findApplied.trim() ? buildFindTerms(findApplied) : undefined;
        const { count, truncated } = applyDocumentHighlights(root, activeFindQuery, { terms: userTerms });
        setHighlightCount(count);
        setFindTruncated(truncated);
        setHighlightIndex((current) => (count === 0 ? 0 : Math.min(current, count - 1)));
        if (count > 0) {
          window.requestAnimationFrame(() => {
            focusDocumentHighlight(body, Math.min(highlightIndex, count - 1), highlightScrollBehavior.current, autoScrollRef.current);
            highlightScrollBehavior.current = 'auto';
          });
        }
        for (const delay of DOC_HIGHLIGHT_RESCAN_DELAYS) {
          timers.push(window.setTimeout(() => {
            const liveBody = bodyRef.current;
            const liveRoot = liveBody?.querySelector<HTMLElement>('.ki-markdown--drawer');
            if (!liveBody || !liveRoot) return;
            if (liveBody.querySelectorAll(`mark.${DOC_HIGHLIGHT_CLASS}`).length >= count) return;
            const retry = applyDocumentHighlights(liveRoot, activeFindQuery, { terms: userTerms });
            setHighlightCount(retry.count);
            setFindTruncated(retry.truncated);
            setHighlightIndex((current) => (retry.count === 0 ? 0 : Math.min(current, retry.count - 1)));
            // 复扫会重建全部 mark（applyDocumentHighlights 先清后插），**连带丢掉 `--active` 标记** ——
            // 实测：打开文档 1.2s 后（第二次复扫）当前命中高亮消失且无人重标，用户只看到满篇同色 mark。
            // 这里补一次重标；`scroll=false` 保持"复扫不动视口"（用户可能已滚到别处阅读）。
            if (retry.count > 0) {
              focusDocumentHighlight(liveBody, Math.min(highlightIndex, retry.count - 1), 'auto', false);
            }
          }, delay));
        }
      } else {
        clearDocumentHighlights(root);
        setHighlightCount(0);
        setFindTruncated(false);
        setHighlightIndex(0);
      }
    });
    return () => {
      window.cancelAnimationFrame(frame);
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [displayedContent, loading, fullscreen, highlightEnabled, activeFindQuery]);

  /**
   * 当前命中变化时更新 active 状态并滚动到目标；顺带用 DOM 实数校正计数。
   * 校正方向只可能是「变小」：React 重渲染会丢掉手动插入的 mark（R4：计数必须等于可导航命中数）。
   */
  useEffect(() => {
    if (!highlightEnabled || highlightCount === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      const actual = focusDocumentHighlight(body, highlightIndex, highlightScrollBehavior.current, autoScrollRef.current);
      highlightScrollBehavior.current = 'auto';
      if (actual !== highlightCount) {
        setHighlightCount(actual);
        setHighlightIndex((current) => (actual === 0 ? 0 : Math.min(current, actual - 1)));
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightEnabled, highlightCount, highlightIndex, fullscreen]);

  const cancelHighlights = useCallback((): void => {
    highlightScrollBehavior.current = 'auto';
    setHighlightEnabled(false);
    setHighlightIndex(0);
    // 取消高亮同时清掉查找词：否则查找栏里还留着词、用户却看不到任何高亮
    setFindDraft('');
    setFindApplied('');
    setFindNotice('');
  }, []);

  const focusNextHighlight = useCallback((): void => {
    if (highlightCount === 0) return;
    autoScrollRef.current = true;
    highlightScrollBehavior.current = 'smooth';
    setHighlightIndex((current) => stepFindIndex(current, highlightCount, 1));
  }, [highlightCount]);

  /** 关闭查找栏：清空输入并回到「展开查找栏之前」的状态（外部词仍在则恢复外部高亮） */
  const closeFindBar = useCallback((): void => {
    window.clearTimeout(findDebounceRef.current);
    findDebounceRef.current = undefined;
    highlightScrollBehavior.current = 'auto';
    setFindOpen(false);
    setFindDraft('');
    setFindApplied('');
    setFindNotice('');
    /* 退出查找 = **清掉全部正文高亮**（原为 `setHighlightEnabled(Boolean(highlightQuery?.trim()))`）。
       原写法把开关回落成"打开文档时带的检索词"：若这篇文档是从检索结果点开的（带 highlightQuery），
       清空/退出后 `activeFindQuery` 又回落到那个词，高亮重新出现 —— 用户点「清空」发现高亮还在
       （2026-10-16 反馈）。清空与退出就应该是"全清"，不再区分高亮来自谁。 */
    setHighlightEnabled(false);
    setHighlightIndex(0);
  }, []);

  /**
   * 工具条放大镜**按下瞬间**抓到的选区种子。
   *
   * 为什么必须提前抓：点击按钮会让正文失焦，浏览器随即清除 DOM 选区 —— 若只在 click 里读
   * `window.getSelection()`，用户「选中文本 → 点放大镜」将永远拿不到内容（要么空栏、要么
   * 上一次的残留词）。capture 放在 onMouseDown，键盘触发（Enter/Space）走 click 兜底。
   */
  const pressedFindSeedRef = useRef('');

  const captureFindSelection = useCallback((): void => {
    pressedFindSeedRef.current = pickFindSeed(window.getSelection()?.toString() ?? '');
  }, []);

  const openFindBar = useCallback((event?: ReactMouseEvent<HTMLButtonElement>): void => {
    setFindOpen(true);
    // 2026-10-15 增量：与 Ctrl+F 同款 —— 有选中就把所选带入查找栏并立即查找；无选中只是展开
    //
    // ⚠️ 只用**鼠标触发**（clickCount ≥ 1）那次的捕获值：用户按下后把指针拖出按钮时 click 不
    // 触发、`pressedFindSeedRef` 会留下陈旧值；键盘（Enter/Space）触发时 clickCount 为 0，
    // 此时必须忽略残留、直接读当前选区 —— 否则会代入上一次的词（无选中时误填）。
    const fromPointer = (event?.detail ?? 0) > 0 ? pressedFindSeedRef.current : '';
    pressedFindSeedRef.current = '';
    const seed = fromPointer || pickFindSeed(window.getSelection()?.toString() ?? '');
    if (seed) applyFindSeed(seed);
  }, [applyFindSeed]);

  /** 查找词生效（防抖后统一落地）：逐键全量重算在大文档上明显迟滞（R8） */
  const commitFindQuery = useCallback((raw: string): void => {
    const { value, truncated } = clampFindQuery(raw);
    setFindNotice(truncated ? `查询最多 ${DOC_FIND_QUERY_MAX} 字符，已截断` : '');
    setFindApplied(value);
    // 用户主动查找：此后命中变化都该滚动（否则"搜了却停在原地"）
    if (value) autoScrollRef.current = true;
    highlightScrollBehavior.current = 'auto';
    if (value) setHighlightEnabled(true);
  }, []);

  const scheduleFind = useCallback((raw: string): void => {
    window.clearTimeout(findDebounceRef.current);
    findDebounceRef.current = window.setTimeout(() => {
      findDebounceRef.current = undefined;
      commitFindQuery(raw);
    }, DOC_FIND_DEBOUNCE_MS);
  }, [commitFindQuery]);

  const findPrev = useCallback((): void => {
    autoScrollRef.current = true;
    highlightScrollBehavior.current = 'smooth';
    setHighlightIndex((current) => stepFindIndex(current, highlightCount, -1));
  }, [highlightCount]);

  const findNext = useCallback((): void => {
    autoScrollRef.current = true;
    highlightScrollBehavior.current = 'smooth';
    setHighlightIndex((current) => stepFindIndex(current, highlightCount, 1));
  }, [highlightCount]);

  const handleFindChange = useCallback((event: ChangeEvent<HTMLInputElement>): void => {
    const raw = event.target.value;
    setFindDraft(raw);
    // IME 组词期间不重算：中文用户还在选词，此时搜索只会让命中数抖动（N8）
    if (findComposingRef.current) return;
    scheduleFind(raw);
  }, [scheduleFind]);

  const handleFindCompositionStart = useCallback((): void => {
    findComposingRef.current = true;
  }, []);

  const handleFindCompositionEnd = useCallback((event: ReactCompositionEvent<HTMLInputElement>): void => {
    findComposingRef.current = false;
    scheduleFind(event.currentTarget.value);
  }, [scheduleFind]);

  /**
   * 查找栏键盘闭环：Enter=下一个、Shift+Enter=上一个。
   *
   * **Esc 不在这里处理**：keydown 是 discrete 事件，React 会在本处理器内同步 flush 状态更新并
   * 重挂 window 监听器（新闭包里 findOpen 已是 false），事件随后冒泡到 window 时会走「关抽屉」分支
   * —— 表现为按一次 Esc 同时关掉查找栏与文档。统一交给 window 上的既有 ESC 处理器（单一入口）。
   */
  const handleFindKeyDown = useCallback((event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (event.shiftKey) findPrev();
    else findNext();
  }, [findNext, findPrev]);

  const handleCopy = useCallback(async () => {
    if (!displayedContent) return;
    // 优先用 Clipboard API（需 HTTPS 或 localhost）；失败回退到 execCommand
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(displayedContent);
      } else {
        // fallback：旧版 textarea + execCommand（兼容非安全上下文）
        const ta = document.createElement('textarea');
        ta.value = displayedContent;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 失败：独立提示条（不污染加载错误状态，正文保留）
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2500);
    }
  }, [displayedContent]);

  /** 暂存当前阅读页选区；只有点击“添加链接”后才打开跳转面板。 */
  const captureReaderSelection = useCallback((explicitAction = false): ReaderLinkSelection | null => {
    if (!editable || !group || content === null || editor.isOpen || readerLinkComposerOpen) return null;
    const root = bodyRef.current?.querySelector<HTMLElement>('.ki-markdown--drawer');
    const selected = window.getSelection();
    const text = selected?.toString().trim() ?? '';
    if (!root || !selected?.rangeCount || !text) {
      setReaderLinkSelection(null);
      if (explicitAction) showSelectionWarning('请先选中正文中的文字，再点击“添加链接”');
      return null;
    }
    const range = selected.getRangeAt(0);
    if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
      setReaderLinkSelection(null);
      if (explicitAction) showSelectionWarning('请在正文中选中要添加链接的文字');
      return null;
    }
    const start = anchorBlock(range.startContainer);
    const end = anchorBlock(range.endContainer);
    if (!start || start !== end || !root.contains(start)) {
      setReaderLinkSelection(null);
      // 仅在「点击按钮校验」时报错；待选模式下用户拖选经过不合法区域属正常过程，静默等待
      if (explicitAction) showSelectionWarning('请只选中同一标题、段落、列表项或表格单元格中的文字');
      return null;
    }
    if (Array.from(start.querySelectorAll('a,code')).some((node) => range.intersectsNode(node))) {
      setReaderLinkSelection(null);
      if (explicitAction) showSelectionWarning('已有链接或代码中的文字，请使用“编辑文档”处理');
      return null;
    }
    const rect = range.getBoundingClientRect();
    const selection = { text, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } };
    setReaderLinkSelection(selection);
    clearSelectionWarning();
    return selection;
  }, [clearSelectionWarning, content, editable, editor.isOpen, group, readerLinkComposerOpen, showSelectionWarning]);

  /**
   * 「添加链接」按钮（用户要求的新顺序：**先点按钮，再选片段**）：
   * ① 若已选好片段 → 直接打开设置面板（保留「先选后点」的顺手路径）；
   * ② 未选 → 进入待选模式（按钮高亮为「选择片段…」），随后在正文中选中片段即自动弹出面板；
   * ③ 待选模式下再点一次 → 取消。
   */
  const openReaderLinkComposer = useCallback((): void => {
    if (captureReaderSelection(true)) {
      setReaderLinkComposerOpen(true);
      setLinkArmed(false);
      return;
    }
    if (linkArmed) {
      setLinkArmed(false);
      clearSelectionWarning();
      return;
    }
    setLinkArmed(true);
    showSelectionWarning('已进入「添加链接」模式：在正文中选中片段即自动弹出设置面板；再点一次按钮可取消');
  }, [captureReaderSelection, clearSelectionWarning, linkArmed, showSelectionWarning]);

  useEffect(() => {
    if (readerLinkComposerOpen || !editable || content === null || editor.isOpen) return;
    let timer: number | undefined;
    const handler = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        const captured = captureReaderSelection();
        // 待选模式：在正文中选中合法片段即自动打开设置面板（用户要求：不必再点一次按钮）
        if (captured && linkArmed) {
          setReaderLinkComposerOpen(true);
          setLinkArmed(false);
        }
      }, 100);
    };
    document.addEventListener('selectionchange', handler);
    return () => { window.clearTimeout(timer); document.removeEventListener('selectionchange', handler); };
  }, [captureReaderSelection, content, editable, editor.isOpen, linkArmed, readerLinkComposerOpen]);

  const openEditor = useCallback((): void => {
    setReaderLinkSelection(null);
    setReaderLinkComposerOpen(false);
    setLinkArmed(false);
    const selection = window.getSelection();
    const root = bodyRef.current?.querySelector('.ki-markdown--drawer');
    const selected = selection?.anchorNode && root?.contains(selection.anchorNode)
      ? selection.toString().trim() : '';
    if (!group) return;
    editor.open({
      scope, group, relation: module, readerSelection: selected || undefined,
      onSaved: (next, result) => {
        setContent(next);
        const indexed = result.vectorStored ? '向量索引已更新'
          : result.fullTextUpdated ? '全文索引已更新' : '索引未变化';
        showSavedNotice(`文档已保存；${indexed}${result.warning ? `；${result.warning}` : ''}`);
      },
    });
  }, [editor, group, module, scope, showSavedNotice]);

  /** ESC 先退出全屏，再次按下才关闭文档；同时锁定底层页面滚动。 */
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handler = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      if (editor.isOpen || readerLinkComposerOpen) return;
      // 浮层最先关（⋯ 菜单排在查找栏之前）：否则一次 Esc 会连抽屉一起收掉
      if (overflowOpen) { setOverflowOpen(false); return; }
      // 查找栏优先：Esc 只关查找栏，再按一次才退全屏 / 关抽屉（Q3：三个 Esc 语义不能撞车）
      if (findOpen) { closeFindBar(); return; }
      // 待选模式优先退出，避免用户被留在「选择片段…」状态里
      if (linkArmed) { setLinkArmed(false); clearSelectionWarning(); return; }
      if (fullscreen) updateFullscreen(false);
      else onClose();
    };
    window.addEventListener('keydown', handler);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener('keydown', handler);
    };
  }, [clearSelectionWarning, closeFindBar, editor.isOpen, findOpen, fullscreen, linkArmed, onClose, overflowOpen, readerLinkComposerOpen, updateFullscreen]);

  /** 「⋯」菜单：点面板外关闭（与 ScopeSelect 同款做法；ESC 由上面的统一链处理） */
  useEffect(() => {
    if (!overflowOpen) return;
    const onDocumentClick = (event: MouseEvent): void => {
      if (overflowRef.current && !overflowRef.current.contains(event.target as Node)) setOverflowOpen(false);
    };
    document.addEventListener('click', onDocumentClick);
    return () => document.removeEventListener('click', onDocumentClick);
  }, [overflowOpen]);

  /** 正文滚动状态：驱动「回到顶部 / 滑到底部」按钮的可用态与显隐 */
  const [atTop, setAtTop] = useState(true);
  const [atBottom, setAtBottom] = useState(true);

  const syncScrollState = useCallback((): void => {
    const el = bodyRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    setAtTop(el.scrollTop <= 2);
    // 内容不足一屏时 max<=0：视为同时处于顶与底，按钮组据此整体隐藏
    setAtBottom(max <= 2 || el.scrollTop >= max - 2);
  }, []);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    syncScrollState();
    el.addEventListener('scroll', syncScrollState, { passive: true });
    // 文档加载完成后（含图片 / Mermaid 撑高内容）与窗口尺寸变化时重新同步
    window.addEventListener('resize', syncScrollState);
    return () => {
      el.removeEventListener('scroll', syncScrollState);
      window.removeEventListener('resize', syncScrollState);
    };
    // fullscreen 切换会让正文容器换父节点并被重建，必须重新绑定到新元素
  }, [syncScrollState, displayedContent, loading, fullscreen]);

  /** 全屏切换后正文容器被重建，恢复到切换前的阅读位置（布局阶段同步执行，不闪回顶部） */
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || savedScrollRef.current === null) return;
    el.scrollTop = savedScrollRef.current;
    savedScrollRef.current = null;
    syncScrollState();
  }, [fullscreen, syncScrollState]);

  const scrollToTop = useCallback((): void => {
    bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const scrollToBottom = useCallback((): void => {
    const el = bodyRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, []);

  /** 内容不足一屏时不渲染按钮，避免无意义的悬浮控件 */
  const scrollable = !(atTop && atBottom);

  /** 查找栏状态区：有词才显示；0 命中给「未找到 x」，否则给 `n/m`（R4：不允许静默） */
  const findStatusText = !activeFindQuery
    ? ''
    : highlightCount > 0
      ? formatFindCount(highlightIndex, highlightCount, findTruncated)
      : describeFindMiss(activeFindQuery);
  /** 查找提示：完整文案（进 title）与工具条内的短徽标（就地展开后空间有限） */
  const findNoticeText = findNotice || (findTruncated && highlightCount > 0 ? describeFindLimit(highlightCount) : '');
  const findNoticeBadge = findNotice
    ? `最多 ${DOC_FIND_QUERY_MAX} 字`
    : findTruncated && highlightCount > 0
      ? `仅前 ${highlightCount} 处`
      : '';

  /**
   * 文档导航（上一级 / 下一级），只在存在跳转历史时渲染。
   *
   * 两个位置共用同一份节点：**内联阅读态放在头部最左**（2026-10-16 一行化：占用原「文档内容」
   * 标签腾出的位置，符合"文档间移动在最外侧"的心智）；其余形态仍跟在标题右侧。
   */
  const hasNavHistory = Boolean((canGoBack && onBack) || (canGoForward && onForward));
  const navCluster = hasNavHistory ? (
    <div className="ki-drawer__nav">
      {canGoBack && onBack && (
        <button
          className="ki-drawer__back"
          onClick={onBack}
          title="返回上一级文档"
          type="button"
          aria-label="返回上一级文档"
        >
          {ICON_NAV_PREV}<span className="ki-drawer__back-label">上一级</span>
        </button>
      )}
      {canGoForward && onForward && (
        <button
          className="ki-drawer__forward"
          onClick={onForward}
          title="前进到下一级文档"
          type="button"
          aria-label="前进到下一级文档"
        >
          {ICON_NAV_NEXT}<span className="ki-drawer__forward-label">下一级</span>
        </button>
      )}
    </div>
  ) : null;

  /**
   * 内联一行头部（浏览页阅读区）是否启用 —— 由 `inlineSearch` 开启，见该 prop 注释。
   * 关掉时本组件头部与交互**完全保持改动前**：标题 + meta + 就地展开的查找栏。
   *
   * ⚠️ 必须排除全屏态：内联阅读**由同一个实例**进入全屏（`inline` 仍为 true），
   * 若只判 `inline`，全屏头部会被一并换成单行布局（标题消失、页级 Tag 与全库搜索框被带进全屏层）
   * —— 而全屏态的头部与动作条是既有形态，本次不改（执行护栏 #1）。
   */
  const inlineBarMode = inline && !fullscreen && Boolean(inlineSearch);
  /**
   * 搜索范围：`findOpen` 即「本文」（复用既有查找内核：高亮、计数、↑↓ 导航、Esc 退出），
   * 不另立状态机 —— 两套状态并存必然漂移。
   */
  const docSearchMode = inlineBarMode && findOpen;
  /**
   * 正文被页级内容（浏览页的全库搜索结果）替换时，一切依赖"当前文档"的动作都禁用：
   * 添加链接 / 编辑文档 / 复制原文 / 全屏阅读 / 正文宽度切换。
   *
   * 用户 2026-10-16 的方案：**头部保持不动、按钮变灰** —— 比"换一套页面工具栏"视觉连续得多，
   * 也诚实（此刻这些动作确实无处作用）。
   */
  const docActionsDisabled = Boolean(bodySlot);

  const body = (
    <div
      className={`ki-drawer__body${fullscreen && !fullscreenWide ? ' ki-drawer__body--narrow' : ''}${bodySlot ? ' ki-drawer__body--slot' : ''}`}
      ref={bodyRef}
    >
      {/* bodySlot（页级内容，如全库搜索结果列表）优先：头部仍是本组件的形态，只有正文被替换 */}
      {bodySlot ?? (
        <>
      {savedNotice && <div className="ki-drawer__copy-failed" role="status">{savedNotice}</div>}
      {selectionWarning && <div className="ki-drawer__copy-failed" role="status">{selectionWarning}</div>}
      {anchorWarning && <div className="ki-drawer__copy-failed" role="status">{anchorWarning}。文档已打开，请重新选择位置。</div>}
      {copyFailed && (
        <div className="ki-drawer__copy-failed" role="status">复制失败，请手动选择文本后复制</div>
      )}
      {loading ? (
        <div className="ki-drawer__status">
          <div className="ki-skeleton" style={{ width: '60%', height: 20, marginBottom: 10 }} />
          <div className="ki-skeleton" style={{ width: '100%', height: 14, marginBottom: 8 }} />
          <div className="ki-skeleton" style={{ width: '90%', height: 14, marginBottom: 8 }} />
          <div className="ki-skeleton" style={{ width: '75%', height: 14 }} />
        </div>
      ) : error && displayedContent === null ? (
        <div className="ki-drawer__status">
          <div className="ki-drawer__status-icon">⚠</div>
          <h3>加载失败</h3>
          <p>{error}</p>
          <button className="ki-btn ki-btn--secondary ki-btn--small" type="button" onClick={retryLoad}>
            重试
          </button>
        </div>
      ) : displayedContent === null ? (
        <div className="ki-drawer__status">
          <div className="ki-drawer__status-icon">📄</div>
          <h3>无原文内容</h3>
          <p>该文档暂无可预览的原文</p>
        </div>
      ) : (
        <>
          {showingFallback && (
            <div className="ki-drawer__status" role="status" style={{ padding: '12px 16px' }}>
              <p>完整原文暂不可用（{error}），当前显示搜索命中片段。</p>
              {group && (
                <button className="ki-btn ki-btn--secondary ki-btn--small" type="button" onClick={retryLoad}>
                  重试加载全文
                </button>
              )}
            </div>
          )}
          <article className="ki-markdown ki-markdown--drawer" onMouseUp={() => { captureReaderSelection(); }} onKeyUp={() => { captureReaderSelection(); }}>
            <MarkdownPreview
              text={displayedContent}
              assetBase={group ? { scope, group } : undefined}
              onLocalLink={onLocalLink}
            />
          </article>
        </>
      )}
        </>
      )}
    </div>
  );

  const foot = displayedContent ? (
    <footer className="ki-drawer__foot">
      <span className="ki-cell-sub">{(displayedContent.length / 1024).toFixed(1)} KB · Markdown</span>
    </footer>
  ) : null;

  return (
    <>
      {!inline && <div className="ki-drawer__scrim ki-drawer__scrim--show" onClick={onClose} />}
      <aside
        ref={drawerRef}
        className={`ki-drawer${fullscreen ? ' ki-drawer--fullscreen' : ''}${inline ? ' ki-drawer--inline' : ''}`}
        role={inline ? undefined : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-label="原文查看"
        /* 当前正文的文档身份：供「加入引用」在正文里划选时判定引用的是哪一篇
           （REQ-20261009-002 需求 B；消费方见 chat/ChatPanel.tsx 的划选监听） */
        data-ki-doc-group={group ?? ''}
        data-ki-doc-name={module}
      >
        {/* 头部 */}
        <header className={`ki-drawer__head${inlineBarMode ? ' ki-drawer__head--bar' : ''}`}>
          <button
            className="ki-drawer__close"
            onClick={onClose}
            title="收起 (ESC)"
            type="button"
            aria-label="收起"
          >
            {ICON_DRAWER_COLLAPSE}
          </button>
          {inlineBarMode ? (
            <>
              {/* ── 一行头部（浏览页阅读态，2026-10-16）─────────────────────────────
                  三段：**文档导航** │ 过滤 + 搜索 │ 文档动作。
                  文档身份标识（标题、scope、group 路径）**不在此渲染**：
                  - 头部因此从两行 126.5px（占阅读区 16%、且不随滚动消失）降为一行 55px；
                  - 身份改由**页头的路径行**（`${group} / ${module}`，见 BrowsePage 的 .ki-page-head）
                    与左栏目录选中态承担 —— 单行内放标题会把搜索框压到 ~80px 不可用
                    （用户 2026-10-16 先要求"最左显示标题"，实测拥挤后改为"取消标题、身份上移页头"）。 */}
              {navCluster}
              {inlineBar}
              {inlineSearch ? (
                <div
                  className={`ki-drawer__search${docSearchMode ? ' ki-drawer__search--doc' : ''}`}
                  role="search"
                  aria-label={docSearchMode ? '文档内查找' : '搜索全部文档'}
                >
                  {/* 输入框与其附属（图标 / 计数 / ↑↓ / ✕）包一层**相对定位容器**：
                      附属元素必须相对**输入框**定位，而不是相对整个搜索组 ——
                      组里还有「全库|本文」与「清空」，相对组定位会让 ✕ 叠到清空按钮上
                      （2026-10-16 用户实测到的重叠：清空按钮背景里出现了 ✕）。 */}
                  <div className="ki-drawer__search-field">
                  <span className="ki-drawer__search-icon" aria-hidden="true">
                    {docSearchMode ? ICON_SEARCH_DOC : ICON_SEARCH_GLOBAL}
                  </span>
                  {/* 同一个输入框承担两种范围：value/onChange/键盘行为随之切换，
                      不换 DOM —— 换 DOM 会在切换瞬间丢焦点。 */}
                  <input
                    ref={findInputRef}
                    className="ki-form-input ki-drawer__search-input"
                    type="text"
                    value={docSearchMode ? findDraft : inlineSearch.value}
                    onChange={docSearchMode ? handleFindChange : (event) => inlineSearch.onChange(event.target.value)}
                    onCompositionStart={docSearchMode ? handleFindCompositionStart : undefined}
                    onCompositionEnd={docSearchMode ? handleFindCompositionEnd : undefined}
                    onKeyDown={docSearchMode ? handleFindKeyDown : undefined}
                    placeholder={docSearchMode ? '本文档内查找…' : (inlineSearch.placeholder ?? '搜索全库文档…')}
                    aria-label={docSearchMode ? '在本文档内查找' : '搜索全部文档'}
                    autoComplete="off"
                    spellCheck={false}
                    /* 走查脚本据此判定当前范围；**不带** data-ki-drawer-find ——
                       AppShell 的 Ctrl+F 判定链靠它区分「直接聚焦」与「请查看器展开」，
                       本框要让 Ctrl+F 走后者（先切「本文」再聚焦），否则会在「全库」模式下被聚焦 */
                    data-ki-drawer-search={docSearchMode ? 'doc' : 'global'}
                  />
                  {docSearchMode ? (
                    <>
                      {findNoticeBadge && (
                        <span className="ki-drawer__find-notice" title={findNoticeText}>{findNoticeBadge}</span>
                      )}
                      <span className="ki-drawer__find-status" role="status" aria-live="polite">{findStatusText}</span>
                      <button
                        className="ki-drawer__find-btn"
                        type="button"
                        onClick={findPrev}
                        disabled={highlightCount === 0}
                        title="上一个命中（Shift+Enter）"
                        aria-label="上一个命中"
                      >↑</button>
                      <button
                        className="ki-drawer__find-btn"
                        type="button"
                        onClick={findNext}
                        disabled={highlightCount === 0}
                        title="下一个命中（Enter）"
                        aria-label="下一个命中"
                      >↓</button>
                      {/* 「本文」模式**不再渲染 ✕**（用户 2026-10-16）：退出由右侧「全库」分段或 Esc 完成，
                          同一处给两个出口反而让人犹豫点哪个 */}
                    </>
                  ) : inlineSearch.value ? (
                    <button
                      className="ki-drawer__search-clear"
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => inlineSearch.onChange('')}
                      title="清空检索词"
                      aria-label="清空检索词"
                    >✕</button>
                  ) : null}
                  </div>
                  {/* 范围分段：复用检索页「混合|全文」同款 .ki-segmented，不新造视觉语言。
                      「本文」= 既有文档内查找（含计数、↑↓、Esc 退出）；「全库」= 页面的结果列表。 */}
                  <div className="ki-segmented ki-drawer__search-mode" role="group" aria-label="搜索范围">
                    <button
                      type="button"
                      aria-pressed={!docSearchMode}
                      onClick={() => { if (findOpen) closeFindBar(); }}
                    >全库</button>
                    <button
                      type="button"
                      aria-pressed={docSearchMode}
                      /* 正文被页级内容替换时禁用：此刻没有"本文"可搜，能点开只会误导 */
                      disabled={docActionsDisabled}
                      /* 复用既有「放大镜」入口的全部行为：进入本文查找 + **带入正文所选**
                         （onMouseDown 抓选区 —— click 时正文已失焦、选区已被清除，2026-10-15 的既有口径） */
                      onMouseDown={captureFindSelection}
                      onClick={openFindBar}
                    >本文</button>
                  </div>
                  {/* 「清空」常驻在分段右侧（用户 2026-10-16：「永久增加，搜不搜索都显示」）。
                      **两个范围都清**：先退出文档内查找（连带清掉全部正文高亮），再清页面的检索词与标签。
                      为什么不再按模式二选一：本文模式的词在组件内、全库模式的词在页面，只清一边会留下
                      另一边的痕迹（先是"本文模式点了没反应"，后是"清空后高亮还在"，两次反馈同一根因）。 */}
                  {inlineSearch.onClear ? (
                    <button
                      className="ki-btn ki-btn--secondary ki-btn--small ki-drawer__search-clearall"
                      type="button"
                      onClick={() => {
                        closeFindBar();
                        inlineSearch.onClear?.();
                      }}
                      title="清空检索词、文档内查找与标签筛选"
                    >清空</button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <>
              <div className="ki-drawer__identity">
                <div className="ki-drawer__title-row">
                  <div className="ki-drawer__title" title={module}>{module}</div>
                  {navCluster}
                </div>
                <div className="ki-drawer__meta">
                  <span className="ki-badge ki-badge--kb" style={{ fontSize: 11 }}>{scope}</span>
                  {group && (
                    <>
                      <span className="ki-drawer__sep">·</span>
                      <span className="ki-drawer__path">{group}</span>
                    </>
                  )}
                </div>
              </div>
              {fullscreen && fullscreenToolbar ? (
                <div className="ki-drawer__fs-toolbar">{fullscreenToolbar}</div>
              ) : null}
            </>
          )}
          <div className="ki-drawer__actions">
            {/* 全屏专属动作（如「AI 对话」开关）：REQ-20261009-002 —— 全屏层会盖住顶栏开关，
                面板未打开时用户在全屏中没有任何 AI 入口 */}
            {fullscreen ? fullscreenActions : null}
            {/* ── 内联一行头部（浏览页阅读态）：把页级动作（居中/铺满）排在动作区最前
                「文档内查找」的入口已交给搜索框右侧的「全库|本文」分段，这里不再渲染放大镜 /
                就地查找栏 —— 同一页出现两个查找入口会让「搜哪里」变得不可判定。 */}
            {inlineBarMode ? inlineActions : null}
            {/* 文档内查找：点放大镜**就地**展开为输入框（不新占一行，正文不被下推）；Ctrl+F 同样唤出。
                移动端没有 Ctrl 键，故保留这个可点入口。 */}
            {inlineBarMode ? null : findOpen ? (
              <div className="ki-drawer__findgroup" role="search" aria-label="文档内查找">
                <input
                  ref={findInputRef}
                  className="ki-drawer__find-input"
                  data-ki-drawer-find=""
                  type="text"
                  value={findDraft}
                  placeholder="本文档内查找…"
                  aria-label="在本文档内查找"
                  autoComplete="off"
                  spellCheck={false}
                  onChange={handleFindChange}
                  onCompositionStart={handleFindCompositionStart}
                  onCompositionEnd={handleFindCompositionEnd}
                  onKeyDown={handleFindKeyDown}
                />
                <span className="ki-drawer__find-status" role="status" aria-live="polite">{findStatusText}</span>
                {findNoticeBadge && (
                  <span className="ki-drawer__find-notice" title={findNoticeText}>{findNoticeBadge}</span>
                )}
                <button
                  className="ki-drawer__find-btn"
                  type="button"
                  onClick={findPrev}
                  disabled={highlightCount === 0}
                  title="上一个命中（Shift+Enter）"
                  aria-label="上一个命中"
                >↑</button>
                <button
                  className="ki-drawer__find-btn"
                  type="button"
                  onClick={findNext}
                  disabled={highlightCount === 0}
                  title="下一个命中（Enter）"
                  aria-label="下一个命中"
                >↓</button>
                <button
                  className="ki-drawer__find-btn ki-drawer__find-btn--close"
                  type="button"
                  onClick={closeFindBar}
                  title="关闭查找（Esc）"
                  aria-label="关闭查找"
                >✕</button>
              </div>
            ) : (
              <button
                className="ki-drawer__find-toggle"
                type="button"
                onMouseDown={captureFindSelection}
                onClick={openFindBar}
                title="在本文档内查找（选中文本会带入；Ctrl+F 同效）"
                aria-label="在本文档内查找"
              >
                {ICON_FIND}
              </button>
            )}
            {/* 全文命中导航：紧贴复制按钮左侧（用户反馈：原孤立在标题区右侧视觉割裂） */}
            {fullscreen && (
              <div className="ki-segmented ki-reader-width" role="group" aria-label="正文宽度">
                <button type="button" aria-pressed={!fullscreenWide} onClick={() => setFullscreenWide(false)}>
                  居中
                </button>
                <button type="button" aria-pressed={fullscreenWide} onClick={() => setFullscreenWide(true)}>
                  铺满
                </button>
              </div>
            )}
            {/* 查找栏展开时由查找栏承担同一套计数与导航，避免两条并排重复（REQ-20261014-002） */}
            {highlightEnabled && highlightCount > 0 && !findOpen && (
              <div className="ki-drawer__highlight" role="group" aria-label="全文命中导航">
                <span className="ki-drawer__highlight-count">{highlightIndex + 1}/{highlightCount}</span>
                <button
                  className="ki-drawer__highlight-btn"
                  type="button"
                  onClick={cancelHighlights}
                  title="取消正文高亮"
                >
                  取消高亮
                </button>
                <button
                  className="ki-drawer__highlight-btn"
                  type="button"
                  onClick={focusNextHighlight}
                  title="跳转到下一个命中"
                >
                  下一个命中
                </button>
              </div>
            )}
            {/* 这三个动作在**窄容器**下会收进右侧「⋯」菜单（同一批节点渲染两版，由容器宽度互斥显示）——
                它们各自带一个角色类名供 CSS 定位，状态类（--armed / --done）语义不变 */}
            {editable && group && content !== null && (
              <button
                className={`ki-drawer__copy ki-drawer__copy--link${linkArmed ? ' ki-drawer__copy--armed' : ''}`}
                type="button"
                aria-pressed={linkArmed}
                disabled={docActionsDisabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openReaderLinkComposer}
                title={linkArmed ? '已进入添加链接模式：在正文中选中片段（再点一次取消）' : '点击后在正文中选中片段，自动弹出链接设置'}
              >{linkArmed ? '选择片段…' : '添加链接'}</button>
            )}
            {editable && group && content !== null && (
              <button className="ki-drawer__copy ki-drawer__copy--edit" type="button" disabled={docActionsDisabled} onClick={openEditor}>编辑文档</button>
            )}
            {displayedContent && (
              <button
                className={`ki-drawer__copy ki-drawer__copy--copy${copied ? ' ki-drawer__copy--done' : ''}`}
                disabled={docActionsDisabled}
                onClick={handleCopy}
                title="复制原文"
                type="button"
              >
                {copied ? '已复制' : '复制'}
              </button>
            )}
            {/* 窄容器的「⋯」入口：宽容器里按钮自身 display:none（菜单不可达），动作照旧平铺 */}
            <div className="ki-drawer__overflow" ref={overflowRef}>
              <button
                type="button"
                className="ki-drawer__copy ki-drawer__overflow-toggle"
                aria-haspopup="menu"
                aria-expanded={overflowOpen}
                onClick={() => setOverflowOpen((open) => !open)}
                title="更多文档动作"
                aria-label="更多文档动作"
              >⋯</button>
              {overflowOpen && (
                <div className="ki-drawer__overflow-menu" role="menu" aria-label="更多文档动作">
                  {editable && group && content !== null && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={docActionsDisabled}
                      className={`ki-drawer__overflow-item${linkArmed ? ' ki-drawer__overflow-item--armed' : ''}`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => { setOverflowOpen(false); openReaderLinkComposer(); }}
                    >{linkArmed ? '选择片段…' : '添加链接'}</button>
                  )}
                  {editable && group && content !== null && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={docActionsDisabled}
                      className="ki-drawer__overflow-item"
                      onClick={() => { setOverflowOpen(false); openEditor(); }}
                    >编辑文档</button>
                  )}
                  {displayedContent && (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={docActionsDisabled}
                      className="ki-drawer__overflow-item"
                      onClick={() => { setOverflowOpen(false); void handleCopy(); }}
                    >{copied ? '已复制' : '复制'}</button>
                  )}
                </div>
              )}
            </div>
            <button
              className="ki-drawer__fullscreen"
              disabled={docActionsDisabled}
              onClick={() => updateFullscreen(!fullscreen)}
              title={fullscreen ? '退出全屏' : '全屏查看'}
              type="button"
            >
              {fullscreen ? '⤢ 还原' : '⤢ 全屏'}
            </button>
          </div>
        </header>

        {outlineHeadings.length > 0 && (
          <DocumentOutline
            headings={outlineHeadings}
            collapsed={outlineCollapsed}
            onToggle={() => updateOutlineCollapsed(!outlineCollapsed)}
            onNavigate={scrollToOutlineHeading}
          />
        )}

        {fullscreen && fullscreenNavigation ? (
          <div className="ki-reader-workspace">
            {fullscreenNavigation}
            <div className="ki-reader-workspace__main">
              {body}
              {foot}
            </div>
          </div>
        ) : (
          <>
            {body}
            {foot}
          </>
        )}

        {/* 正文快速滚动：仅在正文超出一屏时出现，已在顶/底的一侧置灰 */}
        {displayedContent !== null && scrollable && (
          <div className="ki-scroll-nav" role="group" aria-label="正文快速滚动">
            <button
              type="button"
              className="ki-scroll-nav__btn"
              onClick={scrollToTop}
              disabled={atTop}
              title="回到顶部"
              aria-label="回到顶部"
            >
              {ICON_SCROLL_TOP}
            </button>
            <button
              type="button"
              className="ki-scroll-nav__btn"
              onClick={scrollToBottom}
              disabled={atBottom}
              title="滑到底部"
              aria-label="滑到底部"
            >
              {ICON_SCROLL_BOTTOM}
            </button>
          </div>
        )}
      </aside>
      {readerLinkComposerOpen && readerLinkSelection && content !== null && group && (
        <ReaderLinkComposer
          scope={scope}
          group={group}
          relation={module}
          currentContent={content}
          selection={readerLinkSelection}
          onSaved={(next, result) => {
            setContent(next);
            setReaderLinkSelection(null);
            setReaderLinkComposerOpen(false);
            const indexed = result.vectorStored ? '向量索引已更新'
              : result.fullTextUpdated ? '全文索引已更新' : '索引未变化';
            showSavedNotice(`跳转链接已保存；${indexed}${result.warning ? `；${result.warning}` : ''}`);
          }}
          onPartialSaved={(next, warning) => { setContent(next); showSavedNotice(warning); }}
          onClose={() => { setReaderLinkSelection(null); setReaderLinkComposerOpen(false); window.getSelection()?.removeAllRanges(); }}
        />
      )}
    </>
  );
}
