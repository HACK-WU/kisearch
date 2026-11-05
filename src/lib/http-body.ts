/**
 * http-body.ts —— `/api/*` 的 JSON 请求体读取。
 *
 * 抽成独立模块的原因：`views-api` 需要读 body，但它被 `mcp-http-api` 反向引用
 * （分发器调 `handleViewsApi`）。若 `views-api` 再从 `mcp-http-api` 导入读取函数，
 * 两个模块就形成循环依赖 —— 抽到这里两边都只单向依赖本模块。
 *
 * 与 `mcp-http.ts` 里的同名函数保持同一套语义（限长、空体返回 undefined）。
 * 那个文件属于 MCP 主链路，不改动；本模块只服务 API 侧。
 */

import type http from 'node:http';

/** 请求体上限：16 MiB（与 mcp-http-api 既有限制一致） */
export const MAX_API_BODY = 16 * 1024 * 1024;

export function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number = MAX_API_BODY,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').trim();
      if (!text) return resolve(undefined);
      try {
        resolve(JSON.parse(text));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}
