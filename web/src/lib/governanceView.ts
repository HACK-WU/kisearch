/**
 * governanceView.ts —— 治理页「视图模式」的前端基础设施（REQ-20261120-001 · S-04）
 *
 * 为什么单开而不是复用 `viewBuckets.ts`：
 *   那边把 `__root__` 映射成库名、并为浏览页的目录树服务；治理页要的是稳定的
 *   「库 / 组」展示与三段复合键。复用会把树的语义带进表格，改一处两边都受影响。
 *
 * 三条约定：
 *   ① 视图判定只看响应里有没有 `view`（与后端 `isViewRequest` 同源口径）；
 *   ② 条目键统一 `scope\0group\0name` —— 跨库同名文档必须能区分；
 *   ③ 单库模式（或旧 daemon 无 `scope`）照常工作：键退化为 `\0group\0name`。
 */

/** 当前响应是否来自视图（单库 / 旧 daemon → false） */
export function isGovernanceView(res: { view?: string } | null | undefined): boolean {
  return typeof res?.view === 'string' && res.view !== '';
}

/**
 * 文档/回收站条目的复合键。
 *
 * 用 NUL 分隔：group 路径本身含 `/`、scope 名允许 `-` `_`，NUL 两者都不可能出现。
 */
export function govDocKey(d: { scope?: string; group: string; name: string }): string {
  return `${d.scope ?? ''}\u0000${d.group}\u0000${d.name}`;
}

/**
 * 列表里展示的「库 / Group」。
 *
 * `__root__` 是根散文件的内部键（不是给人看的路径）→ 只显示库名。
 */
export function govGroupLabel(scope: string, group: string): string {
  return group === '__root__' ? scope : `${scope} / ${group}`;
}

/** 视图下写入口统一的禁用说明（与后端 409 `VIEW_NOT_WRITABLE` 语义一致） */
export const VIEW_WRITE_HINT = '视图为只读聚合，请切到具体知识库后再修改';
