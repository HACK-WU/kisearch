/**
 * 文档「逻辑路径」与检索词归一化（/api/doc/list?q 的路径检索）。
 *
 * 背景：`q` 原本只比 文档名 与 `relation.sourcePath`（**导入源目录的相对路径**），
 * 而界面上展示/引用的路径是「Group 路径 + 文件」。两者不同源 —— 实测 scope `monitot`：
 *   group = `wiki/API接口文档`，sourcePath = `API接口文档/API认证与授权.md`
 * 用户照着页头那条路径搜 `wiki/API接口文档/API认证与授权` 恒为 0 条，
 * 只剩「正文命中」的无关片段，于是被判定为"不支持路径匹配"。
 *
 * 本模块只做**纯字符串**处理（不触达文件系统；`..` 只是普通字符），三个口径：
 *   1. `normalizeSearchQuery` —— 检索词归一：`\`/`／` → `/`、折叠重复分隔符、去分隔符两侧空白、
 *      去 `./` 与前导/尾随 `/`、trim、小写。归一处后为空 = 无有效检索词（视为不过滤）。
 *   2. `logicalDocPath` —— group 与 sourcePath 按**最长重叠段**合并成一条路径；无 sourcePath
 *      时退回 `group/name`。重叠合并是必须的：否则 `wiki/API接口文档` + `API接口文档/x.md`
 *      会被拼成 `…/API接口文档/API接口文档/x.md`，真实路径反而搜不到。
 *   3. `matchDocQuery` —— 判定命中来源（`name` / `path` / 不命中），供前端分「名称命中」
 *      与「路径命中」两个分区展示。
 *
 * ⚠️ 同源约束：web 侧 `web/src/lib/pathHighlight.ts` 有一套等价的归一化口径（用于把检索词
 * 映射回展示字符串的高亮区间）。**改任一侧必须同步另一侧，并对齐 `test/doc-path.test.ts`
 * 与 `web/test/path-highlight.test.mjs` 的用例**。
 */

/** 反斜杠与全角斜杠统一成 `/`（Windows 复制粘贴 / 中文输入法常见形态） */
const SEPARATOR_CHARS = /[\\／]/g;

/** 可检索文档字段（relations-cache 投影，与 mcp-http-api 的 DocListCache.docs 同形） */
export interface SearchableDoc {
  name: string;
  group: string;
  /** 导入源相对路径（relation.sourcePath）；MCP/CLI 写入的文档没有该字段 */
  path?: string;
}

/** 命中来源：文档名 or 路径 */
export type DocMatchKind = 'name' | 'path';

/**
 * 检索词归一化。
 *
 * 归一后为空串时表示「没有有效检索词」（纯空格 / 纯 `/` / 纯 `\` 等），调用方应放行全部文档，
 * 而不是当成"搜不到任何东西"。
 */
export function normalizeSearchQuery(raw: string): string {
  return raw
    .replace(SEPARATOR_CHARS, '/')
    // 分隔符两侧空白不参与比较：页头就是 `group / module` 这种带空格的形态
    .replace(/\s*\/\s*/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .trim()
    .toLowerCase();
}

/** 按 `/` 拆段（去掉空段；段内空白保留，文件名本身可能带空格） */
function splitSegments(value: string): string[] {
  return value
    .replace(SEPARATOR_CHARS, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * 文档的逻辑路径：group 与 sourcePath 按最长重叠段合并。
 *
 * 依据实测的两种真实分布：
 *   - `sourcePath` 已含 group 前缀（`aiops/algorithms/rca/x.md` @ group `aiops/algorithms/rca`）→ 原样返回
 *   - `sourcePath` 缺 group 前缀（`API接口文档/x.md` @ group `wiki/API接口文档`）→ 补上 `wiki/`
 *   - 无 `sourcePath`（MCP / CLI 写入）→ 退回 `group/name`
 */
export function logicalDocPath(doc: SearchableDoc): string {
  const groupSegments = splitSegments(doc.group);
  const fileSegments = doc.path ? splitSegments(doc.path) : splitSegments(doc.name);
  // 最长重叠：group 的后缀 == path 的前缀
  let overlap = 0;
  const max = Math.min(groupSegments.length, fileSegments.length);
  for (let size = max; size > 0; size -= 1) {
    if (groupSegments.slice(-size).join('/') === fileSegments.slice(0, size).join('/')) {
      overlap = size;
      break;
    }
  }
  return [...groupSegments, ...fileSegments.slice(overlap)].join('/');
}

/**
 * 判定命中来源。
 *
 * - `normalizedQuery` 为空 → 返回 `null`（= 不过滤，调用方按"全部命中"处理）
 * - 文档名先比：名称命中的文档仍归「名称命中」分区（哪怕路径也含该词）
 * - 其余一律按路径比：逻辑路径已包含 group，因此**只输组名**也能命中
 */
export function matchDocQuery(doc: SearchableDoc, normalizedQuery: string): DocMatchKind | null {
  if (!normalizedQuery) return null;
  if (doc.name.toLowerCase().includes(normalizedQuery)) return 'name';
  // 路径侧同样过一遍归一（候选里可能有反斜杠/重复分隔符，与检索词保持同一比较口径）
  return normalizeSearchQuery(logicalDocPath(doc)).includes(normalizedQuery) ? 'path' : null;
}
