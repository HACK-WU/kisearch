/**
 * 图集（atlas）远程部署：`GET /open/v1/atlas/status` 与 `POST /open/v1/atlas/package`。
 *
 * ═══ 为什么要有这一组端点 ═══
 * `ki atlas upload` 直连内核写盘（`src/atlas.ts`），**必须与 ki 同机**；`/api/atlas/package`
 * 是 Web 页专用的 JSON + base64 分片通道（16 MiB 请求体上限、Cookie/本地管理员语义）。
 * 远端只装 `ki-client` 的机器两条都用不了 —— 本文件补齐「跨机把 zip 传进 `.atlas/`」这一跳。
 *
 * ═══ 三条设计约束（都有出处，不要「优化」掉）═══
 * 1. **单请求整包二进制，不分片**：图集包上限 20 MB（`MAX_ZIP_BYTES`），而 `/open/v1` 的
 *    请求体上限默认 512 MB —— 分片是 `/api` 那条 16 MiB 通道逼出来的实现细节，带到这里
 *    只会让「半途中断的暂存目录」变成新问题。
 * 2. **scope 只有一个来源（query）**：二进制 body 里放不进 scope，因此不存在
 *    「query 与 body 各说一套」的绕过面。`/api` 那条通道之所以强制从 body 取，正是为了
 *    消除两个来源；这里换成一元来源后，**校验全部前置到读 body 之前**才是安全的。
 * 3. **校验必须在收流之前**：授权 / 视图 / 库存在 / 只读 / 体积，任一不过就立刻回，
 *    不能「传完 20 MB 才 403」—— 那是 30 秒的等待换一句拒绝。
 */

import type http from 'node:http';

import { isScopeAuthorized } from '../../mcp-token.js';
import { assertHttpChannelWritable, isScopeReadonlyError } from '../../scope-policy.js';
import { isViewName } from '../../scope-view.js';
import { validateScope } from '../../scope.js';
import { scopeDirExists } from '../../store.js';
import { withScopeWriteLock } from '../../scope-write-lock.js';
import { readBody, type BodyTooLargeError } from '../../http-body.js';
import { sendJson, sendOpenApiError } from '../respond.js';
import type { OpenApiContext } from '../index.js';
import type { OpenApiPrincipal } from '../auth.js';

type RouteInput = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
};

/** 图集包允许的 Content-Type（`; charset=` 之类后缀先切掉再比） */
const ZIP_CONTENT_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  // 部分客户端（含 curl 显式指定）用八位字节流；语义上等价，没必要为它单独报错
  'application/octet-stream',
]);

/**
 * 取目标 scope 并做完「非视图」判定。
 *
 * 失败时已写响应并返回 `null`，调用方直接 return。这一段刻意做成公共函数：
 * status 与 package 必须**同一套** scope 语义，否则会出现「status 说没装、package 说库不存在」。
 */
function resolveTargetScope(input: {
  res: http.ServerResponse;
  ctx: OpenApiContext;
  raw: string;
  /** 用于文案：写入侧说「写入」，读取侧说「访问」 */
  action: 'write' | 'read';
}): string | null {
  const { res, ctx, raw, action } = input;
  const scope = raw.trim() || 'default';

  // ① 格式：内核内部才校验，这里提前拦成 400（否则会冒成 500）
  try {
    validateScope(scope);
  } catch {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', 'scope 不合法：仅允许字母、数字、连字符(-)、下划线(_)');
    return null;
  }

  // ② 视图不是库：`readStatus(视图名)` 会静默回 exists:false，用户会误判「图集丢了」
  if (isViewName(ctx.config, scope)) {
    sendOpenApiError(
      res,
      400,
      action === 'write' ? 'OPEN_API_VIEW_NOT_WRITABLE' : 'OPEN_API_VIEW_UNSUPPORTED',
      action === 'write'
        ? `"${scope}" 是知识视图（多个库的检索视图），不能作为图集安装目标；请改为具体的库名`
        : '视图不支持查询图集状态：请改用成员库名，如 scope=<库名>',
      { hint: '用 ki ping 的 scopes 或 ki scope list 取真实库名' },
    );
    return null;
  }

  return scope;
}

/**
 * 图集错误 → `/open/v1` 信封。
 *
 * 刻意**不**把 `ATLAS_<KEY>` 当主码：`/open/v1` 的 `code` 字段是给客户端分支用的稳定标识，
 * 混入第二套命名会让「按码分支」的代码要认同义词表。做法是主码统一
 * `OPEN_API_ATLAS_PACKAGE_INVALID`，具体原因放在 `atlasCode`（14xx 数字）与
 * `atlasKey`（`ATLAS_ENTRY_NOT_FOUND` 等）两个附加字段里 —— 排障表（atlas-deploy §5）
 * 就是按数字码查的，两边能对上。
 */
/**
 * 按图集错误类型给「下一步怎么办」。
 *
 * 为什么需要这张表：内核抛错时**不是每个抛点都带 hint**（`validateEntryHtml` 就没有），
 * 而 `/open/v1` 的客户端在服务端不给 hint 时会回落成通用文案（「查看服务端日志定位」）——
 * 真机实测过这条：包不合格明明该「重新打包」，用户却被告知去查日志（2026-11-25）。
 * 出路是契约的一部分，不能靠内核每个抛点都记得写。
 */
function atlasHintFor(key: string): string {
  switch (key) {
    case 'PACKAGE_INVALID':
      return '用 pack_atlas.py <图集目录> dist/ --zip 重新打包（不要手工 zip：会漏掉烘焙与内联步骤）';
    case 'ENTRY_NOT_FOUND':
      return '包内根目录必须恰好有一个 .html；若打成了「目录包」会藏在子目录里，用 pack_atlas.py 重打';
    case 'TOO_LARGE':
      return '减少视图数量（6~8 页预算）后重新打包；不要靠删代码快照瘦身';
    case 'UNSAFE_ENTRY':
      return '包内有越界路径或链接文件；不要手工改包，用 pack_atlas.py 重打';
    case 'UNSUPPORTED_ZIP':
      return 'zip64 / 加密 / 非常规压缩不支持；用 pack_atlas.py 产出的原始包';
    case 'NOT_FOUND':
      return '该库还没有装图集，先执行 ki-client atlas upload';
    case 'CORRUPTED':
      return '磁盘上的图集文件损坏，重新上传一次覆盖即可';
    default:
      return '重新打包后重试；仍失败请查看服务端日志';
  }
}

function sendAtlasFailure(
  res: http.ServerResponse,
  err: unknown,
  atlas: typeof import('../../atlas/index.js'),
): void {
  if (err instanceof atlas.AtlasError) {
    sendOpenApiError(
      res,
      atlas.atlasHttpStatus(err.code),
      'OPEN_API_ATLAS_PACKAGE_INVALID',
      atlas.describeAtlasError(err),
      {
        atlasCode: err.code,
        atlasKey: atlas.atlasCodeName(err.key),
        hint: err.hint ?? atlasHintFor(err.key),
      },
    );
    return;
  }
  // 写锁忙 / 只读门禁等：这些有明确语义，别都塞进 500
  const code = (err as { code?: string }).code;
  if (code === 'SCOPE_OPERATION_BUSY') {
    sendOpenApiError(res, 409, 'OPEN_API_STORAGE_FAILED', (err as Error).message, { hint: '等当前任务结束后重试' });
    return;
  }
  if (isScopeReadonlyError(err)) {
    sendOpenApiError(res, 403, 'OPEN_API_SCOPE_READONLY', (err as Error).message, {
      hint: '由运维解除该库的只读标记（ki scope readonly <库> --off）后重试',
    });
    return;
  }
  // 未预期异常只回通用文案：内部信息可能含本地路径
  process.stderr.write(`[open-api] atlas 处理失败：${(err as Error).message}\n`);
  sendOpenApiError(res, 500, 'OPEN_API_INTERNAL', '服务内部错误，请查看服务端日志');
}

/** `GET /open/v1/atlas/status?scope=` —— 与 `GET /api/atlas/status` 同构 + `scope` 回显 */
export async function handleOpenApiAtlasStatus(input: RouteInput): Promise<void> {
  const { res, url, ctx, principal } = input;

  const scope = resolveTargetScope({ res, ctx, raw: url.searchParams.get('scope') ?? '', action: 'read' });
  if (scope === null) return;

  // 越权：scope 名只进服务端日志，响应不回显（与 doc/ping 同口径，防跨租户枚举库名）
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] atlas status 越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(
      res,
      403,
      'OPEN_API_SCOPE_FORBIDDEN',
      '该 Token 未被授权访问所请求的 scope（可在 ki 所在机器执行 ki mcp token list 查看授权范围）',
      // 必须自带 hint：客户端在服务端没给 hint 时会回落成通用 403 文案，
      // 而通用文案说的是「未授权」，与「库不存在/只读」的出路完全不同（真机 2026-11-25 踩到）
      { hint: '用 ki mcp token list 核对授权范围，或重新签发包含该库的 Token' },
    );
    return;
  }

  /**
   * 库是否存在：必须在**授权之后**判。
   *
   * 为什么不能省：`readStatus` 对不存在的库返回 `exists:false`，于是「库名拼错」与
   * 「库在但没装图集」给出同一个答案 —— 脚本会据此判定「只是没装」，然后 upload 才报
   * 「库不存在」，两步结论互相打脸（challenger 2026-11-25 提的）。
   * 为什么不能放在授权之前：否则未授权 Token 能靠 404/200 的差异探测某库是否存在
   * （与 doc/ping 的脱敏口径一致）。
   */
  if (!scopeDirExists(scope)) {
    sendOpenApiError(
      res,
      404,
      'OPEN_API_ATLAS_SCOPE_NOT_FOUND',
      `库 ${scope} 不存在（尚未初始化）`,
      { hint: 'ki scope list 可查真实库名；库要先建好才能装图集' },
    );
    return;
  }

  // 动态 import：与 doc/ping 同策略，不把图集内核（zip 解析 + 配置）拉进 HTTP 模块图
  const atlas = await import('../../atlas/index.js');
  try {
    const st = atlas.readStatus(scope);
    // 字段摊平：与 `/api/atlas/status`、`ki atlas status --json` 三方同形（同一套字段名）
    sendJson(res, 200, st.exists && st.meta ? { ok: true, scope, exists: true, ...st.meta } : { ok: true, scope, exists: false });
  } catch (err) {
    sendAtlasFailure(res, err, atlas);
  }
}

/**
 * `POST /open/v1/atlas/package?scope=` —— 整包 zip 上传安装。
 *
 * 顺序即语义（全部在读 body 之前完成 ①~⑥）：
 *   ① scope 格式 ② 非视图 ③ 授权 ④ 库已存在 ⑤ 非只读 ⑥ Content-Type 与 Content-Length
 *   → ⑦ 收流 ⑧ 写锁内 `installPackage`
 */
export async function handleOpenApiAtlasPackage(input: RouteInput): Promise<void> {
  const { req, res, url, ctx, principal } = input;

  const scope = resolveTargetScope({ res, ctx, raw: url.searchParams.get('scope') ?? '', action: 'write' });
  if (scope === null) return;

  // ③ 授权（脱敏：scope 名只进日志）
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] atlas 上传越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(
      res,
      403,
      'OPEN_API_SCOPE_FORBIDDEN',
      '该 Token 未被授权写入所请求的 scope（用 ki mcp token list 核对授权范围）',
      { hint: '用 ki mcp token list 核对授权范围，或重新签发包含该库的读 Token' },
    );
    return;
  }

  // ④ 库必须已存在：否则 installPackage 会 mkdirSync 出 `<kb>/<拼错的库名>/.atlas/` 空壳
  //    判据与 CLI `requireWritableScope` 同源（scopeDirExists），两端不会给出不同答案
  if (!scopeDirExists(scope)) {
    sendOpenApiError(
      res,
      404,
      'OPEN_API_ATLAS_SCOPE_NOT_FOUND',
      `库 ${scope} 不存在（尚未初始化），图集只能装进已存在的库`,
      { hint: '先建库，或改用已存在的 scope（ki scope list 可查）' },
    );
    return;
  }

  // ⑤ 只读库：上传阶段就拒，避免收完 20 MB 才失败
  try {
    assertHttpChannelWritable(scope, 'open-api:atlas');
  } catch (err) {
    if (isScopeReadonlyError(err)) {
      sendOpenApiError(
        res,
        403,
        'OPEN_API_SCOPE_READONLY',
        `${scope} 是只读库，不能安装图集；请先取消其只读标记`,
        { hint: `由运维执行 ki scope readonly ${scope} --off 后重试` },
      );
      return;
    }
    throw err;
  }

  const atlas = await import('../../atlas/index.js');

  // ⑥-a Content-Type
  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!ZIP_CONTENT_TYPES.has(contentType)) {
    sendOpenApiError(
      res,
      415,
      'OPEN_API_UNSUPPORTED_CONTENT_TYPE',
      `图集只能以 zip 字节上传（Content-Type 需要 application/zip），收到「${contentType || '(空)'}」`,
      { accepted: [...ZIP_CONTENT_TYPES] },
    );
    return;
  }

  /**
   * ⑥-b 上限口径：`min(服务端请求体上限, 图集包上限)`。
   *
   * ★ 这里**不能**用 `MAX_API_BODY`（16 MiB）：那是 `/api` JSON 体的口径，而图集包上限是
   *   20 MB，照抄会把 15~20 MB 的合法包拦掉。也不能裸用 `uploadMaxBytes`（默认 512 MB）——
   *   那等于允许 512 MB 进内存。
   */
  const maxBytes = Math.min(ctx.uploadMaxBytes, atlas.MAX_ZIP_BYTES);
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > maxBytes) {
    // 先按 Content-Length 拒：不读 body，直接把连接关掉，客户端立刻知道失败
    res.setHeader('Connection', 'close');
    sendOpenApiError(
      res,
      413,
      'OPEN_API_ATLAS_PACKAGE_INVALID',
      `图集包 ${(declared / 1024 / 1024).toFixed(1)} MB 超过上限 ${(maxBytes / 1024 / 1024).toFixed(1)} MB`,
      {
        limit: maxBytes,
        actual: declared,
        atlasCode: atlas.ATLAS_CODES.TOO_LARGE,
        atlasKey: atlas.atlasCodeName('TOO_LARGE'),
        hint: '减少视图数量后重新打包（pack_atlas.py --zip），不要靠删快照瘦身',
      },
    );
    // 丢弃未读的请求体：不 drain 会让 keep-alive 连接悬着，客户端收不到刚写的响应
    req.resume();
    return;
  }

  // ⑦ 收流（内存）：20 MB 上限下不必落临时文件，也就不存在「中断残留 tmp」这一整类问题
  let zipBuf: Buffer;
  try {
    zipBuf = await readBody(req, maxBytes);
  } catch (err) {
    if ((err as BodyTooLargeError).code === 'BODY_TOO_LARGE') {
      const e = err as BodyTooLargeError;
      sendOpenApiError(
        res,
        413,
        'OPEN_API_ATLAS_PACKAGE_INVALID',
        `请求体超过上限 ${(e.limit / 1024 / 1024).toFixed(1)} MB`,
        { limit: e.limit, actual: e.actual, atlasCode: atlas.ATLAS_CODES.TOO_LARGE, atlasKey: atlas.atlasCodeName('TOO_LARGE') },
      );
      return;
    }
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `读取请求体失败：${(err as Error).message}`);
    return;
  }
  if (zipBuf.length === 0) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', '请求体为空：需要发送图集 zip 的原始字节');
    return;
  }

  // ⑧ 写锁内安装（内核自身无并发保护，见 package.ts 的二期注释）
  const tokenTag = principal.tokenId ? principal.tokenId.slice(0, 8) : 'anonymous';
  /**
   * `title` 只作**兜底**：内核的既有优先级是「包内 meta.json > 内嵌 baked config > 调用方 opts.meta」，
   * 所以图集自己声明过标题时这里传了也不会覆盖（`--title` 的语义就是「包没写标题时补一个」）。
   */
  const title = url.searchParams.get('title')?.trim();
  try {
    const result = await withScopeWriteLock(scope, 'atlas-upload-api', async () =>
      atlas.installPackage(scope, zipBuf, {
        uploadedBy: `open-api:${tokenTag}`,
        ...(title ? { meta: { title } } : {}),
      }),
    );
    sendJson(res, 200, { ok: true, scope, exists: true, ...result.meta, archived: result.archived });
  } catch (err) {
    sendAtlasFailure(res, err, atlas);
  }
}
