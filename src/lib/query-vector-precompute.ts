/**
 * 查询向量预计算传递（O3：把 embedding 移出 scope 占用窗口）。
 *
 * 背景（2026-09-14 并发查询实测）：MCP HTTP 把每个 tools/call 按 scope 提交
 * OperationCoordinator，同 scope 串行；而 embedding 网络调用位于占用窗口内，
 * 于是同 scope 并发查询的总耗时 = Σ(前序请求 embed + 检索)，一个慢 embed
 * （外部 provider 并发抖动实测 2–6.5s）会拖住整批请求（队头阻塞）。
 *
 * 方案：HTTP 层在 coordinator.submit **之前**解析 ki_search 的 query 并完成向量
 * 预计算（无锁、有界并发），经 AsyncLocalStorage 传入工具执行链；vectorSearch
 * 命中即复用、未命中回退自身 embed（短超时 + FTS 降级）。
 *
 * 失败安全：
 *   - 预计算失败只记录 `{ kind: 'failed' }`，工具侧据此跳过重复等待直接降级 FTS；
 *   - 没有任何上下文（CLI / stdio / 未预计算）时行为与改动前完全一致。
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** 预计算结果：向量本身，或失败原因（用于跳过工具内的重复等待） */
export type PrecomputedQueryVector =
  | { kind: 'vector'; vector: number[] }
  | { kind: 'failed'; reason: string };

const storage = new AsyncLocalStorage<Map<string, PrecomputedQueryVector>>();

/** 同一 query 使用不同 timeout 时必须隔离预计算结果。 */
export function queryVectorCacheKey(query: string, timeoutMs: number): string {
  return JSON.stringify([timeoutMs, query]);
}

/** 在 ALS 上下文中执行 fn；entries 为空时零开销直通 */
export function runWithPrecomputedQueryVectors<T>(
  entries: Map<string, PrecomputedQueryVector>,
  fn: () => T,
): T {
  return entries.size === 0 ? fn() : storage.run(entries, fn);
}

/** 读取当前上下文里某个 query + timeout 的预计算结果（无上下文返回 undefined） */
export function getPrecomputedQueryVector(query: string, timeoutMs: number): PrecomputedQueryVector | undefined {
  return storage.getStore()?.get(queryVectorCacheKey(query, timeoutMs));
}

/**
 * 有界并发 map（保持输入顺序）。
 *
 * 预计算必须限并发：并发度直接等于外部 embedding 的瞬时压力，
 * 无上限会把"预计算并行化"变成对 provider 的突发压测，反而抬高抖动率。
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const limit = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}
