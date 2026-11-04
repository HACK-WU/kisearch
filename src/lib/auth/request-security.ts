/**
 * request-security.ts —— 浏览器请求安全基线（REQ-20261103-001 · S-06）
 *
 * 只对写方法生效：
 * - Origin 必须与请求 Host 的 host + port 一致（scheme 允许 http/https：TLS 常由代理终止）；
 * - 无 Origin 但 Sec-Fetch-Site: cross-site → 拒绝；
 * - 有请求体时 Content-Type 必须是 application/json / application/*+json。
 *
 * 非浏览器客户端（Bearer Token / 本机脚本）通常不带 Origin，因此不受影响；
 * 恶意网页发起的跨站写请求必带 Origin（含 text/plain 简单请求），会被这里拦截。
 */

import type { IncomingMessage } from 'node:http';

export interface RequestSecurityError {
  status: 403 | 415;
  code: 'CSRF_ORIGIN_REJECTED' | 'UNSUPPORTED_CONTENT_TYPE';
  message: string;
}

function header(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function parseHostHeader(host: string): { hostname: string; port: string } | null {
  const value = host.trim();
  if (!value) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    if (end < 0) return null;
    const hostname = stripBrackets(value.slice(0, end + 1));
    const rest = value.slice(end + 1);
    if (!rest) return { hostname, port: '' };
    if (!rest.startsWith(':')) return null;
    return { hostname, port: rest.slice(1) };
  }
  const colon = value.lastIndexOf(':');
  if (colon > 0) {
    return { hostname: value.slice(0, colon), port: value.slice(colon + 1) };
  }
  return { hostname: value, port: '' };
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || /^application\/[^/]+\+json$/.test(mediaType);
}

function hasRequestBody(req: IncomingMessage): boolean {
  const length = header(req.headers['content-length']).trim();
  if (length && Number(length) > 0) return true;
  return Boolean(header(req.headers['transfer-encoding']).trim());
}

export function checkRequestSecurity(req: IncomingMessage): RequestSecurityError | null {
  const method = (req.method ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null;

  const origin = header(req.headers.origin).trim();
  const secFetchSite = header(req.headers['sec-fetch-site']).trim().toLowerCase();

  if (!origin) {
    if (secFetchSite === 'cross-site') {
      return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
    }
    return null;
  }
  if (origin === 'null') {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
  }

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
  }

  const hostHeader = header(req.headers.host).trim();
  const host = parseHostHeader(hostHeader);
  if (!host) {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
  }
  if (stripBrackets(host.hostname).toLowerCase() !== stripBrackets(originUrl.hostname).toLowerCase()) {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
  }
  const originPort = originUrl.port || (originUrl.protocol === 'https:' ? '443' : '80');
  const requestPort = host.port || originPort;
  if (requestPort !== originPort) {
    return { status: 403, code: 'CSRF_ORIGIN_REJECTED', message: '请求来源不受信任' };
  }

  if (hasRequestBody(req) && !isJsonContentType(header(req.headers['content-type']))) {
    return { status: 415, code: 'UNSUPPORTED_CONTENT_TYPE', message: '请求格式不支持' };
  }
  return null;
}
