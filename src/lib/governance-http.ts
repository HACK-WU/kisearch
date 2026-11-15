/**
 * 知识治理 HTTP 路由（REQ-20261113-004 · S-06）
 *
 * ═══ 设计意图：单一入口，挂载点极薄 ═══
 * `mcp-http-api.ts` 的 if 链只加一行：`if (await handleGovernanceRoutes(...)) return;`。
 * 该文件已 2400+ 行，逐条加分支会持续放大（与 chat-routes 同一处置）。
 *
 * ═══ 通用语义契约 ═══
 * · 响应外壳：`{ok:true,...}` / `{ok:false,code,error,details?}`
 * · 字段命名：camelCase；入参同时接受 snake_case（`ttl_days`）与 camelCase（`ttlDays`）
 * · 鉴权：scope 必须在 Token 的 scope 集合内，否则 403（不是 404，避免状态码探测）
 * · **路径里不放 group**（group 含 `/`，路径编码会引入双重解码问题）⇒ 一律走 query/body
 * · 未命中本模块的路径返回 false，由上层继续匹配（不影响既有路由）
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { readJson } from './store.js';
import { GovernanceError } from './governance-errors.js';
import {
  readGovernance, writeGovernance, validateTrashSettings, BUILTIN_PRESETS, TRASH_KEEP_DAYS,
  type GovernanceConfig, type LifecyclePreset,
} from './governance-store.js';
import { changeLifecycle } from './relation-lifecycle.js';
import { resolveLifecycle } from './lifecycle.js';
import { resolveVisibilityOfRelation } from './visibility-index.js';
import { readAllGroupCaches } from './group-cache.js';
import { listTypes, createType, updateType, deleteType } from './events/type-service.js';
import {
  listEvents, createEvent, updateEventTitle, transitionEvent, deleteEvent, reopenEvent, collectMembers,
} from './events/event-service.js';
import { listRefs, addRefs, removeRef, searchRefCandidates, searchDocsForAdd } from './events/refs-service.js';
import { readAllEvents, findEventIn } from './events/store.js';
import { readStageLogs } from './events/stage-log.js';
import { listTrash, readTrashSettings, writeTrashSettings, removeTrashItem } from './trash-store.js';
import { restoreFromTrash, purgeExpired } from './trash-service.js';
import { pendingCount, listPending } from './visibility-queue.js';
import { failureFilePath, type FailureFile } from './visibility-index.js';

export interface GovernanceRouteContext {
  /** Token 授权范围；null = 免鉴权（本机 stdio / 回环） */
  authScopes: string[] | null;
}

/** 错误码 → HTTP 状态。未列入的按 400（契约错误） */
const STATUS_BY_CODE: Record<string, number> = {
  EVENT_NOT_FOUND: 404,
  TYPE_NOT_FOUND: 404,
  TRASH_NOT_FOUND: 404,
  REF_NOT_FOUND: 404,
  RESTORE_NAME_CONFLICT: 409,
  REVISION_CONFLICT: 409,
  TYPE_IN_USE: 409,
  TYPE_BUILTIN: 409,
  REF_ALREADY_ASSOCIATED: 409,
  EVENT_CLOSED: 409,
  EVENT_NOT_CLOSED: 409,
  DATASOURCE_LIFECYCLE_LOCKED: 403,
  FORBIDDEN_SCOPE: 403,
  DOC_NOT_FOUND: 404,
};

/**
 * 发送 JSON 并返回 `true`：本模块所有分支都是「写完就 return 已处理」，
 * 让 sendJson 直接产出返回值，避免满屏 `return (sendJson(...), true)` 这种逗号运算符写法。
 */
function sendJson(res: ServerResponse, status: number, payload: unknown): true {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
  return true;
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        resolve(parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof GovernanceError) {
    sendJson(res, STATUS_BY_CODE[err.code] ?? 400, {
      ok: false,
      code: err.code,
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  sendJson(res, 500, { ok: false, error: (err as Error).message });
}

/** 入参兼容：`ttl_days` 与 `ttlDays` 都收（前端用 camel，脚本/MCP 风格用 snake） */
function pick<T>(body: Record<string, unknown>, camel: string, snake: string): T | undefined {
  return (body[camel] ?? body[snake]) as T | undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

export async function handleGovernanceRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: GovernanceRouteContext,
): Promise<boolean> {
  const path = url.pathname.replace(/^\/api/, '').replace(/\/+$/, '') || '/';
  if (path !== '/governance' && !path.startsWith('/governance/')) return false;

  const segs = path.slice('/governance'.length).replace(/^\/+/, '').split('/').filter(Boolean);
  const method = (req.method ?? 'GET').toUpperCase();
  const q = url.searchParams;

  /** scope 鉴权：查询串与 body 都可能是来源，先按查询串判，body 场景在下面补判 */
  const assertScope = (scope: string): void => {
    if (ctx.authScopes && !ctx.authScopes.includes(scope)) {
      throw new GovernanceError('FORBIDDEN_SCOPE', `无权访问 scope「${scope}」`, { scope });
    }
  };

  const scopeFromQuery = (): string => {
    const scope = str(q.get('scope')) ?? 'default';
    assertScope(scope);
    return scope;
  };

  const body = (): Promise<Record<string, unknown>> => readJsonBody(req);
  /**
   * body 里的 scope 优先，其次 URL 的 `?scope=`，最后才 default。
   *
   * 只认 body 是危险的：前端把 scope 放 query、body 只放业务字段时，
   * 写操作会**静默落到 default 库**（页面显示成功、数据却写错库）。
   */
  const scopeFromBody = (b: Record<string, unknown>): string => {
    const scope = str(b.scope) ?? str(q.get('scope')) ?? 'default';
    assertScope(scope);
    return scope;
  };

  try {
    // ─── 分类 ───────────────────────────────────────────
    if (segs[0] === 'lifecycle') {
      if (segs[1] === 'list' && method === 'GET') {
        const scope = scopeFromQuery();
        const config = readGovernance(scope);
        return sendJson(res, 200, {
          ok: true,
          scope,
          group: str(q.get('group')) ?? null,
          kinds: [
            { kind: 'wiki', label: '长期保留', ttlOptions: [] },
            { kind: 'temp', label: '临时', ttlOptions: [7, 30, 90], min: 1, max: 365 },
            { kind: 'event', label: '事件', ttlOptions: [] },
          ],
          presets: [...BUILTIN_PRESETS, ...config.lifecyclePresets],
          groupDefaults: config.groupDefaults,
        });
      }

      if (segs[1] === 'apply' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const result = await changeLifecycle({
          scope,
          group: String(b.group ?? ''),
          name: String(b.name ?? b.relation ?? ''),
          lifecycle: str(b.lifecycle),
          ttlDays: num(pick(b, 'ttlDays', 'ttl_days')),
          eventId: str(pick(b, 'eventId', 'event')),
        });
        if (!result.ok) {
          return sendJson(res, STATUS_BY_CODE[result.code] ?? 400, {
            ok: false,
            code: result.code,
            // 契约字段是 `error`：直接透出内部 `message` 会让前端拿到 undefined
            error: result.message,
            ...(result.details ? { details: result.details } : {}),
          });
        }
        return sendJson(res, 200, { ok: true, scope, ...result.summary });
      }

      if (segs[1] === 'batch-apply' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
        const succeeded: unknown[] = [];
        const failed: unknown[] = [];
        for (const item of items) {
          const result = await changeLifecycle({
            scope,
            group: String(item.group ?? ''),
            name: String(item.name ?? ''),
            lifecycle: str(item.lifecycle),
            ttlDays: num(pick(item, 'ttlDays', 'ttl_days')),
            eventId: str(pick(item, 'eventId', 'event')),
          }).catch((err: unknown) => ({ ok: false as const, code: (err as GovernanceError).code ?? 'UNKNOWN', message: (err as Error).message }));
          if (result.ok) succeeded.push({ group: item.group, name: item.name, ...result.summary });
          else failed.push({ group: item.group, name: item.name, code: result.code, error: result.message });
        }
        return sendJson(res, 200, { ok: true, scope, succeeded: succeeded.length, failed, results: succeeded });
      }

      if (segs[1] === 'presets') {
        const scope = scopeFromQuery();
        const config = readGovernance(scope);
        if (method === 'GET') {
          return sendJson(res, 200, { ok: true, scope, presets: config.lifecyclePresets });
        }
        if (method === 'POST') {
          const b = await body();
          const kind = str(b.kind) ?? 'temp';
          const preset: LifecyclePreset = {
            id: str(b.id) ?? `preset_${Date.now().toString(36)}`,
            name: String(b.name ?? '').trim(),
            kind: kind as LifecyclePreset['kind'],
            ...(num(pick(b, 'ttlDays', 'ttl_days')) !== undefined ? { ttlDays: num(pick(b, 'ttlDays', 'ttl_days')) } : {}),
          };
          if (!preset.name) return sendJson(res, 400, { ok: false, code: 'PRESET_NAME_REQUIRED', error: '预设名不能为空' });
          const next: GovernanceConfig = {
            ...config,
            lifecyclePresets: [...config.lifecyclePresets.filter((p) => p.id !== preset.id), preset],
            updatedAt: new Date().toISOString(),
          };
          writeGovernance(scope, next);
          return sendJson(res, 200, { ok: true, scope, preset });
        }
        if (method === 'DELETE') {
          const id = str(segs[2]);
          const next: GovernanceConfig = {
            ...config,
            lifecyclePresets: config.lifecyclePresets.filter((p) => p.id !== id),
            updatedAt: new Date().toISOString(),
          };
          writeGovernance(scope, next);
          return sendJson(res, 200, { ok: true, scope, removed: id ?? null });
        }
      }
    }

    // ─── 事件类型 ───────────────────────────────────────
    if (segs[0] === 'event-types') {
      if (method === 'GET' && !segs[1]) {
        const scope = scopeFromQuery();
        return sendJson(res, 200, { ok: true, scope, types: listTypes(scope) });
      }
      if (method === 'POST' && !segs[1]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const type = await createType(scope, {
          name: String(b.name ?? ''),
          ...(Array.isArray(b.stages) ? { stages: b.stages as Array<{ name: string; visibility: 'full' | 'fts-only' | 'hidden'; disabled?: boolean }> } : {}),
          ...(str(b.terminalAction) ? { terminalAction: str(b.terminalAction) as 'keep' | 'trash' } : {}),
          ...(pick(b, 'fallbackDays', 'fallback_days') !== undefined ? { fallbackDays: num(pick(b, 'fallbackDays', 'fallback_days')) ?? null } : {}),
        });
        return sendJson(res, 201, { ok: true, scope, type });
      }
      if (segs[1] && method === 'PATCH') {
        const b = await body();
        const scope = scopeFromBody(b);
        const type = await updateType(scope, segs[1], {
          revision: num(b.revision) ?? -1,
          ...(str(b.name) ? { name: str(b.name)! } : {}),
          ...(Array.isArray(b.stages) ? { stages: b.stages as Array<{ key?: string; name: string; visibility: 'full' | 'fts-only' | 'hidden'; disabled?: boolean }> } : {}),
          ...(str(b.terminalAction) ? { terminalAction: str(b.terminalAction) as 'keep' | 'trash' } : {}),
          ...(pick(b, 'fallbackDays', 'fallback_days') !== undefined ? { fallbackDays: num(pick(b, 'fallbackDays', 'fallback_days')) ?? null } : {}),
        });
        return sendJson(res, 200, { ok: true, scope, type });
      }
      if (segs[1] && method === 'DELETE') {
        const scope = scopeFromQuery();
        await deleteType(scope, segs[1]);
        return sendJson(res, 200, { ok: true, scope, deleted: segs[1] });
      }
    }

    // ─── 事件 ───────────────────────────────────────────
    if (segs[0] === 'events') {
      if (method === 'GET' && !segs[1]) {
        const scope = scopeFromQuery();
        const result = listEvents(scope, {
          status: (str(q.get('status')) ?? 'open') as 'open' | 'closed' | 'all',
          ...(str(q.get('type')) ? { typeId: str(q.get('type'))! } : {}),
          ...(str(q.get('q')) ? { q: str(q.get('q'))! } : {}),
          limit: num(q.get('limit')) ?? 20,
          offset: num(q.get('offset')) ?? 0,
          docsPreviewLimit: num(q.get('docsPreviewLimit')) ?? 3,
        });
        return sendJson(res, 200, {
          ok: true,
          scope,
          total: result.total,
          hasMore: result.hasMore,
          events: result.items.map((item) => ({
            ...item.event,
            typeName: item.type?.name ?? null,
            stage: item.stage,
            memberTotal: item.memberTotal,
            docsPreview: item.members.map((m) => ({ group: m.group, name: m.name })),
            visibilitySummary: item.visibilitySummary,
          })),
        });
      }

      if (method === 'POST' && !segs[1]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const event = await createEvent(scope, {
          title: String(b.title ?? ''),
          typeId: String(b.typeId ?? b.type_id ?? ''),
          ...(Array.isArray(b.docs) ? { docs: b.docs as Array<{ group: string; name: string }> } : {}),
          by: 'user',
        });
        return sendJson(res, 201, { ok: true, scope, event });
      }

      const id = segs[1];
      if (id && method === 'GET' && !segs[2]) {
        const scope = scopeFromQuery();
        const event = findEventIn(readAllEvents(scope), id);
        if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
        return sendJson(res, 200, {
          ok: true,
          scope,
          event,
          members: collectMembers(scope, event.id).map((m) => ({ group: m.group, name: m.name })),
          logs: readStageLogs(scope, event.id),
        });
      }

      if (id && method === 'PATCH' && !segs[2]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const event = await updateEventTitle(scope, id, String(b.title ?? ''), num(b.revision) ?? -1);
        return sendJson(res, 200, { ok: true, scope, event });
      }

      if (id && method === 'DELETE' && !segs[2]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const outcome = await deleteEvent(scope, { event: id, docAction: str(b.docAction) as 'wiki' | 'trash' | undefined });
        return sendJson(res, 200, { ...outcome, ok: true, scope });
      }

      if (id && segs[2] === 'stage' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const outcome = await transitionEvent(scope, {
          event: id,
          stage: String(b.stage ?? ''),
          ...(str(b.note) ? { note: str(b.note)! } : {}),
          by: 'user',
        });
        return sendJson(res, 200, { ok: true, scope, ...outcome });
      }

      if (id && segs[2] === 'reopen' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const outcome = await reopenEvent(scope, id);
        return sendJson(res, 200, { ok: true, scope, ...outcome });
      }

      // ─── 参考文档 ───
      if (id && segs[2] === 'refs') {
        if (method === 'GET' && !segs[3]) {
          const scope = scopeFromQuery();
          return sendJson(res, 200, { ok: true, scope, ...listRefs(scope, id) });
        }
        if (method === 'POST' && segs[3] === 'search') {
          const b = await body();
          const scope = scopeFromBody(b);
          const q0 = str(b.query);
          if (!q0) {
            // 无自定义 query：走确定性候选（真实检索需注入 search 实现）
            const result = await searchRefCandidates(scope, id, { search: async () => [] });
            return sendJson(res, 200, { ok: true, scope, ...result, note: 'HTTP 层未接语义检索实现时返回空候选，请用手动搜索' });
          }
          const hits = searchDocsForAdd(scope, q0, num(b.limit) ?? 20);
          return sendJson(res, 200, { ok: true, scope, hits });
        }
        if (method === 'POST' && !segs[3]) {
          const b = await body();
          const scope = scopeFromBody(b);
          const docs = Array.isArray(b.docs) ? (b.docs as Array<{ group: string; name: string; score?: number }>) : [{ group: String(b.group ?? ''), name: String(b.name ?? '') }];
          const result = addRefs(scope, id, { docs, addedBy: (str(b.addedBy) as 'ai' | 'manual') ?? 'manual' });
          return sendJson(res, 200, { ok: true, scope, ...result });
        }
        if (method === 'DELETE') {
          const scope = scopeFromQuery();
          removeRef(scope, id, str(q.get('group')) ?? '', str(q.get('name')) ?? '');
          return sendJson(res, 200, { ok: true, scope, removed: true });
        }
      }
    }

    /**
     * GET /governance/docs —— 文档列表**带分类**（分类页列表与批量条的数据源）。
     *
     * 为什么不复用 `/api/doc/list`：那个接口只回 group/name，不含 lifecycle。
     * 前端拿它渲染列表就只能显示"未知分类"，再去逐篇查分类等于 N+1 次调用。
     * 这里直接读分片 + 现算档位，一次返回列表所需的全部字段。
     */
    if (segs[0] === 'docs' && method === 'GET' && !segs[1]) {
      const scope = scopeFromQuery();
      const groupFilter = str(q.get('group'));
      const keyword = (str(q.get('q')) ?? '').toLowerCase();
      const limit = Math.min(Math.max(num(q.get('limit')) ?? 50, 1), 200);
      const offset = Math.max(num(q.get('offset')) ?? 0, 0);
      const now = Date.now();

      // 事件与阶段名：列表要显示「#3 登录页白屏 · 排查中」，逐个查会变成 N+1
      const eventIndex = new Map(
        readAllEvents(scope).map((e) => [e.id, e] as const),
      );
      const typeStageNames = new Map<string, string>();
      for (const type of listTypes(scope)) {
        for (const stage of type.stages) typeStageNames.set(`${type.id}\u0000${stage.key}`, stage.name);
      }

      const all: Array<Record<string, unknown>> = [];
      for (const [group, doc] of readAllGroupCaches(scope)) {
        if (groupFilter && group !== groupFilter) continue;
        for (const rel of doc.hot_relations) {
          if (keyword && !rel.text.toLowerCase().includes(keyword)) continue;
          const lifecycle = resolveLifecycle(rel);
          const visibility = resolveVisibilityOfRelation(scope, rel).mode;
          all.push({
            group,
            name: rel.text,
            lifecycle: lifecycle.kind,
            ...(lifecycle.expiresAt !== undefined ? { expiresAt: lifecycle.expiresAt } : {}),
            ...(rel.ttlDays !== undefined ? { ttlDays: rel.ttlDays } : {}),
            ...(rel.eventId ? { eventId: rel.eventId } : {}),
            ...(lifecycle.inconsistent ? { lifecycleWarning: lifecycle.reason } : {}),
            visibility,
            imported: rel.isImported === true,
            lastUsedTime: rel.lastUsedTime ?? null,
            event: (() => {
              if (!rel.eventId) return null;
              const event = eventIndex.get(rel.eventId);
              if (!event) return { id: rel.eventId, shortId: null, title: '(事件已删除)', stageName: null };
              return {
                id: event.id,
                shortId: event.shortId,
                title: event.title,
                stageName: typeStageNames.get(`${event.typeId}\u0000${event.stageKey}`) ?? null,
                closed: event.closedAt !== null,
              };
            })(),
            remainDays: lifecycle.expiresAt !== undefined
              ? Math.max(0, Math.ceil((lifecycle.expiresAt - now) / 86_400_000))
              : null,
          });
        }
      }
      return sendJson(res, 200, { ok: true, scope, total: all.length, items: all.slice(offset, offset + limit) });
    }

    // ─── 文档搜索（手动添加参考文档）────────────────────
    if (segs[0] === 'docs' && segs[1] === 'search' && method === 'GET') {
      const scope = scopeFromQuery();
      return sendJson(res, 200, { ok: true, scope, hits: searchDocsForAdd(scope, str(q.get('q')) ?? '', num(q.get('limit')) ?? 20) });
    }

    // ─── 回收站 ─────────────────────────────────────────
    if (segs[0] === 'trash') {
      if (method === 'GET' && !segs[1]) {
        const scope = scopeFromQuery();
        const result = listTrash(scope, {
          ...(str(q.get('reason')) ? { reason: str(q.get('reason')) as never } : {}),
          limit: num(q.get('limit')) ?? 50,
          offset: num(q.get('offset')) ?? 0,
        });
        return sendJson(res, 200, {
          ok: true,
          scope,
          total: result.total,
          items: result.items.map(({ dir, ...rest }) => rest),
          settings: readTrashSettings(scope),
        });
      }

      if (segs[1] === 'restore' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const outcome = restoreFromTrash({
          scope,
          group: String(b.group ?? ''),
          dirName: String(b.dirName ?? b.dir_name ?? ''),
          ...(str(b.targetLifecycle) ? { targetLifecycle: str(b.targetLifecycle) as 'wiki' | 'temp' } : {}),
        });
        return outcome.ok
          ? sendJson(res, 200, { ...outcome, scope })
          : sendJson(res, STATUS_BY_CODE[outcome.code] ?? 400, { ok: false, scope, code: outcome.code, error: outcome.error });
      }

      if (segs[1] === 'purge' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const removed = removeTrashItem(scope, String(b.group ?? ''), String(b.dirName ?? b.dir_name ?? ''));
        return removed
          ? sendJson(res, 200, { ok: true, scope, purged: true })
          : sendJson(res, 404, { ok: false, code: 'TRASH_NOT_FOUND', error: '回收站条目不存在' });
      }

      if (segs[1] === 'sweep' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const result = purgeExpired({ scope, dryRun: b.dryRun === true || b.dry_run === true });
        return sendJson(res, 200, { ok: true, scope, ...result });
      }

      if (segs[1] === 'settings') {
        /**
         * ⚠ body 只能读一次：`readJsonBody` 是流消费，第二次调用时请求已 end，
         * 监听器永远不会触发 ⇒ Promise 悬住、连接挂死（PUT 之前就是这么写的）。
         */
        const b = await body();
        const scope = method === 'GET' ? scopeFromQuery() : scopeFromBody(b);
        if (method === 'GET') {
          return sendJson(res, 200, { ok: true, scope, settings: readTrashSettings(scope), options: TRASH_KEEP_DAYS });
        }
        if (method === 'PUT') {
          const validated = validateTrashSettings({
            ...(num(b.keepDays) !== undefined ? { keepDays: num(b.keepDays) as never } : {}),
            ...(str(b.expireAction) ? { expireAction: str(b.expireAction) as never } : {}),
          });
          if (!validated.ok) return sendJson(res, 400, { ok: false, code: 'TRASH_SETTINGS_INVALID', error: validated.message });
          return sendJson(res, 200, { ok: true, scope, settings: writeTrashSettings(scope, validated.value) });
        }
      }
    }

    // ─── 诊断与计数 ─────────────────────────────────────
    if (segs[0] === 'diagnostics' && method === 'GET') {
      const scope = scopeFromQuery();
      let failures: FailureFile = { version: 1, items: [] };
      try {
        const raw = readJson<FailureFile>(failureFilePath(scope));
        if (raw && Array.isArray(raw.items)) failures = raw;
      } catch { /* 诊断文件损坏时按空处理 */ }
      return sendJson(res, 200, {
        ok: true,
        scope,
        pending: { count: pendingCount(scope), items: listPending(scope) },
        failures,
        trash: { total: listTrash(scope).total },
      });
    }

    if (segs[0] === 'counts' && method === 'GET') {
      const scope = scopeFromQuery();
      let docs = 0;
      for (const [, doc] of readAllGroupCaches(scope)) docs += doc.hot_relations.length;
      const events = readAllEvents(scope);
      return sendJson(res, 200, {
        ok: true,
        scope,
        docs,
        eventsOpen: events.filter((e) => e.closedAt === null).length,
        eventsClosed: events.filter((e) => e.closedAt !== null).length,
        trash: listTrash(scope).total,
        pendingIndex: pendingCount(scope),
      });
    }

    return false;
  } catch (err) {
    fail(res, err);
    return true;
  }
}

/** 诊断文件路径（供外部测试与页面复用） */
export function governanceDiagnosticsPath(scope: string): string {
  return failureFilePath(scope);
}
