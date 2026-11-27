/**
 * link.ts —— `ki atlas link` 的**纯规划**逻辑（2026-11-27）
 *
 * I/O（读 views.json / 写成员 / 写 token）留在 `src/atlas.ts`；
 * 这里只回答两个问题，便于单测直接覆盖：
 *   1. 该把图集库加进哪些视图？（自动发现 / 显式限定 / 阈值跳过）
 *   2. 哪些 Token 需要补授权？（全量授权与已授权的跳过）
 *
 * 抽出来的原因：这两段是本命令唯一有分支的判断。留在 commander action 里
 * 只能靠「起真实库 + 真实 token 文件」验证，回归成本极高。
 */

/** 自动发现视图时，成员数超过该值即跳过（大杂烩视图不该被自动扩大授权） */
export const AUTO_LINK_MAX_MEMBERS = 5;

export interface AtlasLinkPlan {
  /** 需要把图集库加进去的视图（按原顺序） */
  targets: string[];
  /** 自动发现时因成员过多被跳过的视图 */
  skipped: string[];
  /** `--views` 里根本不存在的视图 */
  missingViews: string[];
  /** `--views` 里存在、但不含主库的视图（不能静默忽略：用户以为关联上了） */
  notContaining: string[];
}

/**
 * 规划目标视图。
 *
 * - 未给 `viewFilter`：自动发现「members 含主库」的视图，成员数 > 阈值（默认 5）的跳过
 * - 给了 `viewFilter`：只用它，且显式拒绝「不存在」与「不含主库」两类
 */
export function planAtlasLink(input: {
  mainScope: string;
  views: Record<string, { members: string[] }>;
  viewFilter?: string[];
  autoMaxMembers?: number;
}): AtlasLinkPlan {
  const max = input.autoMaxMembers ?? AUTO_LINK_MAX_MEMBERS;
  const names = Object.keys(input.views);
  const containing = names.filter((n) => input.views[n].members.includes(input.mainScope));

  if (input.viewFilter && input.viewFilter.length > 0) {
    const missingViews = input.viewFilter.filter((n) => !input.views[n]);
    const notContaining = input.viewFilter.filter(
      (n) => input.views[n] !== undefined && !containing.includes(n),
    );
    const rejected = missingViews.length > 0 || notContaining.length > 0;
    return {
      targets: rejected ? [] : input.viewFilter,
      skipped: [],
      missingViews,
      notContaining,
    };
  }

  const skipped = containing.filter((n) => input.views[n].members.length > max);
  return {
    targets: containing.filter((n) => input.views[n].members.length <= max),
    skipped,
    missingViews: [],
    notContaining: [],
  };
}

export interface TokenGrantPlan {
  /** 需要追加图集库 scope 的 Token id */
  updated: string[];
  /** 全量授权（`all`），无需追加 */
  skipped: string[];
}

/**
 * 规划补授权。已授权图集库的 Token 不计入任何一类（幂等重跑不产生噪声）。
 */
export function planTokenGrants(input: {
  tokens: { id: string; scopes: string[] }[];
  atlasScope: string;
  allScopes: string;
  isAuthorized: (scopes: string[], scope: string) => boolean;
}): TokenGrantPlan {
  const updated: string[] = [];
  const skipped: string[] = [];
  for (const token of input.tokens) {
    if (token.scopes.includes(input.allScopes)) {
      skipped.push(token.id);
      continue;
    }
    if (input.isAuthorized(token.scopes, input.atlasScope)) continue;
    updated.push(token.id);
  }
  return { updated, skipped };
}

/** 把图集库并入某 Token 的 scope 列表（去重，保持原顺序） */
export function withAtlasScope(scopes: string[], atlasScope: string): string[] {
  return scopes.includes(atlasScope) ? scopes : [...scopes, atlasScope];
}
