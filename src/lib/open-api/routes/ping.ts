/**
 * `GET /open/v1/ping` —— 连通性 / 鉴权 / 上限自检。
 *
 * 存在的意义不只是「活没活」：agent 拿到一份大文档后，第一步就该先 ping 读 `limits`，
 * 否则它会拿着 5MB 的文件去撞默认 1MB 的单文件上限（design S-02 §3.6 的推演问题 1）。
 * 因此这里必须回显**真实生效**的上限，而不是文档里的理论值。
 *
 * 开关关闭时本端点仍可用（S-03 D-03）：关闭上传后，运维/agent 仍然需要一条
 * 「token 有没有过期、服务在不在、上限是多少」的通道。
 */

import type http from 'node:http';

import { getScopeImportConfig } from '../../config.js';
import { isScopeAuthorized } from '../../mcp-token.js';
import { OPEN_API_PREFIX } from '../constants.js';
import { sendJson, sendOpenApiError } from '../respond.js';
import type { OpenApiContext } from '../index.js';
import type { OpenApiPrincipal } from '../auth.js';

/** 未指定 scope 时按 default 库的上限回显（与「不传 --scope 就用 default」一致） */
const DEFAULT_SCOPE = 'default';

export async function handleOpenApiPing(input: {
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
}): Promise<void> {
  const { res, url, ctx, principal } = input;
  const scope = url.searchParams.get('scope')?.trim() || DEFAULT_SCOPE;

  // 越权：scope 名只进服务端日志，响应里不回显（防跨租户枚举库名）
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] ping 越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(
      res,
      403,
      'OPEN_API_SCOPE_FORBIDDEN',
      '该 Token 未被授权访问所请求的 scope（可在 ki 所在机器执行 ki mcp token list 查看授权范围）',
    );
    return;
  }

  // 内核的默认上限放这里动态取：静态 import 会把整个导入内核拉进 HTTP 模块图，
  // 而 daemon 启动时并不需要它（/api/* 也是同样的延迟加载策略）。
  const { DEFAULT_MAX_FILE_SIZE_BYTES, DEFAULT_MAX_ASSET_SIZE } = await import('../../import.js');
  const importCfg = getScopeImportConfig(ctx.config, scope);

  sendJson(res, 200, {
    ok: true,
    api: OPEN_API_PREFIX.replace(/^\//, ''),
    ...(principal.tokenId ? { tokenId: principal.tokenId } : {}),
    scopes: principal.scopes,
    readOnly: principal.readOnly,
    // 能走到这里就说明上传通道是开的（关闭时 import/* 直接 404，但 ping 本身照常）
    uploadApi: ctx.uploadApi,
    limits: {
      /** 回显的基准 scope：scopes.<scope>.import.* 会改变下面两项 */
      scope,
      /** 单次请求体上限（mcp.http.uploadMaxBytes） */
      maxRequestBody: ctx.uploadMaxBytes,
      /** 单文件上限（scopes.<scope>.import.maxFileSize，默认 1MB） */
      maxFileSize: importCfg?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES,
      /** 单附件（图片）上限（scopes.<scope>.import.maxAssetSize，默认 5MB） */
      maxAssetSize: importCfg?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE,
    },
  });
}
