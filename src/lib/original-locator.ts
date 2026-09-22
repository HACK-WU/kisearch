/**
 * original-locator.ts —— 将 FTS 命中关联回 local KB 原文的最小定位能力。
 *
 * FTS 索引保存的是清洗后的 chunk，local KB 保存的是未清洗原文。这里不把
 * 清洗后的字符 offset 直接当成原文 offset，而是：
 * 1. 导入时用 chunk 中可在原文找到的稳定片段记录原文行范围；
 * 2. 检索时在原文中按查询词确认实际命中行；
 * 3. 历史索引没有 locator 时仍可尝试全原文匹配，失败则返回空匹配，不猜行号。
 */

export interface SourceLineRange {
  lineStart: number;
  lineEnd: number;
}

export interface FtsLocator extends SourceLineRange {
  /** FTS-only Collection 中的稳定 ID。 */
  ftsId: string;
  /** 导入时的源文件相对路径；sync-relation 产生的资产可能没有。 */
  sourcePath?: string;
  /** 清洗 chunk 的 1-based 序号。 */
  chunkIndex?: number;
}

export interface OriginalMatch extends SourceLineRange {
  /** 带行号前缀的原文片段，便于 MCP 无高亮展示。 */
  excerpt: string;
}

/** 每个文档默认返回的原文命中区域上限。 */
export const DEFAULT_ORIGINAL_MATCH_LIMIT = 3;

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 为一个清洗后的 chunk 寻找原文行范围。
 * 只在存在可复核的原文锚点时返回范围；找不到时返回 undefined，避免伪造行号。
 */
function locateChunkRange(original: string, chunkText: string): SourceLineRange | undefined {
  const lines = chunkText
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean);
  const candidates = [
    ...lines.filter((line) => line.length >= 8),
    ...lines.filter((line) => line.length >= 2 && line.length < 8),
  ];

  const matchedRanges: SourceLineRange[] = [];
  let searchFrom = 0;
  for (const candidate of candidates) {
    let offset = original.indexOf(candidate, searchFrom);
    if (offset < 0) offset = original.indexOf(candidate);
    if (offset >= 0) {
      matchedRanges.push({
        lineStart: lineNumberAt(original, offset),
        lineEnd: lineNumberAt(original, offset + candidate.length - 1),
      });
      searchFrom = offset + candidate.length;
    }
  }
  if (matchedRanges.length > 0) {
    return {
      lineStart: Math.min(...matchedRanges.map((range) => range.lineStart)),
      lineEnd: Math.max(...matchedRanges.map((range) => range.lineEnd)),
    };
  }

  // 清洗可能只改变了空白或 Markdown 标记。逐行按“原文包含清洗行”匹配，
  // 仍然只返回有证据的范围。
  const originalLines = original.split(/\r?\n/);
  const candidate = candidates[0];
  if (!candidate) return undefined;
  const normalizedCandidate = candidate.replace(/[\s`*_>#-]/g, '');
  if (normalizedCandidate.length < 2) return undefined;
  for (let i = 0; i < originalLines.length; i += 1) {
    const normalizedOriginal = normalizeLine(originalLines[i]).replace(/[\s`*_>#-]/g, '');
    if (normalizedOriginal.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedOriginal)) {
      return { lineStart: i + 1, lineEnd: i + 1 };
    }
  }
  return undefined;
}

/** 为导入/重建产生的 chunk 计算原文行范围。 */
export function buildChunkLineRanges(
  original: string,
  chunks: Array<{ index: number; text: string }>,
): Map<number, SourceLineRange> {
  const result = new Map<number, SourceLineRange>();
  for (const chunk of chunks) {
    const range = locateChunkRange(original, chunk.text);
    if (range) result.set(chunk.index, range);
  }
  return result;
}

function extractTerms(text: string): string[] {
  const terms = new Set<string>();
  const trimmed = text.trim();
  if (trimmed.length >= 2) terms.add(trimmed);
  for (const token of text.match(/[A-Za-z0-9_][A-Za-z0-9_./-]*|[\u3400-\u9fff]{2,}/g) ?? []) {
    if (token.length >= 2) terms.add(token);
  }
  return [...terms].sort((a, b) => b.length - a.length);
}

function stripExcerptLineNumbers(excerpt: string): string {
  return excerpt.replace(/^\d+ \| /gm, '');
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    count += 1;
    offset = index + Math.max(1, term.length);
  }
  return count;
}

/**
 * 从一个文档的全部候选区域中选择最相关的前 N 个区域。
 *
 * 排名优先级：完整查询短语、查询词覆盖率、查询词出现次数、命中密度、
 * 区域长度，最后用原文行号保证结果稳定。返回值按原文行号排序，便于
 * MCP 消费方和前端按“下一个命中”顺序跳转。
 */
export function selectTopOriginalMatches(
  matches: OriginalMatch[],
  query: string,
  limit = DEFAULT_ORIGINAL_MATCH_LIMIT,
  options: { fallbackText?: string } = {},
): OriginalMatch[] {
  if (matches.length === 0) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_ORIGINAL_MATCH_LIMIT;
  const normalizedQuery = normalizeLine(query).toLocaleLowerCase();
  const queryTerms = extractTerms(query);
  const normalizedMatches = matches.map((match) => ({
    match,
    text: normalizeLine(stripExcerptLineNumbers(match.excerpt)).toLocaleLowerCase(),
  }));
  const hasQueryTerm = queryTerms.some((term) => {
    const normalizedTerm = term.toLocaleLowerCase();
    return normalizedMatches.some(({ text }) => text.includes(normalizedTerm));
  });
  const rankingTerms = hasQueryTerm || !options.fallbackText
    ? queryTerms
    : extractTerms(options.fallbackText).slice(0, 12);

  const ranked = normalizedMatches.map(({ match, text }) => {
    const exactPhrase = normalizedQuery.length >= 2 && text.includes(normalizedQuery) ? 1 : 0;
    const matchedTerms = rankingTerms.filter((term) => text.includes(term.toLocaleLowerCase()));
    const occurrences = matchedTerms.reduce(
      (total, term) => total + countOccurrences(text, term.toLocaleLowerCase()),
      0,
    );
    const density = occurrences / Math.max(1, text.length);
    return {
      match,
      exactPhrase,
      coverage: matchedTerms.length,
      occurrences,
      density,
      span: match.lineEnd - match.lineStart + 1,
    };
  });

  ranked.sort((a, b) => (
    b.exactPhrase - a.exactPhrase
      || b.coverage - a.coverage
      || b.occurrences - a.occurrences
      || b.density - a.density
      || a.span - b.span
      || a.match.lineStart - b.match.lineStart
      || a.match.lineEnd - b.match.lineEnd
  ));

  return ranked
    .slice(0, safeLimit)
    .map(({ match }) => match)
    .sort((a, b) => a.lineStart - b.lineStart || a.lineEnd - b.lineEnd);
}

function findMatchingLineNumbers(lines: string[], terms: string[], range?: SourceLineRange): number[] {
  const start = Math.max(1, range?.lineStart ?? 1);
  const end = Math.min(lines.length, range?.lineEnd ?? lines.length);
  const matched: number[] = [];
  for (let line = start; line <= end; line += 1) {
    if (terms.some((term) => lines[line - 1].includes(term))) matched.push(line);
  }
  return matched;
}

function toWindows(lines: number[]): Array<SourceLineRange> {
  const windows: Array<SourceLineRange> = [];
  for (const line of lines) {
    const previous = windows.at(-1);
    if (previous && line <= previous.lineEnd + 1) previous.lineEnd = line;
    else windows.push({ lineStart: line, lineEnd: line });
  }
  return windows;
}

/**
 * 在原文中定位查询词；fallbackText 用于查询词经过分词/清洗后与原文不完全一致的旧索引。
 */
export function locateOriginalMatches(
  original: string,
  query: string,
  options: { fallbackText?: string; range?: SourceLineRange } = {},
): OriginalMatch[] {
  const lines = original.split(/\r?\n/);
  const queryTerms = extractTerms(query);
  let matched = findMatchingLineNumbers(lines, queryTerms, options.range);

  if (matched.length === 0 && options.fallbackText) {
    const fallbackTerms = extractTerms(options.fallbackText).slice(0, 12);
    matched = findMatchingLineNumbers(lines, fallbackTerms, options.range);
  }

  return toWindows(matched).map(({ lineStart, lineEnd }) => ({
    lineStart,
    lineEnd,
    excerpt: lines
      .slice(lineStart - 1, lineEnd)
      .map((line, index) => `${lineStart + index} | ${line}`)
      .join('\n'),
  }));
}

export function totalOriginalLines(original: string): number {
  return original.split(/\r?\n/).length;
}
