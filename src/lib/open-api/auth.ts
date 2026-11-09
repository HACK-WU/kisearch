/**
 * `/open/v1/*` 的身份解析：**Bearer-only**。
 *
 * 为什么不复用 `resolveWebPrincipal`（design S-01 D-01）：
 *   1. 它把 local-admin 放在第一优先（`web-auth.ts` 的 `isLocalAdminRequest`），
 *      本机回环请求会直接短路成管理员 —— 而本通道的验收锚点是 A4「本机 127.0.0.1
 *      不带 token 也必须 401」；
 *   2. 它会读浏览器 Cookie，让程序接口意外接受浏览器会话（跨站语义混进来）。
 *
 * 也不接 `checkRequestSecurity`：它强制写请求的 Content-Type 为 JSON，
 * 会挡掉 multipart；而本通道不依赖 Cookie，本就不存在 CSRF 面。
 */

import type http from 'node:http';

import type { TokenAuth } from '../mcp-token.js';
import type { OpenApiErrorCode } from './constants.js';

/** 鉴权结果：`scopes` 已含视图授权（`findTokenAuth` 内已合并，本模块**不得**再合并一次） */
export interface OpenApiPrincipal {
  tokenId?: string;
  scopes: string[];
  readOnly: boolean;
}

export type OpenApiAuthResult =
  | { ok: true; principal: OpenApiPrincipal }
  | { ok: false; status: 401 | 403; code: OpenApiErrorCode; message: string };

/** 只读 Token 允许的方法：其余一律 403（与 MCP 通道的只读语义对齐） */
const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 解析 `/open/v1/*` 请求的 Token 身份。
 *
 * 判定顺序即语义，不可调整：
 *   ① 取 `Authorization`，非 `Bearer ` 前缀或值为空 → 401 REQUIRED
 *   ② 查 Token 存储，未命中 → 401 INVALID（**不区分**「不存在」与「owner 被禁用」，
 *      否则就成了可以枚举的判据）
 *   ③ 只读 Token + 写方法 → 403 READONLY
 */
export function resolveOpenApiPrincipal(
  req: http.IncomingMessage,
  deps: { resolveTokenAuth: (token: string) => TokenAuth | undefined },
): OpenApiAuthResult {
  const header = req.headers.authorization;
  const raw = Array.isArray(header) ? header[0] : header;
  const token = bearerToken(raw);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'OPEN_API_TOKEN_REQUIRED',
      message: '需要 Authorization: Bearer <token>（本通道不接受 Cookie、不支持匿名，本机访问同样需要 Token）',
    };
  }

  const auth = deps.resolveTokenAuth(token);
  if (!auth) {
    return {
      ok: false,
      status: 401,
      code: 'OPEN_API_TOKEN_INVALID',
      message: 'Token 无效或已失效（可在 ki 所在机器执行 ki mcp token list 核对）',
    };
  }

  const method = (req.method ?? 'GET').toUpperCase();
  if (auth.readOnly && !READ_METHODS.has(method)) {
    return {
      ok: false,
      status: 403,
      code: 'OPEN_API_TOKEN_READONLY',
      message: '该 Token 为只读模式，不能调用写接口（如需上传请换一个可写 Token）',
    };
  }

  return {
    ok: true,
    principal: {
      ...(auth.id ? { tokenId: auth.id } : {}),
      scopes: auth.scopes,
      readOnly: auth.readOnly,
    },
  };
}

/** 从 `Authorization` 头里取出 Bearer 值；前缀/格式不对或为空返回 undefined */
function bearerToken(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const match = /^Bearer[ \t]+(.+)$/i.exec(raw.trim());
  const value = match?.[1]?.trim();
  return value ? value : undefined;
}
