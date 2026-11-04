/**
 * authApi.ts —— Web 登录 / 用户管理接口（REQ-20261103-001 · S-04）
 */

import { notifyUnauthorized } from '@/lib/authEvents';

export type Role = 'admin' | 'editor' | 'viewer';

export interface AuthUser {
  id: string | null;
  username: string;
  role: Role;
  expiresAt?: string | null;
  disabled?: boolean;
  createdAt?: string | null;
  lastLoginAt?: string | null;
}

export interface MeResponse {
  ok: boolean;
  authenticated: boolean;
  source: 'local' | 'session' | 'token' | 'anonymous';
  localAdminEnabled: boolean;
  user: AuthUser | null;
  permissions: string[];
}

export interface UserView {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
  passwordUpdatedAt: string;
  lastLoginAt?: string;
  /** /api/users 列表下发的 Token 数量 */
  tokenCount?: number;
}

export type TokenCreator = 'self' | 'admin' | 'cli';

export interface UserTokenView {
  id: string;
  label: string;
  readOnly: boolean;
  createdReadOnly: boolean;
  scopes: string[];
  createdBy: TokenCreator;
  createdAt: string;
  ownerId?: string;
}

export interface TokenListResult {
  tokens: UserTokenView[];
  count: number;
  limit: number | null;
  unlimited: boolean;
}

export class AuthApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = 'AuthApiError';
  }
}

async function authFetch<T>(
  path: string,
  init?: RequestInit,
  notify401 = true,
): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON / 空响应 */
  }
  if (!res.ok) {
    if (res.status === 401 && notify401) notifyUnauthorized('auth-api');
    const payload = body as { code?: string; error?: string } | undefined;
    throw new AuthApiError(
      res.status,
      payload?.code,
      payload?.error ?? `HTTP ${res.status}`,
      body,
    );
  }
  return body as T;
}

export async function getMe(): Promise<MeResponse> {
  return authFetch<MeResponse>('/api/auth/me', undefined, false);
}

export async function login(
  username: string,
  password: string,
): Promise<{ ok: true; user: AuthUser; permissions: string[] }> {
  return authFetch<{ ok: true; user: AuthUser; permissions: string[] }>(
    '/api/auth/login',
    { method: 'POST', body: JSON.stringify({ username, password }) },
    false,
  );
}

export async function logout(): Promise<void> {
  await authFetch<{ ok: true }>('/api/auth/logout', { method: 'POST' }, false);
}

export async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
  await authFetch<{ ok: true }>('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ oldPassword, newPassword }),
  });
}

export async function listUsers(): Promise<UserView[]> {
  const r = await authFetch<{ ok: true; users: UserView[] }>('/api/users');
  return r.users;
}

export async function createUser(input: {
  username: string;
  password: string;
  role: Role;
  expiresAt?: string | null;
}): Promise<UserView> {
  const r = await authFetch<{ ok: true; user: UserView }>('/api/users', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return r.user;
}

export async function updateUser(
  id: string,
  patch: { role?: Role; password?: string; disabled?: boolean; expiresAt?: string | null },
): Promise<UserView> {
  const r = await authFetch<{ ok: true; user: UserView }>(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
  return r.user;
}

export async function deleteUser(id: string): Promise<{ tokenCleanupWarning?: string }> {
  return authFetch<{ ok: true; tokenCleanupWarning?: string }>(
    `/api/users/${encodeURIComponent(id)}`,
    { method: 'DELETE' },
  );
}

const TOKEN_PATH = (ownerId: string, tokenId?: string): string =>
  `/api/users/${encodeURIComponent(ownerId)}/tokens${tokenId ? `/${encodeURIComponent(tokenId)}` : ''}`;

export async function listMyTokens(): Promise<TokenListResult> {
  const r = await authFetch<{ ok: true } & TokenListResult>('/api/me/tokens');
  return { tokens: r.tokens, count: r.count, limit: r.limit, unlimited: r.unlimited };
}

export async function createMyToken(input: {
  label: string;
  readOnly: boolean;
  scopes: string[];
}): Promise<{ token: string; item: UserTokenView }> {
  return authFetch<{ ok: true; token: string; item: UserTokenView }>('/api/me/tokens', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function revokeMyToken(tokenId: string): Promise<void> {
  await authFetch<{ ok: true }>(`/api/me/tokens/${encodeURIComponent(tokenId)}`, { method: 'DELETE' });
}

export async function listUserTokens(ownerId: string): Promise<TokenListResult> {
  const r = await authFetch<{ ok: true } & TokenListResult>(TOKEN_PATH(ownerId));
  return { tokens: r.tokens, count: r.count, limit: r.limit, unlimited: r.unlimited };
}

export async function createUserToken(
  ownerId: string,
  input: { label: string; readOnly: boolean; scopes: string[] },
): Promise<{ token: string; item: UserTokenView }> {
  return authFetch<{ ok: true; token: string; item: UserTokenView }>(TOKEN_PATH(ownerId), {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function revokeUserToken(ownerId: string, tokenId: string): Promise<void> {
  await authFetch<{ ok: true }>(TOKEN_PATH(ownerId, tokenId), { method: 'DELETE' });
}
