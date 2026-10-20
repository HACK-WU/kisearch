/**
 * 路径命中高亮：把「用户写的检索词」映射回「展示用路径字符串」上的区间。
 *
 * 为什么不用 `searchText.tsx` 的 `highlightMatch`：那套词表是为**正文**设计的（按空白/标点拆词、
 * 中文 2~4 字滑窗、高频词剔除）。路径是"一整条定位串"，按滑窗拆会切出 `能/`、`档/AP` 这类
 * 碎片，高亮满屏却不指向用户真正输入的路径。这里只做**连续子串**高亮。
 *
 * 归一化口径与后端 `src/lib/doc-path.ts::normalizeSearchQuery` 保持一致：
 * `\` / 全角 `／` → `/`、去分隔符两侧空白、折叠重复分隔符、去 `./` 与前导/尾随 `/`、大小写不敏感。
 * ⚠️ 改任一侧必须同步另一侧，并对齐 `test/doc-path.test.ts` 与 `web/test/path-highlight.test.mjs`。
 */

export interface PathHighlightRange {
  /** 原始字符串上的起始下标（含） */
  start: number;
  /** 原始字符串上的结束下标（不含） */
  end: number;
}

/** 检索词归一（仅用于比较，不产出展示文本） */
export function normalizeQueryForMatch(raw: string): string {
  return raw
    .replace(/[\\／]/g, '/')
    .replace(/\s*\/\s*/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
}

/**
 * 路径归一，同时保留「归一后第 i 个字符来自原文第 map[i] 个字符」的映射。
 * 有映射才能把 mark 区间画回原文（原文里可能带空格、大小写与检索词不同）。
 */
function normalizePathWithMap(raw: string): { text: string; map: number[] } {
  const unified: { ch: string; index: number }[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    unified.push({ ch: ch === '\\' || ch === '／' ? '/' : ch, index: i });
  }
  const kept: { ch: string; index: number }[] = [];
  for (let i = 0; i < unified.length; i += 1) {
    const current = unified[i];
    if (/\s/.test(current.ch)) {
      // 分隔符两侧的空白不参与比较：页头展示的就是 `group / module` 这种带空格的形态
      if (kept[kept.length - 1]?.ch === '/') continue;
      let next: { ch: string } | undefined;
      for (let j = i + 1; j < unified.length; j += 1) {
        if (!/\s/.test(unified[j].ch)) {
          next = unified[j];
          break;
        }
      }
      if (next?.ch === '/') continue;
      kept.push(current);
      continue;
    }
    // 折叠重复分隔符
    if (current.ch === '/' && kept[kept.length - 1]?.ch === '/') continue;
    kept.push(current);
  }
  // 去前导 / 尾随分隔符（与检索词归一对称，否则 `a/` 永远匹配不到 `a`）
  while (kept.length > 0 && kept[0].ch === '/') kept.shift();
  while (kept.length > 0 && kept[kept.length - 1].ch === '/') kept.pop();
  return {
    text: kept.map((item) => item.ch.toLowerCase()).join(''),
    map: kept.map((item) => item.index),
  };
}

/**
 * 求检索词在路径文本中的高亮区间；不命中或检索词为空时返回 null（调用方原样渲染）。
 * 只返回**首个**命中区间：路径通常只出现一次，整条涂满反而不好读。
 */
export function findPathHighlightRange(pathText: string, query: string): PathHighlightRange | null {
  const needle = normalizeQueryForMatch(query);
  if (!needle || !pathText) return null;
  const { text, map } = normalizePathWithMap(pathText);
  const index = text.indexOf(needle);
  if (index < 0) return null;
  const last = index + needle.length - 1;
  if (map[last] === undefined) return null;
  return { start: map[index], end: map[last] + 1 };
}
