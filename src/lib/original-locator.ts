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

/** 仅用于内部排序：将每个候选原文区域关联回产生它的 FTS chunk。 */
export interface OriginalMatchRankingContext {
  matches: OriginalMatch[];
  fallbackText: string;
  score?: number;
}

export interface OriginalLocator {
  /** 整个文档解析一次，后续按 query / 行范围定位时复用行数组。 */
  locate(query: string, options?: { fallbackText?: string; range?: SourceLineRange; fallbackOnly?: boolean }): OriginalMatch[];
  /** 用 chunk 中的原文锚点推导行范围，复用预计算的行偏移。 */
  locateChunkRange(chunkText: string): SourceLineRange | undefined;
  totalLines: number;
}

/** 每个文档默认返回的原文命中区域上限。 */
export const DEFAULT_ORIGINAL_MATCH_LIMIT = 3;

function buildLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

function lineNumberAt(lineStarts: number[], offset: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= offset) low = middle + 1;
    else high = middle - 1;
  }
  return high + 1;
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 为一个清洗后的 chunk 寻找原文行范围。
 * 只在存在可复核的原文锚点时返回范围；找不到时返回 undefined，避免伪造行号。
 */
function locateChunkRange(original: string, chunkText: string, lineStarts: number[]): SourceLineRange | undefined {
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
        lineStart: lineNumberAt(lineStarts, offset),
        lineEnd: lineNumberAt(lineStarts, offset + candidate.length - 1),
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

  // 这里曾有一个「逐行骨架包含」回退分支（把候选行与原文行去掉 Markdown/空白标记后
  // 互相比较），意图是兜住"清洗只改了标记"的行。实测该分支净有害：原文的空行/装饰行
  // （`---`、`###`）骨架为 ''，而 `候选.includes('')` 恒真 → 任何"全部候选行都没在原文
  // 命中"的 chunk 都会拿到一个指向空行的伪造行号（真实语料扫描 1503 文档 / 7476 chunk：
  // 44 次返回伪造空行、0 次命中真实内容行，且伪造出的 range 还会抑制 search 的
  // unmappedChunk 降级信号）。按本函数契约——找不到就返回 undefined，绝不伪造行号——
  // 删除该分支；"清洗只改空白/标记"的行本来就由上面的 indexOf 匹配覆盖。
  return undefined;
}

/** 为导入/重建产生的 chunk 计算原文行范围。 */
export function buildChunkLineRanges(
  original: string,
  chunks: Array<{ index: number; text: string }>,
): Map<number, SourceLineRange> {
  const result = new Map<number, SourceLineRange>();
  const lineStarts = buildLineStarts(original);
  for (const chunk of chunks) {
    const range = locateChunkRange(original, chunk.text, lineStarts);
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

function isAsciiTokenCharacter(character: string | undefined): boolean {
  return character !== undefined && /[A-Za-z0-9_+#]/.test(character);
}

function countOccurrences(text: string, term: string): number {
  if (!term) return 0;
  const startsWithAsciiWord = isAsciiTokenCharacter(term[0]);
  const endsWithAsciiWord = isAsciiTokenCharacter(term[term.length - 1]);
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(term, offset);
    if (index < 0) break;
    const before = text[index - 1];
    const after = text[index + term.length];
    if ((!startsWithAsciiWord || !isAsciiTokenCharacter(before)) && (!endsWithAsciiWord || !isAsciiTokenCharacter(after))) count += 1;
    offset = index + Math.max(1, term.length);
  }
  return count;
}

function normalizeForRanking(text: string): string {
  return normalizeLine(text).normalize('NFC').toLowerCase();
}

/** ASCII 单词按 token 边界匹配，避免把 `catapult` 算成命中 `cat`。 */
function containsTerm(text: string, term: string): boolean {
  if (!term) return false;
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(term, offset);
    if (index < 0) return false;
    const before = text[index - 1];
    const after = text[index + term.length];
    const startsWithAsciiWord = isAsciiTokenCharacter(term[0]);
    const endsWithAsciiWord = isAsciiTokenCharacter(term[term.length - 1]);
    if ((!startsWithAsciiWord || !isAsciiTokenCharacter(before)) && (!endsWithAsciiWord || !isAsciiTokenCharacter(after))) return true;
    offset = index + Math.max(term.length, 1);
  }
  return false;
}

function compareContextQuality(
  a: { coverage: number; density: number; occurrences: number; contextScore: number },
  b: { coverage: number; density: number; occurrences: number; contextScore: number },
): number {
  return b.coverage - a.coverage
    || b.density - a.density
    || b.occurrences - a.occurrences
    || b.contextScore - a.contextScore;
}

/**
 * 从一个文档的全部候选区域中选择最相关的前 N 个区域。
 *
 * 排名优先级：完整查询短语、查询词覆盖率、命中密度、区域紧密度、出现次数，
 * 最后用原文行号保证结果稳定。返回值按原文行号排序，便于
 * MCP 消费方和前端按“下一个命中”顺序跳转。
 */
export function selectTopOriginalMatches(
  matches: OriginalMatch[],
  query: string,
  limit = DEFAULT_ORIGINAL_MATCH_LIMIT,
  options: { fallbackText?: string; fallbackContexts?: OriginalMatchRankingContext[] } = {},
): OriginalMatch[] {
  if (matches.length === 0) return [];
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : DEFAULT_ORIGINAL_MATCH_LIMIT;
  const normalizedQuery = normalizeForRanking(query);
  const queryTerms = extractTerms(query);
  const normalizedMatches = matches.map((match) => ({
    match,
    text: normalizeForRanking(stripExcerptLineNumbers(match.excerpt)),
  }));
  const ranked = normalizedMatches.map(({ match, text }) => {
    const exactPhrase = normalizedQuery.length >= 2 && containsTerm(text, normalizedQuery) ? 1 : 0;
    const matchedQueryTerms = queryTerms.filter((term) => containsTerm(text, normalizeForRanking(term)));
    const applicableContexts = matchedQueryTerms.length === 0
      ? (options.fallbackContexts ?? []).filter((context) => context.matches.some((contextMatch) => (
        contextMatch.lineStart <= match.lineEnd && contextMatch.lineEnd >= match.lineStart
      )))
      : [];
    const fallbackTerms = applicableContexts.length > 0
      ? applicableContexts.map((context) => ({
        terms: extractTerms(context.fallbackText).slice(0, 12),
        score: context.score ?? 0,
      }))
      : matchedQueryTerms.length === 0 && options.fallbackText
        ? [{ terms: extractTerms(options.fallbackText).slice(0, 12), score: 0 }]
        : [{ terms: matchedQueryTerms, score: 0 }];
    const variants = fallbackTerms.map(({ terms, score }) => {
      const normalizedTerms = terms.map(normalizeForRanking);
      const matchedTerms = normalizedTerms.filter((term) => containsTerm(text, term));
      const occurrences = matchedTerms.reduce((total, term) => total + countOccurrences(text, term), 0);
      return {
        coverage: matchedTerms.length,
        occurrences,
        density: occurrences / Math.max(1, text.length),
        contextScore: score,
      };
    });
    variants.sort(compareContextQuality);
    const best = variants[0] ?? { coverage: 0, occurrences: 0, density: 0, contextScore: 0 };
    return {
      match,
      exactPhrase,
      ...best,
      span: match.lineEnd - match.lineStart + 1,
    };
  });

  ranked.sort((a, b) => (
    b.exactPhrase - a.exactPhrase
      || b.coverage - a.coverage
      || b.density - a.density
      || a.span - b.span
      || b.occurrences - a.occurrences
      || b.contextScore - a.contextScore
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
  const normalizedTerms = terms.map(normalizeForRanking);
  const matched: number[] = [];
  for (let line = start; line <= end; line += 1) {
    const normalizedLine = normalizeForRanking(lines[line - 1]);
    if (normalizedTerms.some((term) => containsTerm(normalizedLine, term))) matched.push(line);
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
function locateOriginalMatchesInLines(
  lines: string[],
  query: string,
  options: { fallbackText?: string; range?: SourceLineRange; fallbackOnly?: boolean } = {},
): OriginalMatch[] {
  const queryTerms = extractTerms(query);
  let matched = options.fallbackOnly ? [] : findMatchingLineNumbers(lines, queryTerms, options.range);

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

/** 缓存拆分行数组与行偏移，供同一文档的多个 FTS chunk 复用。 */
export function createOriginalLocator(original: string): OriginalLocator {
  const lines = original.split(/\r?\n/);
  const lineStarts = buildLineStarts(original);
  return {
    totalLines: lines.length,
    locate: (query, options = {}) => locateOriginalMatchesInLines(lines, query, options),
    locateChunkRange: (chunkText) => locateChunkRange(original, chunkText, lineStarts),
  };
}

export function locateOriginalMatches(
  original: string,
  query: string,
  options: { fallbackText?: string; range?: SourceLineRange; fallbackOnly?: boolean } = {},
): OriginalMatch[] {
  return createOriginalLocator(original).locate(query, options);
}

export function totalOriginalLines(original: string): number {
  return original.split(/\r?\n/).length;
}
