/**
 * web-session-store.ts —— Web 登录会话（REQ-20261103-001 · S-02）
 *
 * 进程内 Map，daemon 重启即失效（v1 决策）。
 * - 32 字节随机 session id；默认 7 天滑动；
 * - 单用户最多 10 个活跃会话，超出淘汰最旧；
 * - 改密/删除/禁用由 principal 解析层按用户记录校验，本模块只负责会话生命周期。
 */

import * as crypto from 'node:crypto';

export const SESSION_COOKIE_NAME = 'ki_web_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;

export interface SessionRecord {
  id: string;
  userId: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  passwordUpdatedAt: string;
}

const sessions = new Map<string, SessionRecord>();

function generateSessionId(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function pruneUserSessions(userId: string): void {
  const own = [...sessions.values()]
    .filter((s) => s.userId === userId)
    .sort((a, b) => a.createdAt - b.createdAt);
  while (own.length >= MAX_SESSIONS_PER_USER) {
    const oldest = own.shift();
    if (!oldest) break;
    sessions.delete(oldest.id);
  }
}

export function createSession(
  userId: string,
  passwordUpdatedAt: string,
  ttlMs = SESSION_TTL_MS,
): SessionRecord {
  pruneUserSessions(userId);
  const now = Date.now();
  const record: SessionRecord = {
    id: generateSessionId(),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt: now + ttlMs,
    passwordUpdatedAt,
  };
  sessions.set(record.id, record);
  return record;
}

export function getSession(id: string): SessionRecord | undefined {
  const record = sessions.get(id);
  if (!record) return undefined;
  if (record.expiresAt <= Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  if (Date.now() - record.lastSeenAt >= TOUCH_INTERVAL_MS) {
    record.lastSeenAt = Date.now();
    record.expiresAt = record.lastSeenAt + SESSION_TTL_MS;
  }
  return record;
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

/** 删除某用户全部会话；exceptId 用于改密后保留当前会话并轮换 */
export function deleteUserSessions(userId: string, exceptId?: string): number {
  let removed = 0;
  for (const [id, record] of sessions) {
    if (record.userId !== userId) continue;
    if (exceptId && id === exceptId) continue;
    sessions.delete(id);
    removed++;
  }
  return removed;
}

/** 测试/诊断用 */
export function sessionCount(): number {
  return sessions.size;
}

export function clearSessions(): void {
  sessions.clear();
}
