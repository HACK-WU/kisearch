/**
 * 浏览页检索结果的分区与摘要（2026-10-20 路径检索）。
 *
 * 背景：路径命中原先和名称命中挤在同一个「文件名命中」分区里，结果头还把
 * 「名称/路径命中」与「正文命中」加总成一个数字。实测页头形态的路径查询会得到
 * `名称/路径 0 + 正文 20 = 20 条` —— 用户看到"有 20 条"，却一条都不是按路径找到的，
 * 于是判定"不支持路径匹配"。这里把两件事分开：
 *   1) `splitSearchDocs`：按后端 `matchedBy` 拆成名称命中 / 路径命中两个分区；
 *   2) `searchResultSummary`：结果头分开报三个数，不再相加掩盖。
 */

export interface SearchDocSection<T> {
  nameHits: T[];
  pathHits: T[];
}

/**
 * 按命中来源拆分。
 * 旧版 daemon 不返回 `matchedBy`（undefined）→ 归入名称命中，保证降级时不丢结果。
 */
export function splitSearchDocs<T extends { matchedBy?: 'name' | 'path' }>(docs: T[]): SearchDocSection<T> {
  const nameHits: T[] = [];
  const pathHits: T[] = [];
  for (const doc of docs) {
    if (doc.matchedBy === 'path') pathHits.push(doc);
    else nameHits.push(doc);
  }
  return { nameHits, pathHits };
}

/** 结果头摘要：名称 / 路径 / 正文分别计数，禁止相加成一个"总数" */
export function searchResultSummary(counts: { name: number; path: number; fullText: number }): string {
  return `名称 ${counts.name} · 路径 ${counts.path} · 正文 ${counts.fullText}`;
}

/** 是否存在「名称 / 路径」命中：为 0 时前端必须显式提示，不能让正文结果顶掉 */
export function hasNameOrPathHit(section: { nameHits: unknown[]; pathHits: unknown[] }): boolean {
  return section.nameHits.length > 0 || section.pathHits.length > 0;
}

/**
 * 展示用路径：优先后端合并好的 `logicalPath`（Group + 导入源路径），
 * 旧 daemon 无该字段时退回 `path` / group（至少能看出在哪一组）。
 */
export function docDisplayPath(doc: { group: string; path?: string; logicalPath?: string }): string {
  return doc.logicalPath ?? doc.path ?? doc.group;
}

/**
 * 与后端 `normalizeSearchQuery` 的判空口径一致：只由分隔符 / 空白组成 = 无有效检索词。
 * 字符类必须同时含 **ASCII `/`**、`\`、全角 `／` 与空白 —— 少写一个就会让 `/` 通过判空、
 * 发一次"命中全库"的请求（自测用例锁住这一点）。
 */
export function hasSearchTerm(raw: string): boolean {
  return raw.replace(/[\\/／\s\u3000]/g, '').length > 0;
}
