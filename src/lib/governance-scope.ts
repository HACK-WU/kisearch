/**
 * governance-scope.ts —— 知识治理**读路径**的 scope 解析（视图展开 + 鉴权）
 *
 * 为什么单开一个模块而不是改 `governance-http.ts` 的 `scopeFromQuery`：
 *   治理端点是读写混排的。写端点必须拿到**原始库名**，让 `withScopeWriteLock` 里的
 *   `assertNotScopeView` 去拒绝（视图不可写）；若在公共入口就把视图展开成成员库，
 *   「视图下改分类」会静默落到第一个成员库 —— 写错库比直接报错严重得多。
 *   所以只有读端点显式调用本模块。
 *
 * 三条约束：
 *   ① 视图展开只走 `resolveScopeTargets`（视图唯一展开点），本模块不自己拆 members；
 *   ② 鉴权必须「视图名 ∧ 全部成员」全有或全无（`isScopeAccessAllowed`）——
 *      只比名字会让 token 授权一个视图名就读到未授权成员库；
 *   ③ 成员数上限 {@link MAX_MEMBERS}：每个成员都是一次全量分片读，不限会让
 *      分类页请求随视图规模线性变慢（超限显式进 skipped，不静默丢）。
 */

import type { KiConfig } from './config.js';
import { resolveScopeTargets, isViewRequest, isViewError } from './scope-view.js';
import { isScopeAccessAllowed, missingViewMembers } from './scope-access.js';
import { GovernanceError } from './governance-errors.js';

/**
 * 单次合并的成员库上限。
 *
 * 与 `recall/types.ts` 的 `MAX_PHYSICAL` 同值同口径（IO 成本按物理库计）。
 * 本机 `just-test` 视图有 13 个成员 —— 超限时截断并写进 `skipped`，
 * 页面据此提示「还有 N 个库未加载」，而不是让整个视图不可用。
 */
export const MAX_MEMBERS = 12;

export interface GovernanceTargets {
  /** 原始请求值（视图名或库名），仅用于响应回显 */
  requested: string;
  /** 是视图时 = 视图名；单库为 null */
  view: string | null;
  /** 实际要读的物理库（视图已展开、去重、≤ MAX_MEMBERS） */
  members: string[];
  /** 未参与本次读取的成员（strict 未注册 / 超出上限），下游并入响应 `skipped` */
  skipped: { scope: string; reason: string }[];
  /** 是否因成员超限被截断 */
  truncated: boolean;
}

/**
 * 解析治理读请求的 scope。
 *
 * 行为（与 S01 设计文档 §3 行为表一一对应）：
 *   - 空 / 未传            → `default`
 *   - 真实库名             → 单库，鉴权沿用「名字在授权集合内」
 *   - 视图名               → 展开成员 + 全有或全无鉴权 + 上限截断
 *   - 含逗号（多段）       → 400 SCOPE_MULTI_UNSUPPORTED
 *   - 视图成员全被跳过     → 400 VIEW_NO_USABLE_MEMBER
 *
 * @throws GovernanceError（VIEW_EMPTY / VIEWS_CORRUPT / SCOPE_MULTI_UNSUPPORTED /
 *         VIEW_NO_USABLE_MEMBER / FORBIDDEN_SCOPE）
 */
export function resolveGovernanceTargets(
  config: KiConfig,
  raw: string | undefined,
  opts: { authScopes: string[] | null },
): GovernanceTargets {
  const requested = (raw ?? '').trim() || 'default';

  // 多段在治理域没有语义：既没有「多库并列」的页面，也无法定义混排后的归属展示。
  // 显式拒绝优于按第一段静默执行（那会让人以为看的是两个库的合集）。
  if (requested.includes(',')) {
    throw new GovernanceError(
      'SCOPE_MULTI_UNSUPPORTED',
      `治理端点只接受单个 scope（收到「${requested}」）。需要多库聚合请使用知识视图`,
      { scope: requested },
    );
  }

  let targets;
  try {
    targets = resolveScopeTargets(config, requested);
  } catch (err) {
    if (isViewError(err)) {
      if (err.code === 'VIEW_EMPTY') {
        throw new GovernanceError('VIEW_EMPTY', err.message, {
          ...(err.view ? { view: err.view } : {}),
        });
      }
      if (err.code === 'VIEWS_CORRUPT') {
        throw new GovernanceError('VIEWS_CORRUPT', err.message);
      }
    }
    throw err;
  }

  if (!isViewRequest(targets)) {
    const scope = targets.scopes[0] ?? requested;
    if (opts.authScopes && !opts.authScopes.includes(scope)) {
      throw new GovernanceError('FORBIDDEN_SCOPE', `无权访问 scope「${scope}」`, { scope });
    }
    return { requested: scope, view: null, members: [scope], skipped: [], truncated: false };
  }

  const view = targets.views[0];
  // 鉴权：名字命中还不够，必须全部成员都授权（scope-access.ts 的三条铁律之一）
  if (opts.authScopes && !isScopeAccessAllowed(opts.authScopes, view)) {
    const missing = missingViewMembers(opts.authScopes, view) ?? [];
    throw new GovernanceError(
      'FORBIDDEN_SCOPE',
      missing.length > 0
        ? `无权访问视图「${view}」：未授权其成员 ${missing.join('、')}`
        : `无权访问视图「${view}」`,
      { scope: view, missingViewMembers: missing },
    );
  }

  const skipped = [...targets.skipped];
  const members = targets.scopes.slice(0, MAX_MEMBERS);
  for (const extra of targets.scopes.slice(MAX_MEMBERS)) {
    skipped.push({
      scope: extra,
      reason: `超出单次合并上限 ${MAX_MEMBERS}，本次未读取`,
    });
  }
  const truncated = targets.scopes.length > MAX_MEMBERS;

  if (members.length === 0) {
    throw new GovernanceError(
      'VIEW_NO_USABLE_MEMBER',
      `视图「${view}」没有可用的成员库`,
      { view, skipped },
    );
  }

  return { requested: view, view, members, skipped, truncated };
}
