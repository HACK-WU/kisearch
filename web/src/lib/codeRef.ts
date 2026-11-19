/**
 * codeRef.ts —— 把结论正文里的「代码位置 / 符号」解析成可点开的已确认位置。
 *
 * 为什么需要它：模型在 `chain[].text` 里更愿意写反引号（`` `src/lib/events/types.ts` ``、
 * `` `liveThinking?` ``），而不是把路径单独填进 `ref` 字段。只在 `ref` 有值时才给胶囊，
 * 等于把"能不能点"交给模型的心情 —— 实测 5 个节点全是空 ref，页面上看得见位置却点不动。
 *
 * 两轮匹配，先精确后宽松：
 * 1. **路径**（含 `/` 且末段带扩展名）：`path:line` 精确行 → 落在起止区间内 → 同文件唯一 → 同文件第一处；
 * 2. **符号**（`liveThinking?`、`EventView.pinnedAt`）：取最后一段，在**已确认位置的快照正文**里按词边界找，
 *    命中多处取行号最小的一处。
 *
 * 为什么允许多处取第一：点击后浮层**第一行就写着真实的 `file:line`**，看错位置的成本是"再往下列表看一眼"，
 * 而完全不显示胶囊的成本是"这个功能等于不存在"。歧义信息通过 `title` 与浮层页脚（该文件另有 N 处）交代。
 */

/** 只依赖结构，不 import api 类型：本模块同时被组件与 jiti 单测使用 */
export interface RefLocationLike {
  id: string;
  file: string;
  line: number;
  endLine?: number;
  /** 符号匹配只认"这段快照里出现过这个符号" */
  snippet?: string;
}

/** 反引号里出现的通用关键字不当符号（会和满屏代码撞） */
const SYMBOL_STOP = new Set([
  'catch', 'return', 'await', 'async', 'const', 'let', 'function', 'true', 'false',
  'null', 'undefined', 'string', 'number', 'boolean', 'import', 'export', 'default',
  'interface', 'type', 'new', 'this', 'self', 'props', 'state',
]);

/** 统一分隔符、去掉开头的 `./`（模型常写 `./src/a.ts`） */
export function normalizeRefPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

/**
 * 解析一段文本里的路径：`src/a.ts:12` / `src/a.ts` / `./src/a.ts`。
 * 不像路径（不含分隔符、末段没扩展名）返回 null。
 */
export function parseRefText(text: string): { path: string; line: number | null } | null {
  const raw = text.trim().replace(/^`|`$/g, '').trim();
  if (!raw) return null;

  let path = raw;
  let line: number | null = null;
  const colon = raw.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(raw.slice(colon + 1))) {
    path = raw.slice(0, colon);
    const parsed = Number(raw.slice(colon + 1));
    line = parsed >= 1 ? parsed : null;
  }

  path = normalizeRefPath(path);
  if (!path.includes('/')) return null;
  // 末段带扩展名才算文件：`src/lib/events` 这种目录名不参与（容易和分组路径撞）
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  if (!lastSegment.includes('.')) return null;

  return { path, line };
}

/**
 * 解析一段文本里的符号：`liveThinking?` → `liveThinking`；`EventView.pinnedAt` → `pinnedAt`。
 * 太短（<4）或落在通用关键字表里的一律不认，避免把 `type` / `props` 这种词链到随机快照。
 */
export function parseRefSymbol(text: string): string | null {
  const raw = text.trim().replace(/^`|`$/g, '').replace(/\(\)$/, '').replace(/\?$/, '').trim();
  if (!/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(raw)) return null;
  const last = raw.slice(raw.lastIndexOf('.') + 1);
  if (last.length < 4) return null;
  if (SYMBOL_STOP.has(last.toLowerCase())) return null;
  return last;
}

/** 两个路径是否指同一个文件：允许一侧是另一侧的路径后缀（模型常省略前缀目录） */
function sameFile(a: string, b: string): boolean {
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickFirst<T extends RefLocationLike>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return [...items].sort((a, b) => (a.line === b.line ? a.file.localeCompare(b.file) : a.line - b.line))[0]!;
}

/**
 * 在已确认位置里找这段文本指向的那一处（找不到 → null，调用方退回普通 code 样式）。
 * 返回的 `loc` 可能只是"同文件 / 同符号"的第一处，歧义由调用方在浮层页脚交代。
 */
export function matchConfirmedLocation<T extends RefLocationLike>(
  text: string,
  confirmed: readonly T[],
): T | null {
  const parsedPath = parseRefText(text);
  if (parsedPath) {
    const candidates = confirmed.filter((item) => sameFile(normalizeRefPath(item.file), parsedPath.path));
    if (candidates.length === 0) return null;

    if (parsedPath.line !== null) {
      const exact = candidates.find((item) => item.line === parsedPath.line);
      if (exact) return exact;
      // 指向区间内部（模型写 `:455`，确认位置是 `:453-456`）
      const inside = candidates.find((item) => {
        const end = item.endLine ?? item.line;
        return item.line <= parsedPath.line! && parsedPath.line! <= end;
      });
      return inside ?? null;
    }
    return pickFirst(candidates);
  }

  const symbol = parseRefSymbol(text);
  if (!symbol) return null;
  const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
  const holders = confirmed.filter((item) => item.snippet && pattern.test(item.snippet));
  return pickFirst(holders);
}

/** 同一位置集合里，与 `loc` 同文件的其它已确认位置数量（浮层页脚用：「该文件另有 N 处」） */
export function countSiblingsInFile<T extends RefLocationLike>(loc: T, confirmed: readonly T[]): number {
  const file = normalizeRefPath(loc.file);
  return confirmed.filter((item) => item.id !== loc.id && normalizeRefPath(item.file) === file).length;
}
