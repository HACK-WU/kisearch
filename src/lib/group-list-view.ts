/**
 * Group 树查询的「视图展开」统一入口。
 *
 * 为什么需要这一层：`executeQueryGroup` 只认**物理库名**（读 `dataDir/<scope>/group-index.json`），
 * 视图名传进去必然报「知识库尚未导入」。视图 → 成员库的展开原本被复制在
 * CLI（`src/group.ts`）与 MCP 工具（`src/lib/mcp-tools/group-list.ts`）各一份，
 * 对话侧（`src/lib/chat/mcp-tool-registry.ts`）漏接 → 会话 scope 是视图时
 * `ki_group_list` 也报「尚未导入」（2026-11-26 · 事件 #110）。
 *
 * 本函数只做「解析 + 分桶 + 逐成员执行」，不做渲染：三端（CLI / MCP / 对话）
 * 各自把 {@link GroupListOutcome} 转成自己的输出形态，避免再复制第四份展开逻辑。
 *
 * ★ 视图判定只认 `isViewRequest`（名字命中 views.json），**不叠加成员数**：
 *   单成员视图同样是视图，落到单库分支会拿视图名当物理库名（见 scope-view.ts 注释）。
 */
import { loadConfig } from './config.js';
import { isViewRequest, resolveScopeTargets } from './scope-view.js';
import { withTimeout } from './mcp-tools/util.js';
import { executeQueryGroup, type QueryGroupParams, type QueryGroupResult } from '../query-group.js';

/** 单成员失败的告警（与 `ok:false` 的 `hint` 同语义：给下一步动作） */
export interface GroupListSkipped {
  scope: string;
  reason: string;
}

/** 一个成员库的查询结果：成功给渲染好的树，失败只影响该桶 */
export interface GroupListBucket {
  scope: string;
  output?: string;
  error?: string;
}

/**
 * 视图分支的整体上限。
 *
 * 为什么必须有：视图是**串行**逐成员查询，只设每成员上限时 N 个成员最坏 N×上限
 * （3 成员 90s / 13 成员 390s），调用方只会看到"卡住"。整体上限到点后
 * **剩余成员进 skipped 而不是整体失败** —— 已经查到的桶仍然有值。
 */
export const VIEW_TOTAL_TIMEOUT = {
  /** MCP 客户端 `tools/call` 硬超时 60s（SDK DEFAULT_REQUEST_TIMEOUT_MSEC），留 10s 余量 */
  MCP: 50_000,
  /** 对话通道无客户端硬超时，按"用户愿意等多久"取值 */
  CHAT: 90_000,
} as const;

export interface GroupListQueryOptions extends Omit<QueryGroupParams, 'scope'> {
  /**
   * 超时设置。MCP 与对话层都传 `TOOL_TIMEOUT.READ` 作单成员上限：
   * 视图有多成员时按「每成员一次」计算，与改造前 MCP 层的行为一致。
   */
  timeout?: {
    /** 单成员上限 */
    ms: number;
    /** 超时错误文案里的工具名 */
    label: string;
    /** 视图分支整体上限（不传 = 不设总上限，保持既有行为） */
    totalMs?: number;
  };
}

export type GroupListOutcome =
  /** 非视图：原样透传 `executeQueryGroup` 的结果（调用方自己决定 error 形态） */
  | { kind: 'single'; result: QueryGroupResult }
  /** 视图：按成员库分桶，`ok` 恒为 true（单桶失败只落在 bucket.error） */
  | {
    kind: 'view';
    view: string;
    views: string[];
    members: string[];
    /**
     * 成员总数。与 `buckets.length` 对比可发现「桶被序列化层截断」
     * （对话通道超预算时 `buckets` 会被裁，`memberTotal` 是标量、先于数组保留）。
     */
    memberTotal: number;
    buckets: GroupListBucket[];
    skipped: GroupListSkipped[];
  }
  /** 视图存在但没有可用成员（strict 模式下成员全未注册） */
  | { kind: 'view-empty'; view: string; views: string[]; skipped: GroupListSkipped[] };

/**
 * 按 scope 形态执行 Group 树查询。
 *
 * 抛错语义保持不变：`resolveScopeTargets` 的 `VIEW_EMPTY` / `INVALID_SCOPE` 照旧向上抛，
 * 由调用方（MCP handler 的 try/catch、对话 tool-loop）转成工具失败。
 */
export async function queryGroupByScope(
  scope: string | undefined,
  opts: GroupListQueryOptions,
): Promise<GroupListOutcome> {
  const { timeout, ...params } = opts;
  const targets = resolveScopeTargets(loadConfig(), scope);

  /** `capMs` 仅视图分支用（把"总超时剩余量"作为该成员的上限） */
  const runOne = (target: string, capMs?: number): Promise<QueryGroupResult> => {
    const pending = executeQueryGroup({ scope: target, ...params });
    if (!timeout) return pending;
    const ms = capMs === undefined ? timeout.ms : Math.max(1, Math.min(timeout.ms, capMs));
    return withTimeout(pending, ms, timeout.label);
  };

  if (!isViewRequest(targets)) {
    // 单段非视图：`resolveScopeTargets` 已做过 resolveScope + validateScope，这里不再拿原始入参
    const target = targets.scopes[0];
    if (target === undefined) {
      return { kind: 'single', result: { ok: false, error: `无法解析 scope「${scope ?? ''}」` } };
    }
    return { kind: 'single', result: await runOne(target) };
  }

  const view = targets.views[0] ?? '';
  if (targets.scopes.length === 0) {
    return { kind: 'view-empty', view, views: targets.views, skipped: targets.skipped };
  }

  const totalMs = timeout?.totalMs;
  const deadline = totalMs === undefined ? undefined : Date.now() + totalMs;
  const buckets: GroupListBucket[] = [];
  const skipped: GroupListSkipped[] = [...targets.skipped];

  for (const member of targets.scopes) {
    const remainMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainMs !== undefined && remainMs <= 0) {
      // 整体超时不整体失败：把没查的成员如实报出来，已查到的桶照常返回
      skipped.push({
        scope: member,
        reason: `视图整体超时（${totalMs}ms）已用尽，未查询该成员；可改用单库或减小 depth 后重试`,
      });
      continue;
    }
    try {
      const r = await runOne(member, remainMs);
      buckets.push(r.ok ? { scope: member, output: r.output } : { scope: member, error: r.error });
    } catch (err) {
      // 单个成员超时 / 索引损坏不应让整个视图不可用（与 CLI、MCP 既有口径一致）
      buckets.push({ scope: member, error: (err as Error).message });
    }
  }

  return {
    kind: 'view',
    view,
    views: targets.views,
    members: targets.scopes,
    memberTotal: targets.scopes.length,
    buckets,
    skipped,
  };
}
