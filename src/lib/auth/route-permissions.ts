/**
 * route-permissions.ts —— `/api/*` 能力注册表（REQ-20261103-001 · S-03）
 *
 * 白名单 + 默认拒绝：
 * - 只有本表命中的路径才会进入 handler；
 * - 命中但 principal 缺少 capability → 403；
 * - 未命中 → 404（与既有“路径不存在”语义一致）。
 *
 * 新增 `/api` 路由必须同时在本表登记；覆盖率测试会枚举 handler 路由字面量并断言覆盖。
 */

import type { Capability } from './capabilities.js';

export type RouteKind = 'public' | 'authenticated' | 'permission';

export interface RouteMatch {
  kind: RouteKind | 'unknown';
  capability?: Capability;
}

interface Rule {
  method: string;
  test: (path: string) => boolean;
  kind: RouteKind;
  capability?: Capability;
}

function exact(method: string, path: string, kind: RouteKind, capability?: Capability): Rule {
  return { method, test: (p) => p === path, kind, ...(capability ? { capability } : {}) };
}

function pattern(method: string, regex: RegExp, kind: RouteKind, capability?: Capability): Rule {
  return { method, test: (p) => regex.test(p), kind, ...(capability ? { capability } : {}) };
}

const RULES: Rule[] = [
  // ── 认证（gate 之前已处理；登记用于覆盖率与 public 语义）──
  exact('POST', '/auth/login', 'public'),
  exact('GET', '/auth/me', 'public'),
  exact('POST', '/auth/logout', 'public'),
  exact('POST', '/auth/password', 'authenticated'),

  // ── 任务（动态路径先于通配）──
  exact('GET', '/tasks', 'permission', 'tasks.read'),
  pattern('GET', /^\/tasks\/[^/]+\/log$/, 'permission', 'tasks.read'),
  pattern('GET', /^\/tasks\/[^/]+$/, 'permission', 'tasks.read'),
  pattern('DELETE', /^\/tasks\/[^/]+$/, 'permission', 'tasks.delete'),

  // ── 自己的 MCP Token（所有登录角色可用；Token principal 不在能力表内）──
  { method: '*', test: (p) => p === '/me/tokens' || p.startsWith('/me/tokens/'), kind: 'permission', capability: 'tokens.self' },

  // ── 用户管理（S-04 实现；当前 admin 命中后由分发器 404）──
  { method: '*', test: (p) => p === '/users' || p.startsWith('/users/'), kind: 'permission', capability: 'users.manage' },

  // ── 对话：全局提示词配置 admin-only；清空全部会话 admin-only；其余 chat 路由 chat.use ──
  exact('PUT', '/chat/prompt-config', 'permission', 'ops.write'),
  exact('DELETE', '/chat/conversations', 'permission', 'ops.write'),
  { method: '*', test: (p) => p === '/chat' || p.startsWith('/chat/'), kind: 'permission', capability: 'chat.use' },

  // ── 知识读 ──
  exact('GET', '/health', 'permission', 'knowledge.read'),
  exact('GET', '/search-config', 'permission', 'knowledge.read'),
  exact('GET', '/tags', 'permission', 'knowledge.read'),
  exact('GET', '/doc/list', 'permission', 'knowledge.read'),
  exact('GET', '/doc/get', 'permission', 'knowledge.read'),
  exact('GET', '/doc/edit', 'permission', 'knowledge.read'),
  exact('GET', '/asset', 'permission', 'knowledge.read'),
  exact('GET', '/import/config', 'permission', 'knowledge.read'),
  exact('GET', '/import/upload-status', 'permission', 'knowledge.read'),
  exact('GET', '/import/status', 'permission', 'knowledge.read'),
  exact('GET', '/import/incomplete', 'permission', 'knowledge.read'),
  exact('GET', '/vector/status', 'permission', 'knowledge.read'),
  exact('GET', '/embedding/summary', 'permission', 'knowledge.read'),
  exact('POST', '/vector/status/refresh', 'permission', 'knowledge.read'),

  // ── 知识写 ──
  exact('POST', '/doc/edit', 'permission', 'knowledge.write'),
  exact('POST', '/import/upload', 'permission', 'knowledge.write'),
  exact('POST', '/import/run', 'permission', 'knowledge.write'),
  exact('POST', '/import/preflight', 'permission', 'knowledge.write'),
  exact('POST', '/import/retry-incomplete', 'permission', 'knowledge.write'),

  // ── 数据源 ──
  exact('GET', '/datasource/list', 'permission', 'datasource.read'),
  exact('GET', '/datasource/detail', 'permission', 'datasource.read'),
  exact('POST', '/datasource/sync', 'permission', 'datasource.write'),
  exact('POST', '/datasource/schedule', 'permission', 'datasource.write'),
  exact('POST', '/datasource/add-remote', 'permission', 'datasource.write'),
  exact('POST', '/datasource/update', 'permission', 'datasource.write'),
  exact('POST', '/datasource/remove', 'permission', 'datasource.delete'),
  exact('POST', '/datasource/prune', 'permission', 'datasource.delete'),
  exact('POST', '/import/prune', 'permission', 'datasource.delete'),

  // ── 运维 / 任务取消 ──
  exact('POST', '/restore/run', 'permission', 'ops.write'),
  exact('GET', '/restore/status', 'permission', 'tasks.read'),
  exact('POST', '/restore/cancel', 'permission', 'tasks.cancel'),
  exact('POST', '/vector/optimize', 'permission', 'ops.write'),
  exact('POST', '/import/cancel', 'permission', 'tasks.cancel'),
];

export function matchRoute(method: string, path: string): RouteMatch {
  const upper = method.toUpperCase();
  for (const rule of RULES) {
    if (rule.method !== '*' && rule.method !== upper) continue;
    if (!rule.test(path)) continue;
    return {
      kind: rule.kind,
      ...(rule.capability ? { capability: rule.capability } : {}),
    };
  }
  return { kind: 'unknown' };
}
