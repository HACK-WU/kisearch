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

export function isRootGroup(group: string): boolean {
  return group === ROOT_GROUP_KEY;
}

/** Group → 展示名（根组显示为「根」；其余原样） */
export function groupDisplayName(group: string): string {
  return isRootGroup(group) ? ROOT_GROUP_LABEL : group;
}
