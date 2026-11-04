/**
 * rootGroup.ts —— 「根散文件」保留键的前端唯一定义（**零依赖**）
 *
 * 为什么单列一个零依赖文件，而不是放在 `groupTree.ts`：
 * `chat/format.ts` 会被 node 侧的 jiti 验收测试直接 import，而 jiti **不认 `@/` 别名**；
 * `groupTree.ts` 为了类型引了 `@/api/httpApi`。把常量下沉到这里，两处都能安全复用，
 * 又不会产生第二份副本（副本一旦漂移，前端就会把 `__root__` 当成普通目录显示）。
 *
 * ★ 必须与后端 `src/lib/import-path.ts` 的 `ROOT_GROUP_KEY` 逐字一致。
 * ★ 该键只用于**存储**；一切面向人的出口都要经 `groupDisplayName()` 映射成「根」。
 */

export const ROOT_GROUP_KEY = '__root__';

/** 根组在界面上的称呼（只用于展示，绝不回传给后端） */
export const ROOT_GROUP_LABEL = '根';

/** 是否根组（容忍 `undefined` / `null`：调用方常从可选字段取值） */
export function isRootGroup(group: string | undefined | null): boolean {
  return group === ROOT_GROUP_KEY;
}

/**
 * Group → 展示名（根组显示为「根」；其余原样）。
 *
 * 容忍 `undefined` / `null`（返回空串）：调用方常从可选字段（`r.group?`、`viewing.group`）
 * 直接取值，逐个 `?? ''` 只会把同一件事重复十遍，还容易漏。
 *
 * ★ 只用于**独立字段**（键值对的值、抽屉身份行等省了会留空槽的位置）。
 *   **路径段**位置（`a / b` 拼接、面包屑、徽标、aria）一律用 `groupPathSegment()`：
 *   根散文件不是目录，写出「根 / 文档名」等于凭空多一级（2026-11-04 用户拍板）。
 */
export function groupDisplayName(group: string | undefined | null): string {
  if (!group) return '';
  return isRootGroup(group) ? ROOT_GROUP_LABEL : group;
}

/**
 * Group 作为**路径段**时的取值：根组**不贡献任何段**（返回空串），其余原样。
 *
 * 用法：`[groupPathSegment(x), name].filter(Boolean).join(' / ')` —— 根组自然退化成 `name`，
 * 调用方无需自己写 `isRootGroup` 分支，也不会漏掉分隔符（空串被 `filter(Boolean)` 吃掉）。
 */
export function groupPathSegment(group: string | undefined | null): string {
  return isRootGroup(group) ? '' : (group ?? '');
}

/**
 * 不能空着的字段（参数值 / 表格列）里对根的称呼。
 *
 * 这类位置留空会被读成"没设置 / 自动派生"，与事实（确实落在根）不同，故用「根目录」描述；
 * 它仍然是**路径段之外**的口径 —— 任何 `a / b` 拼接位置都该用 `groupPathSegment()`。
 */
export const ROOT_GROUP_FIELD_LABEL = '根目录';
