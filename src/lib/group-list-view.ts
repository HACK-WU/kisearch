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
 *
 * ★ 2026-11-27（事件 #112）：分析链路（`buildKbReadToolEntries`）与查找链路
 *   （`makeRecallToolRunner`）此前只查首个成员库 —— 它们手里已经是 `picked.physical`，
 *   且各自有 config 快照 / OperationCoordinator 互斥，不能进来再 `loadConfig()`。
 *   为此加两个**可选**入参（不传时三端行为逐字节不变）：
 *     - `resolved`：调用方已解析的成员库，跳过本层的视图解析；
 *     - `maxFullMembers`：分层降级，前 N 个成员完整树、其余只给顶层 Group 名。
 *   执行方式也可由调用方接管（`runOne`），保证快照与互斥不被绕过。
 */
import { loadConfig } from './config.js';
import { isViewRequest, resolveScopeTargets, type ScopeTargets } from './scope-view.js';
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
  /**
   * 该桶是**降级输出**（按 `maxFullMembers` 只给了顶层 Group 名）。
   * 调用方必须把这一点透传给模型/用户 —— 静默降级等于 #112 那个 bug 换个形态存在。
   */
  degraded?: true;
  /** 降级说明（可行动提示：怎么才能看到完整树） */
  note?: string;
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

/** 降级桶的固定提示（模型拿到后应改用单库 scope 下钻） */
export const DEGRADED_MEMBER_NOTE = '仅列顶层 Group（depth=1）；需细看该成员请把 scope 传成它的库名';

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
  /**
   * 调用方已解析好的成员库（分析 / 查找链路传入）。
   *
   * 为什么需要：这两条链路已经过 `resolveRecallTargets`（存在性 + 授权 + 视图展开），
   * 且分析侧在 `runWithConfigSnapshot` 作用域内执行 —— 本层再 `loadConfig()` 会读到
   * 快照之外的真实配置。传了就**跳过视图解析**，按 `physical` 长度决定单库/多桶。
   */
  resolved?: { physical: string[]; display: string[] };
  /**
   * 分层降级：前 N 个成员返回完整树，其余成员按 `depth: 1` 只给顶层 Group 名。
   *
   * 面向模型的分析 / 查找链路传 1（模型只需「知道有什么」，需要细节时自己下钻单库）；
   * 不传 = 全部成员完整树，CLI / MCP / 对话三端行为不变。
   */
  maxFullMembers?: number;
  /**
   * 执行器接管（可选）：调用方需要 config 快照 / OperationCoordinator 互斥时传入。
   *
   * 缺省 = 本层直接 `executeQueryGroup` + `withTimeout`（三端既有行为）。
   * 传了则**超时也由调用方负责**，本层只传 `capMs`（剩余总预算）过去。
   */
  runOne?: (
    target: string,
    capMs: number | undefined,
    params: Omit<QueryGroupParams, 'scope'>,
  ) => Promise<QueryGroupResult>;
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
    /** 被降级（只给顶层 Group）的成员；空数组表示全部成员都是完整树 */
    degraded: string[];
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
  const { timeout, resolved, maxFullMembers, runOne: runOneOverride, ...params } = opts;

  /** `capMs` 仅多桶分支用（把"总超时剩余量"作为该成员的上限） */
  const runMember = (target: string, capMs: number | undefined, p: Omit<QueryGroupParams, 'scope'>): Promise<QueryGroupResult> => {
    if (runOneOverride) return runOneOverride(target, capMs, p);
    const pending = executeQueryGroup({ scope: target, ...p });
    if (!timeout) return pending;
    const ms = capMs === undefined ? timeout.ms : Math.max(1, Math.min(timeout.ms, capMs));
    return withTimeout(pending, ms, timeout.label);
  };

  let targets: ScopeTargets;
  if (resolved) {
    // 调用方已解析：不复用 loadConfig()，只借用 ScopeTargets 的形状
    targets = { scopes: resolved.physical, views: resolved.display, skipped: [], multiRequested: resolved.physical.length > 1 };
  } else {
    targets = resolveScopeTargets(loadConfig(), scope);
  }

  /*
   * 多桶判据（2026-11-27 补齐逗号多库）：
   *   - 视图（`isViewRequest`，含单成员视图）→ 分桶；
   *   - 逗号多库（`multiRequested`）→ **也分桶**：请求形态本来就是多个库，
   *     `views` 为空只是说明"不是视图"，不代表"只查一个"。此前只认 isViewRequest，
   *     `scope:"a,b"` 落到 single 分支取 `targets.scopes[0]`，静默丢掉其余库（#112 残留面）；
   *   - `multiRequested` 是**请求形态**而非成员数，不与 `isViewRequest` 的单成员视图规则冲突；
   *   - resolved：调用方已展开，按物理库个数判断（display 可能不是视图名）。
   */
  const multi = resolved
    ? targets.scopes.length > 1
    : (isViewRequest(targets) || targets.multiRequested);

  if (!multi) {
    // 单段非视图 / 单成员 resolved：`resolveScopeTargets` 已做过 resolveScope + validateScope
    const target = targets.scopes[0];
    if (target === undefined) {
      return { kind: 'single', result: { ok: false, error: `无法解析 scope「${scope ?? ''}」` } };
    }
    return { kind: 'single', result: await runMember(target, undefined, params) };
  }

  // 回显：视图给视图名、逗号多库给原始入参、resolved 给 display；空串会让调用方误判「没有范围」
  const view = resolved ? resolved.display.join(',') : (targets.views[0] ?? scope ?? '');
  if (targets.scopes.length === 0) {
    return { kind: 'view-empty', view, views: targets.views, skipped: targets.skipped };
  }

  const totalMs = timeout?.totalMs;
  const deadline = totalMs === undefined ? undefined : Date.now() + totalMs;
  const buckets: GroupListBucket[] = [];
  const skipped: GroupListSkipped[] = [...targets.skipped];
  const degraded: string[] = [];

  for (const [index, member] of targets.scopes.entries()) {
    const remainMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainMs !== undefined && remainMs <= 0) {
      // 整体超时不整体失败：把没查的成员如实报出来，已查到的桶照常返回
      skipped.push({
        scope: member,
        reason: `视图整体超时（${totalMs}ms）已用尽，未查询该成员；可改用单库或减小 depth 后重试`,
      });
      continue;
    }
    /*
     * 分层降级（#112）：给模型用的链路不需要一次看完全部成员的全部内容，
     * 但**必须能看出"还有哪些成员、里面有哪些顶层 Group"**。depth=1 正好只渲染顶层，
     * 且仍走同一个执行器（快照 / 互斥 / 超时语义都不变）。
     */
    const isDegraded = maxFullMembers !== undefined && index >= maxFullMembers;
    const memberParams = isDegraded ? { ...params, depth: 1 } : params;
    if (isDegraded) degraded.push(member);
    try {
      const r = await runMember(member, remainMs, memberParams);
      buckets.push(r.ok
        ? { scope: member, output: r.output, ...(isDegraded ? { degraded: true as const, note: DEGRADED_MEMBER_NOTE } : {}) }
        : { scope: member, error: r.error });
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
    degraded,
  };
}
