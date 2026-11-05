/**
 * views-api.ts —— 知识视图的 HTTP 接口（REQ-20261104-004 / R-03、R-11、R-13）
 *
 * 端点（`p` 已去掉 `/api` 前缀）：
 *   GET    /views                列表（含 canEdit / 归属 / 创建时间）
 *   GET    /views/impact         影响面：给定候选成员，返回将失去该视图的 Token
 *   POST   /views                新建
 *   PATCH  /views/:id            改成员 / 改名（带 baseRevision → 409）
 *   DELETE /views/:id            删除
 *
 * 三条硬约定：
 *   1. `canEdit` **只在服务端算**（D6 / §1.6）—— 前端拿到布尔值直接用，
 *      不许自己比 userId，否则两处口径必然漂移。
 *   2. 成员名字的合法性交给 `createView` / `updateView` 内部校验（它们已经做了），
 *      handler 只做"形状校验 + 权限校验 + 错误码翻译"。
 *   3. 视图不存在与无权修改都不泄露细节：404 / 403 的 body 里不带成员清单。
 */

import type http from 'node:http';
import {
  ViewError,
  createView,
  deleteView,
  isViewError,
  makeViewNameResolver,
  readViews,
  renameView,
  updateView,
  validateViewMembers,
  type ViewConfig,
} from './scope-view.js';
import { listTokens, type TokenRecord } from './mcp-token.js';
import { listRegisteredDataSourceRecords } from './datasource.js';
import { vectorListScopes } from './vector-client.js';
import { buildMemberMeta } from './view-member-meta.js';
import { readViewDimensionState } from './view-dimension-state.js';
import { listUsers } from './user-store.js';
import { isScopeReadonly, type KiConfig } from './config.js';
import type { WebPrincipal } from './web-auth.js';
import { readJsonBody } from './http-body.js';
/*
 * ⚠ 两个 `scope` 模块别搞混：
 *   · `../scope.js`（`src/scope.ts`）—— CLI 入口 + `executeScopeList` + `countScopeDocs`；
 *     顶层有 `_isMain` 守卫，非直接运行不 parse，可安全 import。
 *   · `./scope.js`（`src/lib/scope.ts`）—— `parseScopes` / `validateScope` / `listAllScopes`。
 * 曾经把 `countScopeDocs` 也写成 `from './scope.js'`，类型检查没拦住（jiti 运行时才暴露），
 * 表现为 `(0, _scope.countScopeDocs) is not a function` → 文档数统计全失败 → 空库标不出来。
 */
import { countScopeDocs, type ViewDimensionState, type ViewInfo, type ViewMemberMeta } from '../scope.js';
import { listAllScopes, ScopeError } from './scope.js';

/** 当前操作者：userId + 是否管理员 */
export interface ViewActor {
  id: string;
  isAdmin: boolean;
}

/**
 * 由 Web 身份推出操作者。
 *
 * - `local-admin`（本机回环免登录）→ 等价管理员（与 CLI 的 D8 口径一致）
 * - `session` → 取 userId 与 role
 * - `token` → 机器身份：`views.write` 能力已从 TOKEN_CAPABILITIES 剔除，正常走不到这里；
 *   真到了也按"非管理员、无归属"处理，宁可拒绝
 */
export function viewActorOf(principal: WebPrincipal): ViewActor {
  if (principal.kind === 'local-admin') return { id: 'local-admin', isAdmin: true };
  if (principal.kind === 'session') {
    return { id: principal.userId, isAdmin: principal.role === 'admin' };
  }
  return { id: principal.tokenId ? `token:${principal.tokenId}` : 'token:unknown', isAdmin: false };
}

/**
 * 写权限判定（D6 / §1.6）：管理员可改任意视图；其他用户只能改**自己创建的**。
 * 旧视图没有 `createdBy`（003 时代）→ 视为无主，仅管理员可改。
 */
export function canEditView(def: ViewConfig, actor: ViewActor): boolean {
  if (actor.isAdmin) return true;
  if (!def.createdBy) return false;
  return def.createdBy === actor.id;
}

/**
 * `mine` / `canEdit` / `createdByName` / `impactCount` 全部由**服务端**算：
 * - 前端拿不到"当前 userId"，让它自己比 id 必然与后端漂移（§1.6）；
 * - `createdBy` 是 userId，**不能直接展示**（用户看到一串 ID 等于没信息），这里翻成显示名；
 * - 影响面按视图逐行给出（demo §4.4「视图行常驻影响面摘要」），前端不再逐行发请求。
 */
type ViewEntryDto = ViewInfo & {
  canEdit: boolean;
  mine: boolean;
  createdByName?: string;
  /** 有多少 Token 因缺成员授权而看不到该视图（0 = 全部可见） */
  impactCount: number;
};

/** 组装返回给前端的视图条目（成员可用性在调用方算好） */
function toDto(
  name: string,
  def: ViewConfig,
  base: Omit<ViewInfo, 'view' | 'id' | 'members' | 'revision'>,
  actor: ViewActor,
  extra: { createdByName?: string; impactCount: number },
): ViewEntryDto {
  return {
    view: name,
    id: def.id,
    members: def.members,
    revision: def.revision,
    ...base,
    ...(def.createdBy ? { createdBy: def.createdBy } : {}),
    ...(def.createdAt ? { createdAt: def.createdAt } : {}),
    ...(def.updatedBy ? { updatedBy: def.updatedBy } : {}),
    ...(def.updatedAt ? { updatedAt: def.updatedAt } : {}),
    ...(extra.createdByName ? { createdByName: extra.createdByName } : {}),
    canEdit: canEditView(def, actor),
    mine: def.createdBy === actor.id,
    impactCount: extra.impactCount,
  };
}

/**
 * 成员可用性。
 *
 * 判定与字段拼装**全部委托** `buildMemberMeta` —— 与 `ki_scope_list` 共用同一份口径，
 * 避免两处实现各自演化（曾出现页面有 `docCount`、MCP 侧没有的情况）。
 * 这里只负责提供数据来源。
 */
function memberAvailability(
  config: KiConfig,
  members: string[],
  kbScopes: Set<string>,
  vectorScopes: Set<string>,
  scheduledScopes: Map<string, boolean> = new Map(),
  dimensionStateOf: (scope: string) => ViewDimensionState = () => 'unknown',
): Pick<ViewInfo, 'memberMeta' | 'availableCount' | 'missing'> {
  return buildMemberMeta({
    members,
    kbScopes,
    vectorScopes,
    isReadonly: (scope) => isScopeReadonly(config, scope),
    dimensionStateOf,
    docCountOf: (scope) => {
      try {
        return countScopeDocs(scope).wikiCount;
      } catch (err) {
        // 不静默：统计失败与"空库"在页面上长得一样，必须能在服务端日志里看见
        console.warn(
          `⚠️ 视图成员 "${scope}" 的文档数统计失败，本次不标「空」：${(err as Error).message}`,
        );
        return undefined;
      }
    },
    scheduledScopes,
  });
}

function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, code, error: message }));
}

/**
 * 把视图相关的异常统一翻成响应。
 *
 * ★ 必须同时处理 `ScopeError`：`validateViewMembers()` 对**名字本身非法**的成员抛的是
 *   `ScopeError`（来自 `lib/scope.ts`），不是 `ViewError`。只判 `isViewError` 会让这类
 *   请求冒泡成 500 —— 用户传错一个成员名得到"服务器错误"，是最容易被忽略的体验缺陷。
 *
 * @returns 已处理并写响应 → true；未知异常 → false（由调用方继续抛）
 */
function replyIfViewError(res: http.ServerResponse, err: unknown): boolean {
  if (isViewError(err)) {
    sendError(res, viewErrorStatus(err.code), err.code, err.message);
    return true;
  }
  if (err instanceof ScopeError) {
    sendError(res, 400, 'INVALID_VIEW_MEMBER', err.message);
    return true;
  }
  return false;
}

/** 把 ViewError 翻成 HTTP 状态码 */
function viewErrorStatus(code: string): number {
  switch (code) {
    case 'VIEW_NOT_FOUND':
      return 404;
    case 'VIEWS_CORRUPT':
      return 500;
    default:
      return 400; // INVALID_VIEW_NAME / VIEW_NAME_CONFLICT / INVALID_VIEW_MEMBER
  }
}

/**
 * 解码 URL 路径段。
 *
 * 非法转义（如 `%zz`）会让 `decodeURIComponent` 抛 `URIError`，不处理就是 500；
 * 这类请求应该按「参数非法」回 400。
 */
function decodeIdSegment(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** 按 id 找视图名（页面用 id 定位，不用名字——名字会变） */
function nameOfId(config: KiConfig, id: string): { name: string; def: ViewConfig } | null {
  for (const [name, def] of Object.entries(readViews(config))) {
    if (def.id === id) return { name, def };
  }
  return null;
}

function parseMembers(raw: unknown): string[] | { error: string } {
  if (raw === undefined) return { error: '缺少 members' };
  if (!Array.isArray(raw)) return { error: 'members 必须是字符串数组' };
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.trim() === '') {
      return { error: 'members 必须是非空字符串数组' };
    }
    const name = item.trim();
    if (!out.includes(name)) out.push(name);
  }
  if (out.length === 0) return { error: '至少选择一个知识库' };
  return out;
}

/**
 * 影响面（R-05 口径）：只统计**被授权该视图 ∧ 缺至少一个新成员授权**的 Token。
 * 未授权该视图的 Token 本来也看不到它，不计入 —— 否则数字虚高、删除确认文案失真。
 */
function computeImpact(
  tokens: TokenRecord[],
  members: string[],
  viewName: string,
  viewId: string,
  resolveViewName: (idOrName: string) => string | null,
): { id: string; label: string | null }[] {
  const affected: { id: string; label: string | null }[] = [];
  for (const token of tokens) {
    const grants = Array.isArray(token.viewGrants) ? token.viewGrants : [];
    const scopes = Array.isArray(token.scopes) ? token.scopes : [];
    const grantsView = grants.includes(viewId)
      || grants.includes(viewName)
      || scopes.includes(viewName); // 历史兼容：视图名混写在 scopes 里
    if (!grantsView) continue;

    // 该 Token 的完整授权集合（名称空间）
    const names = scopes.includes('all') ? ['all'] : [...scopes, ...grants.map((g) => resolveViewName(g) ?? g)];
    if (names.includes('all')) continue;
    if (members.every((m) => names.includes(m))) continue; // 一个都没缺
    affected.push({ id: token.id, label: token.label ?? null });
  }
  return affected;
}

export interface ViewsApiCtx {
  usersPath?: string;
}

/**
 * 处理 `/api/views*`。
 * @param p 不含 `/api` 前缀的路径（如 `/views`、`/views/v_ab12cd34`）
 */
export async function handleViewsApi(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  p: string,
  principal: WebPrincipal,
  config: KiConfig,
  _ctx: ViewsApiCtx = {},
): Promise<void> {
  const actor = viewActorOf(principal);
  const method = (req.method ?? 'GET').toUpperCase();

  // ── GET /views：列表 ──
  if (p === '/views' && method === 'GET') {
    try {
      const viewsMap = readViews(config);
      const names = Object.keys(viewsMap).sort();
      // 可用性：KB 名单是同步的；向量名单为保持接口简单只标 kb（与页面展示够用）
      const kbScopes = new Set(listAllScopes());
      /*
       * 向量名单：`vectorListScopes()` 只扫 collections 目录（不启引擎、不需要 apiKey），
       * 成本很低。**必须取真实值** —— 传空集合会让 `memberMeta.vector` 恒为 false，
       * 页面上所有 kb 成员都会被标成「只全文」，有向量的库也被误标。
       */
      let vectorScopes = new Set<string>();
      try {
        vectorScopes = new Set(await vectorListScopes());
      } catch {
        vectorScopes = new Set(); // 扫描失败按「无向量」处理：不误报有向量
      }
      // userId → 显示名：一次建成，供归属列展示（`createdBy` 是 userId，不能直接给用户看）
      let userNames = new Map<string, string>();
      try {
        userNames = new Map(listUsers().map((u) => [u.id, u.username]));
      } catch {
        userNames = new Map(); // 用户文件损坏不阻断列表，归属退化为不显示
      }
      /*
       * 配了定时同步的 scope → 上次自动执行是否失败（一次算好，避免每个视图重复读数据源文件）。
       * ★ 用 `lastAutoState` 而不是 `lastSync.state`：前者是**定时跑出来**的结果，
       *   后者可能是手动同步 —— 手动失败不代表定时链路有问题，反之亦然。
       */
      let scheduledScopes = new Map<string, boolean>();
      try {
        scheduledScopes = new Map(
          listRegisteredDataSourceRecords(config)
            .filter(({ record }) => record.schedule?.enabled === true)
            .map(({ scope, record }) => [scope, record.schedule?.lastAutoState === 'failed']),
        );
      } catch {
        scheduledScopes = new Map(); // 数据源文件损坏不阻断视图列表，只是不标「定时」
      }
      /*
       * 维度状态：纯 fs 读 `.vector-status` 快照（零锁、不 withEngine），按 scope
       * 缓存一次算好供所有视图复用。★ 不调用 getVectorDimensionStatus —— 那会
       * ZVecOpen 拿进程锁，撞锁时 3×2s 重试，会把列表接口拖到分钟级。
       */
      const dimensionCache = new Map<string, ViewDimensionState>();
      const dimensionStateOf = (s: string): ViewDimensionState => {
        let state = dimensionCache.get(s);
        if (state === undefined) {
          state = readViewDimensionState(config, s);
          dimensionCache.set(s, state);
        }
        return state;
      };
      // 影响面：token 只取一次，逐视图算（demo §4.4 的「行内常驻摘要」）
      const tokens = listTokens();
      const resolveViewName = makeViewNameResolver(config);
      const entries = names.map((name) => {
        const def = viewsMap[name];
        const createdByName = def.createdBy ? userNames.get(def.createdBy) : undefined;
        return toDto(name, def, {
          ...memberAvailability(config, def.members, kbScopes, vectorScopes, scheduledScopes, dimensionStateOf),
        }, actor, {
          ...(createdByName ? { createdByName } : {}),
          impactCount: computeImpact(tokens, def.members, name, def.id, resolveViewName).length,
        });
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, count: entries.length, views: entries }));
    } catch (err) {
      if (replyIfViewError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── GET /views/impact：影响面 ──
  if (p === '/views/impact' && method === 'GET') {
    const raw = url.searchParams.get('members') ?? '';
    const members = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (members.length === 0) {
      sendError(res, 400, 'INVALID_VIEW_MEMBER', '缺少 members 查询参数');
      return;
    }
    const viewId = url.searchParams.get('viewId')?.trim() ?? '';
    const found = viewId ? nameOfId(config, viewId) : null;
    try {
      let resolveViewName: (idOrName: string) => string | null;
      try {
        resolveViewName = makeViewNameResolver(config);
      } catch {
        resolveViewName = (x) => x;
      }
      const affected = computeImpact(listTokens(), members, found?.name ?? '', viewId, resolveViewName);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, affected, count: affected.length }));
    } catch (err) {
      if (replyIfViewError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── POST /views：新建 ──
  if (p === '/views' && method === 'POST') {
    const body = (await readJsonBody(req)) as { name?: unknown; members?: unknown } | undefined;
    if (!body || typeof body !== 'object') {
      sendError(res, 400, 'INVALID_VIEW_NAME', '缺少请求体');
      return;
    }
    if (typeof body.name !== 'string' || body.name.trim() === '') {
      sendError(res, 400, 'INVALID_VIEW_NAME', '名称为空');
      return;
    }
    const members = parseMembers(body.members);
    if (!Array.isArray(members)) {
      sendError(res, 400, 'INVALID_VIEW_MEMBER', members.error);
      return;
    }
    const name = body.name.trim();
    try {
      // createdBy 用 actor.id（userId），不是显示名 —— R-07
      createView(config, name, members, { createdBy: actor.id });
      const def = readViews(config)[name];
      res.writeHead(201, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, view: { view: name, id: def.id, members, revision: def.revision, createdAt: def.createdAt ?? null, canEdit: true } }));
    } catch (err) {
      if (replyIfViewError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── PATCH /views/:id：改成员 / 改名 ──
  const patchMatch = /^\/views\/([^/]+)$/.exec(p);
  if (patchMatch && method === 'PATCH') {
    const id = decodeIdSegment(patchMatch[1]);
    if (id === null) {
      sendError(res, 400, 'INVALID_VIEW_ID', '视图 ID 的 URL 编码非法');
      return;
    }
    const found = nameOfId(config, id);
    if (!found) {
      sendError(res, 404, 'VIEW_NOT_FOUND', '视图不存在或已被删除');
      return;
    }
    if (!canEditView(found.def, actor)) {
      sendError(res, 403, 'VIEW_NOT_OWNER', '仅创建者或管理员可修改该视图');
      return;
    }
    const body = (await readJsonBody(req)) as {
      name?: unknown;
      members?: unknown;
      baseRevision?: unknown;
    } | undefined;
    if (!body || typeof body !== 'object') {
      sendError(res, 400, 'INVALID_VIEW_NAME', '缺少请求体');
      return;
    }
    /*
     * 乐观锁（N7 / R-11）：`baseRevision` **必须传**。
     * 允许缺省等于允许"不读就覆盖"——任何客户端漏传就能绕过并发保护，锁形同虚设。
     */
    if (typeof body.baseRevision !== 'number') {
      sendError(res, 400, 'VIEW_REVISION_REQUIRED', '缺少 baseRevision：请先读取视图再提交，避免覆盖他人改动');
      return;
    }
    if (body.baseRevision !== found.def.revision) {
      sendError(res, 409, 'VIEW_REVISION_CONFLICT', '他人已修改该视图，请刷新后重试');
      return;
    }

    /*
     * 成员**先校验、后落盘**。
     * 原顺序是「先改名、再校验成员」——成员非法时返回 400，但名字已经改了，
     * 前端按"整体失败"处理、重试旧名字直接 404（非原子的部分成功）。
     */
    let nextMembers: string[] | null = null;
    if (body.members !== undefined) {
      const parsed = parseMembers(body.members);
      if (!Array.isArray(parsed)) {
        sendError(res, 400, 'INVALID_VIEW_MEMBER', parsed.error);
        return;
      }
      nextMembers = parsed;
      const targetName = (typeof body.name === 'string' && body.name.trim() !== '')
        ? body.name.trim()
        : found.name;
      try {
        validateViewMembers(config, nextMembers, targetName);
      } catch (err) {
        if (replyIfViewError(res, err)) return;
        throw err;
      }
    }

    try {
      let currentName = found.name;
      if (typeof body.name === 'string' && body.name.trim() !== '' && body.name.trim() !== found.name) {
        // 改名：ID 不变（D7），token 授权自动跟随
        renameView(config, currentName, body.name.trim(), { updatedBy: actor.id });
        currentName = body.name.trim();
      }
      if (nextMembers !== null) {
        updateView(config, currentName, () => nextMembers as string[], { updatedBy: actor.id });
      } else if (currentName !== found.name) {
        // 只改名时也要推进 revision（renameView 已做），无需额外写
      }
      const def = readViews(config)[currentName];
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        ok: true,
        view: {
          view: currentName,
          id: def.id,
          members: def.members,
          revision: def.revision,
          createdBy: def.createdBy ?? null,
          createdAt: def.createdAt ?? null,
          updatedAt: def.updatedAt ?? null,
          canEdit: canEditView(def, actor),
        },
      }));
    } catch (err) {
      if (replyIfViewError(res, err)) return;
      throw err;
    }
    return;
  }

  // ── DELETE /views/:id ──
  const delMatch = /^\/views\/([^/]+)$/.exec(p);
  if (delMatch && method === 'DELETE') {
    const id = decodeIdSegment(delMatch[1]);
    if (id === null) {
      sendError(res, 400, 'INVALID_VIEW_ID', '视图 ID 的 URL 编码非法');
      return;
    }
    const found = nameOfId(config, id);
    if (!found) {
      sendError(res, 404, 'VIEW_NOT_FOUND', '视图不存在或已被删除');
      return;
    }
    if (!canEditView(found.def, actor)) {
      sendError(res, 403, 'VIEW_NOT_OWNER', '仅创建者或管理员可修改该视图');
      return;
    }
    try {
      deleteView(config, found.name);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      if (replyIfViewError(res, err)) return;
      if (err instanceof ViewError) throw err;
      throw err;
    }
    return;
  }

  sendError(res, 404, 'NOT_FOUND', `Not Found: /api${p}`);
}
