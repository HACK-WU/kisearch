/**
 * 读正文（`ki_get_module_info`）的「视图展开」统一入口。
 *
 * 与 `group-list-view.ts` 同因：`executeGetModuleInfo` 只认**物理库名**，视图名传进去
 * 必然报「知识库尚未导入」。展开逻辑原本只写在 CLI（`src/get-module-info.ts` 的 action）
 * 与 MCP 工具（`src/lib/mcp-tools/get-module-info.ts`）里，对话侧
 * （`src/lib/chat/mcp-tool-registry.ts`）直接调核心函数 → 会话 scope 选视图时读正文必失败
 * （2026-11-26 · 事件 #110 复查时发现，同一根因的第三个入口）。
 *
 * ★ 视图下的语义不是「随便挑一个成员」：`group + relation` 在多个成员库可能同时命中，
 *   而两份文档可能同名异义。规则保持既有设计（S-07 D3）：
 *   显式 `member` 优先 → 否则逐库探测 → 唯一命中才返回 → 多命中 fail-loud 列候选。
 */
import { loadConfig } from './config.js';
import { getViewMembers, isViewRequest, resolveScopeTargets } from './scope-view.js';
import { withTimeout } from './mcp-tools/util.js';
import { executeGetModuleInfo, executeGetModuleInfoBatch } from '../get-module-info.js';

type ModuleInfoResult = Awaited<ReturnType<typeof executeGetModuleInfo>>;
type ModuleInfoBatchResult = Awaited<ReturnType<typeof executeGetModuleInfoBatch>>;

export interface GetModuleInfoViewParams {
  scope: string | undefined;
  group: string;
  /** 单条查询（与 `relations` 二选一） */
  relation?: string;
  /** 批量查询（≤10 条，须同 Group，与 `relation` 二选一） */
  relations?: string[];
  /** 视图模式下指定来源库（同一 group+relation 在多个成员库都存在时必填） */
  member?: string;
  /** 分段读取参数：**不传就不上报**，返回体与引入分页前逐字节一致 */
  page?: { startLine?: number; startChar?: number; maxChars?: number };
  timeout: { ms: number; label: string };
  /** 视图整体上限（可选；超时后剩余成员记入 failures 而不是整体失败） */
  totalMs?: number;
}

export type GetModuleInfoOutcome =
  /** 非视图，或视图 + 显式 member，或视图唯一命中：结果可直接透传 */
  | { kind: 'single'; result: ModuleInfoResult | ModuleInfoBatchResult; member?: string }
  | { kind: 'view-empty'; view: string; skipped: { scope: string; reason: string }[] }
  | { kind: 'bad-member'; view: string; member: string; members: string[] }
  | { kind: 'batch-needs-member'; view: string; candidates: string[] }
  | { kind: 'ambiguous'; view: string; candidates: { scope: string; result: ModuleInfoResult }[] }
  | {
    kind: 'not-found';
    view: string;
    searched: string[];
    failures: { scope: string; reason: string }[];
  };

/** 判断成员库返回的 `error` 是否只是「这篇文档不存在」（而非库故障） */
function resultError(r: ModuleInfoResult): string {
  const obj = r as unknown as { error?: unknown; hint?: unknown };
  const err = typeof obj.error === 'string' ? obj.error : '读取失败';
  return typeof obj.hint === 'string' && obj.hint.length > 0 ? `${err}（${obj.hint}）` : err;
}

export async function getModuleInfoByScope(params: GetModuleInfoViewParams): Promise<GetModuleInfoOutcome> {
  const { scope, group, relation, relations, member, page, timeout, totalMs } = params;
  /**
   * ★ 批量也必须**原样透传** startLine / startChar：核心 `executeGetModuleInfoBatchLocal`
   *   见到它们会 fail-loud 指路（"批量不支持分段，改用单条 relation"）。
   *   在这里只挑 maxChars 转发 = 静默丢弃起点参数，批量会从**文首**返回冒充用户请求的那一段。
   */
  const pageArgs = page ?? {};
  const targets = resolveScopeTargets(loadConfig(), scope);

  const runSingle = (target: string, capMs?: number): Promise<ModuleInfoResult> => {
    const pending = executeGetModuleInfo({ scope: target, group, relation: relation as string, ...pageArgs });
    const ms = capMs === undefined ? timeout.ms : Math.max(1, Math.min(timeout.ms, capMs));
    return withTimeout(pending, ms, timeout.label);
  };

  if (!isViewRequest(targets)) {
    // 非视图分支 `resolveScopeTargets` 恒给 1 个已解析 scope；兜底只为类型收窄
    const target = targets.scopes[0] ?? 'default';
    const result = relations
      ? await withTimeout(
        executeGetModuleInfoBatch({ scope: target, group, relations, ...pageArgs }),
        timeout.ms,
        timeout.label,
      )
      : await runSingle(target);
    return { kind: 'single', result };
  }

  const view = targets.views[0] ?? '';
  if (targets.scopes.length === 0) {
    return { kind: 'view-empty', view, skipped: targets.skipped };
  }

  let candidates = targets.scopes;
  if (member !== undefined) {
    const members = getViewMembers(loadConfig(), view);
    if (!members.includes(member)) {
      return { kind: 'bad-member', view, member, members };
    }
    candidates = [member];
  }

  // 批量：落到单一成员库（单成员视图无歧义 → 自动取唯一成员，不强制 member）
  if (relations) {
    const target = member ?? (targets.scopes.length === 1 ? targets.scopes[0] : undefined);
    if (!target) {
      return { kind: 'batch-needs-member', view, candidates };
    }
    const result = await withTimeout(
      executeGetModuleInfoBatch({ scope: target, group, relations, ...pageArgs }),
      timeout.ms,
      timeout.label,
    );
    return { kind: 'single', result, member: target };
  }

  const deadline = totalMs === undefined ? undefined : Date.now() + totalMs;
  const hits: { scope: string; result: ModuleInfoResult }[] = [];
  /**
   * 探测失败（不是"没这篇文档"，而是引擎锁 / 维度不匹配 / 索引损坏）单独收起来：
   * 不分流的话，0 命中时只能报"均未找到"—— 把故障说成"文档不存在"，
   * 用户会去别的库重导，问题永远不会被发现。
   */
  const failures: { scope: string; reason: string }[] = [];

  for (const candidate of candidates) {
    const remainMs = deadline === undefined ? undefined : deadline - Date.now();
    if (remainMs !== undefined && remainMs <= 0) {
      failures.push({
        scope: candidate,
        reason: `视图整体超时（${totalMs}ms）已用尽，未读取该成员`,
      });
      continue;
    }
    try {
      const r = await runSingle(candidate, remainMs);
      if (r.ok) hits.push({ scope: candidate, result: r });
      else if (member !== undefined) {
        // 显式指定了来源库：原样返回该库的错误（不再包装成"均未找到"）
        return { kind: 'single', result: r, member: candidate };
      } else {
        failures.push({ scope: candidate, reason: resultError(r) });
      }
    } catch (err) {
      failures.push({ scope: candidate, reason: (err as Error).message });
    }
  }

  if (hits.length === 1) {
    const only = hits[0];
    return { kind: 'single', result: only.result, member: only.scope };
  }
  if (hits.length > 1) {
    // 多命中不静默选一个：两份文档可能同名异义，且事后无法发现选错了
    return { kind: 'ambiguous', view, candidates: hits };
  }
  return { kind: 'not-found', view, searched: candidates, failures };
}

