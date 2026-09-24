/**
 * MarkdownPreview.tsx —— Markdown 渲染（marked 完整语法 + mermaid 图表 + 本地图片附件）
 *
 * - marked 渲染标题/列表/表格/代码块/引用/链接等 GFM 语法
 * - ```mermaid 代码块渲染为图表（mermaid 动态加载，仅当文档含 mermaid 时才拉取 chunk）
 * - 安全（渲染的是**导入的外部不可信 wiki**，故按不可信输入处理）：
 *   ① 丢弃文档中内嵌的原始 HTML（避免样式注入/XSS），仅白名单放行 `<img>`（只取 src/alt/title，
 *      其余属性含 on* 事件一律丢弃）
 *   ② **URL scheme 白名单**：marked v18 默认不净化 href/src，`[x](javascript:...)` 会产出点击即
 *      执行的 `<a>`（浏览器实测），`data:text/html,<script>` 同理 → 对 link 与 image 都做 scheme
 *      白名单，拦下的降级为纯文本 + 可见标记（fail-loud，不静默吞掉）
 * - 本地图片附件（REQ-20260904-001）：提供 assetBase 时，相对路径 src 重写为 `/api/asset` 路由寻址
 *   group 级 assets 目录；加载失败的图片替换为可见占位块（fail-loud：明确告知"图片未导入 + 路径"，
 *   而非静默破图或空白）
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Marked, Renderer, type Token, type TokenizerAndRendererExtension } from 'marked';
import { isLocalDocumentHref } from '@/lib/documentLinks';

/** 附件寻址上下文：提供时相对路径图片重写为 /api/asset 路由；缺省时保持原 src（如写入页预览） */
export interface AssetBase {
  scope: string;
  group: string;
}

/** HTML 属性转义（防 alt/src/title 中的引号破坏属性边界） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 代码文本转义：代码高亮前先确保不可信内容只能作为文本节点显示。 */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** 复制代码时移除末尾全部 CR/LF（包括作者保留的末尾空行），避免终端粘贴后立即提交命令。 */
export function normalizeCodeForCopy(source: string): string {
  return source.replace(/[\r\n]+$/, '');
}

/** 是否为外部或不可寻址 URL（scheme / 协议相对 / posix 绝对路径）：保持原样不重写 */
export function isExternalOrAbsoluteUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url) || url.startsWith('/');
}

// ─── URL scheme 白名单（XSS 防线）────────────────────────────

/** 链接放行的 scheme；无 scheme（相对路径 / 锚点 / 查询）也放行 */
const SAFE_LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
/** 图片放行的 scheme；`data:` 单独处理（只允许 image/* 子类型，内联图片是合法用法） */
const SAFE_IMAGE_SCHEMES = new Set(['http', 'https']);

/**
 * 归一化后再判 scheme：去控制字符（含 \t\n，防 `java\tscript:` 绕过）与首尾空白，
 * 并解码数字实体（防 `java&#115;cript:` 绕过——浏览器解析属性值时会先解码实体）。
 */
function normalizeUrlForCheck(url: string): string {
  return url
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => safeFromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/gi, (_m, d: string) => safeFromCodePoint(parseInt(d, 10)))
    .trim();
}

/** String.fromCodePoint 对越界值会抛 RangeError；畸形实体不应让整个渲染失败 */
function safeFromCodePoint(n: number): string {
  try {
    return Number.isFinite(n) ? String.fromCodePoint(n) : '';
  } catch {
    return '';
  }
}

/** 取归一化后的 scheme（小写）；无 scheme 返回 null */
export function schemeOf(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(normalizeUrlForCheck(url));
  return m ? m[1].toLowerCase() : null;
}

/**
 * 链接 URL 是否可安全渲染为 `<a href>`。
 *
 * 为何必须自己判：marked v18 默认**不净化** href，而 `renderer.link` 此前从未被覆盖 →
 * `[x](javascript:alert(1))` 会原样产出可点击执行的 `<a>`（浏览器实测：大小写混淆
 * `JaVaScRiPt:`、前导空白、`data:text/html,<script>` 均透出）。渲染对象是导入的外部 wiki，
 * 同源下可进而调 `/api/*` 与 `/mcp` 写操作篡改 KB → 构成存储型 XSS。
 *
 * 放行：http(s) / mailto / 无 scheme（相对路径、锚点、查询、协议相对 `//`）。
 * 拦截：javascript: data: vbscript: blob: file: 等一切非白名单 scheme。
 */
export function isSafeLinkUrl(url: string): boolean {
  const u = normalizeUrlForCheck(url);
  if (!u) return false;
  const s = schemeOf(u);
  return s === null || SAFE_LINK_SCHEMES.has(s);
}

/** 图片 src 是否可安全渲染：http(s) / 相对路径 / `data:image/*`；拦 javascript: 与 data:text/html */
export function isSafeImageSrc(url: string): boolean {
  const u = normalizeUrlForCheck(url);
  if (!u) return false;
  const s = schemeOf(u);
  if (s === null) return true;
  if (SAFE_IMAGE_SCHEMES.has(s)) return true;
  return s === 'data' && /^data:image\//i.test(u);
}

/** 被拦下的链接：保留可读文本 + 一个带诊断信息的可见标记（fail-loud，不静默吞掉） */
function blockedLinkMark(url: string): string {
  const s = schemeOf(url) ?? '(未知)';
  return `<span class="ki-link-blocked" role="note" title="已拦截不安全的链接协议 ${escapeAttr(s)}:；原文 ${escapeAttr(url)}">⚠</span>`;
}

/** 被拦下的图片：沿用附件缺失占位块的视觉语义（同类：“这里本该有图，但它不可用”） */
function blockedImageNotice(url: string, alt: string): string {
  const s = schemeOf(url) ?? '(未知)';
  const altPart = alt ? `<span class="ki-asset-missing__alt">（${escapeAttr(alt)}）</span>` : '';
  return `<span class="ki-asset-missing" role="note">`
    + `<span class="ki-asset-missing__icon">⚠</span>`
    + `<span class="ki-asset-missing__text">已拦截不安全的图片协议 ${escapeAttr(s)}: · ${escapeAttr(url)}</span>`
    + altPart
    + `</span>`;
}

/** 相对路径图片 → /api/asset 路由；外链与绝对路径原样返回 */
export function rewriteAssetSrc(href: string, base?: AssetBase): string {
  if (!base || !href || isExternalOrAbsoluteUrl(href)) return href;
  const qs = new URLSearchParams({ scope: base.scope, group: base.group, path: href });
  return `/api/asset?${qs.toString()}`;
}

/**
 * 渲染前预处理：图片 URL 中的空格 percent-encode。
 * marked 不把含空格的 URL 解析为图片（会降为字面文本，REQ 形态 2），编码后即可正常解析；
 * 仅作用于渲染输入，不改动 local KB 原文。
 * 保护边界：代码围栏内不编码（示例不改写）；尖括号 destination 不编码（marked 原生支持含空格）；
 * title 部分原样拼回（marked 要求引用前为真实空白，%20 不被识别，否则 title 被并入 href → 404）。
 */
export function encodeImageSpaces(md: string): string {
  return outsideCodeFences(md, (seg) =>
    seg.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, body: string) => {
      if (body.trim().startsWith('<')) return `![${alt}](${body})`;
      const t = /\s+(?:"[^"]*"|'[^']*'|\([^)]*\))\s*$/.exec(body);
      const url = t ? body.slice(0, t.index) : body;
      return `![${alt}](${url.replace(/ /g, '%20')}${t ? t[0] : ''})`;
    })
  );
}

/** 按代码围栏（``` / ~~~）切分，仅对围栏外文本执行改写（与导入侧 outsideCodeFences 同逻辑） */
function outsideCodeFences(md: string, rewrite: (seg: string) => string): string {
  const lines = md.split('\n');
  let inFence = false;
  let buf: string[] = [];
  const out: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      out.push(rewrite(buf.join('\n')));
      buf = [];
    }
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out.join('\n');
}

/** 从 `<img>` 标签属性串中提取白名单属性值（带引号优先；无引号取到空白/`>` 为止） */
function extractAttr(attrs: string, name: string): string {
  const quoted = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)
    ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`, 'i').exec(attrs);
  if (quoted) return quoted[1];
  const bare = new RegExp(`\\s${name}\\s*=\\s*([^\\s>]+)`, 'i').exec(attrs);
  return bare ? bare[1] : '';
}

interface SafeDetailsToken {
  type: string;
  raw: string;
  open: boolean;
  summaryTokens: Token[];
  bodyTokens: Token[];
}

interface MarkdownLine {
  start: number;
  end: number;
  text: string;
}

/** 拆出带源码偏移的行，供 details tokenizer 精确消费原文。 */
function markdownLines(source: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf('\n', start);
    const end = newline < 0 ? source.length : newline + 1;
    const contentEnd = newline < 0 ? end : newline;
    lines.push({ start, end, text: source.slice(start, contentEnd).replace(/\r$/, '') });
    start = end;
  }
  return lines;
}

function fenceMarker(line: string): { char: '`' | '~'; length: number } | null {
  const match = /^ {0,3}(`{3,}|~{3,})/.exec(line);
  if (!match) return null;
  return { char: match[1][0] as '`' | '~', length: match[1].length };
}

function isFenceClose(line: string, fence: { char: '`' | '~'; length: number }): boolean {
  const match = /^ {0,3}(`+|~+)[ \t]*$/.exec(line);
  return Boolean(match && match[1][0] === fence.char && match[1].length >= fence.length);
}

const DETAILS_CLOSE_LINE = /^ {0,3}<\/details\s*>[ \t]*$/i;

function parseDetailsOpening(line: string): { attributes: string; summary?: string } | null {
  const match = /^ {0,3}<details\b([^>]*)>(.*)$/i.exec(line);
  if (!match) return null;
  const remainder = match[2].trim();
  if (!remainder) return { attributes: match[1] };
  const summary = /^<summary\b[^>]*>([\s\S]*?)<\/summary>$/i.exec(remainder);
  return summary ? { attributes: match[1], summary: summary[1] } : null;
}

function hasOpenAttribute(attributes: string): boolean {
  const attribute = /(?:^|\s)([^\s=/>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g;
  for (const match of attributes.matchAll(attribute)) {
    if (match[1].toLowerCase() === 'open') return true;
  }
  return false;
}

/** 将 GitHub 常见的 details 块收敛为安全 token；不透传其原始 HTML 属性。 */
function safeDetailsExtension(): TokenizerAndRendererExtension {
  return {
    name: 'kiSafeDetails',
    level: 'block',
    tokenizer(source) {
      const firstNewline = source.indexOf('\n');
      const firstContentEnd = firstNewline < 0 ? source.length : firstNewline;
      const first: MarkdownLine = {
        start: 0,
        end: firstNewline < 0 ? source.length : firstNewline + 1,
        text: source.slice(0, firstContentEnd).replace(/\r$/, ''),
      };
      const opening = parseDetailsOpening(first.text);
      if (!opening) return undefined;

      const lines = markdownLines(source);
      let depth = 1;
      let fence: { char: '`' | '~'; length: number } | null = null;
      let closing: MarkdownLine | undefined;
      for (const line of lines.slice(1)) {
        if (fence) {
          if (isFenceClose(line.text, fence)) fence = null;
          continue;
        }
        const marker = fenceMarker(line.text);
        if (marker) {
          fence = marker;
          continue;
        }
        if (parseDetailsOpening(line.text)) depth += 1;
        else if (DETAILS_CLOSE_LINE.test(line.text) && --depth === 0) {
          closing = line;
          break;
        }
      }
      // 不完整标签不生成控件；后续原始 HTML 仍由现有白名单策略处理。
      if (!closing) return undefined;

      const bodyStart = first.end;
      const bodyEnd = closing.start;
      const bodySource = source.slice(bodyStart, bodyEnd);
      let summary = opening.summary;
      let contentSource = bodySource;
      if (summary === undefined) {
        const bodyLines = markdownLines(bodySource);
        const summaryLine = bodyLines.find((line) => line.text.trim().length > 0);
        const summaryMatch = summaryLine && /^\s*<summary\b[^>]*>([\s\S]*?)<\/summary>\s*$/i.exec(summaryLine.text);
        if (summaryMatch && summaryLine) {
          summary = summaryMatch[1];
          contentSource = bodySource.slice(0, summaryLine.start) + bodySource.slice(summaryLine.end);
        }
      }
      summary ??= 'Details';
      const raw = source.slice(0, closing.end);

      return {
        type: 'kiSafeDetails',
        raw,
        open: hasOpenAttribute(opening.attributes),
        summaryTokens: this.lexer.inlineTokens(summary),
        bodyTokens: this.lexer.blockTokens(contentSource),
      };
    },
    renderer(token) {
      const details = token as SafeDetailsToken;
      const open = details.open ? ' open' : '';
      const summary = this.parser.parseInline(details.summaryTokens);
      const body = this.parser.parse(details.bodyTokens);
      return `<details${open}><summary>${summary}</summary>\n${body}</details>\n`;
    },
  };
}

/** 构造渲染器：image/link 做 scheme 白名单 + src 重写；html 仅白名单放行 `<img>`，其余原生 HTML 丢弃 */
function buildRenderer(base?: AssetBase) {
  const renderer = new Renderer();
  renderer.code = ({ text, lang }) => {
    const language = lang?.trim().split(/\s+/, 1)[0];
    const languageClass = language ? ` class="language-${escapeAttr(language)}"` : '';
    return '<div class="ki-code-block">'
      + '<button class="ki-code-copy" type="button" data-ki-copy-code aria-label="复制代码">复制</button>'
      + `<pre><code${languageClass}>${escapeHtml(text)}</code></pre>`
      + '<span class="ki-code-copy-status" aria-live="polite"></span>'
      + '</div>\n';
  };
  renderer.image = ({ href, title, text }) => {
    const raw = href ?? '';
    // scheme 白名单：javascript: 在 <img src> 中虽不执行（实测），但仍拦下以免留下误导性死图；
    // data:image/* 是合法内联图片用法，放行
    if (!isSafeImageSrc(raw)) return blockedImageNotice(raw, text ?? '');
    const src = rewriteAssetSrc(raw, base);
    const t = title ? ` title="${escapeAttr(title)}"` : '';
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text ?? '')}"${t}>`;
  };
  // 用 function 而非箭头函数：需要 this.parser.parseInline 渲染链接内嵌套格式（`[`code`](url)` 等），
  // 只用 token.text 会把内部 markdown 当字面文本输出
  renderer.link = function ({ href, title, tokens, text }) {
    const url = href ?? '';
    const inner = this.parser?.parseInline(tokens) ?? escapeAttr(text ?? '');
    if (!isSafeLinkUrl(url)) return `${inner}${blockedLinkMark(url)}`;
    const t = title ? ` title="${escapeAttr(title)}"` : '';
    // 外部链接开新页并断 opener（防 window.opener 反向操控来源页）；站内相对链接不加 target
    const ext = /^(?:https?:)?\/\//i.test(url.trim()) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${escapeAttr(url)}"${t}${ext}>${inner}</a>`;
  };
  renderer.html = ({ text }) => {
    // 块级 html token 可含多个标签（吃到空行为止）：遍历全部 <img> 逐个净化重建，
    // 避免多标签 token 因“整串锚定”不匹配而被整体丢弃（图片连占位块都不留）
    let out = '';
    for (const m of text.matchAll(/<img\b([^>]*?)\/?>/gi)) {
      const src = extractAttr(m[1], 'src');
      if (!src) continue;
      const alt = extractAttr(m[1], 'alt');
      const title = extractAttr(m[1], 'title');
      if (!isSafeImageSrc(src)) {
        out += blockedImageNotice(src, alt);
        continue;
      }
      const t = title ? ` title="${escapeAttr(title)}"` : '';
      out += `<img src="${escapeAttr(rewriteAssetSrc(src, base))}" alt="${escapeAttr(alt)}"${t}>`;
    }
    // 注：原生 HTML 的 `<a>` 不在白名单内，故被丢弃——这是**安全的**：marked 把
    // `<a href="javascript:x">文字</a>` 拆为 html token + text token + html token，丢标签后中间文字仍保留；
    // 整块级 html token 的情况下则连同文字一起丢（过度丢弃，但不构成注入面）。
    // 切勿在此重建 `<a>`：正则只能匹配开标签、拿不到标签文字，反而会用 href 充当文本并凭空多出链接。
    return out;
  };
  return renderer;
}

/** 渲染 Markdown 为 HTML 字符串（GFM：表格/删除线/任务列表；breaks 单换行转 <br>） */
export function renderMarkdownHtml(md: string, base?: AssetBase): string {
  const parser = new Marked({ renderer: buildRenderer(base), gfm: true, breaks: true });
  parser.use({ extensions: [safeDetailsExtension()] });
  return parser.parse(encodeImageSpaces(md), { async: false }) as string;
}

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid');
  return mermaidPromise;
}

/** 占位块展示用的原始路径：/api/asset 路由还原 path 参数，其余原样 */
function displaySrc(src: string): string {
  try {
    const u = new URL(src, window.location.origin);
    const p = u.searchParams.get('path');
    if (p) return p;
  } catch { /* 非 URL 形式原样返回 */ }
  return src;
}

/** 将加载失败的 img 替换为可见占位块（textContent 赋值，不引入注入面） */
function replaceWithPlaceholder(img: HTMLImageElement): void {
  if (img.dataset.kiAssetHandled) return;
  img.dataset.kiAssetHandled = '1';
  const src = img.getAttribute('src') ?? '';
  const wrap = document.createElement('div');
  wrap.className = 'ki-asset-missing';
  wrap.setAttribute('role', 'note');
  const icon = document.createElement('span');
  icon.className = 'ki-asset-missing__icon';
  icon.textContent = '🖼';
  const main = document.createElement('span');
  main.className = 'ki-asset-missing__text';
  main.textContent = `图片无法显示（未导入或加载失败） · ${displaySrc(src)}`;
  wrap.appendChild(icon);
  wrap.appendChild(main);
  const alt = img.getAttribute('alt');
  if (alt) {
    const altEl = document.createElement('span');
    altEl.className = 'ki-asset-missing__alt';
    altEl.textContent = `（${alt}）`;
    wrap.appendChild(altEl);
  }
  img.replaceWith(wrap);
}

async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch { /* insecure context / permission denial: try the compatible fallback */ }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  let copied = false;
  try {
    textarea.select();
    copied = document.execCommand('copy');
  } finally {
    textarea.remove();
  }
  if (!copied) throw new Error('浏览器未能复制文本');
}

/** Markdown 预览组件（dangerouslySetInnerHTML 渲染 + mermaid 图表挂载 + 附件占位块） */
export interface MarkdownPreviewProps {
  text: string;
  assetBase?: AssetBase;
  /** 返回 true 表示已在当前应用内处理该本地文档链接，应阻止浏览器默认跳转。 */
  onLocalLink?: (href: string) => boolean;
}

export function MarkdownPreview({ text, assetBase, onLocalLink }: MarkdownPreviewProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const html = useMemo(
    () => renderMarkdownHtml(text, assetBase),
    [text, assetBase?.scope, assetBase?.group],
  );

  // Markdown 通过 dangerouslySetInnerHTML 注入，不能给每个链接绑定 React onClick；
  // 用事件代理接入页面导航状态，同时保留外链、锚点和未解析链接的浏览器行为。
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !onLocalLink) return;
    const handleClick = (event: MouseEvent): void => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const link = target.closest('a[href]') as HTMLAnchorElement | null;
      if (!link || !root.contains(link)) return;
      const href = link.getAttribute('href');
      if (!href || !isLocalDocumentHref(href)) return;
      if (onLocalLink(href)) event.preventDefault();
    };
    root.addEventListener('click', handleClick);
    return () => root.removeEventListener('click', handleClick);
  }, [onLocalLink]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const timers = new Set<number>();
    let disposed = false;
    const handleCopy = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const button = target.closest<HTMLButtonElement>('[data-ki-copy-code]');
      if (!button || !root.contains(button)) return;
      const codeBlock = button.closest<HTMLElement>('.ki-code-block');
      const source = codeBlock?.querySelector<HTMLElement>('.ki-mermaid')?.dataset.copyText
        ?? codeBlock?.querySelector('pre code')?.textContent;
      if (source === undefined) return;
      const status = codeBlock?.querySelector<HTMLElement>('.ki-code-copy-status');

      button.disabled = true;
      void copyText(normalizeCodeForCopy(source)).then(() => {
        button.textContent = '已复制';
        button.setAttribute('aria-label', '代码已复制');
        button.dataset.copyState = 'success';
        if (status) status.textContent = '代码已复制';
      }).catch(() => {
        button.textContent = '复制失败';
        button.setAttribute('aria-label', '复制失败，请手动选择文本');
        button.dataset.copyState = 'error';
        if (status) status.textContent = '复制失败，请手动选择文本';
      }).finally(() => {
        if (disposed) return;
        const timer = window.setTimeout(() => {
          timers.delete(timer);
          if (!button.isConnected) return;
          button.textContent = '复制';
          button.setAttribute('aria-label', '复制代码');
          delete button.dataset.copyState;
          button.disabled = false;
          if (status) status.textContent = '';
        }, 1800);
        timers.add(timer);
      });
    };
    root.addEventListener('click', handleCopy);
    return () => {
      disposed = true;
      root.removeEventListener('click', handleCopy);
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, [html]);

  // mermaid 代码块异步渲染（动态加载 mermaid，避免无图表时也加载大 chunk）
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !html.includes('language-mermaid')) return;
    let cancelled = false;
    setReady(false);
    void loadMermaid().then((mod) => {
      if (cancelled) return;
      const mermaid = mod.default;
      // securityLevel 必须为 'strict'（mermaid 默认值），**不得改成 'loose'**：
      // 源码实证（mermaid 11.16.1）三处均以 loose 为开关——
      //   ① mermaid.core.mjs `else if (!isLooseSecurityLevel) DOMPurify.sanitize(...)`：loose 时**完全跳过净化**，
      //      原始 SVG 直接进 innerHTML（可含 foreignObject/事件属性）；
      //   ② setClickFun / setClickFunc 开头均 `if (securityLevel !== 'loose') return`：loose 时
      //      `click A call fn()` 会绑定为活动 JS 回调（比 javascript: 链接更危险）。
      // 本组件渲染的是**导入的外部不可信 wiki**，故取 strict。
      // 代价：图表内 HTML 标签会被转义为文本、`click` 交互失效——知识 wiki 的图表只用于展示，可接受。
      // 注：'loose' 是前端初始脚手架提交（c56d68b「对齐 demo」）带入的，无注释/无测试锁定，非故意围栏。
      mermaid.initialize({
        startOnLoad: false,
        theme: 'default',
        securityLevel: 'strict',
        // 避免 Mermaid 解析失败时将错误图插入 document.body。
        suppressErrorRendering: true,
      });
      const blocks = root.querySelectorAll<HTMLElement>('pre > code.language-mermaid');
      const renderAll = async (): Promise<void> => {
        for (const block of Array.from(blocks)) {
          if (cancelled) return;
          const code = block.textContent ?? '';
          const pre = block.closest('pre');
          if (!pre) continue;
          try {
            const { svg } = await mermaid.render(`ki-mermaid-${Math.random().toString(36).slice(2, 10)}`, code);
            const wrap = document.createElement('div');
            wrap.className = 'ki-mermaid';
            wrap.dataset.copyText = code;
            wrap.innerHTML = svg;
            pre.replaceWith(wrap);
          } catch {
            /* 解析失败保留源码块，用户可自行查看 */
          }
        }
        if (!cancelled) setReady(true);
      };
      void renderAll();
    });
    return () => {
      cancelled = true;
    };
  }, [html]);

  // 附件缺失 fail-loud：加载/解码失败的 img 替换为可见占位块（REQ-20260904-001）。
  // 以 decode() 结果判定而非 naturalWidth：Firefox 对无固有尺寸的 SVG 返回 naturalWidth=0 且 complete=true，
  // 尺寸判定会把加载成功的 SVG 误判为“未导入”。
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    for (const img of Array.from(root.querySelectorAll('img'))) {
      const fail = (): void => replaceWithPlaceholder(img);
      const checkDecoded = (): void => {
        if (typeof img.decode === 'function') img.decode().then(() => undefined).catch(fail);
        else if (img.naturalWidth === 0) fail();
      };
      if (img.complete) {
        checkDecoded();
      } else {
        img.addEventListener('error', fail, { once: true });
        img.addEventListener('load', checkDecoded, { once: true });
      }
    }
  }, [html]);

  return <div ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} data-mermaid={ready ? 'done' : undefined} />;
}
