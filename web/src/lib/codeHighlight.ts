/**
 * codeHighlight.ts —— 代码块语法高亮（highlight.js，同步、按需语法、纯函数）
 *
 * 为什么单独成模块：
 * ① **同步**是硬约束 —— `renderMarkdownHtml` 是同步纯函数（供 `useMemo` 与流式渲染的
 *    `renderMarkdownBlocks` 复用 `old.html`），异步高亮库（如 Shiki 的 `codeToHtml`）无法直接嵌入，
 *    除非把整条渲染链改成异步。highlight.js 的 `highlight()` 同步返回，天然贴合。
 * ② **体积可控** —— 只引 `core` + 12 门实测命中的语言：raw 68KB / gzip 22KB
 *    （全量 190 门是 927KB / 304KB，实测不可接受）。语言表按真实 KB 的围栏语言分布选定：
 *    非 mermaid 代码块 1738 个，ts 505 / bash 185 / http 40 / json 17 / yaml 9 / jsonc 7 / sql 1 …
 *
 * 两条**降级而非报错**的边界（代码仍完整可读，只是没有颜色）：
 * - 未知语言 / 非语言（`text`） / 空语言 → 返回 null，调用方退回转义纯文本；
 * - 超阈值（行数 / 字符数）→ 返回 null。真实 KB 最大块仅 103 行，阈值只防 AI 生成的超长块
 *   卡主线程（实测 3000 行 72-92ms 可感知卡顿）。
 *
 * ⚠️ **mermaid 必须跳过着色**：它走图表渲染，源码只是兜底展示。
 */
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import http from 'highlight.js/lib/languages/http';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const GRAMMARS = {
  bash, css, go, http, java, javascript, json, python, sql, typescript, xml, yaml,
};

for (const [name, grammar] of Object.entries(GRAMMARS)) {
  hljs.registerLanguage(name, grammar);
}

/**
 * 不参与着色的围栏语言：
 * - `mermaid` —— 由图表渲染接管（失败时才展示源码，此时也无需颜色）；
 * - `text` / `plaintext` / `none` / `output` —— 声明为纯文本的块（真实 KB 里 `text` 有 36 处）。
 */
const SKIP_LANGUAGES = new Set(['mermaid', 'text', 'plaintext', 'txt', 'none', 'output']);

/** 超过以下规模直接跳过着色：单次高亮 >30ms 会让长文档打开时掉帧（实测 1000 行 ~28-70ms） */
export const HIGHLIGHT_MAX_LINES = 1000;
export const HIGHLIGHT_MAX_CHARS = 80 * 1024;

/**
 * 围栏语言 → 可用语法名；不可着色返回 null（别名 `ts` / `py` / `sh` / `yml` / `jsonc` / `html` 由 hljs 解析）。
 *
 * ⚠️ **返回归一后的围栏名（`raw`），不返回 `getLanguage().name`**：后者是**显示名**，
 * 如 xml 语法的 name 是 `HTML, XML`、typescript 是 `TypeScript`。拿显示名再喂回 `hljs.highlight`
 * 会二次经 `getLanguage()` 小写解析 —— `html, xml` 查不到 → 抛 `Unknown language`（实测：html 块
 * 因此静默降级成无颜色），而大小写巧合命中的（`typescript`）看不出问题，属"一半能跑"的坑。
 */
export function resolveHighlightLanguage(language?: string): string | null {
  const raw = (language ?? '').trim().toLowerCase();
  if (!raw || SKIP_LANGUAGES.has(raw)) return null;
  return hljs.getLanguage(raw) ? raw : null;
}

/**
 * 高亮一段代码，返回可安全插入 `<code>` 的 HTML；**返回 null 表示不着色**（调用方须自行转义）。
 *
 * 安全：highlight.js 的 `highlight()` 会自行转义 `& < > " '`（实测 `<script>` 输出为 `&lt;script`,
 * `</code>` 不逃逸容器），因此返回值只含 `<span class="hljs-*">` 与已转义文本。
 * 仍在此 try/catch：语法包异常不应让整篇文档渲染失败 —— 降级为「无颜色但可读」。
 */
export function highlightCodeHtml(text: string, language?: string): string | null {
  if (!text) return null;
  const resolved = resolveHighlightLanguage(language);
  if (!resolved) return null;
  if (text.length > HIGHLIGHT_MAX_CHARS) return null;
  // 行数判定放在字符数之后：先做 O(1) 的长度判断，避免每块都白扫一遍换行
  let lines = 1;
  for (let i = 0; i < text.length && lines <= HIGHLIGHT_MAX_LINES; i += 1) {
    if (text[i] === '\n') lines += 1;
  }
  if (lines > HIGHLIGHT_MAX_LINES) return null;
  try {
    return hljs.highlight(text, { language: resolved }).value;
  } catch {
    return null;
  }
}
