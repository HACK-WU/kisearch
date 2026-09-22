/**
 * Markdown 本地文档链接解析。
 *
 * 文档原文中的 href 可能是：
 * - 相对当前 Markdown 文件的路径（如 ../lessons/lesson-03.md）；
 * - 以知识库根目录为基准的路径（如 stages/2-核心架构/lessons/lesson-03.md）；
 * - 带 URL 编码、查询参数或锚点的上述路径。
 *
 * 这里仅负责把 href 映射到 /api/doc/list 返回的文档元数据，实际切换状态由页面负责。
 */

import type { DocItem } from '@/api/httpApi';

const DOCUMENT_EXTENSIONS = /\.(?:md|markdown)$/i;

/** 文档抽屉当前项/历史项；content 仅在搜索结果已有原文时复用。 */
export interface DocumentView {
  module: string;
  group?: string;
  path?: string;
  content?: string;
  /** 从全文检索/浏览正文命中打开时，传递到阅读器的高亮查询词。 */
  highlightQuery?: string;
}

/** Markdown 链接是否可能是知识库中的本地文档链接。 */
export function isLocalDocumentHref(href: string): boolean {
  const value = href.trim();
  if (!value || value.startsWith('#')) return false;
  // 协议链接、协议相对链接交给浏览器原有行为；/ 开头的路径仍可能是本地 Web 文档路径。
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(value)) return false;
  return DOCUMENT_EXTENSIONS.test(decodePathPart(value));
}

/** 统一 URL 编码、分隔符和根目录前缀，供路径比较使用。 */
function normalizeDocumentPath(value: string): string {
  return decodePathPart(value)
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/^\.\//, '');
}

function decodePathPart(value: string): string {
  const pathPart = value.split(/[?#]/, 1)[0];
  try {
    return decodeURIComponent(pathPart);
  } catch {
    // 畸形 percent 编码不应让整个文档无法打开，保留原文交给后续精确匹配。
    return pathPart;
  }
}

function toAbsolutePath(href: string, basePath?: string): string | null {
  try {
    const base = basePath
      ? `https://ki.local/${normalizeDocumentPath(basePath)}`
      : 'https://ki.local/';
    return normalizeDocumentPath(new URL(href, base).pathname);
  } catch {
    return null;
  }
}

/**
 * 将 Markdown 本地链接解析为文档列表项。
 * 精确 sourcePath 优先；sourcePath 不可用时，再以文档名做唯一匹配兜底。
 */
export function resolveDocumentLink(
  href: string,
  currentPath: string | undefined,
  currentGroup: string | undefined,
  docs: DocItem[],
): DocItem | null {
  if (!isLocalDocumentHref(href)) return null;

  const candidatePaths = new Set<string>();
  const relativePath = toAbsolutePath(href, currentPath);
  const rootPath = toAbsolutePath(href);
  if (relativePath) candidatePaths.add(relativePath);
  if (rootPath) candidatePaths.add(rootPath);

  for (const candidate of candidatePaths) {
    const exact = docs.find((doc) => doc.path && normalizeDocumentPath(doc.path) === candidate);
    if (exact) return exact;
  }

  // 某些旧记录没有 sourcePath，只能用 basename + 当前 group 做安全兜底。
  const candidateNames = [...candidatePaths]
    .map((path) => path.split('/').pop() ?? '')
    .filter(Boolean)
    .map((name) => name.replace(DOCUMENT_EXTENSIONS, ''));
  for (const name of candidateNames) {
    const matches = docs.filter((doc) => doc.name === name);
    if (matches.length === 1) return matches[0];
    const sameGroup = matches.filter((doc) => doc.group === currentGroup);
    if (sameGroup.length === 1) return sameGroup[0];
  }

  return null;
}
