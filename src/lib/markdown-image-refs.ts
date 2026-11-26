/**
 * markdown 图片引用的抽取与「是否本地相对路径」的判定（REQ-20260904-001 的实现本体）。
 *
 * 为什么从 `import.ts` 抽出来（与 `asset-path.ts` 抽出同一动机）：这两个函数是**纯字符串
 * 处理**，却被三类场景共用 —— 导入内核收集附件、`asset-image` 生成图片清单、以及删除/治理
 * 侧判定「图片还有没有文档引用」（`asset-orphan.ts`，#102）。后两者只要判定，不需要切分、
 * 向量与 SVG worker；留在 `import.ts` 里会把整个导入内核拉进删除路径的模块图。
 *
 * 这里是**唯一实现**：`import.ts` 只做 re-export 保持既有导出面，别再复制一份
 * （DRY 不是洁癖 —— 两份判据漂移时，「哪份算未被引用」会直接导致误删或漏删）。
 */

/** markdown 图片语法：![alt](url) / ![alt](url "title")；URL 允许含空格（形态 2，导入侧宽松收集，前端渲染时再编码） */
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g;
/** HTML 写法：<img src="url"> / <img src='url'> / <img src=url> */
const HTML_IMG_RE = /<img\b[^>]*?\ssrc\s*=\s*["']?([^"'\s>]+)["']?/gi;

/** 剥离 markdown 图片 URL 尾部的 title 部分（` "..."` / ` '...'`） */
function stripImageTitle(raw: string): string {
  return raw.replace(/\s+["'][^"']*["']\s*$/, '').trim();
}

/** 归一化图片引用 URL：剥 CommonMark 尖括号 destination（`![a](<p q.png>)`）、去尾部 title 与 #fragment */
function normalizeRefUrl(raw: string): string {
  let u = stripImageTitle(raw).trim();
  const angled = /^<([\s\S]*)>$/.exec(u);
  if (angled) u = angled[1].trim();
  return u.replace(/#.*$/, '');
}

/**
 * 按代码围栏（``` / ~~~）切分，仅对围栏外文本执行 extract（P2：防代码块内的示例图片
 * 被当真实引用收集 → 无谓告警；前端同源保护见 MarkdownPreview.encodeImageSpaces）
 */
function outsideCodeFences(md: string, extract: (seg: string) => void): void {
  const lines = md.split('\n');
  let inFence = false;
  let buf: string[] = [];
  const flush = (): void => {
    if (buf.length > 0) {
      extract(buf.join('\n'));
      buf = [];
    }
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    buf.push(line);
  }
  flush();
}

/** 提取 md 原文中的全部图片引用 URL（markdown 语法 + HTML <img src>；围栏外；不去重、不过滤） */
export function extractImageRefs(mdText: string): string[] {
  const out: string[] = [];
  outsideCodeFences(mdText, (seg) => {
    // 顺序语义：先遍历完 markdown 语法、再遍历 HTML <img>（非文档出现顺序）
    for (const m of seg.matchAll(MD_IMAGE_RE)) out.push(normalizeRefUrl(m[1]));
    for (const m of seg.matchAll(HTML_IMG_RE)) out.push(normalizeRefUrl(m[1]));
  });
  return out.filter((u) => u.length > 0);
}

/** 是否为“可收集的本地相对路径”：排除任何 scheme（http/https/file/data）、协议相对、posix/windows 绝对路径与锚点 */
export function isCollectibleRelativeAsset(url: string): boolean {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)) return false;
  if (url.startsWith('/')) return false;
  if (/^[a-zA-Z]:[\\/]/.test(url)) return false;
  if (url.startsWith('#')) return false;
  return true;
}
