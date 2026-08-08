/**
 * MarkdownPreview.tsx —— Markdown 渲染（marked 完整语法 + mermaid 图表）
 *
 * - marked 渲染标题/列表/表格/代码块/引用/链接等 GFM 语法
 * - ```mermaid 代码块渲染为图表（mermaid 动态加载，仅当文档含 mermaid 时才拉取 chunk）
 * - 安全：丢弃文档中内嵌的原始 HTML（避免样式注入/XSS）
 */

import { useEffect, useRef, useState } from 'react';
import { marked } from 'marked';

const renderer = new marked.Renderer();
// 丢弃原始 HTML 标签，防止知识库文档注入样式/脚本
renderer.html = () => '';

/** 渲染 Markdown 为 HTML 字符串（GFM：表格/删除线/任务列表；breaks 单换行转 <br>） */
export function renderMarkdownHtml(md: string): string {
  return marked.parse(md, { renderer, gfm: true, breaks: true }) as string;
}

let mermaidPromise: Promise<typeof import('mermaid')> | null = null;
function loadMermaid(): Promise<typeof import('mermaid')> {
  mermaidPromise ??= import('mermaid');
  return mermaidPromise;
}

/** Markdown 预览组件（dangerouslySetInnerHTML 渲染 + mermaid 图表挂载） */
export function MarkdownPreview({ text }: { text: string }): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const html = renderMarkdownHtml(text);

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

  return <div ref={rootRef} dangerouslySetInnerHTML={{ __html: html }} data-mermaid={ready ? 'done' : undefined} />;
}
