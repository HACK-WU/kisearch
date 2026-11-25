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

/** `readBody` 超限时抛的错误形状（调用方据此回 413，不必解析文案） */
export interface BodyTooLargeError extends Error {
  code: 'BODY_TOO_LARGE';
  limit: number;
  actual: number;
}

/**
 * 读取**原始**请求体（Buffer，不解析、不落盘），超限即拒（2026-11-25）。
 *
 * 与 {@link readJsonBody} 的唯一差别是不做 `JSON.parse` —— 图集远程上传要原样收下 zip 字节。
 *
 * ★ 上限**必须由调用方传**，不要用 `MAX_API_BODY` 的默认值：那个 16 MiB 是 `/api/*` JSON
 * 体的口径，而图集包上限是 20 MB（`MAX_ZIP_BYTES`），照抄默认值会把 15~20 MB 的合法包拦掉。
 *
 * ★ 超限行为分两种，取决于客户端有没有报 `Content-Length`：
 *   - 有（`fetch` 传 Buffer 一定会有）：调用方应**先**按它预检，本函数只会兜底；
 *   - 无（chunked）：流中判定超限后必须 `destroy`，否则内存会被灌爆 —— 代价是客户端看到
 *     连接被重置而不是 413。这是 Node 生态的普遍取舍，不在这里硬造一个「边收边丢」的实现。
 */
export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        const err = Object.assign(new Error(`请求体超过上限 ${maxBytes} 字节`), {
          code: 'BODY_TOO_LARGE' as const,
          limit: maxBytes,
          actual: size,
        });
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('request aborted')));
  });
}
