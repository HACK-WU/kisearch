/**
 * capabilities.ts —— Web 账号能力矩阵（REQ-20261103-001 · S-03 的前置）
 *
 * 角色只映射到能力集合；路由/工具门禁在 S-03 接入。
 * 本文件先供 `/api/auth/me` 返回 permissions。
 */

import type { Role } from '../user-store.js';

export type Capability =
  | 'knowledge.read'
  | 'knowledge.write'
  | 'chat.use'
  | 'chat.writeTools'
  | 'datasource.read'
  | 'datasource.write'
  | 'datasource.delete'
  | 'tasks.read'
  | 'tasks.cancel'
  | 'tasks.delete'
  | 'users.manage'
  | 'tokens.self'
  | 'ops.write'
  /** 视图读：所有登录角色都有（团队共享，D1） */
  | 'views.read'
  /**
   * 视图写：所有登录角色都有（D6「任何登录用户都能建自己的视图」）。
   * ★ **不能**放进 `WRITE_CAPABILITIES`：那里用来把 viewer 映射成 `USER_READONLY`，
   *   放进去会让「viewer 能建视图」与「viewer 只读」自相矛盾。
   */
  | 'views.write'
  /**
   * 一次性问答（`ki_ask`，REQ-20261113-001 · S-02 §3.2）。
   *
   * 与 `knowledge.read` 刻意分开：读是零成本，问答会消耗上游模型额度并外发内容，
   * 同一能力点无法分别授权（也就无法单独撤销）。
   */
  | 'knowledge.ask';

export const ALL_CAPABILITIES: readonly Capability[] = [
  'knowledge.read',
  'knowledge.write',
  'chat.use',
  'chat.writeTools',
  'datasource.read',
  'datasource.write',
  'datasource.delete',
  'tasks.read',
  'tasks.cancel',
  'tasks.delete',
  'users.manage',
  'tokens.self',
  'ops.write',
  'views.read',
  'views.write',
  'knowledge.ask',
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set(ALL_CAPABILITIES),
  editor: new Set<Capability>([
    'knowledge.read',
    'knowledge.write',
    'chat.use',
    'chat.writeTools',
    // 问答与对话同档：能对话就能问答（两者都消耗模型额度）
    'knowledge.ask',
    'datasource.read',
    'tasks.read',
    'tokens.self',
    'views.read',
    'views.write',
  ]),
  // viewer 也有 views.write：D6 的「只能改自己创建的」隐含「能创建」（否则无从谈起）
  viewer: new Set<Capability>([
    'knowledge.read',
    'chat.use',
    // 与 chat.use 同档：viewer 能对话就能问答（额度由 ki_ask 的限流兜住，不靠角色区分）
    'knowledge.ask',
    'tasks.read',
    'tokens.self',
    'views.read',
    'views.write',
  ]),
};

/**
 * 既有 MCP Token 的能力集合：保留既有能力，**不新增** users.manage / tasks.delete。
 * Token 仍受 scope 约束；本表只防止能力白名单给 Token 扩权。
 */
export const TOKEN_CAPABILITIES: ReadonlySet<Capability> = new Set(
  ALL_CAPABILITIES.filter((capability) =>
    capability !== 'users.manage'
    && capability !== 'tasks.delete'
    && capability !== 'tokens.self'
    // Token 是机器身份：可以读视图列表，但不该通过 HTTP 创建/修改视图（归属无法界定）
    && capability !== 'views.write'),
);

/** 动作维度为写的集合（用于错误码映射：viewer → USER_READONLY） */
export const WRITE_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'knowledge.write',
  'chat.writeTools',
  'datasource.write',
  'datasource.delete',
  'tasks.cancel',
  'tasks.delete',
  'users.manage',
  'ops.write',
]);

export function permissionsForRole(role: Role): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasCapability(role: Role, capability: Capability): boolean {
  return ROLE_CAPABILITIES[role].has(capability);
}
