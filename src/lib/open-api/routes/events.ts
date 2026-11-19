/**
 * `GET /open/v1/events` —— 事件状态查询（只读，2026-11-19）。
 *
 * 为什么需要它：上传产物文档时要带 `lifecycle=event&event=#N`，而客户端判断这个事件
 * 能不能挂，只有两条路 ——
 *   ① 传完之后看 POST 的失败响应体；但 httpflex 在 4xx 时会丢掉响应体，脚本只剩状态码；
 *   ② 传之前先查一次，也就是本端点。
 * 没有 ② 时，`--event` 填错或事件已收口要先把整个包传完才知道，服务端返回的
 * `available`（可用事件清单）也拿不到。
 *
 * 两种查询由 `event` 参数区分（路由表是精确匹配，不做动态路径）：
 *   · `?event=%233` / `?event=evt_…` → 单个事件（含阶段与可见性），供上传前预检
 *   · 不带 `event` → 列表（`status` / `q` / `limit`），供「该挂哪个事件」的选择
 *
 * 与上传开关的关系：**不受** `uploadApi` 影响 —— 关掉上传后「有哪些事件」仍是诊断所需，
 * 与 `/open/v1/ping` 同侧。也不做 daemon 漂移守卫：本端点只读分片，不碰 vectorDir。
 *
 * 已收口事件照常返回（`closed: true`），**不在这里拒绝** —— 能不能挂由上传链路判定；
 * 查询端点的职责是如实回显状态，否则调用方无法区分「不存在」与「收口了」。
 *
 * 视图与 `/api/governance/events`（页面用）是**两套 DTO**：页面那份带 members 预览、
 * visibilitySummary 等展示字段，本端点只给调用方判断「能不能挂」所需的字段。
 * 不追求与页面 DTO 对齐 —— 对外接口放宽容易、收窄难，多余字段一旦发出去就不能删。
 */

import type http from 'node:http';

import { isScopeAuthorized } from '../../mcp-token.js';
import { findEventIn, isEventClosed, readAllEvents } from '../../events/store.js';
import { getType } from '../../events/type-service.js';
import { listEvents } from '../../events/event-service.js';
import type { EventRecord, EventTypeRecord, Visibility } from '../../events/types.js';
import type { OpenApiPrincipal } from '../auth.js';
import { sendJson, sendOpenApiError } from '../respond.js';

/** 与「不传 --scope 就用 default」一致 */
const DEFAULT_SCOPE = 'default';
/** 列表条数上限：对外收窄到 50（内核允许 100，但调用方是脚本，没有翻页需求） */
const MAX_LIMIT = 50;
const DEFAULT_LIMIT = 20;
/** 事件不存在时回显的可用事件条数（与上传链路的 details 同口径） */
const AVAILABLE_MAX = 5;
const STATUSES = ['open', 'closed', 'all'] as const;

export interface OpenApiEventView {
  id: string;
  shortId: number;
  title: string;
  typeName: string | null;
  /** 收口动作：keep=文档转长期保留 / trash=文档进回收站。上传前判断产物去留要用 */
  terminalAction: 'keep' | 'trash' | null;
  /** 当前阶段与它决定的可见性；类型/阶段悬空时为 null */
  stage: { key: string; name: string; visibility: Visibility } | null;
  closed: boolean;
  updatedAt: number;
}

/**
 * 事件 → 对外视图。
 *
 * `type` 由调用方传入：列表分支的 `listEvents` 已经解析好类型（`item.type`），
 * 再调 `getType` 会让每行都读一次 `_types.json`（50 条 = 50 次文件读）。
 */
function toView(event: EventRecord, type: EventTypeRecord | null): OpenApiEventView {
  const stage = type?.stages.find((s) => s.key === event.stageKey);
  return {
    id: event.id,
    shortId: event.shortId,
    title: event.title,
    typeName: type?.name ?? null,
    terminalAction: type?.terminalAction ?? null,
    stage: stage ? { key: stage.key, name: stage.name, visibility: stage.visibility } : null,
    closed: isEventClosed(event),
    updatedAt: event.updatedAt,
  };
}

/**
 * 未收口事件摘要（不存在时的 `available`，形状与上传链路一致）。
 *
 * 接已读好的事件列表而不是自己去读：调用方刚刚为「找这个事件」读过一次全量。
 */
function availableEvents(events: readonly EventRecord[]): Array<{ id: string; shortId: number; title: string }> {
  return events
    .filter((e) => !isEventClosed(e))
    .slice(0, AVAILABLE_MAX)
    .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title }));
}

export async function handleOpenApiEvents(input: {
  res: http.ServerResponse;
  url: URL;
  principal: OpenApiPrincipal;
}): Promise<void> {
  const { res, url, principal } = input;
  const scope = url.searchParams.get('scope')?.trim() || DEFAULT_SCOPE;

  // 越权：scope 名只进服务端日志，响应不回显（与 ping 同一口径，防跨租户枚举库名）
  if (!isScopeAuthorized(principal.scopes, scope)) {
    process.stderr.write(`[open-api] events 越权：token ${principal.tokenId ?? '(临时)'} 请求 scope "${scope}"\n`);
    sendOpenApiError(
      res,
      403,
      'OPEN_API_SCOPE_FORBIDDEN',
      '该 Token 未被授权访问所请求的 scope（可在 ki 所在机器执行 ki mcp token list 查看授权范围）',
    );
    return;
  }

  // ── 单个事件：上传前预检 ──────────────────────────────
  const eventRef = (url.searchParams.get('event') ?? '').trim();
  if (eventRef) {
    const all = readAllEvents(scope);
    const found = findEventIn(all, eventRef);
    if (!found) {
      sendOpenApiError(res, 404, 'OPEN_API_EVENT_NOT_FOUND', `事件「${eventRef}」不存在`, {
        available: availableEvents(all),
      });
      return;
    }
    sendJson(res, 200, { ok: true, scope, event: toView(found, getType(scope, found.typeId)) });
    return;
  }

  // ── 列表 ────────────────────────────────────────────
  const statusRaw = (url.searchParams.get('status') ?? 'open').trim().toLowerCase();
  if (!(STATUSES as readonly string[]).includes(statusRaw)) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `status 只能是 ${STATUSES.join(' / ')}，收到「${statusRaw}」`);
    return;
  }

  const limitRaw = (url.searchParams.get('limit') ?? '').trim();
  const limit = limitRaw === '' ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    sendOpenApiError(res, 400, 'OPEN_API_BAD_REQUEST', `limit 必须是 1~${MAX_LIMIT} 之间的整数，收到「${limitRaw}」`);
    return;
  }

  const q = (url.searchParams.get('q') ?? '').trim() || undefined;
  const result = listEvents(scope, {
    status: statusRaw as 'open' | 'closed' | 'all',
    ...(q ? { q } : {}),
    limit,
  });

  sendJson(res, 200, {
    ok: true,
    scope,
    status: statusRaw,
    total: result.total,
    hasMore: result.hasMore,
    events: result.items.map((item) => toView(item.event, item.type)),
  });
}
