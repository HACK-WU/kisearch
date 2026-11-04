/**
 * authEvents.ts —— 统一 401 通知（REQ-20261103-001 · S-04）
 *
 * API / MCP / chat SSE 任一通道发现会话失效时派发同一事件；
 * AuthProvider 只监听一次，避免"多通道同时 401 → 多次跳登录"。
 */

export const AUTH_UNAUTHORIZED_EVENT = 'ki:unauthorized';

export type UnauthorizedSource = 'api' | 'mcp' | 'chat' | 'auth-api';

export function notifyUnauthorized(source: UnauthorizedSource): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(AUTH_UNAUTHORIZED_EVENT, { detail: { source } }));
}
