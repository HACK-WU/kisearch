/**
 * writeGroup.ts —— 写入落点推导（前端唯一实现）
 *
 * Group 允许留空：留空落到**根**（后端 `__root__` 保留键）——与 `ki import` 的根目录口径一致
 * （`src/lib/import-path.ts` 的 `resolveGroupForSource`：源目录根下的散文件归根）。
 *
 * ★ 为什么不直接用空串表示根（`''` 作 group 键）：空键在分片路径、persistCacheShape、
 *   分片枚举、路径向量 docId、`/api/doc/list?group=` 语义上都不可表达（各条约束见后端注释）。
 *
 * ★ 为什么曾经用「与 scope 同名的组」而改掉：2026-11-02 实测确认它会与「源目录里真实存在
 *   一个与 scope 同名的子目录」共用同一个 group 键，两篇不同来源的同名文档被判成
 *   「幂等重导」，后一篇内容静默丢失。改成保留键后二者天然分离。
 *
 * ★ 根是「留空」的落点，用户不能手写：前端提交前把 `__root__` 视为空（与后端
 *   `isUserAssignableGroup` 的拒收口径对齐）。
 */

import { ROOT_GROUP_KEY } from './groupTree';

export interface WriteGroupTarget {
  /**
   * 实际提交给后端的 Group（保证非空；group 与 scope 都为空时返回空串，
   * 由调用方的 scope 确认/校验先行拦截，不应以该状态提交）。
   */
  group: string;
  /** 是否走了"留空 → 根"的兜底（用于成功提示回显落点） */
  fellBack: boolean;
}

/**
 * 推导写入落点。
 * @param group 用户填写的 Group（可为空 / 空白 / 多级路径）
 * @param scope 已确认的目标 scope
 */
export function resolveWriteGroup(group: string, scope: string): WriteGroupTarget {
  const trimmedGroup = (group ?? '').trim();
  // 保留名一律当"留空"处理：根只能通过留空到达（后端也会拒收手写的保留名）
  if (trimmedGroup && trimmedGroup !== ROOT_GROUP_KEY) return { group: trimmedGroup, fellBack: false };
  const trimmedScope = (scope ?? '').trim();
  // scope 为空时交回空串，由调用方的 scope 校验给出可读错误（不要凭空造一个根）
  return { group: trimmedScope ? ROOT_GROUP_KEY : '', fellBack: trimmedScope.length > 0 };
}
