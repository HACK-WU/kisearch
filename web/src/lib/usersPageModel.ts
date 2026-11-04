/**
 * usersPageModel.ts —— 用户管理 / 个人中心纯函数（REQ-20261104-001）
 *
 * 只放可单测的展示与 guard 逻辑；请求与状态留在页面组件。
 */

import type { Role, UserTokenView, UserView } from '@/api/authApi';

export type AccountStatus = 'active' | 'disabled' | 'expired';
export type AccountLike = Pick<UserView, 'role' | 'disabled' | 'expiresAt'>;

export const TOKEN_LIMIT_USER = 10;

export function accountStatus(user: AccountLike, now = Date.now()): AccountStatus {
  if (user.disabled) return 'disabled';
  if (user.expiresAt) {
    const at = Date.parse(user.expiresAt);
    if (Number.isFinite(at) && at <= now) return 'expired';
  }
  return 'active';
}

export function accountActive(user: AccountLike, now = Date.now()): boolean {
  return accountStatus(user, now) === 'active';
}

export const STATUS_LABEL: Record<AccountStatus, string> = {
  active: '启用',
  disabled: '已禁用',
  expired: '已过期',
};

export const ROLE_LABEL: Record<Role, string> = {
  admin: '管理员',
  editor: '读写账号',
  viewer: '只读账号',
};

export const PERMISSION_LABEL: Record<Role, string> = {
  admin: '全部权限',
  editor: '读写',
  viewer: '只读',
};

export function permissionDescription(role: Role): string {
  if (role === 'admin') return '全部权限 · 固定，不可修改';
  if (role === 'editor') return '可写知识、导入文档，AI 对话可写；数据源只读';
  return '可浏览、检索与只读 AI 对话；所有写入禁止';
}

export function formatTime(value?: string | null, withSeconds = false): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const text = String(value).replace('T', ' ');
    return withSeconds ? text.slice(0, 19) : text.slice(0, 16);
  }
  const pad = (n: number): string => String(n).padStart(2, '0');
  const base = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return withSeconds ? `${base}:${pad(date.getSeconds())}` : base;
}

export function validityLabel(user: Pick<UserView, 'expiresAt'>, now = Date.now()): string {
  if (!user.expiresAt) return '永久';
  const at = Date.parse(user.expiresAt);
  if (!Number.isFinite(at)) return user.expiresAt;
  const text = formatTime(user.expiresAt);
  return at <= now ? `${text}（已过期）` : text;
}

export function tokenCountLabel(role: Role, count: number): string {
  return role === 'admin' ? `已创建 ${count} · 不限` : `已创建 ${count} / ${TOKEN_LIMIT_USER}`;
}

export interface TokenAddState {
  disabled: boolean;
  hint: string;
  title: string;
}

export function tokenAddState(input: {
  role: Role;
  active: boolean;
  tokenCount: number;
  pendingAccountChanges?: boolean;
  passwordPanelOpen?: boolean;
}): TokenAddState {
  if (input.passwordPanelOpen) {
    return {
      disabled: true,
      hint: '请先完成或取消「重置密码」，再新增 Token。',
      title: '请先完成或取消「重置密码」，再新增 Token',
    };
  }
  if (input.pendingAccountChanges) {
    return {
      disabled: true,
      hint: '账号权限/状态/有效期有未保存修改，请先保存后再新增 Token。',
      title: '请先保存账号权限/状态/有效期，再新增 Token',
    };
  }
  if (!input.active) {
    return {
      disabled: true,
      hint: '账号已禁用或已过期，无法创建有效的 Token。',
      title: '账号已禁用或已过期，无法创建 Token',
    };
  }
  if (input.role !== 'admin' && input.tokenCount >= TOKEN_LIMIT_USER) {
    return {
      disabled: true,
      hint: `已达 ${TOKEN_LIMIT_USER} 个 Token 上限，撤销一个后可新增。`,
      title: `已达 ${TOKEN_LIMIT_USER} 个 Token 上限，请先撤销一个`,
    };
  }
  return { disabled: false, hint: '', title: '' };
}

export function tokenLimitHint(role: Role, count: number): string | null {
  return role !== 'admin' && count >= TOKEN_LIMIT_USER
    ? `已达 ${TOKEN_LIMIT_USER} 个 Token 上限，撤销一个后可创建新的。`
    : null;
}

export function tokenCreatorLabel(createdBy: UserTokenView['createdBy']): string {
  if (createdBy === 'self') return '本人';
  if (createdBy === 'admin') return '管理员';
  if (createdBy === 'cli') return 'CLI';
  return '—';
}

export function tokenModeLabel(readOnly: boolean): string {
  return readOnly ? '只读' : '读写';
}

export function tokenScopeLabel(scopes: string[]): string {
  return scopes.includes('all') ? '全部知识库' : scopes.join('、');
}

export function tokenTightened(token: UserTokenView, ownerRole: Role): boolean {
  return ownerRole === 'viewer' && token.createdReadOnly === false;
}

export function validateUsername(value: string): string | null {
  const text = value.trim();
  if (!text) return '请输入用户名';
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(text)) {
    return '用户名仅允许字母、数字、点、连字符、下划线，长度 1-64';
  }
  return null;
}

export function validateTokenLabel(value: string): string | null {
  const text = value.trim();
  if (!text || text.length > 64) return 'Token 名称长度需为 1-64 个字符';
  return null;
}

export function validatePassword(value: string): string | null {
  if (value.length < 8 || value.length > 128) return '密码长度需为 8-128 个字符';
  return null;
}

export function validateExpiry(value: string): string | null {
  if (!value) return '请选择有效期时间';
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return '有效期不是合法时间';
  if (at <= Date.now()) return '有效期必须晚于当前时间';
  return null;
}

export function hasPendingAccountSecurityChanges(
  original: Pick<UserView, 'role' | 'disabled' | 'expiresAt'>,
  draft: { role: Role; disabled: boolean; expiresAt: string | null },
): boolean {
  const originalExpiry = original.expiresAt ? original.expiresAt.slice(0, 16) : '';
  const draftExpiry = draft.expiresAt ? draft.expiresAt.slice(0, 16) : '';
  return original.role !== draft.role
    || original.disabled !== draft.disabled
    || originalExpiry !== draftExpiry;
}

const ERROR_MESSAGES: Record<string, string> = {
  USER_EXISTS: '用户名已存在',
  USER_NOT_FOUND: '账号不存在',
  USER_INVALID_USERNAME: '用户名仅允许字母、数字、点、连字符、下划线，长度 1-64',
  USER_PASSWORD_TOO_WEAK: '密码长度需为 8-128 个字符',
  USER_INVALID_EXPIRY: '账号有效期不是合法时间',
  USER_LAST_ADMIN: '不能删除、降级或禁用最后一个管理员',
  USER_ADMIN_EXISTS: '系统只能有一个管理员',
  USER_ADMIN_PROTECTED: '管理员账号不可降级、禁用、删除或设置有效期',
  USER_SELF_PROTECTED: '不能删除或禁用当前登录账号',
  USER_ADMIN_CLI_ONLY: '管理员账号只能通过命令行创建',
  TOKEN_LIMIT_REACHED: `普通账号最多 ${TOKEN_LIMIT_USER} 个 Token`,
  TOKEN_LABEL_EXISTS: '该账号下已存在同名 Token',
  TOKEN_OWNER_INACTIVE: '账号已禁用或已过期，无法管理 Token',
  TOKEN_OWNER_NOT_FOUND: 'Token 所属账号不存在',
  TOKEN_NOT_FOUND: 'Token 不存在或不属于该账号',
  TOKEN_INVALID: 'Token 参数不合法',
  TOKEN_FORBIDDEN: '当前身份不能管理自助 Token',
};

export function describeUserError(code: string | undefined, fallback: string): string {
  return (code && ERROR_MESSAGES[code]) || fallback;
}
