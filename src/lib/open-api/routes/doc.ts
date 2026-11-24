/**
 * `GET /open/v1/doc` —— 文档正文与附图清单（REQ-20261124-002 · S-03）
 *
 * 契约（完整说明见 design/S03_文档正文端点_DESIGN.md）：
 *
 * - 入参：`scope`（必填）、`group`（必填）、`relation`（必填）；**不支持 `member`（视图）**
 * - 成功 200：`executeGetModuleInfoLocal({scope,group,relation},{noVectorFallback:true})` 的
 *   返回体**原样透出**（`content` + `images[]` + `lifecycle` / `eventId` / `expiresAt` /
 *   `remainDays` / `lifecycleWarning` / `revision` / `totalLines`），**不做 DTO 裁剪** ——
 *   与 `/api/doc/get`、MCP `ki_get_module_info` 同形是「正文同源」的唯一保障。
 *   ★ 实现期已核对：该返回体**不含本地绝对路径**，原样透出无泄露风险。
 * - `images[].ref` 必须可直接作为 `/open/v1/asset` 的 `path`（客户端不做任何映射）
 * - 失败：400 `BAD_REQUEST`（缺参 / 传了 `member`）/ 400 `VIEW_UNSUPPORTED`（视图名）/
 *   403 `SCOPE_FORBIDDEN` / 404 `NOT_FOUND` / 500
 * - 可见性：阶段 `hidden` 的文档按名可取（与 MCP 口径一致）；返回体含生命周期类字段，
 *   但**不含事件阶段可见性** —— hidden 提示由客户端固定文案承担，端点不追加阶段查询
 * - 副作用：成功后 `recordScopeUsage(scope,'download')` + `logDownload({endpoint:'doc'})`
 * - 开关：`downloadApi=false` 时由分发器在路由前拦成 404（本函数不会被调用）
 *
 * ═══ 两个实现要点 ═══
 * 1. **内核必须动态 import**：`get-module-info.js` 会把向量引擎/CLI 内核拖进模块图，
 *    `ping.ts` 的 `DEFAULT_MAX_*` 与 `/api/*` 的 `getApiHandler()` 都是同一策略。
 * 2. **失败体必须裁剪**：内核失败时的 `hint` 可能含候选 Group 路径，原样透出等于
 *    对外提供「库结构探测」能力（设计 §7「候选清单不返回」）。
 */

import type http from 'node:http';

import { recordScopeUsage } from '../../scope-usage.js';
import { isViewName } from '../../scope-view.js';
import { isScopeAuthorized } from '../../mcp-token.js';
import { validateScope } from '../../scope.js';
import { logDownload } from '../audit.js';
import { sendJson, sendOpenApiError } from '../respond.js';
import type { OpenApiContext } from '../index.js';
import type { OpenApiPrincipal } from '../auth.js';

export async function handleOpenApiDoc(input: {
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
}): Promise<void> {
  const { res, url, ctx, principal } = input;

  const scope = url.searchParams.get('scope')?.trim() ?? '';
  const group = url.searchParams.get('group')?.trim() ?? '';
  const relation = url.searchParams.get('relation')?.trim() ?? '';

  // ① 必填参数
  const missing: string[] = [];
  if (!scope) missing.push('scope');
  if (!group) missing.push('group');
  if (!relation) missing.push('relation');
  if (missing.length > 0) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `缺参数：${missing.join(' / ')}`);
    return;
  }

  // ② `member`（视图聚合）显式拒绝，而不是静默忽略 —— 否则调用方会以为聚合生效了
  if (url.searchParams.has('member')) {
    sendOpenApiError(
      res,
      400,
      'OPEN_API_BAD_REQUEST',
      '不支持 member（视图聚合）参数：视图属 Web 语义，取件请用真实库名 + group + relation',
    );
    return;
  }

  // ②-b scope 名格式：内核内部才校验，这里提前拦成 400（否则冒成 500）
  try {
    validateScope(scope);
  } catch {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', 'scope 不合法：仅允许字母、数字、连字符(-)、下划线(_)');
    return;
  }

  // ③ 视图名
  if (isViewName(ctx.config, scope)) {
    sendOpenApiError(
      res,
      400,
      'OPEN_API_VIEW_UNSUPPORTED',
      '视图不支持取件：请改用成员库名，如 scope=<库名>',
      { hint: '用 ki_scope_list 或 ping 的 scopes 取成员库名' },
    );
    return;
  }

  // ④ 越权（scope 名只进服务端日志，响应不回显）
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] doc 越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(
      res,
      403,
      'OPEN_API_SCOPE_FORBIDDEN',
      '该 Token 未被授权访问所请求的 scope（可在 ki 所在机器执行 ki mcp token list 查看授权范围）',
    );
    return;
  }

  try {
    // ⑤ 读内核（动态 import：不把 CLI/向量内核拉进 HTTP 模块图）
    const mod = await import('../../../get-module-info.js');
    // noVectorFallback：与 /api/doc/get、MCP 按名读一致 —— 只精确取，不做向量兜底
    const result = await mod.executeGetModuleInfoLocal({ scope, group, relation }, { noVectorFallback: true });

    if (!result.ok) {
      // 裁剪：内核的 error/hint 可能含候选 Group 路径 → 等于「库结构探测」，一律不外发
      sendOpenApiError(res, 404, 'OPEN_API_NOT_FOUND', '文档不存在（group + relation 需与库内落点完全一致）');
      return;
    }

    // ⑥ 成功体原样透出（同形是「正文同源」的保障）
    sendJson(res, 200, result);

    // ⑦ 计量与留痕（两者内部吞异常，绝不影响已发出的响应）
    recordScopeUsage(scope, 'download');
    logDownload({
      ...(principal.tokenId ? { tokenId: principal.tokenId } : {}),
      scope,
      endpoint: 'doc',
      path: `${group}/${relation}`,
      ...(typeof result.content === 'string' ? { bytes: Buffer.byteLength(result.content, 'utf-8') } : {}),
      status: 200,
    });
  } catch (err) {
    process.stderr.write(`[open-api] doc 读取失败：${(err as Error).message}\n`);
    sendOpenApiError(res, 500, 'OPEN_API_INTERNAL', '服务内部错误，请查看服务端日志');
  }
}
