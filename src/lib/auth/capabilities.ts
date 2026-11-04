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
  | 'ops.write';

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
];

export const ROLE_CAPABILITIES: Record<Role, ReadonlySet<Capability>> = {
  admin: new Set(ALL_CAPABILITIES),
  editor: new Set<Capability>([
    'knowledge.read',
    'knowledge.write',
    'chat.use',
    'chat.writeTools',
    'datasource.read',
    'tasks.read',
    'tokens.self',
  ]),
  viewer: new Set<Capability>(['knowledge.read', 'chat.use', 'tasks.read', 'tokens.self']),
};

/**
 * 既有 MCP Token 的能力集合：保留既有能力，**不新增** users.manage / tasks.delete。
 * Token 仍受 scope 约束；本表只防止能力白名单给 Token 扩权。
 */
export const TOKEN_CAPABILITIES: ReadonlySet<Capability> = new Set(
  ALL_CAPABILITIES.filter((capability) =>
    capability !== 'users.manage' && capability !== 'tasks.delete' && capability !== 'tokens.self'),
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
