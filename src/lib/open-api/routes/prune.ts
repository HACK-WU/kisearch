/**
 * `POST /open/v1/import/prune` —— 目录同步清理的**只读**候选查询（2026-11-26 · 事件 #105 批 2）。
 *
 * ═══ 为什么只有「算」，没有「删」═══
 * 用户拍板：token 通道不提供删除权限。删除落在两处——页面「目录同步清理」勾选，或服务端主机
 * 上 `ki import --source <同一目录> --group <组> --prune --yes`。本端点因此是纯读：
 * 不写 KB、不动向量、不删任何文件，响应里也刻意剥离 `token`（候选指纹）与
 * `allCandidateSourcePaths`，避免调用方误以为「拿到就能删」。
 *
 * ═══ 为什么必须由客户端交 `scannedRels`，而不是服务端自己扫 ═══
 * `ki-client upload-dir` 是**分批 + 增量**的（只传 sha256 变化的文件），服务端每个 uploadId
 * 只看到该批文件。把「服务端收到了哪些」当成本次目录全量，会把所有未变化的文档判成「本地已删」
 * ——批量误删候选。所以「本次目录有哪些文件」只能由持有全量扫描结果的客户端显式交上来。
 * 只交 `.md`（图片是 assets，不进 `sourcePath`；混入会稀释闸门分母）。
 *
 * ═══ 口径唯一 ═══
 * 与页面 `POST /api/import/prune`、CLI `ki import --prune` 共用 `planImportPrune`
 * （双闸门 0.8/0.8 + 500 上限）。任何一侧另算一套，CLI/远端就会删得比页面狠。
 *
 * ═══ 权限与开关 ═══
 * - 授权：`isScopeAuthorized`（含 `all` 通配），越权 403。
 * - 开关：路径在 `/open/v1/import` 前缀下，自动受 `uploadApi` 管（`isUploadPath`）。
 * - 只读 token：本端点是 POST，认证层按方法判定会返回 403 `OPEN_API_TOKEN_READONLY`。
 *   这不是缺陷——`--prune` 依附上传命令，上传本就需要可写 Token（见决策记录）。
 * - 只读库：**放行**。纯读，且与页面 `dryRun` 对只读库放行同口径（`mcp-http-api.ts` 的
 *   `if (!dryRun && rejectIfScopeReadonly(...))`）。
 */

import type http from 'node:http';

import { isScopeAuthorized } from '../../mcp-token.js';
import { readViews } from '../../scope-view.js';
import { isUserAssignableGroup, resolveGroupForSource } from '../../import-path.js';
import { planImportPrune, type ImportPrunePlan } from '../../import-prune.js';
import { readBody } from '../../http-body.js';
import { sendJson, sendOpenApiError } from '../respond.js';
import type { OpenApiPrincipal } from '../auth.js';
import type { OpenApiContext } from '../index.js';

type RouteInput = {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  ctx: OpenApiContext;
  principal: OpenApiPrincipal;
};

/**
 * 请求体上限 8 MiB。
 *
 * 5 万条相对路径约 5 MB（一条 60~100 字节）。比 `/api/*` 的 16 MiB 小是刻意的：
 * 本端点只收一份路径清单，没有正文，放宽只会增加内存风险。
 */
const MAX_PRUNE_BODY = 8 * 1024 * 1024;
/** 单次清单条数上限（5 万 ≈ 一个大型 wiki 仓库的文档量） */
const MAX_PRUNE_RELS = 50_000;

export async function handleOpenApiImportPrune(input: RouteInput): Promise<void> {
  const { req, res, url, ctx, principal } = input;
  const scope = (url.searchParams.get('scope') ?? '').trim() || 'default';

  // ── 1) scope 授权（脱敏：scope 名只进服务端日志）──
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] prune 越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(res, 403, 'OPEN_API_SCOPE_FORBIDDEN', '该 Token 未被授权访问所请求的 scope（用 ki mcp token list 核对授权范围）');
    return;
  }

  // ── 2) 视图名：候选按物理库的 group cache 算（视图没有自己的存储，不是可寻址落点）──
  try {
    const views = readViews(ctx.config);
    if (Object.prototype.hasOwnProperty.call(views, scope)) {
      sendOpenApiError(
        res,
        400,
        'OPEN_API_VIEW_UNSUPPORTED',
        `"${scope}" 是知识视图：候选按物理库的文档来源计算，请改为具体的库名`,
      );
      return;
    }
  } catch { /* 视图表损坏不影响查询（与上传通道一致：不阻塞授权） */ }

  // ── 3) 收集请求体（先按 Content-Length 预检：够早就能回 413，连接还没被烧掉）──
  const declared = Number(req.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > MAX_PRUNE_BODY) {
    sendOpenApiError(res, 413, 'OPEN_API_PAYLOAD_TOO_LARGE', `请求体 ${declared} 字节超过上限 ${MAX_PRUNE_BODY}；请缩小 --group 范围后重试`);
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req, MAX_PRUNE_BODY);
  } catch (err) {
    const e = err as Error & { code?: string; limit?: number };
    if (e?.code === 'BODY_TOO_LARGE') {
      // 无 Content-Length（chunked）时流里判定超限，连接已被 destroy，这里只是尽力回执
      sendOpenApiError(res, 413, 'OPEN_API_PAYLOAD_TOO_LARGE', `请求体超过上限 ${e.limit ?? MAX_PRUNE_BODY} 字节`);
      return;
    }
    process.stderr.write(`[open-api] prune 读取请求体失败：${e?.message ?? String(err)}\n`);
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', '请求体读取失败（连接中断或传输不完整），请重试');
    return;
  }

  let body: Record<string, unknown> = {};
  if (raw.length > 0) {
    try {
      const parsed = JSON.parse(raw.toString('utf-8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
      else {
        sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', '请求体必须是 JSON 对象：{"scannedRels": ["a.md", ...]}');
        return;
      }
    } catch {
      sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', '请求体不是合法 JSON（本端点只收 JSON 对象，不收 multipart）');
      return;
    }
  }

  // ── 4) 参数：group 与 scannedRels ──
  // group 语义与上传完全一致：'' = 全 scope（差集覆盖整库），子路径 = 只在该子树内算
  const groupRaw = url.searchParams.get('group') ?? (typeof body.group === 'string' ? body.group : '');
  const group = groupRaw.trim();
  if (group && !isUserAssignableGroup(group)) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `非法 group「${group}」：不能是绝对路径、含 .. 或反斜杠，也不能是保留名 "__root__"`);
    return;
  }

  if (!Array.isArray(body.scannedRels)) {
    sendOpenApiError(
      res,
      400,
      'OPEN_API_BAD_REQUEST',
      '缺少 scannedRels（本次目录**全量**的 .md 相对路径数组）。增量上传只传了变化的文件，服务端无法自行推断全量',
      { example: { scannedRels: ['guide/a.md', 'guide/b.md'] } },
    );
    return;
  }
  const scannedRels = sanitizeRels(body.scannedRels);
  if (scannedRels.length === 0) {
    sendOpenApiError(
      res,
      400,
      'OPEN_API_BAD_REQUEST',
      'scannedRels 为空或全部非法：路径必须是相对目录、不含 .. 或绝对路径。空清单会算出「整库待删」，因此直接拒绝',
    );
    return;
  }
  if (scannedRels.length > MAX_PRUNE_RELS) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `scannedRels 条数 ${scannedRels.length} 超过上限 ${MAX_PRUNE_RELS}，请缩小 --group 范围`);
    return;
  }
  const preserveRels = sanitizeRels(body.preserveRels);

  // ── 5) 与 run 同源计算（importedGroups 由 rel 推导，规则与导入内核一致）──
  try {
    const plan = planImportPrune({
      scope,
      group,
      scannedRels,
      ...(preserveRels.length > 0 ? { preserveRels } : {}),
      importedGroups: [...new Set(scannedRels.map((rel) => resolveGroupForSource(group, rel, scope)))],
      // pickMode 恒 'dir'：本端点只服务目录同步场景；其余闸门（子集重试 / 上传不完整）不适用
      precheck: { pruneStale: true, pickMode: 'dir', subsetRetry: false, uploadIncomplete: false, scannedCount: scannedRels.length },
    });

    sendJson(res, 200, {
      ok: true,
      scope,
      ...(group ? { group } : {}),
      scanned: scannedRels.length,
      plan: toReadonlyPlan(plan),
      /** 恒定 false：本通道没有删除权（能力位之外的第二道明示，防调用方按字段猜） */
      deletable: false,
      hint: '本通道只读：删除请到 Web「目录同步清理」勾选，或在服务端主机执行 ki import --source <同一目录> --group <组> --prune --yes',
    });
  } catch (err) {
    // `planImportPrune` 内部已 fail-soft（计算异常 → skipReason=ERROR），走到这里说明是更外层的问题
    process.stderr.write(`[open-api] prune 计算失败：${(err as Error).message}\n`);
    sendOpenApiError(res, 500, 'OPEN_API_INTERNAL', '候选计算失败，请查看服务端日志');
  }
}

/**
 * 对外视图：剥离只有删除通道才用得上的字段。
 *
 * - `token`：候选指纹，页面拿它做「你确认的就是这份清单」的凭据；本通道不能删，留着只会
 *   诱导调用方去拼一个删除请求。
 * - `allCandidateSourcePaths`：超限时的全量候选（可达数万条），服务端内部分批删除用。
 *   本端点不传 `emitTokenWhenOverLimit`，正常不会出现，这里仍防御性剔除。
 */
function toReadonlyPlan(plan: ImportPrunePlan): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...plan };
  delete copy.token;
  delete copy.allCandidateSourcePaths;
  return copy;
}

/**
 * 净化相对路径清单：只接受「相对目录、无 `..`、非绝对路径、长度合理」的字符串。
 *
 * 与 `/api` 侧 `sanitizeOnlyRelPaths` 同口径（那边是模块内私有函数，不为此导出而改动
 * 另一个模块的公共面）。本函数额外做两件这里才需要的事：统一分隔符、去重 ——
 * 差集与闸门分母都依赖集合语义，重复条目会让 `coordRatio` 失真。
 */
function sanitizeRels(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out = new Set<string>();
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const rel = value.trim().replaceAll('\\', '/').replace(/^\.\/+/, '');
    if (!rel || rel.length > 4096) continue;
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel)) continue;
    if (rel.split('/').includes('..')) continue;
    out.add(rel);
  }
  return [...out];
}
