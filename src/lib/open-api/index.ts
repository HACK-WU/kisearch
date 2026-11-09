/**
 * `/open/v1/*` 分发器：第三方程序 API 的唯一入口。
 *
 * 三层职责，顺序即语义：
 *   ① **开关**：`uploadApi=false` 时 `/open/v1/import/*` 一律 404（不泄露接口存在性，
 *      design S-03 D-01）。`/open/v1/ping` 不受影响 —— 它是关闭后唯一还能确认
 *      「服务活着、token 有效」的诊断入口。
 *   ② **鉴权**：Bearer-only（见 auth.ts）。放在路由匹配**之前**，未知路径也要先验 token，
 *      避免未授权探测拿到「这个路径存在/不存在」的差异。
 *   ③ **路由**：精确匹配，未命中 404、方法不符 405。
 *
 * 与 `/api/*` 的关系：各自独立，互不调用。`/api/*` 是浏览器语义（Cookie / local-admin /
 * CSRF 基线 / 路由能力表），本通道一条都不适用。
 */

import type http from 'node:http';

import type { KiConfig } from '../config.js';
import type { TokenAuth } from '../mcp-token.js';
import { assertDaemonIdentityCurrent } from '../scope-collection.js';
import { resolveOpenApiPrincipal, type OpenApiPrincipal } from './auth.js';
import { OPEN_API_PREFIX, OPEN_API_UPLOAD_PATH } from './constants.js';
import { sendOpenApiError } from './respond.js';
import { handleOpenApiPing } from './routes/ping.js';
import { handleOpenApiImportStatus, handleOpenApiImportUpload } from './routes/import.js';

/** 分发器依赖：全部由 `mcp-http.ts` 注入，本模块不自己去读配置/Token 存储 */
export interface OpenApiContext {
  resolveTokenAuth: (token: string) => TokenAuth | undefined;
  /** 上传接口开关（false = `/open/v1/import/*` 404） */
  uploadApi: boolean;
  /** 单次请求体上限（字节） */
  uploadMaxBytes: number;
  config: KiConfig;
}

interface OpenApiRouteInput {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
}

interface OpenApiRoute {
  method: 'GET' | 'POST';
  path: string;
  handler: (input: OpenApiRouteInput) => Promise<void> | void;
}

/**
 * 本期路由表。
 *
 * `POST /open/v1/import/upload` 与 `GET /open/v1/import/status` 由 S-02（W7/W8）注册；
 * 在那之前它们落到「未匹配路由 → 404」，与「路径写错」同语义（正是设计要的不泄露）。
 */
const ROUTES: OpenApiRoute[] = [
  { method: 'GET', path: `${OPEN_API_PREFIX}/ping`, handler: handleOpenApiPing },
  { method: 'POST', path: `${OPEN_API_UPLOAD_PATH}/upload`, handler: handleOpenApiImportUpload },
  { method: 'GET', path: `${OPEN_API_UPLOAD_PATH}/status`, handler: handleOpenApiImportStatus },
];

/** 是否属于「上传通道」路径（开关只拦这里） */
export function isUploadPath(pathname: string): boolean {
  return pathname === OPEN_API_UPLOAD_PATH || pathname.startsWith(`${OPEN_API_UPLOAD_PATH}/`);
}

/** 请求是否属于 `/open/v1` 命名空间（供 mcp-http.ts 做前缀分发） */
export function isOpenApiPath(pathname: string): boolean {
  return pathname === OPEN_API_PREFIX || pathname.startsWith(`${OPEN_API_PREFIX}/`);
}

export async function handleOpenApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  ctx: OpenApiContext,
): Promise<void> {
  // ① 开关：关闭时连鉴权都不做，直接按「路由不存在」回 404 —— 403 会泄露「接口存在但被关」
  if (!ctx.uploadApi && isUploadPath(url.pathname)) {
    sendOpenApiError(res, 404, 'OPEN_API_NOT_FOUND', 'Not Found');
    return;
  }

  // ② 鉴权
  const auth = resolveOpenApiPrincipal(req, { resolveTokenAuth: ctx.resolveTokenAuth });
  if (!auth.ok) {
    sendOpenApiError(res, auth.status, auth.code, auth.message);
    return;
  }
  const principal = auth.principal;

  // ③ 身份漂移守卫：只罩**上传**路径
  //
  // 漂移意味着 daemon 内存中的 engine/句柄指向旧 vectorDir，继续接受上传会把数据写到错误位置，
  // 与 `/api/*` 同口径 fail-loud。但 `/ping` 必须豁免 —— 它是漂移/配置异常时唯一还能确认
  // 「服务活着、token 有效、上限多少」的通道，拦掉它等于把诊断入口一起关死
  // （`scope-collection.ts` 的注释点名了 `/healthz` 与 ping 这两个端点必须可用）。
  if (isUploadPath(url.pathname)) {
    try {
      assertDaemonIdentityCurrent(ctx.config);
    } catch (err) {
      const e = err as Error & { code?: string };
      sendOpenApiError(res, 409, 'OPEN_API_DAEMON_DRIFT', e.message);
      return;
    }
  }

  // ④ 路由
  const method = (req.method ?? 'GET').toUpperCase();
  const route = ROUTES.find((r) => r.path === url.pathname);
  if (!route) {
    sendOpenApiError(res, 404, 'OPEN_API_NOT_FOUND', 'Not Found');
    return;
  }
  if (route.method !== method) {
    // 405 必须带 Allow：curl 用户与 agent 都靠它判断「是不是写错方法」而不是「路径没了」
    const allow = [...new Set(ROUTES.filter((r) => r.path === url.pathname).map((r) => r.method))].join(', ');
    sendOpenApiError(res, 405, 'OPEN_API_METHOD_NOT_ALLOWED', `该路径只接受 ${allow}`, {}, { Allow: allow });
    return;
  }

  try {
    await route.handler({ req, res, url, ctx, principal });
  } catch (err) {
    // 未预期异常只回通用文案：内部路径/参数可能含 token 或本地路径
    process.stderr.write(`[open-api] ${method} ${url.pathname} 处理失败：${(err as Error).message}\n`);
    sendOpenApiError(res, 500, 'OPEN_API_INTERNAL', '服务内部错误，请查看服务端日志');
  }
}
