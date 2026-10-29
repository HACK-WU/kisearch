/**
 * registeredScopes.ts —— 总览页「显示注册 scope」卡片的纯逻辑
 *
 * 数据来自 `ki_scope_list`（DashboardPage 已经通过 `useScopeList()` 拉取）：
 * 本模块只做筛选与口径归一，不新增请求。
 *
 * 为什么独立成文件：`web/test` 只覆盖 `src/lib` 下的纯函数，而"哪些算注册项""模式怎么归一"
 * 这类判定最容易在后续改动中悄悄漂移。
 */

export interface RegisteredScopeLike {
  scope: string;
  registered: boolean;
}

export type ScopeMode = 'default' | 'strict';

/**
 * `ki_scope_list` 的 `scopeMode` 归一：未知 / 缺失一律按 default。
 *
 * 旧版 daemon 不返回该字段；strict 才需要特殊说明，回退 default 是保守方向。
 */
export function normalizeScopeMode(mode: string | undefined | null): ScopeMode {
  return mode === 'strict' ? 'strict' : 'default';
}

/** 只保留配置中注册的 scope（保持接口返回顺序，即 scope 名字典序） */
export function registeredScopesOf<T extends RegisteredScopeLike>(
  scopes: readonly T[] | undefined | null,
): T[] {
  return (scopes ?? []).filter((s) => s.registered);
}
