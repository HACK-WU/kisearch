/**
 * web-auth.ts —— Web 身份解析（REQ-20261103-001 · S-02）
 *
 * 固定优先级：
 *   1. 本机回环 + Host 回环 + 无 XFF → local-admin
 *   2. Authorization: Bearer → token principal（Bearer 无效时不回退 Cookie）
 *   3. Cookie ki_web_session → session principal（每次重读 users.json）
 *   4. 都没有 → null（匿名）
 *
 * `/api` 与 `/mcp` 共用；S-03 在此之上做能力门禁。
 */

import type * as http from 'node:http';
import * as crypto from 'node:crypto';
import * as net from 'node:net';
import { isLoopbackAddr } from './net-addr.js';
import { ALL_SCOPES, findTokenAuth, type TokenAuth } from './mcp-token.js';
import { findUserById, isUserActive, type Role, type UserRecord } from './user-store.js';
import type { TaskOperator } from './task-registry.js';
import {
  ALL_CAPABILITIES,
  ROLE_CAPABILITIES,
  TOKEN_CAPABILITIES,
  type Capability,
} from './auth/capabilities.js';
import {
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  deleteSession,
  getSession,
} from './web-session-store.js';

export type WebPrincipal =
  | { kind: 'local-admin'; label: string; scopes: null; readOnly: false }
  | {
      kind: 'session';
      sessionId: string;
      userId: string;
      username: string;
      role: Role;
      scopes: string[];
      readOnly: boolean;
    }
  | { kind: 'token'; tokenId?: string; scopes: string[]; readOnly: boolean };

export interface WebAuthContext {
  authEnabled: boolean;
  token?: string;
  clientAddr?: string;
  /** 本机回环免登录开关（缺省 true；false = 本机也必须登录） */
  localAdmin?: boolean;
  /** 测试注入；缺省 ~/.ki/users.json */
  usersPath?: string;
  /** 测试/嵌入方注入；缺省 findTokenAuth */
  resolveTokenAuth?: (token: string) => TokenAuth | undefined;
  /** 兼容旧调用方：只返回 scope 集合（readOnly 视为 false） */
  resolveTokenScopes?: (token: string) => string[] | undefined;
}

export interface WebAuthResult {
  principal: WebPrincipal | null;
  /** Bearer 存在但无效：必须 401，不能回退到 Cookie */
  rejected?: 'invalid-token';
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

/** Host 头是否为回环（去端口） */
export function isLoopbackHostHeader(host?: string): boolean {
  if (!host) return false;
  let h = host.trim().toLowerCase();
  if (h === '::1') return true;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    h = end >= 0 ? h.slice(0, end + 1) : h;
  } else {
    const colon = h.indexOf(':');
    if (colon >= 0) h = h.slice(0, colon);
  }
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]'
    || (net.isIPv4(h) && h.startsWith('127.'));
}

/** 出现代理头即不判本机（SSH 隧道无 XFF，仍可本地免登录） */
export function hasForwardedHeaders(req: http.IncomingMessage): boolean {
  return Boolean(
    headerValue(req.headers['x-forwarded-for']).trim()
    || headerValue(req.headers['x-real-ip']).trim()
    || headerValue(req.headers.forwarded).trim(),
  );
}

/**
 * 本机管理员判定：
 * - 回环绑定（authEnabled=false）：来源回环即可（Host 缺失的 HTTP/1.0 请求也兼容）；
 * - 对外绑定（authEnabled=true）：来源 + Host 双回环 + 无 XFF。
 */
export function isLocalAdminRequest(
  req: http.IncomingMessage,
  clientAddr: string | undefined,
  authEnabled: boolean,
  localAdminEnabled = true,
): boolean {
  if (!localAdminEnabled) return false;
  if (!isLoopbackAddr(clientAddr)) return false;
  if (hasForwardedHeaders(req)) return false;
  // 回环绑定也校验 Host（HTTP/1.0 无 Host 时兼容）；避免反向代理把远程伪装成本机
  if (!authEnabled) return !req.headers.host || isLoopbackHostHeader(req.headers.host);
  return isLoopbackHostHeader(req.headers.host);
}

export function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

export function getSessionIdFromRequest(req: http.IncomingMessage): string | undefined {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
}

export function serializeSessionCookie(id: string, maxAgeSeconds = SESSION_TTL_MS / 1000): string {
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(id)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeSeconds)}`,
  ].join('; ');
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function tokenAuthToPrincipal(auth: TokenAuth): WebPrincipal {
  return {
    kind: 'token',
    scopes: auth.scopes,
    readOnly: auth.readOnly,
    ...(auth.id ? { tokenId: auth.id } : {}),
  };
}

export function resolveWebPrincipal(
  req: http.IncomingMessage,
  ctx: WebAuthContext,
): WebAuthResult {
  const clientAddr = ctx.clientAddr ?? req.socket.remoteAddress;
  if (isLocalAdminRequest(req, clientAddr, ctx.authEnabled, ctx.localAdmin !== false)) {
    return { principal: { kind: 'local-admin', label: '本机', scopes: null, readOnly: false } };
  }

  const auth = req.headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice('Bearer '.length).trim()
    : '';
  if (bearer) {
    if (ctx.token && tokenMatches(bearer, ctx.token)) {
      return {
        principal: { kind: 'token', scopes: [ALL_SCOPES], readOnly: false },
      };
    }
    const resolved = ctx.resolveTokenAuth
      ? ctx.resolveTokenAuth(bearer)
      : findTokenAuth(bearer, undefined, ctx.usersPath);
    if (resolved) return { principal: tokenAuthToPrincipal(resolved) };
    if (ctx.resolveTokenScopes) {
      const scopes = ctx.resolveTokenScopes(bearer);
      if (scopes) return { principal: { kind: 'token', scopes, readOnly: false } };
    }
    return { principal: null, rejected: 'invalid-token' };
  }

  const sessionId = getSessionIdFromRequest(req);
  if (!sessionId) return { principal: null };
  const session = getSession(sessionId);
  if (!session) return { principal: null };

  let user: UserRecord | undefined;
  try {
    user = findUserById(session.userId, ctx.usersPath);
  } catch {
    // 用户存储损坏：按未登录处理，避免把未知状态当成有效会话
    return { principal: null };
  }
  if (!user || !isUserActive(user) || user.passwordUpdatedAt !== session.passwordUpdatedAt) {
    deleteSession(session.id);
    return { principal: null };
  }

  return {
    principal: {
      kind: 'session',
      sessionId: session.id,
      userId: user.id,
      username: user.username,
      role: user.role,
      scopes: [ALL_SCOPES],
      readOnly: user.role === 'viewer',
    },
  };
}

/** 任务操作者快照（S-05）：服务端在创建任务时写入，客户端不可指定 */
export function taskOperatorForPrincipal(principal: WebPrincipal | null): TaskOperator {
  if (!principal) return { type: 'legacy', label: '—' };
  if (principal.kind === 'local-admin') return { type: 'local', label: '本机' };
  if (principal.kind === 'session') {
    return { type: 'user', label: principal.username, userId: principal.userId };
  }
  return {
    type: 'token',
    label: principal.tokenId ? `Token ${principal.tokenId}` : 'Token 临时',
    ...(principal.tokenId ? { tokenId: principal.tokenId } : {}),
  };
}

export function capabilitiesForPrincipal(principal: WebPrincipal | null): ReadonlySet<Capability> {
  if (!principal) return new Set<Capability>();
  if (principal.kind === 'local-admin') return new Set(ALL_CAPABILITIES);
  if (principal.kind === 'token') return TOKEN_CAPABILITIES;
  return ROLE_CAPABILITIES[principal.role];
}

/** local-admin → null（不限）；token/session → scope 集合 */
export function authScopesForPrincipal(principal: WebPrincipal | null): string[] | null {
  if (!principal || principal.kind === 'local-admin') return null;
  return principal.scopes;
}

/** /mcp 的 TokenAuth：local-admin → null（全部工具）；viewer 会话 → readOnly */
export function toTokenAuth(principal: WebPrincipal | null): TokenAuth | null {
  if (!principal || principal.kind === 'local-admin') return null;
  if (principal.kind === 'token') {
    return {
      ...(principal.tokenId ? { id: principal.tokenId } : {}),
      scopes: principal.scopes,
      readOnly: principal.readOnly,
    };
  }
  return {
    scopes: principal.scopes,
    readOnly: principal.role === 'viewer',
  };
}

// ─── 登录失败限速（内存，v1） ─────────────────────────

const MAX_FAILURES = 5;
const WINDOW_MS = 5 * 60 * 1000;
const MAX_RATE_KEYS = 10_000;
const MAX_KEYS_PER_IP = 100;

interface RateEntry {
  count: number;
  resetAt: number;
  lastAt: number;
}

const rateEntries = new Map<string, RateEntry>();

function rateKey(clientAddr: string, username: string): string {
  return `${clientAddr}\0${username.trim().toLowerCase().slice(0, 64)}`;
}

function ipKeyCount(ip: string): number {
  let count = 0;
  for (const key of rateEntries.keys()) if (key.startsWith(`${ip}\0`)) count++;
  return count;
}

function purgeExpired(now: number): void {
  for (const [key, entry] of rateEntries) {
    if (entry.resetAt <= now) rateEntries.delete(key);
  }
}

function evictOldest(): void {
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of rateEntries) {
    if (entry.lastAt < oldestAt) {
      oldestAt = entry.lastAt;
      oldestKey = key;
    }
  }
  if (oldestKey) rateEntries.delete(oldestKey);
}

function evictOldestForIp(ip: string): void {
  let oldestKey: string | undefined;
  let oldestAt = Infinity;
  for (const [key, entry] of rateEntries) {
    if (!key.startsWith(`${ip}\0`)) continue;
    if (entry.lastAt < oldestAt) {
      oldestAt = entry.lastAt;
      oldestKey = key;
    }
  }
  if (oldestKey) rateEntries.delete(oldestKey);
}

export function checkLoginRateLimit(
  clientAddr: string,
  username: string,
): { allowed: boolean; retryAfterMs?: number } {
  const now = Date.now();
  purgeExpired(now);
  const entry = rateEntries.get(rateKey(clientAddr, username));
  if (!entry || entry.count < MAX_FAILURES) return { allowed: true };
  return { allowed: false, retryAfterMs: Math.max(0, entry.resetAt - now) };
}

export function recordLoginFailure(clientAddr: string, username: string): void {
  const now = Date.now();
  purgeExpired(now);
  const key = rateKey(clientAddr, username);
  const existing = rateEntries.get(key);
  if (existing) {
    existing.count += 1;
    existing.lastAt = now;
    return;
  }
  if (rateEntries.size >= MAX_RATE_KEYS) evictOldest();
  if (ipKeyCount(clientAddr) >= MAX_KEYS_PER_IP) evictOldestForIp(clientAddr);
  rateEntries.set(key, { count: 1, resetAt: now + WINDOW_MS, lastAt: now });
}

export function clearLoginFailures(clientAddr: string, username: string): void {
  rateEntries.delete(rateKey(clientAddr, username));
}

/** 测试用 */
export function resetLoginRateLimit(): void {
  rateEntries.clear();
}

export function loginRateLimitSize(): number {
  return rateEntries.size;
}
