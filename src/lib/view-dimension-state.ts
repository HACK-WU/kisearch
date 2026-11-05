/**
 * view-dimension-state.ts —— 视图成员「向量维度状态」的唯一读取口径。
 *
 * 为什么单独抽出来：`/api/views` 与 `ki_scope_list` 都要给 memberMeta 填
 * `dimensionState`，两份实现各自演化必然漂移（历史教训见 view-member-meta.ts 文件头）。
 *
 * ★ 刻意只读 `.vector-status` 快照文件，不调用 `getVectorDimensionStatus`：
 *   后者要 `withEngine` → `ZVecOpen` 拿进程锁，撞锁时 3×2s 重试，放进列表接口
 *   会把 /views 拖到分钟级。项目既有决策见 `src/mcp-server.ts`：启动不做
 *   O(scope) 逐集合维度诊断，维度冲突改为按需拦截。
 *
 * ★ 读的是 `readPersistedVectorDimension`（**不看 5 分钟 TTL**），不是
 *   `readVectorDimensionSnapshot`。后者在过期时会丢掉 `persisted` 并返回 unknown；
 *   实测本机 178 份快照全部过期（含真实 mismatch 的），若按 TTL 判定，
 *   「维度不一致」标记在真实数据里一个都不会出现。集合维度是结构性事实，
 *   只有重建/重导才会变，而这些路径都会刷新快照。
 *   配置侧维度则**活读** `config.embedding.dimension`，改配置后结论会跟着变。
 *
 * ★ 因此这是「已确认清单」，不是全量保证：
 *   · 没跑过 import / restore / refresh 的 scope 没有快照 → `unknown`
 *   · 快照缺 `persisted` / 损坏 / scope 不匹配 → `unknown`
 *   · 没标记的库 ≠ 维度正常，页面必须另给「N 个库维度状态未确认」
 *   · 集合被外部手段重建但快照未刷新时可能误报（fail-loud 取舍，hover 给出路）
 */

import { readPersistedVectorDimension } from './vector-dimension-snapshot.js';
import type { KiConfig } from './config.js';
import type { ViewDimensionState } from '../scope.js';

/**
 * 读单个 scope 的维度状态。纯 fs、零锁、不打开引擎；任何异常都降级为 `unknown`，
 * 绝不把维度检查失败变成列表接口的 500。
 */
export function readViewDimensionState(
  config: Pick<KiConfig, 'dataDir' | 'embedding'>,
  scope: string,
): ViewDimensionState {
  try {
    const persisted = readPersistedVectorDimension(config, scope);
    // 没有 persisted 就无法下结论：既不是「一致」，也不是「不一致」。
    if (persisted === undefined) return 'unknown';
    return persisted === config.embedding.dimension ? 'ok' : 'mismatch';
  } catch {
    return 'unknown';
  }
}
