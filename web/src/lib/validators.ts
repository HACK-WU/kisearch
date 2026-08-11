/**
 * 前端输入校验工具。
 *
 * 与后端校验对齐：
 * - Relation / Group / Tag 均拒绝路径分隔符（"/"、"\\"）与路径穿越（".."）
 * - Group / Tag 支持中文、字母、数字、连字符、下划线、空格、点号（用于子目录层级）
 * - Relation 与 wiki 文件名映射（relation.md），必须能在文件名系统中存在
 * - Tag 用逗号分隔，禁止包含逗号
 */

export const INVALID_PATH_CHARS = /[/\\]/;
export const PATH_TRAVERSAL = '..';

/** 判断 relation 是否含非法路径字符 */
export function isUnsafeRelationName(value: string): boolean {
  return INVALID_PATH_CHARS.test(value) || value.includes(PATH_TRAVERSAL);
}

/** 判断 group 路径（含子目录）是否合法：每段不允许 "/" 开头后跟 ..，全路径禁止 \ 和 .. */
export function isInvalidGroupPath(value: string): boolean {
  if (!value || !value.trim()) return true;
  if (value.includes('\\')) return true;
  if (value.includes('..')) return true;
  // 不允许绝对路径或相对路径开头
  if (value.startsWith('/')) return true;
  // 不允许空段（连续斜杠或尾部斜杠）
  const segments = value.split('/');
  if (segments.some((s) => s.length === 0)) return true;
  return false;
}

/** 判断 tag 是否合法：禁止逗号（分隔符）、路径分隔符、路径穿越、纯空白 */
export function isInvalidTag(value: string): boolean {
  if (!value || !value.trim()) return true;
  if (value.includes(',')) return true;
  if (INVALID_PATH_CHARS.test(value)) return true;
  if (value.includes('..')) return true;
  return false;
}

/** Group 路径校验错误文案（前端展示） */
export function groupError(value: string): string | null {
  if (!value || !value.trim()) return 'Group 路径不能为空';
  if (value.includes('\\')) return 'Group 路径不能包含 \\';
  if (value.includes('..')) return 'Group 路径不能包含 ..（路径穿越）';
  if (value.startsWith('/')) return 'Group 路径不能以 / 开头';
  if (value.split('/').some((s) => s.length === 0)) return 'Group 路径不能有连续或尾部 /';
  return null;
}

/** Relation 名称校验错误文案 */
export function relationError(value: string): string | null {
  if (!value || !value.trim()) return '文档名称不能为空';
  if (INVALID_PATH_CHARS.test(value)) return '文档名称不能包含 / 或 \\';
  if (value.includes('..')) return '文档名称不能包含 ..';
  return null;
}

/** Tag 校验错误文案 */
export function tagError(value: string): string | null {
  if (!value || !value.trim()) return 'Tag 不能为空';
  if (value.includes(',')) return 'Tag 不能包含逗号（逗号是 tag 分隔符）';
  if (INVALID_PATH_CHARS.test(value)) return 'Tag 不能包含 / 或 \\';
  if (value.includes('..')) return 'Tag 不能包含 ..';
  return null;
}