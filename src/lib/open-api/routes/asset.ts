/**
 * `GET /open/v1/asset` —— 附件原始字节（REQ-20261124-002 · S-02）
 *
 * 契约（完整说明见 design/S02_附件字节端点_DESIGN.md）：
 *
 * - 入参：`scope`（必填）、`group`（必填，干净相对路径）、`path`（必填，等于文档
 *   `images[].ref`，含子目录时整体 URL 编码）
 * - 成功 200：二进制；`Content-Type` 取 `asset-mime.ts::ASSET_MIME`（白名单外一律 404）；
 *   `Cache-Control: no-cache`（幂等重导会覆盖同名附件）；`X-Content-Type-Options: nosniff`；
 *   SVG 追加 `Content-Security-Policy: sandbox`；**不支持 Range / ETag**（见设计 §7）
 * - 失败：400 `BAD_REQUEST`（缺参 / ref 为空）/ 400 `VIEW_UNSUPPORTED`（视图名）/
 *   403 `PATH_FORBIDDEN`（group 非法或越界）/ 403 `SCOPE_FORBIDDEN` /
 *   404 `NOT_FOUND`（不存在、后缀不在白名单、外链 ref —— 三者同语义，附带提示）
 * - 副作用：成功后 `recordScopeUsage(scope,'download')` + `logDownload`，两者失败均不影响响应
 * - 安全：路径解析**必须**走 `asset-path.ts::resolveAssetPath`（双锚点），禁止自己拼 path.join；
 *   `trash`（回收站）参数刻意不支持
 * - 并发：导入侧附件复制是 tmp + rename 原子化，读侧只会看到「完整或不存在」两态；
 *   stat/读阶段文件消失（ENOENT）映射 404，不落 500
 * - 开关：`downloadApi=false` 时由分发器在路由前拦成 404（本函数不会被调用）
 */

import fs from 'node:fs';
import type http from 'node:http';

import { ASSET_MIME } from '../../asset-mime.js';
import { resolveAssetPath } from '../../asset-path.js';
import { isScopeAuthorized } from '../../mcp-token.js';
import { validateScope } from '../../scope.js';
import { recordScopeUsage } from '../../scope-usage.js';
import { isViewName } from '../../scope-view.js';
import { logDownload } from '../audit.js';
import { sendOpenApiError } from '../respond.js';
import type { OpenApiContext } from '../index.js';
import type { OpenApiPrincipal } from '../auth.js';

/** 读文件失败的 errno → 是否按「不存在」处理（ENOTDIR 也算：路径中段不是目录） */
function isNotFoundErrno(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

export async function handleOpenApiAsset(input: {
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
}): Promise<void> {
  const { res, url, ctx, principal } = input;

  const scope = url.searchParams.get('scope')?.trim() ?? '';
  const group = url.searchParams.get('group')?.trim() ?? '';
  const ref = url.searchParams.get('path') ?? '';

  // ① 必填参数：三项缺任一都给 400，文案点名缺哪个（agent 靠 code 分支、人靠文案）
  const missing: string[] = [];
  if (!scope) missing.push('scope');
  if (!group) missing.push('group');
  if (!ref.trim()) missing.push('path');
  if (missing.length > 0) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `缺参数：${missing.join(' / ')}`);
    return;
  }

  // ①-b scope 名格式：`getAssetsDir` 内部才校验，这里提前拦成 400
  //    （否则非法 scope 会让异常冒到分发器的 500，把「参数错」误报成「服务故障」）
  try {
    validateScope(scope);
  } catch {
    // 不回显原值：与 403 脱敏同口径
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', 'scope 不合法：仅允许字母、数字、连字符(-)、下划线(_)');
    return;
  }

  // ② 视图名：MCP 侧视图可用，但取件必须落到真实库 —— 给区分性文案，否则用户以为文档丢了
  if (isViewName(ctx.config, scope)) {
    sendOpenApiError(
      res,
      400,
      'OPEN_API_VIEW_UNSUPPORTED',
      '视图不支持取件（附件按库存盘）：请改用成员库名，如 scope=<库名>',
      { hint: '用 ki_scope_list 或 ping 的 scopes 取成员库名' },
    );
    return;
  }

  // ③ 越权：scope 名只进服务端日志，响应不回显（防跨租户枚举库名，与 ping 同口径）
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] asset 越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(
      res,
      403,
      'OPEN_API_SCOPE_FORBIDDEN',
      '该 Token 未被授权访问所请求的 scope（可在 ki 所在机器执行 ki mcp token list 查看授权范围）',
    );
    return;
  }

  // ④ 双锚点路径解析（与 /api/asset 同口径，见 asset-path.ts）
  const resolved = resolveAssetPath(scope, group, ref);
  if (!resolved.ok) {
    if (resolved.reason === 'external') {
      sendOpenApiError(res, 404, 'OPEN_API_NOT_FOUND', resolved.message, {
        hint: 'path 应为 assets 内相对路径（即 /open/v1/doc 返回的 images[].ref），不支持外链',
      });
      return;
    }
    if (resolved.reason === 'empty') {
      sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', resolved.message);
      return;
    }
    // absolute / traversal / invalid-group：路径本身不合法 → 403 而非 404
    sendOpenApiError(res, 403, 'OPEN_API_PATH_FORBIDDEN', resolved.message);
    return;
  }

  // ⑤ 后缀白名单：不在表内与「文件不存在」同语义（不暴露目录结构）
  const mime = ASSET_MIME[resolved.ext];
  if (!mime) {
    sendOpenApiError(res, 404, 'OPEN_API_NOT_FOUND', '附件不存在或类型不受支持');
    return;
  }

  // ⑥ 读字节：一次性读全量（单附件默认 ≤ maxAssetSize 5MB，见设计 §7 重评触发条件）
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(resolved.absPath);
  } catch (err) {
    if (isNotFoundErrno(err)) {
      // stat 通过后文件被删 / 正在被覆盖：原子化复制保证只会「完整或不存在」
      sendOpenApiError(res, 404, 'OPEN_API_NOT_FOUND', '附件不存在或类型不受支持');
      return;
    }
    process.stderr.write(`[open-api] asset 读取失败：${(err as Error).message}\n`);
    sendOpenApiError(res, 500, 'OPEN_API_INTERNAL', '服务内部错误，请查看服务端日志');
    return;
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': String(buffer.length),
    // 幂等重导会覆盖同名附件 → 不做强缓存，每次回源
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    // SVG 原样下发时必须在浏览器侧失去脚本能力（与 /api/asset 同口径）
    ...(mime === 'image/svg+xml' ? { 'Content-Security-Policy': 'sandbox' } : {}),
  });
  res.end(buffer);

  // ⑦ 计量与留痕：都在内部吞掉异常，绝不影响已发出的响应
  recordScopeUsage(scope, 'download');
  logDownload({
    ...(principal.tokenId ? { tokenId: principal.tokenId } : {}),
    scope,
    endpoint: 'asset',
    path: `${group}/${resolved.rel}`,
    bytes: buffer.length,
    status: 200,
  });
}
