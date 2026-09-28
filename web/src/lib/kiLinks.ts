/** 文件内可迁移的跳转链接：与旧 Markdown 链接在语法上可区分。 */
export type KiLinkTarget =
  | { v: 1; type: 'external'; url: string }
  | { v: 1; type: 'document'; scope: string; group: string; relation: string; anchor?: string };

const PREFIX = 'ki-link:';
const ANCHOR_PATTERN = /^(?:p|h|li|td|th)-[0-9a-f]{16}$/;

/** 可作为跳转落点的块级元素：标题、段落之外，列表项与表格单元格也能选中。 */
export const ANCHOR_SELECTOR = 'h1,h2,h3,h4,h5,h6,p,li,td,th';
/** 只有标题与段落，供编辑器锚点下拉使用，避免长表格把列表撑爆。 */
export const HEAD_PARA_SELECTOR = 'h1,h2,h3,h4,h5,h6,p';

export type AnchorKind = 'p' | 'h' | 'li' | 'td' | 'th';

/** 块元素对应的锚点类型；六级标题共用 h 前缀。 */
export function anchorKind(element: Element): AnchorKind {
  const tag = element.tagName.toLowerCase();
  if (tag === 'p') return 'p';
  if (tag.startsWith('h')) return 'h';
  return tag as AnchorKind;
}

/** 从选区里的任意节点向上找到最近的落点块。 */
export function anchorBlock(node: Node): HTMLElement | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  return element?.closest<HTMLElement>(ANCHOR_SELECTOR) ?? null;
}

export function encodeKiLink(target: KiLinkTarget): string {
  // encodeURIComponent 不编码圆括号；Markdown 链接目的地会被未编码的 ')' 提前截断。
  const encoded = encodeURIComponent(JSON.stringify(target)).replace(/[()]/g, (char) => char === '(' ? '%28' : '%29');
  return `${PREFIX}${encoded}`;
}

export function parseKiLink(href: string): KiLinkTarget | null {
  if (!href.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(decodeURIComponent(href.slice(PREFIX.length))) as Partial<KiLinkTarget>;
    if (value.v !== 1) return null;
    if (value.type === 'external' && typeof value.url === 'string') {
      const url = new URL(value.url);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
      return { v: 1, type: 'external', url: url.href };
    }
    if (value.type === 'document' && typeof value.scope === 'string' && typeof value.group === 'string'
      && typeof value.relation === 'string' && /^[a-zA-Z0-9_-]+$/.test(value.scope)
      && value.group.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'))
      && value.relation && !/[\\/\u0000]/.test(value.relation)
      && (!value.anchor || (typeof value.anchor === 'string' && ANCHOR_PATTERN.test(value.anchor)))) {
      return {
        v: 1, type: 'document', scope: value.scope, group: value.group, relation: value.relation,
        ...(value.anchor ? { anchor: value.anchor } : {}),
      };
    }
  } catch { /* 畸形或被篡改的链接不渲染为可点击链接 */ }
  return null;
}

export function deepLink(target: Extract<KiLinkTarget, { type: 'document' }>): string {
  const query = new URLSearchParams({ scope: target.scope, group: target.group, relation: target.relation });
  if (target.anchor) query.set('anchor', target.anchor);
  return `/browse?${query.toString()}`;
}

/** 基于可见块文本生成稳定 ID；重复同文段时阅读器拒绝猜测落点。 */
export function paragraphAnchor(kind: AnchorKind, text: string): string {
  const value = text.replace(/\s+/g, ' ').trim().normalize('NFC');
  let a = 2166136261;
  let b = 0x9e3779b9;
  for (let i = 0; i < value.length; i += 1) {
    a = Math.imul(a ^ value.charCodeAt(i), 16777619);
    b = Math.imul(b ^ value.charCodeAt(i), 2246822519);
  }
  return `${kind}-${(a >>> 0).toString(16).padStart(8, '0')}${(b >>> 0).toString(16).padStart(8, '0')}`;
}

export function findAnchorBlocks(
  root: ParentNode, selector: string = ANCHOR_SELECTOR,
): { anchor: string; label: string; element: HTMLElement }[] {
  return Array.from(root.querySelectorAll<HTMLElement>(selector))
    .map((element) => {
      const label = element.textContent?.replace(/\s+/g, ' ').trim() ?? '';
      return { anchor: paragraphAnchor(anchorKind(element), label), label, element };
    })
    .filter((entry) => entry.label.length > 0);
}
