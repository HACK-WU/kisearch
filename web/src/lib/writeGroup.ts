/**
 * writeGroup.ts —— 写入落点推导（前端唯一实现）
 *
 * Group 允许留空：留空落到**与 scope 同名的 Group**——与 `ki import` 的根目录口径一致
 * （`src/lib/import-path.ts` 的 `resolveGroupForSource`：根下散文件归 `scope` 名）。
 *
 * ★ 为什么不引入"空 group 键"（让文档真正落在 scope 根）：
 *   - 分片路径：`group-cache.ts` 里 `''.split('/')` = `['']` 命中 `s === ''` ⇒ 直接抛"非法的 Group 路径"；
 *   - 落盘兼容桥：`persistCacheShape` 的 `if (!groupPath) continue` ⇒ 内存写成功、磁盘静默丢弃；
 *   - 分片枚举：`collectShardGroupPaths` 只收**目录**，根组成 `.relations/cache.json`（文件）⇒ 写进去永远读不到；
 *   - 路径向量：`buildGroupPathContent('')` = `''` ⇒ 所有根路径向量撞同一 docId 互相覆盖；
 *   - HTTP 语义：`/api/doc/list` 的 `group=` 空值已表示"全部文档"，二义；
 *   - 删除预览：`group-delete` 用 `path.dirname(getLocalKbDir(scope, ''))` ⇒ 把整个 scope 当成要删的组。
 *
 * 因此这里只做"回退到一个合法且语义一致的真实组"，不改变存储模型。
 */

export interface WriteGroupTarget {
  /**
   * 实际提交给后端的 Group（保证非空；group 与 scope 都为空时返回空串，
   * 由调用方的 scope 确认/校验先行拦截，不应以该状态提交）。
   */
  group: string;
  /** 是否走了"留空 → scope 同名组"的兜底（用于成功提示回显落点） */
  fellBack: boolean;
}

/**
 * 推导写入落点。
 * @param group 用户填写的 Group（可为空 / 空白 / 多级路径）
 * @param scope 已确认的目标 scope
 */
export function resolveWriteGroup(group: string, scope: string): WriteGroupTarget {
  const trimmedGroup = (group ?? '').trim();
  if (trimmedGroup) return { group: trimmedGroup, fellBack: false };
  const trimmedScope = (scope ?? '').trim();
  return { group: trimmedScope, fellBack: trimmedScope.length > 0 };
}
