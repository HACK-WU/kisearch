/**
 * view-member-meta.ts —— 视图成员元信息的**唯一构建口径**。
 *
 * 为什么单独抽出来：`/api/views`（视图管理页）与 `ki_scope_list`（MCP / CLI）
 * 都要产出 `ViewMemberMeta`，但两份实现曾各自演化 —— 页面侧填了
 * `docCount / scheduled / scheduledFailed`，MCP 侧只填 `scope / kb / vector / readonly`。
 * 同一个类型、同一份语义、两个入口给不同的东西，使用方看不出「哪个成员是空库」，
 * 而且不会报错（只是字段没有）。
 *
 * ★ 本模块**只做拼装**，不 import 任何会反向依赖调用方的模块（避免成环）：
 *   数据由调用方算好传入（`docCountOf` / `scheduledScopes` / `isReadonly`）。
 */

import type { ViewMemberMeta } from '../scope.js';

export interface MemberMetaInput {
  members: string[];
  /** 有 KB 数据的 scope */
  kbScopes: Set<string>;
  /** 有向量 collection 的 scope */
  vectorScopes: Set<string>;
  isReadonly: (scope: string) => boolean;
  /**
   * 文档数。返回 `undefined` 表示「未知/统计失败」——
   * 此时**不输出** `docCount`，前端因此不会标「空」（把统计失败标成空库更误导）。
   */
  docCountOf: (scope: string) => number | undefined;
  /** scope → 定时上次自动执行是否失败；不在表里 = 未配定时 */
  scheduledScopes: Map<string, boolean>;
}

export interface MemberMetaResult {
  memberMeta: ViewMemberMeta[];
  /** 两层都不存在的成员名 */
  missing: string[];
  /** 至少有一层（KB 或向量）存在的成员数 */
  availableCount: number;
}

/**
 * 构建成员元信息。
 *
 * 标记语义（页面据此渲染 chip）：
 * - `kb === false && vector === false` → 缺失（库不可用）
 * - `docCount === 0` → 空（库在、0 篇）
 * - `readonly` → 只读
 * - `scheduled` / `scheduledFailed` → 定时 / 定时（上次失败）
 */
export function buildMemberMeta(input: MemberMetaInput): MemberMetaResult {
  const { members, kbScopes, vectorScopes, isReadonly, docCountOf, scheduledScopes } = input;

  const memberMeta: ViewMemberMeta[] = members.map((scope) => {
    const kb = kbScopes.has(scope);
    const vector = vectorScopes.has(scope);
    // 没有 KB 数据时文档数必然是 0（也用于「缺失」之外的展示一致性）
    const docCount = kb ? docCountOf(scope) : 0;
    const scheduledFailed = scheduledScopes.get(scope);

    return {
      scope,
      kb,
      vector,
      readonly: isReadonly(scope),
      ...(docCount === undefined ? {} : { docCount }),
      ...(scheduledScopes.has(scope)
        ? { scheduled: true, ...(scheduledFailed ? { scheduledFailed: true } : {}) }
        : {}),
    };
  });

  const missing = memberMeta.filter((x) => !x.kb && !x.vector).map((x) => x.scope);
  return { memberMeta, missing, availableCount: members.length - missing.length };
}
