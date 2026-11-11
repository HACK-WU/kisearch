import { CHAT_BUDGET, type ChatToolResponse } from '../chat-contract.js';

/**
 * 工具返回的**有界序列化**（模型与页面共用同一份文本）。
 *
 * ═══ 截断语义（2026-11-11 改造）═══
 * 旧实现：序列化后**从字符串尾部直接切**，再补一句提示。两个后果：
 *   · 输出是半截 JSON，模型**解析不了**，也就看不到"被切之后还有哪些字段"；
 *   · **排在被切位置之后的字段整体消失** —— 例如 `ki_get_module_info` 的
 *     `{ok, scope, content, revision, totalLines}`，长文档的 `content` 一超预算，
 *     `revision` 就再也拿不到，`ki_edit_relation` 因此永远无法开工
 *     （`.plans/2026-11-11-get-module-info-paging` 用工具分页解决了长文档本身，
 *      这里补**通用**兜底：别的工具（`ki_search` / `ki_scope_list` …）不该重蹈覆辙）。
 *
 * 新实现分三级，**前一级削得动就不进下一级**：
 *   ① 字符串级：给所有字符串叶子取统一上限，二分出"还能放下的最大上限" ——
 *      只压正文，`ok` / `revision` / `totalLines` / 命中项的 `group`、`relation`、`score` 全部原样保留；
 *   ② 数组级：正文都是短字段（如 `ki_scope_list` 的上百条）时，改为给列表保留前缀，
 *      末尾补一条 `…[已截断：共 N 项，此处省略 M 项]`（总数字段仍在，模型知道真实规模）；
 *   ③ 兜底：非对象值 / 上面两级都放不下 → 沿用旧的前缀切（保证绝不超预算）。
 *
 * @param limit 本次序列化使用的字符上限（REQ-20261015-001：来自运行时配置的生效值）。
 *   **缺省 = 内置默认**，既有调用方零改动。
 * @param toolName 工具名（可选）：只用于把**兜底**截断标记写成「`ki_search`: 工具返回超过 …」，
 *   便于用户与排查侧直接看出是哪次调用被砍。不传则与既有文案逐字节一致。
 */
export function serializeToolResponse(
  value: unknown,
  limit: number = CHAT_BUDGET.maxToolResponseChars,
  toolName?: string,
): ChatToolResponse {
  const full = JSON.stringify(value, null, 2) ?? 'null';
  // 计数口径与全仓一致：按**码点**（不切代理对），且不额外分配数组
  const originalChars = codePoints(full);
  if (originalChars <= limit) return { text: full, originalChars, truncated: false, limit };

  const structured = shrinkStructured(value, limit);
  if (structured !== null) return { text: structured, originalChars, truncated: true, limit };

  // 兜底（非对象值 / 削无可削）：沿用旧的前缀切
  const marker = `\n…[${toolName ? `${toolName}: ` : ''}工具返回超过 ${limit} 字符，已截断]`;
  let prefix = '';
  let seen = 0;
  for (const char of full) {
    if (seen < limit - marker.length) prefix += char;
    seen += 1;
  }
  return { text: prefix + marker, originalChars: seen, truncated: true, limit };
}

// ─── 结构化截断 ─────────────────────────────────────────

/** 被削掉正文的字段在**字符串内部**留痕（不新增字段，模型的解析逻辑不用变） */
const fieldMarker = (origChars: number): string => `…[已截断：原文 ${origChars} 字符]`;

/** 被砍掉的列表元素：补一条同类数组里的"文字哨兵"（JSON 仍合法，且一眼看得出少了什么） */
const listMarker = (total: number, kept: number): string => `…[已截断：共 ${total} 项，此处省略 ${total - kept} 项]`;

/** 遍历节点数上界：超大对象不为一篇文档卡住事件循环（护栏：迭代必须有界） */
const MAX_NODES = 20_000;

type Path = (string | number)[];

interface StringLeaf {
  path: Path;
  /** 原值（二分时按不同上限重建，不必反复深克隆整棵对象） */
  orig: string;
  chars: number;
  /** 值本身比「截断标记」还短时不值得削 —— 削了反而更长 */
  shrinkable: boolean;
}

interface ListLeaf {
  path: Path;
  length: number;
}

/** 码点数（`for…of` 按码点迭代，天然不切代理对） */
function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** 取前 n 个**码点**（不会把 emoji 劈成半个） */
function sliceCodePoints(s: string, n: number): string {
  let out = '';
  let taken = 0;
  for (const ch of s) {
    if (taken >= n) break;
    out += ch;
    taken += 1;
  }
  return out;
}

/**
 * 按路径取节点；**路径失效时返回 undefined 而不是抛错**。
 *
 * 失效是常态：外层数组先被截断，属于被丢元素的内层数组/字段路径就没了。
 * 取不到就跳过（那些内容本来也已被丢弃），不能把整次序列化搞崩。
 */
function nodeAt(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
}

/** 按路径写值；路径已失效（父节点被截断丢弃）时**静默跳过**，同 `nodeAt` 的理由 */
function setIn(root: unknown, path: Path, value: unknown): void {
  let cur: unknown = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    if (cur === null || typeof cur !== 'object') return;
    cur = (cur as Record<string | number, unknown>)[path[i]];
  }
  if (cur === null || typeof cur !== 'object') return;
  (cur as Record<string | number, unknown>)[path[path.length - 1]] = value;
}

/** 收集字符串叶子与数组容器（同一趟遍历，节点数有上界） */
function collect(node: unknown, path: Path, strings: StringLeaf[], lists: ListLeaf[], budget: { left: number }): void {
  if (budget.left <= 0) return;
  budget.left -= 1;
  if (typeof node === 'string') {
    const chars = codePoints(node);
    strings.push({ path, orig: node, chars, shrinkable: chars > codePoints(fieldMarker(chars)) });
    return;
  }
  if (Array.isArray(node)) {
    if (node.length > 1) lists.push({ path, length: node.length });
    for (let i = 0; i < node.length; i += 1) collect(node[i], [...path, i], strings, lists, budget);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, val] of Object.entries(node as Record<string, unknown>)) {
      collect(val, [...path, key], strings, lists, budget);
    }
  }
}

/**
 * 结构化截断主流程：字符串级 → 数组级；返回 null 表示削无可削（交给兜底）。
 *
 * 两级都用**同一个上限轴**做二分：cap 越大保留越多，二分出"还放得下的最大 cap"，
 * 这样各字段/各列表按同一比例收敛，不会出现"第一个吃掉全部预算、后面只剩元数据"的畸形结果。
 */
function shrinkStructured(value: unknown, limit: number): string | null {
  if (value === null || typeof value !== 'object') return null; // 纯字符串/数字：兜底

  let pristine: unknown;
  try {
    // 只读副本：二分要对同一个原值反复重建，且**不得就地污染**调用方的对象
    pristine = JSON.parse(JSON.stringify(value));
  } catch {
    return null; // 含循环引用等不可序列化结构：交给兜底
  }

  const strings: StringLeaf[] = [];
  const lists: ListLeaf[] = [];
  collect(pristine, [], strings, lists, { left: MAX_NODES });

  /** 按「字符串上限 + 列表上限」重建一次文本（每次从 pristine 重建，互不残留） */
  const render = (capStrings: number, capLists: number): string => {
    const work = JSON.parse(JSON.stringify(pristine)) as unknown;
    for (const leaf of strings) {
      if (!leaf.shrinkable || leaf.chars <= capStrings) continue;
      setIn(work, leaf.path, sliceCodePoints(leaf.orig, capStrings) + fieldMarker(leaf.chars));
    }
    for (const list of lists) {
      if (list.length <= capLists) continue;
      // ⚠️ 外层数组先被截断时，内层数组的路径已经失效（元素被丢掉）——必须跳过，
      //    否则 `arr.length = …` 会抛 TypeError（auto-review 用嵌套 results[].chunks[] 复现过）
      const arr = nodeAt(work, list.path);
      if (!Array.isArray(arr)) continue;
      const keep = Math.max(0, capLists);
      arr.length = keep;
      arr.push(listMarker(list.length, keep));
    }
    return JSON.stringify(work, null, 2) ?? 'null';
  };

  // ① 字符串级：短字段不值得削，先看有没有可削的长正文
  let maxStrings = 0;
  for (const leaf of strings) if (leaf.shrinkable && leaf.chars > maxStrings) maxStrings = leaf.chars;
  if (maxStrings > 0) {
    const best = binarySearch(maxStrings, (cap) => render(cap, Number.POSITIVE_INFINITY), limit);
    if (best !== null) return best;
  }

  // ② 数组级：正文都是短字段（列表型工具），改为保留前缀 + 哨兵
  let maxList = 0;
  for (const list of lists) if (list.length > maxList) maxList = list.length;
  if (maxList > 0) {
    const best = binarySearch(maxList, (cap) => render(Number.POSITIVE_INFINITY, cap), limit);
    if (best !== null) return best;
    // ③ 混合形状：单个巨型字段 + 巨型列表**同时**要削（①削字不够、②带着原字段削不动），
    //    最后再试一次「字符串削到 0 + 列表二分」。只在真需要时多花这点遍历，不影响常规路径。
    const both = binarySearch(maxList, (cap) => render(0, cap), limit);
    if (both !== null) return both;
  }

  return null;
}

/**
 * 二分"还放得下的最大 cap"。
 * `build(cap)` 的文本长度随 cap 单调不增，故可直接二分；无解返回 null。
 */
function binarySearch(maxCap: number, build: (cap: number) => string, limit: number): string | null {
  let lo = 0;
  let hi = maxCap;
  let best: string | null = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = build(mid);
    if (codePoints(text) <= limit) {
      best = text;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}
