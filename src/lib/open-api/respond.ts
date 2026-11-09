/**
 * `/open/v1/*` 的响应工具。
 *
 * 只做「写 JSON + 统一错误形状」这一件事，不放业务。抽出来的理由：
 * 分发器与各 handler 都要发错误，若各写一份 `res.writeHead(..., {'Content-Type': ...})`，
 * 迟早出现某条路径漏 Content-Type 或漏 `ok:false`，而 agent 侧是按 `ok/code` 分支的。
 */

import type http from 'node:http';

import type { OpenApiErrorCode } from './constants.js';

/** 发送 JSON 响应（已结束的响应不再重复写，避免 ERR_STREAM_WRITE_AFTER_END 噪音） */
export function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    // 程序接口一律不缓存：状态查询（进度/任务终态）必须每次回源
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/**
 * 统一错误响应 `{ ok: false, code, error }` + 可选附加字段。
 *
 * 附加字段（如 `{limit, actual}` / `skippedSample`）直接铺在同层：agent 读文档即可拼出
 * 判断分支，不必解析 error 文案。
 */
export function sendOpenApiError(
  res: http.ServerResponse,
  status: number,
  code: OpenApiErrorCode,
  error: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { ok: false, code, error, ...extra }, headers);
}
