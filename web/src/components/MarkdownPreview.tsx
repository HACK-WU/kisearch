/**
 * MarkdownPreview.tsx —— Markdown 渲染（marked 完整语法 + mermaid 图表 + 本地图片附件）
 *
 * - marked 渲染标题/列表/表格/代码块/引用/链接等 GFM 语法
 * - ```mermaid 代码块渲染为图表（mermaid 动态加载，仅当文档含 mermaid 时才拉取 chunk）
 * - 安全：丢弃文档中内嵌的原始 HTML（避免样式注入/XSS），仅白名单放行 `<img>`（只取 src/alt/title，
 *   其余属性含 on* 事件一律丢弃）
 * - 本地图片附件（REQ-20260904-001）：提供 assetBase 时，相对路径 src 重写为 `/api/asset` 路由寻址
 *   group 级 assets 目录；加载失败的图片替换为可见占位块（fail-loud：明确告知"图片未导入 + 路径"，
 *   而非静默破图或空白）
 */

import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';

/** 附件寻址上下文：提供时相对路径图片重写为 /api/asset 路由；缺省时保持原 src（如写入页预览） */
export interface AssetBase {
  scope: string;
  group: string;
}

/** HTML 属性转义（防 alt/src/title 中的引号破坏属性边界） */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** 是否为外部或不可寻址 URL（scheme / 协议相对 / posix 绝对路径）：保持原样不重写 */
export function isExternalOrAbsoluteUrl(url: string): boolean {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url) || url.startsWith('/');
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

/** 构造渲染器：image 重写 src；html 仅白名单放行 `<img>`，其余原生 HTML 丢弃（XSS 防护） */
function buildRenderer(base?: AssetBase) {
  const renderer = new marked.Renderer();
  renderer.image = ({ href, title, text }) => {
    const src = rewriteAssetSrc(href ?? '', base);
    const t = title ? ` title="${escapeAttr(title)}"` : '';
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(text ?? '')}"${t}>`;
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
      const t = title ? ` title="${escapeAttr(title)}"` : '';
      out += `<img src="${escapeAttr(rewriteAssetSrc(src, base))}" alt="${escapeAttr(alt)}"${t}>`;
    }
    return out;
  };
  return renderer;
}

/** 渲染 Markdown 为 HTML 字符串（GFM：表格/删除线/任务列表；breaks 单换行转 <br>） */
export function renderMarkdownHtml(md: string, base?: AssetBase): string {
  return marked.parse(encodeImageSpaces(md), { renderer: buildRenderer(base), gfm: true, breaks: true }) as string;
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

/** Markdown 预览组件（dangerouslySetInnerHTML 渲染 + mermaid 图表挂载 + 附件占位块） */
export function MarkdownPreview({ text, assetBase }: { text: string; assetBase?: AssetBase }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const html = renderMarkdownHtml(text, assetBase);

  // mermaid 代码块异步渲染（动态加载 mermaid，避免无图表时也加载大 chunk）
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !html.includes('language-mermaid')) return;
    let cancelled = false;
    setReady(false);
    void loadMermaid().then((mod) => {
      if (cancelled) return;
      const mermaid = mod.default;
      mermaid.initialize({ startOnLoad: false, theme: 'default', securityLevel: 'loose' });
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
