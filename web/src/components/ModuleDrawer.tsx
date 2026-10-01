/**
 * ModuleDrawer.tsx —— 原文查看抽屉（右侧滑出 + scrim + 复制）
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { ReaderLinkComposer, type ReaderLinkSelection } from '@/components/ReaderLinkComposer';
import { anchorBlock, findAnchorBlocks } from '@/lib/kiLinks';
import { selectHighlightTerms } from '@/lib/searchText';
import { useDocumentEditor } from '@/lib/documentEditorContext';

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

function escapeHighlightRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 正文高亮词表：与结果列表（lib/searchText）共用同一套切词（中文 2~4 字滑窗 + 停用词），
 * 并按**全文文本**自适应剔除泛词——否则「什么需要注册中心」这类无空格中文长句会拆不出词（0 命中），
 * 或是「注册」这种泛词在一篇讲服务注册的文档里铺满几十处高亮（实测 39 处 → 泛词剔除后 ~24 处）。
 */
function buildHighlightPattern(query: string, text: string): RegExp | null {
  const terms = selectHighlightTerms(query, text)
    .sort((a, b) => b.length - a.length)
    .map(escapeHighlightRegExp);
  return terms.length > 0 ? new RegExp(`(${terms.join('|')})`, 'gi') : null;
}

function clearDocumentHighlights(root: HTMLElement): void {
  for (const mark of Array.from(root.querySelectorAll<HTMLElement>(`mark.${DOC_HIGHLIGHT_CLASS}`))) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    mark.remove();
  }
}

/** 在已安全渲染的 Markdown 文本节点上包裹 mark，不拼接原始 HTML。 */
function applyDocumentHighlights(root: HTMLElement, query: string): number {
  clearDocumentHighlights(root);

  const textNodes: Text[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const parent = text.parentElement;
    // 页面生成的复制控件不是原文，不能参与命中计数/自动定位。
    if (text.nodeValue && parent && !parent.closest('script,style,svg,button,[aria-live]')) textNodes.push(text);
    node = walker.nextNode();
  }

  // 词表按全文自适应（先收集文本再建 pattern）：泛词剔除依赖整篇的出现频次
  const pattern = buildHighlightPattern(query, textNodes.map((text) => text.nodeValue ?? '').join('\n'));
  if (!pattern) return 0;

  let count = 0;
  for (const textNode of textNodes) {
    const value = textNode.nodeValue ?? '';
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    let lastIndex = 0;
    let matched = false;
    const fragment = root.ownerDocument.createDocumentFragment();
    while ((match = pattern.exec(value)) !== null) {
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
  return count;
}

function focusDocumentHighlight(body: HTMLDivElement, index: number, behavior: ScrollBehavior): void {
  const marks = Array.from(body.querySelectorAll<HTMLElement>(`mark.${DOC_HIGHLIGHT_CLASS}`));
  marks.forEach((mark, markIndex) => mark.classList.toggle(DOC_HIGHLIGHT_ACTIVE_CLASS, markIndex === index));
  const target = marks[index];
  if (!target) return;
  const bodyRect = body.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = body.scrollTop + targetRect.top - bodyRect.top - (body.clientHeight - targetRect.height) / 2;
  body.scrollTo({ top: Math.max(0, top), behavior });
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
  /** 常驻模式（浏览页双栏的右栏）：不渲染遮罩与 dialog 语义，容器改为内联定位，隐藏关闭按钮。 */
  inline?: boolean;
}

export function ModuleDrawer({
  scope,
  module,
  group,
  initialContent,
  fallbackContent,
  highlightQuery,
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
  inline = false,
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
  const [selectionWarning, setSelectionWarning] = useState('');
  const selectionWarningTimer = useRef<number | undefined>(undefined);
  const editor = useDocumentEditor();
  const [internalFullscreen, setInternalFullscreen] = useState(false);
  const fullscreen = controlledFullscreen ?? internalFullscreen;
  const [highlightEnabled, setHighlightEnabled] = useState(Boolean(highlightQuery?.trim()));
  const [highlightCount, setHighlightCount] = useState(0);
  const [highlightIndex, setHighlightIndex] = useState(0);
  const [outlineHeadings, setOutlineHeadings] = useState<OutlineHeading[]>([]);
  /** 非受控兜底：大纲默认折叠（与两个页面的受控初值一致），需要时手动展开 */
  const [internalOutlineCollapsed, setInternalOutlineCollapsed] = useState(true);
  /** 全屏正文宽度：默认铺满（用户 2026-10-02 要求）；切「居中」时收窄到 770px 阅读轴 */
  const [fullscreenWide, setFullscreenWide] = useState(true);

  const outlineCollapsed = controlledOutlineCollapsed ?? internalOutlineCollapsed;
  const highlightScrollBehavior = useRef<ScrollBehavior>('auto');
  /** 正文滚动容器 */
  const bodyRef = useRef<HTMLDivElement>(null);
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
  }, []);

  useEffect(() => {
    setHighlightEnabled(Boolean(highlightQuery?.trim()));
    setHighlightIndex(0);
    highlightScrollBehavior.current = 'auto';
  }, [highlightQuery]);

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

  /** 内容渲染后把全文上下文应用到 Markdown 文本节点，并自动定位首个命中。 */
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      const root = body?.querySelector<HTMLElement>('.ki-markdown--drawer');
      if (!body || !root) {
        setHighlightCount(0);
        return;
      }
      const count = highlightEnabled && highlightQuery?.trim()
        ? applyDocumentHighlights(root, highlightQuery)
        : (clearDocumentHighlights(root), 0);
      setHighlightCount(count);
      setHighlightIndex((current) => count === 0 ? 0 : Math.min(current, count - 1));
      if (count > 0) {
        window.requestAnimationFrame(() => {
          focusDocumentHighlight(body, Math.min(highlightIndex, count - 1), highlightScrollBehavior.current);
          highlightScrollBehavior.current = 'auto';
        });
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [displayedContent, loading, fullscreen, highlightEnabled, highlightQuery]);

  /** 当前命中变化时更新 active 状态并滚动到目标。 */
  useEffect(() => {
    if (!highlightEnabled || highlightCount === 0) return;
    const frame = window.requestAnimationFrame(() => {
      const body = bodyRef.current;
      if (!body) return;
      focusDocumentHighlight(body, highlightIndex, highlightScrollBehavior.current);
      highlightScrollBehavior.current = 'auto';
    });
    return () => window.cancelAnimationFrame(frame);
  }, [highlightEnabled, highlightCount, highlightIndex, fullscreen]);

  const cancelHighlights = useCallback((): void => {
    highlightScrollBehavior.current = 'auto';
    setHighlightEnabled(false);
    setHighlightIndex(0);
  }, []);

  const focusNextHighlight = useCallback((): void => {
    if (highlightCount === 0) return;
    highlightScrollBehavior.current = 'smooth';
    setHighlightIndex((current) => (current + 1) % highlightCount);
  }, [highlightCount]);

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
  }, [clearSelectionWarning, editor.isOpen, fullscreen, linkArmed, onClose, readerLinkComposerOpen, updateFullscreen]);

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

  const body = (
    <div
      className={`ki-drawer__body${fullscreen && !fullscreenWide ? ' ki-drawer__body--narrow' : ''}`}
      ref={bodyRef}
    >
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
        className={`ki-drawer${fullscreen ? ' ki-drawer--fullscreen' : ''}${inline ? ' ki-drawer--inline' : ''}`}
        role={inline ? undefined : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-label="原文查看"
      >
        {/* 头部 */}
        <header className="ki-drawer__head">
          <button
            className="ki-drawer__close"
            onClick={onClose}
            title="收起 (ESC)"
            type="button"
            aria-label="收起"
          >
            {ICON_DRAWER_COLLAPSE}
          </button>
          <div className="ki-drawer__identity">
            <div className="ki-drawer__title-row">
              <div className="ki-drawer__title" title={module}>{module}</div>
              {(canGoBack && onBack || canGoForward && onForward) && (
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
              )}
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
          <div className="ki-drawer__actions">
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
            {highlightEnabled && highlightCount > 0 && (
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
            {editable && group && content !== null && (
              <button
                className={`ki-drawer__copy${linkArmed ? ' ki-drawer__copy--armed' : ''}`}
                type="button"
                aria-pressed={linkArmed}
                onMouseDown={(event) => event.preventDefault()}
                onClick={openReaderLinkComposer}
                title={linkArmed ? '已进入添加链接模式：在正文中选中片段（再点一次取消）' : '点击后在正文中选中片段，自动弹出链接设置'}
              >{linkArmed ? '选择片段…' : '添加链接'}</button>
            )}
            {editable && group && content !== null && (
              <button className="ki-drawer__copy" type="button" onClick={openEditor}>编辑文档</button>
            )}
            {displayedContent && (
              <button
                className={`ki-drawer__copy${copied ? ' ki-drawer__copy--done' : ''}`}
                onClick={handleCopy}
                title="复制原文"
                type="button"
              >
                {copied ? '已复制' : '复制'}
              </button>
            )}
            <button
              className="ki-drawer__fullscreen"
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
