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
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './store.js';
import { GovernanceError, httpStatusFor } from './governance-errors.js';
// 大体积请求体（事件参考文档上传）走限长版本：本文件的 `readJsonBody` 无上限，
// 那是既有路由的历史现状（P3-B 决定不搭车改），新端点必须自己带闸。
import { readJsonBody as readApiJsonBody, MAX_API_BODY } from './http-body.js';
// 上传判据与 /api/import/upload 同源（见 import-upload-policy.ts 头注释）
import { validateUploadFile, type UploadFilePolicy } from './import-upload-policy.js';
import { ASSET_EXTENSIONS, DEFAULT_MAX_FILE_SIZE_BYTES, DEFAULT_MAX_ASSET_SIZE } from './import.js';
import { isUserAssignableGroup, deriveGroupPath, relationOfPath } from './import-path.js';
import { readRefs } from './events/refs-store.js';
import {
  readGovernance, writeGovernance, validateTrashSettings, validatePresetKind, BUILTIN_PRESETS, TRASH_KEEP_DAYS,
  type GovernanceConfig, type LifecyclePreset,
} from './governance-store.js';
import { changeLifecycle } from './relation-lifecycle.js';
import { resolveLifecycle } from './lifecycle.js';
import { resolveVisibilityOfRelation } from './visibility-index.js';
import { readAllGroupCaches } from './group-cache.js';
import { listTypes, createType, updateType, deleteType } from './events/type-service.js';
import {
  listEvents, createEventWithBinding, updateEvent, transitionEvent, deleteEvent, reopenEvent,
  type CreateEventOutcome,
} from './events/event-service.js';
import { bindMembers, unbindMember, type BindMembersOutcome } from './events/members.js';
import { readLastFind, saveLastFind } from './events/refs-store.js';
import { listRefs, addRefs, removeRef, searchRefCandidates, searchDocsForAdd, REF_LIMIT } from './events/refs-service.js';
import { createSearchAdapter, type RefSearchFn } from './events/refs-search.js';
import { readAllEvents, findEventIn, isEventClosed, mustFindEvent } from './events/store.js';
import { resolveFindTargets } from './events/find-targets.js';
import { defaultFindConfig, readPromptConfig } from './chat/prompt-config.js';
import { runDeepFindAsSearchResult } from './events/find-service.js';
import { loadConfig, getScopeImportConfig, resolveImportExtensions } from './config.js';
import { ALL_SCOPES } from './mcp-token.js';
import { loadEventDetail } from './events/event-detail.js';
import {
  confirmDraftLocations,
  discardAnalysisDraft,
  removeConfirmedLocation,
} from './events/analysis-store.js';
import { cancelEventAnalysis, isAnalysisActive, readNormalizedAnalysisDoc, startEventAnalysis } from './events/analysis-runner.js';
import {
  ASK_DOC_MAX_BYTES,
  ASK_DOC_MAX_TURNS,
  clearAskTurns,
  readAskDoc,
} from './events/analysis-ask-store.js';
import { askEventAnalysis, type AskTargetEvent } from './events/analysis-ask-runner.js';
import { listTrash, readTrashSettings, writeTrashSettings, removeTrashItem } from './trash-store.js';
import { restoreFromTrash, purgeExpired } from './trash-service.js';
import { pendingCount, listPending, scheduleConsume } from './visibility-queue.js';
import { failureFilePath, type FailureFile } from './visibility-index.js';

/**
 * 绑定结果的给人看的一句话：AI 与页面都用它解释"为什么搜不到 / 为什么被拒"。
 * `hidden` / `fts-only` 必须显式说明是**预期行为**，否则调用方会把正常行为当失败重试。
 */
function buildMemberHint(result: BindMembersOutcome): string {
  const parts: string[] = [];
  if (result.bound.length > 0) parts.push(`已挂上 ${result.bound.length} 篇`);
  if (result.skipped.length > 0) parts.push(`跳过 ${result.skipped.length} 篇（已在本事件或重复提交）`);
  if (result.failed.length > 0) parts.push(`${result.failed.length} 篇被拒（见 failed[]）`);
  if (result.visibilityFailed.length > 0) {
    parts.push(`⚠ ${result.visibilityFailed.length} 篇索引未能摘除，仍可能被检索到（已记录诊断）`);
  }
  if (result.visibility.mode === 'hidden') {
    parts.push('当前阶段不可检索：语义与全文都搜不到，这是阶段设计的预期行为');
  } else if (result.visibility.mode === 'fts-only') {
    parts.push('当前阶段仅全文可命中：语义检索不会召回，这是预期行为');
  } else {
    parts.push('当前阶段语义与全文都可检索');
  }
  if (result.pending.length > 0) parts.push(`索引补齐中（${result.pending.join(' / ')}），数秒后生效`);
  return parts.join('；');
}

/** 创建事件的绑定摘要 */
function buildBindingHint(outcome: CreateEventOutcome): string {
  const { docs, refs } = outcome.binding;
  const parts = [`事件已创建：关联 ${docs.bound.length} 篇、参考 ${refs.added} 篇`];
  if (docs.failed.length > 0) parts.push(`${docs.failed.length} 篇关联文档被拒（见 binding.docs.failed）`);
  if (refs.failed.length > 0) parts.push(`${refs.failed.length} 条参考文档失败（见 binding.refs.failed）`);
  if (docs.visibilityFailed.length > 0) {
    parts.push(`⚠ ${docs.visibilityFailed.length} 篇索引未能摘除，仍可能被检索到`);
  }
  if (outcome.visibility.mode === 'hidden') parts.push('当前阶段不可检索（预期行为）');
  else if (outcome.visibility.mode === 'fts-only') parts.push('当前阶段仅全文可命中（预期行为）');
  return parts.join('；');
}

/** 该事件此刻是否真有一个后台分析在跑（与 `readNormalizedAnalysisDoc` 的僵尸判定同一口径） */
function isAnalysisRunning(scope: string, eventId: string): boolean {
  return isAnalysisActive(scope, eventId)
    && readNormalizedAnalysisDoc(scope, eventId).draft?.status === 'running';
}

export interface GovernanceRouteContext {
  /** Token 授权范围；null = 免鉴权（本机 stdio / 回环） */
  authScopes: string[] | null;
}

/**
 * 检索实现按需加载。
 *
 * `search.ts` 会连带 vector-client / commander 等一整套检索栈；静态 import 会让
 * `mcp-http-api` 的模块初始化多背一份（本项目对 jiti 启动耗时敏感，见项目架构记忆）。
 * 首次调用后由 ESM 模块缓存兜住，后续零额外成本。
 */
let searchModulePromise: Promise<typeof import('../search.js')> | null = null;
function getSearchModule(): Promise<typeof import('../search.js')> {
  searchModulePromise ??= import('../search.js');
  return searchModulePromise;
}

/**
 * 检索适配器：懒加载 `executeSearch` 后交给 `events/refs-search.ts` 做窄化与错误翻译。
 *
 * 适配器只建一次（首调用时），之后复用；`getSearchModule` 保证 `ki mcp` 启动不背检索栈。
 */
let adapterCache: RefSearchFn | null = null;
async function searchAdapter(args: { scope: string; query: string; topK: number }) {
  if (!adapterCache) {
    const { executeSearch } = await getSearchModule();
    adapterCache = createSearchAdapter(executeSearch);
  }
  return adapterCache(args);
}

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
    sendJson(res, httpStatusFor(err.code), {
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

// ─── 参考文档上传（REQ-20261118-001）────────────────────

/** 单次上传文件数上限（需求 D5：选择即限制，不截断） */
const EVENT_REF_UPLOAD_MAX_FILES = 10;

/**
 * 缺省落点 Group：`事件参考/{短号}-{标题}`（需求 D1）。
 *
 * 为什么不能沿用导入的缺省（`__root__`）：参考文档行会显示 group 名，沉到「根」
 * 既看不出这批文档哪来，也会与根目录散落文件混在一起（截图中已有一条落在 `__root__`）。
 * 标题里的分隔符与控制字符必须剔掉，否则拼出来的 group 本身不合法。
 */
function defaultEventRefGroup(event: { shortId: number; title: string }): string {
  const title = event.title
    .replace(/[\\/\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return title ? `事件参考/${event.shortId}-${title}` : `事件参考/${event.shortId}`;
}

/** 上传请求体：限长读取 + 解析失败转成可判别的治理错误 */
async function readEventRefUploadBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  try {
    const raw = await readApiJsonBody(req, MAX_API_BODY);
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  } catch (err) {
    throw new GovernanceError(
      'REF_UPLOAD_BAD_REQUEST',
      `请求体无法解析（应为 JSON，且不超过 ${Math.round(MAX_API_BODY / 1024 / 1024)}MB）：${(err as Error).message}`,
    );
  }
}

/**
 * `POST /governance/events/:id/refs/upload` —— 上传文件并挂为该事件的参考文档。
 *
 * ★ 顺序是硬约束：**全部校验通过之前一个字节都不落盘** → 起导入 job → job 结束后建引用。
 *   先导入后校验会留下「文档已入库、却没进参考文档」的孤儿文档，用户无从发现（护栏 #1）。
 *
 * ★ 导入内核用 `await import()` 懒加载：`mcp-http-api.ts` 静态 import 本模块，
 *   这里再静态回引就成环（护栏 #2）。请求期动态 import 命中 ESM 缓存，后续零成本。
 */
async function uploadEventRefDocs(args: {
  res: ServerResponse;
  scope: string;
  eventRef: string;
  body: Record<string, unknown>;
  authScopes: string[] | null;
}): Promise<true> {
  const { res, scope, eventRef, body, authScopes } = args;

  const allEvents = readAllEvents(scope);
  const event = findEventIn(allEvents, eventRef);
  if (!event) {
    throw new GovernanceError('EVENT_NOT_FOUND', `事件「${eventRef}」不存在`, {
      available: allEvents.filter((e) => !isEventClosed(e)).slice(0, 5)
        .map((e) => ({ id: e.id, shortId: e.shortId, title: e.title })),
    });
  }

  const rawFiles = Array.isArray(body.files) ? body.files : [];
  const files = rawFiles.map((f) => (f && typeof f === 'object' ? (f as { name?: string; content?: string }) : {}));
  if (files.length === 0) {
    throw new GovernanceError('REF_UPLOAD_NO_FILE', '请至少选择一个文件（body: { files: [{ name, content }] }）');
  }
  if (files.length > EVENT_REF_UPLOAD_MAX_FILES) {
    throw new GovernanceError(
      'REF_UPLOAD_TOO_MANY',
      `单次最多 ${EVENT_REF_UPLOAD_MAX_FILES} 个文件（本次 ${files.length} 个），请分批上传`,
      { limit: EVENT_REF_UPLOAD_MAX_FILES, received: files.length },
    );
  }

  const requestedGroup = str(body.group);
  if (requestedGroup !== undefined && !isUserAssignableGroup(requestedGroup)) {
    throw new GovernanceError(
      'REF_UPLOAD_GROUP_INVALID',
      `落点 Group「${requestedGroup}」非法：不能是绝对路径、不能含「..」、不能是保留根键`,
      { group: requestedGroup },
    );
  }
  const group = requestedGroup ?? defaultEventRefGroup(event);

  /**
   * 名额预检**必须在这里**（不是等 addRefs 抛）：`addRefs` 是整批校验全通过才写，
   * 那时文件早已入库 —— 用户会看到「上传失败」，库里却多出几篇没挂上事件的文档。
   */
  const existing = readRefs(scope, event.id);
  if (existing.length + files.length > REF_LIMIT) {
    throw new GovernanceError(
      'REF_LIMIT_EXCEEDED',
      `参考文档最多 ${REF_LIMIT} 篇（当前 ${existing.length} 篇，本次 ${files.length} 篇），请先清理或减少数量`,
      { limit: REF_LIMIT, current: existing.length, requested: files.length },
    );
  }

  const requestConfig = loadConfig();
  const importConfig = getScopeImportConfig(requestConfig, scope);
  const policy: UploadFilePolicy = {
    extensions: resolveImportExtensions(requestConfig, scope),
    assetExtensions: [...ASSET_EXTENSIONS],
    assetsEnabled: importConfig?.assets !== false,
    maxFileSizeBytes: importConfig?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE_BYTES,
    maxAssetSizeBytes: importConfig?.maxAssetSize ?? DEFAULT_MAX_ASSET_SIZE,
    // 需求：不能上传目录 —— 名字里带 `/` 或 `\` 一律拒（前端只给文件选择器，接口得自己守住）
    allowSubdirs: false,
  };

  const seen = new Set<string>();
  const accepted: { name: string; buf: Buffer }[] = [];
  const rejected: { name: string; error: string }[] = [];
  for (const f of files) {
    try {
      const v = validateUploadFile({ name: f.name, content: f.content }, policy, seen);
      seen.add(v.name);
      // 图片附件不是可引用文档：传了也会在列表里查无此文，不如当场拒
      if (v.isAsset) throw new Error('参考文档只接受文档文件，图片等附件请走「知识写入 → 上传导入」');
      accepted.push({ name: v.name, buf: v.buf });
    } catch (err) {
      rejected.push({ name: f.name ?? '(未命名)', error: (err as Error).message });
    }
  }
  if (accepted.length === 0) {
    throw new GovernanceError('REF_UPLOAD_INVALID_FILE', '所有文件都未通过校验', { files: rejected });
  }

  const {
    getUploadsRoot, bindUploadScope, writeUploadSession, createJob, runImportJob,
  } = await import('./mcp-http-api.js');

  /**
   * 暂存目录复用 `~/.ki/import-uploads/<uploadId>`（与网页上传同根、同命名）：
   * 导入结束后它会被登记为 group 的 `source.dir`（后续编辑/同步仍要读原文），
   * 因此**不能在导入完成后删掉**；TTL 清理见到会话里的 `jobId` 会跳过，与既有上传一致。
   */
  const uploadId = crypto.randomUUID();
  const dir = path.join(getUploadsRoot(), uploadId);
  fs.mkdirSync(dir, { recursive: true });
  if (!bindUploadScope(dir, scope)) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new GovernanceError('REF_UPLOAD_INVALID_FILE', '上传暂存目录与当前 scope 不匹配');
  }
  for (const f of accepted) fs.writeFileSync(path.join(dir, f.name), f.buf);

  const job = createJob(scope, 'import', requestConfig, {
    operator: { type: 'user', label: `事件 #${event.shortId} 参考文档上传` },
  });
  writeUploadSession(dir, { scope, updatedAt: Date.now(), state: 'importing', jobId: job.id });

  const bindEventId = event.id;
  const expected = accepted.length;
  const targets = accepted.map((f) => ({
    name: f.name,
    group: deriveGroupPath(group, f.name),
    relation: relationOfPath(f.name),
  }));

  /**
   * 后台串行：导入 → 建引用 → 写 `job.refsBinding`。
   * `runImportJob` 自己吞异常并落 job 终态（done / failed / cancelled），故这里只需看 `job.state`。
   */
  void (async () => {
    try {
      await runImportJob(job, {
        scope,
        sourceDir: dir,
        group,
        // D4：同名默认不覆盖；被 skip 的文档若已在库中，仍然是可引用的目标（下方按库内实际存在判）
        conflictMode: 'skip',
        // D3：事件页上传是「补证据」，不得在用户 wiki 目录凭空生成文件
        wikiWriteback: false,
      }, requestConfig);
    } catch (err) {
      // runImportJob 内部已落 job 终态；这里兜住"连终态都没落下"的极端情况
      job.state = 'failed';
      job.error = (err as Error).message;
    }

    const addedSkipped: string[] = [];
    const failed: { name: string; error: string }[] = rejected.map((r) => ({ name: r.name, error: r.error }));
    /**
     * 同名未覆盖的清单（`conflictMode: 'skip'`）：这些文档保持库中旧内容，
     * 引用指向的是旧版本 —— 不告诉用户，就会变成「传了新版却没生效」的悬案。
     */
    const skippedConflicts = (() => {
      const conflicts = (job.result as { conflicts?: Array<{ relation?: string; action?: string; skipReason?: string }> } | undefined)?.conflicts;
      if (!Array.isArray(conflicts)) return [] as string[];
      return [...new Set(
        conflicts
          .filter((c) => c.action === 'skip' && c.skipReason === 'same-name')
          .map((c) => c.relation ?? '')
          .filter(Boolean),
      )];
    })();
    let added = 0;
    try {
      // 现读一次分片：导入刚写完元数据，不读缓存对象（避免拿到上一步的快照）
      const caches = readAllGroupCaches(scope);
      for (const t of targets) {
        const inLib = caches.get(t.group)?.hot_relations.some((r) => r.text === t.relation) === true;
        if (!inLib) {
          failed.push({
            name: t.name,
            error: job.state === 'done' ? '导入未完成，文档未落库' : (job.error ?? '导入失败'),
          });
          continue;
        }
        try {
          // 逐篇加入：一篇被拒（已关联 / 被已收口事件锁定）不该连累其余文件
          const r = addRefs(scope, bindEventId, {
            docs: [{ group: t.group, name: t.relation }],
            addedBy: 'manual',
            ...(authScopes ? { tokenScopes: authScopes } : {}),
          });
          added += r.added;
          addedSkipped.push(...r.skipped);
        } catch (err) {
          failed.push({ name: t.name, error: (err as Error).message });
        }
      }
    } catch (err) {
      failed.push({ name: '(全部)', error: `建立引用失败：${(err as Error).message}` });
    }
    job.refsBinding = { added, skipped: addedSkipped, skippedConflicts, failed, expected };
  })();

  return sendJson(res, 202, {
    ok: true,
    scope,
    eventId: event.id,
    shortId: event.shortId,
    group,
    jobId: job.id,
    uploadId,
    refs: { limit: REF_LIMIT, current: existing.length },
    accepted: targets.map((t) => ({ name: t.name, group: t.group, relation: t.relation })),
    rejected,
    hint: rejected.length > 0
      ? `${accepted.length} 个文件已开始导入，${rejected.length} 个未通过校验（见 rejected）；导入完成后自动加入参考文档`
      : `${accepted.length} 个文件已开始导入，完成后自动加入参考文档`,
  });
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
          return sendJson(res, httpStatusFor(result.code), {
            ok: false,
            code: result.code,
            // 契约字段是 `error`：直接透出内部 `message` 会让前端拿到 undefined
            error: result.message,
            ...(result.details ? { details: result.details } : {}),
          });
        }
        if (result.summary.pending?.length) void scheduleConsume(scope);
        return sendJson(res, 200, { ok: true, scope, ...result.summary });
      }

      if (segs[1] === 'batch-apply' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const items = Array.isArray(b.items) ? (b.items as Record<string, unknown>[]) : [];
        const succeeded: unknown[] = [];
        const failed: unknown[] = [];
        // 批量里只要有一条产生了待补索引，循环结束后统一触发一次补齐
        // （单条 apply 是逐次触发；批量若漏了这句，改完分类的 pending 要等 daemon 重启才执行）
        let pendingAny = false;
        for (const item of items) {
          const result = await changeLifecycle({
            scope,
            group: String(item.group ?? ''),
            name: String(item.name ?? ''),
            lifecycle: str(item.lifecycle),
            ttlDays: num(pick(item, 'ttlDays', 'ttl_days')),
            eventId: str(pick(item, 'eventId', 'event')),
          }).catch((err: unknown) => ({ ok: false as const, code: (err as GovernanceError).code ?? 'UNKNOWN', message: (err as Error).message }));
          if (result.ok) {
            succeeded.push({ group: item.group, name: item.name, ...result.summary });
            if (result.summary.pending?.length) pendingAny = true;
          } else {
            failed.push({ group: item.group, name: item.name, code: result.code, error: result.message });
          }
        }
        if (pendingAny) void scheduleConsume(scope);
        return sendJson(res, 200, { ok: true, scope, succeeded: succeeded.length, failed, results: succeeded });
      }

      if (segs[1] === 'presets') {
        if (method === 'GET') {
          const scope = scopeFromQuery();
          const config = readGovernance(scope);
          return sendJson(res, 200, { ok: true, scope, presets: config.lifecyclePresets });
        }
        if (method === 'POST') {
          const b = await body();
          /**
           * scope 必须取**请求体**：页面把 scope 放 body 里，此前这里读 query
           * → 非 default 库新建的分类会静默写进 default 的 governance.json。
           */
          const scope = scopeFromBody(b);
          const config = readGovernance(scope);
          // 档位只允许 wiki / temp：event 预设无法表达"绑哪个事件"，落盘即契约外数据
          const kindCheck = validatePresetKind(str(b.kind) ?? 'temp');
          if (!kindCheck.ok) {
            return sendJson(res, 400, { ok: false, code: 'PRESET_KIND_INVALID', error: kindCheck.message });
          }
          const preset: LifecyclePreset = {
            id: str(b.id) ?? `preset_${Date.now().toString(36)}`,
            name: String(b.name ?? '').trim(),
            kind: kindCheck.kind,
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
          const scope = scopeFromQuery();
          const config = readGovernance(scope);
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
        const outcome = await createEventWithBinding(scope, {
          title: String(b.title ?? ''),
          ...(typeof b.description === 'string' ? { description: b.description } : {}),
          typeId: String(b.typeId ?? b.type_id ?? ''),
          ...(str(pick(b, 'stageKey', 'stage_key')) ? { stageKey: str(pick(b, 'stageKey', 'stage_key'))! } : {}),
          ...(Array.isArray(b.docs) ? { docs: b.docs as Array<{ group: string; name: string }> } : {}),
          ...(Array.isArray(b.refs) ? { refs: b.refs as Array<{ group: string; name: string }> } : {}),
          by: 'user',
        });
        // 索引补写是异步的：入队后立刻触发一次消费（失败由 attempts 保留重试）
        if (outcome.pending.length > 0) void scheduleConsume(scope);
        return sendJson(res, 201, {
          ok: true,
          scope,
          event: outcome.event,
          binding: outcome.binding,
          visibility: outcome.visibility,
          pending: outcome.pending,
          hint: buildBindingHint(outcome),
        });
      }

      const id = segs[1];
      if (id && method === 'GET' && !segs[2]) {
        const scope = scopeFromQuery();
        // 404 判定保持不变（错误码/状态码不动），找到后再走共用读取
        const found = findEventIn(readAllEvents(scope), id);
        if (!found) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
        /**
         * 读取逻辑与 MCP `ki_event_get` 共用 `loadEventDetail`（单一真源）。
         * 展示仍按本接口的**旧 DTO**：`event` 保持原形、`analysis.draft` 保留 candidates/steps、
         * `logs` 保留 eventId —— 前端详情页依赖这些字段，不能换成 MCP 的裁剪版。
         *
         * 两个易错点：
         *   · `analysisActive` 必须传真实值：`ZOMBIE_TIMEOUT_MS` 只有 2 分钟，一次分析常跑几分钟，
         *     恒传 false 会让正在跑的分析被归一成 failed，详情页误报"分析已中断"；
         *   · 上面已查过一次事件，若两次之间被删，`loadEventDetail` 会抛 EVENT_NOT_FOUND ——
         *     这里兜回同一个 404，不退化成 500。
         */
        let detail: ReturnType<typeof loadEventDetail>;
        try {
          detail = loadEventDetail(scope, found.id, { analysisActive: isAnalysisActive(scope, found.id) });
        } catch (err) {
          if (err instanceof GovernanceError && err.code === 'EVENT_NOT_FOUND') {
            return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          }
          throw err;
        }
        return sendJson(res, 200, {
          ok: true,
          scope,
          event: detail.event,
          members: detail.members.map((m) => ({ group: m.group, name: m.name })),
          logs: detail.logs,
          analysis: { draft: detail.analysis.draft, confirmed: detail.analysis.confirmed },
        });
      }

      if (id && method === 'PATCH' && !segs[2]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const event = await updateEvent(scope, id, {
          ...(typeof b.title === 'string' ? { title: b.title } : {}),
          ...(typeof b.description === 'string' ? { description: b.description } : {}),
          revision: num(b.revision) ?? -1,
        });
        return sendJson(res, 200, { ok: true, scope, event });
      }

      // ─── 事件源码分析（REQ-20261113-003 · S-03/S-04）───
      if (id && segs[2] === 'analyze' && method === 'POST' && !segs[3]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const started = await startEventAnalysis(scope, id, { forceOverwrite: b.forceOverwrite === true });
        return sendJson(res, started.reused ? 200 : 202, {
          ok: true,
          scope,
          eventId: started.doc.eventId,
          reused: started.reused,
          analysis: { draft: started.doc.draft, confirmed: started.doc.confirmed },
        });
      }

      // ─── 手动停止分析（2026-11-16 用户要求弹窗里有「停止」）───
      // 幂等：没在跑也返回 200 + canceled:false（按钮可能被点两次，不该报错）。
      // 返回的 draft 可能仍是 running —— 后台任务收到 abort 后才落终态，前端继续轮询即可。
      if (id && segs[2] === 'analysis' && segs[3] === 'cancel' && method === 'POST' && !segs[4]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const event = findEventIn(readAllEvents(scope), id);
        if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
        const canceled = cancelEventAnalysis(scope, event.id);
        const analysisDoc = readNormalizedAnalysisDoc(scope, event.id);
        return sendJson(res, 200, {
          ok: true,
          scope,
          eventId: event.id,
          canceled,
          analysis: { draft: analysisDoc.draft, confirmed: analysisDoc.confirmed },
        });
      }

      if (id && segs[2] === 'analysis') {
        /*
         * 追问（B2）：`/analysis/ask`
         * · POST 提问（knowledge.ask）；GET 读记录（knowledge.ask）；DELETE 清空（knowledge.write）
         * · 传了 runId 但与该事件当前草稿不符 → 409 REVISION_CONFLICT（避免"拿新结论回答老问题"）
         */
        /*
         * 追问流式通道（SSE）：`POST /analysis/ask/stream`
         * 与普通 POST 共用同一套闸门与落库，这里只把增量文本实时吐给前端。
         */
        if (method === 'POST' && segs[3] === 'ask' && segs[4] === 'stream' && !segs[5]) {
          const b = await body();
          const scope = scopeFromBody(b);
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          // SSE 必须立刻把响应头刷出去：否则前端要等到第一段正文才拿到 200，体感像"卡住"
          res.flushHeaders?.();
          res.socket?.setNoDelay?.(true);
          const send = (payload: unknown): void => { res.write(`data: ${JSON.stringify(payload)}\n\n`); };
          try {
            const passedRunId = str(b.runId);
            const currentRunId = readNormalizedAnalysisDoc(scope, event.id).draft?.runId ?? null;
            if (passedRunId && passedRunId !== currentRunId) {
              throw new GovernanceError('REVISION_CONFLICT', '分析结果已更新，请刷新后重新提问');
            }
            const result = await askEventAnalysis(scope, event as unknown as AskTargetEvent, {
              question: str(b.question) ?? '',
              onDelta: (text) => send({ type: 'delta', text }),
            });
            send({ type: 'done', turn: result.turn });
          } catch (err) {
            const ge = err instanceof GovernanceError ? err : null;
            send({
              type: 'error',
              ...(ge ? { code: ge.code } : {}),
              message: (err as Error).message || '追问失败',
            });
          } finally {
            res.end();
          }
          return true;
        }
        if (segs[3] === 'ask' && !segs[4]) {
          if (method === 'GET') {
            const scope = scopeFromQuery();
            const event = findEventIn(readAllEvents(scope), id);
            if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
            const doc = readAskDoc(scope, event.id);
            const onlyRun = str(q.get('runId'));
            const turns = onlyRun ? doc.turns.filter((t) => t.runId === onlyRun) : doc.turns;
            const activeRunId = readNormalizedAnalysisDoc(scope, event.id).draft?.runId ?? null;
            return sendJson(res, 200, {
              ok: true,
              scope,
              eventId: event.id,
              turns,
              total: turns.length,
              truncated: doc.turns.length > ASK_DOC_MAX_TURNS
                || Buffer.byteLength(JSON.stringify(doc.turns)) > ASK_DOC_MAX_BYTES,
              activeRunId,
            });
          }
          if (method === 'POST') {
            const b = await body();
            const scope = scopeFromBody(b);
            const event = findEventIn(readAllEvents(scope), id);
            if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
            const passedRunId = str(b.runId);
            const currentRunId = readNormalizedAnalysisDoc(scope, event.id).draft?.runId ?? null;
            if (passedRunId && passedRunId !== currentRunId) {
              throw new GovernanceError('REVISION_CONFLICT', '分析结果已更新，请刷新后重新提问');
            }
            const question = str(b.question) ?? '';
            const result = await askEventAnalysis(scope, event as unknown as AskTargetEvent, { question });
            return sendJson(res, 200, { ok: true, scope, eventId: event.id, turn: result.turn });
          }
          if (method === 'DELETE') {
            const scope = scopeFromQuery();
            const event = findEventIn(readAllEvents(scope), id);
            if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
            const cleared = await clearAskTurns(scope, event.id);
            return sendJson(res, 200, { ok: true, scope, eventId: event.id, cleared });
          }
        }
        if (method === 'GET' && !segs[3]) {
          const scope = scopeFromQuery();
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          const analysisDoc = readNormalizedAnalysisDoc(scope, event.id);
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: event.id,
            draft: analysisDoc.draft,
            confirmed: analysisDoc.confirmed,
          });
        }
        if (method === 'POST' && segs[3] === 'confirm' && !segs[4]) {
          const b = await body();
          const scope = scopeFromBody(b);
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          /*
           * 运行中禁止确认/丢弃：进度写盘里的 `candidates` 还是空的（候选只在终态汇总），
           * 此时确认 = 0 条写入 + 草稿被丢，而后台收尾的 `updateDraftIfMatch` 又因 runId
           * 不匹配直接 no-op —— 用户会看到「已停止/已完成」却什么都没留下。
           */
          if (isAnalysisRunning(scope, event.id)) {
            return sendJson(res, 409, {
              ok: false,
              code: 'ANALYSIS_ALREADY_RUNNING',
              error: '分析仍在进行中：请先「停止」或等待完成，再确认/丢弃草稿',
            });
          }
          const candidateIds = Array.isArray(b.candidateIds) ? b.candidateIds.map((x) => String(x)) : [];
          const outcome = await confirmDraftLocations(scope, event.id, {
            candidateIds,
            ...(str(b.expectedRunId) ? { expectedRunId: str(b.expectedRunId)! } : {}),
            discardDraft: b.discardDraft === true,
          });
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: event.id,
            added: outcome.added,
            draft: outcome.doc.draft,
            confirmed: outcome.doc.confirmed,
          });
        }
        if (method === 'DELETE' && segs[3] === 'draft' && !segs[4]) {
          const scope = scopeFromQuery();
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          if (isAnalysisRunning(scope, event.id)) {
            return sendJson(res, 409, {
              ok: false,
              code: 'ANALYSIS_ALREADY_RUNNING',
              error: '分析仍在进行中：请先「停止」或等待完成，再丢弃草稿',
            });
          }
          const doc = await discardAnalysisDraft(scope, event.id);
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: event.id,
            draft: doc.draft,
            confirmed: doc.confirmed,
          });
        }
        if (method === 'DELETE' && segs[3] === 'confirmed' && segs[4] && !segs[5]) {
          const scope = scopeFromQuery();
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          const doc = await removeConfirmedLocation(scope, event.id, segs[4]);
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: event.id,
            draft: doc.draft,
            confirmed: doc.confirmed,
          });
        }
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

      // ─── 关联文档（事件成员）───
      if (id && segs[2] === 'members') {
        if (method === 'POST' && !segs[3]) {
          const b = await body();
          const scope = scopeFromBody(b);
          const result = await bindMembers(scope, id, {
            docs: Array.isArray(b.docs) ? (b.docs as Array<{ group: string; name: string }>) : [],
            by: 'user',
          });
          if (result.pending.length > 0) void scheduleConsume(scope);
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: result.event.id,
            shortId: result.event.shortId,
            visibility: result.visibility,
            bound: result.bound,
            skipped: result.skipped,
            failed: result.failed,
            ...(result.visibilityFailed.length > 0 ? { visibilityFailed: result.visibilityFailed } : {}),
            pending: result.pending,
            hint: buildMemberHint(result),
          });
        }
        if (method === 'DELETE' && !segs[3]) {
          const scope = scopeFromQuery();
          const result = await unbindMember(scope, id, str(q.get('group')) ?? '', str(q.get('name')) ?? '');
          if (result.pending.length > 0) void scheduleConsume(scope);
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: result.event.id,
            removed: result.removed,
            lifecycle: result.lifecycle,
            visibility: result.visibility,
            pending: result.pending,
            hint: result.pending.length > 0
              ? '已解绑，文档恢复长期保留；索引补齐中（含组路径索引），数秒后可被语义检索'
              : '已解绑，文档恢复长期保留',
          });
        }
      }

      // ─── 参考文档 ───
      if (id && segs[2] === 'refs') {
        if (method === 'GET' && !segs[3]) {
          const scope = scopeFromQuery();
          return sendJson(res, 200, { ok: true, scope, ...listRefs(scope, id) });
        }
        /**
         * 「AI 查找」的结论（2026-11-19）：确认加入参考文档后落盘，刷新/换机仍可见。
         *
         * 为什么单独一个端点而不是塞进 refs 列表：它是**一次查找的注脚**，
         * 与 refs 数组的增删无关，读写时机也不同（确认时写、进页面时读）。
         *
         * 事件存在性**先校验再读写**（事件 #44）：否则任意 id 都能落一个孤儿
         * `events/<id>.refs.json`（事件列表里看不到它），读侧还会把「事件不存在」
         * 伪装成 `lastFind: null` —— 与同前缀 `GET /refs` 的 EVENT_NOT_FOUND 口径不一致。
         */
        if (segs[3] === 'find-summary') {
          if (method === 'GET') {
            const scope = scopeFromQuery();
            const event = mustFindEvent(scope, id);
            return sendJson(res, 200, { ok: true, scope, lastFind: readLastFind(scope, event.id) });
          }
          if (method === 'POST') {
            const b = await body();
            const scope = scopeFromBody(b);
            // 事件校验优先于参数校验：否则「id 打错」会被报成「summary 不能为空」
            const event = mustFindEvent(scope, id);
            const summary = (str(b.summary) ?? '').trim();
            if (!summary) {
              throw new GovernanceError('REF_UPLOAD_BAD_REQUEST', 'summary 不能为空');
            }
            const uncertainties = Array.isArray(b.uncertainties)
              ? b.uncertainties.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 8)
              : [];
            // 落盘用规范 id（`evt_…`）：`id` 段是调用方给的，不能直接当文件名
            saveLastFind(scope, event.id, {
              summary: summary.slice(0, 2000),
              ...(uncertainties.length > 0 ? { uncertainties } : {}),
              at: Date.now(),
            });
            return sendJson(res, 200, { ok: true });
          }
        }
        if (method === 'POST' && segs[3] === 'search') {
          const b = await body();
          const scope = scopeFromBody(b);
          /**
           * **该路由只出 AI 候选**（S-05 §3.2 五步）。
           *
           * 2026-11-15 前这里按 `query` 有无分流：有 query 走按名子串搜索 —— 这正是
           * 「AI 查找」把事件标题当搜索词、永远 0 命中的根因。现已拆开：
           * 手动按名搜索走 `GET /governance/docs/search`。
           */
          if (str(b.query)) {
            throw new GovernanceError(
              'REF_SEARCH_QUERY_UNSUPPORTED',
              '该接口只返回 AI 候选，不再接受 query；按名搜索请用 GET /governance/docs/search?scope=&q=',
              { hint: '/governance/docs/search' },
            );
          }
          /*
           * **只有模型通道**（REQ-20261118-004）：确定性 fast 通道已下线。
           *
           * 理由：不调模型的"AI 查找"实际是「关键词 + 向量检索」，与用户点开"AI"的预期不符；
           *      调用方不如自己 ki_search。`mode` 入参保留但**忽略**（旧前端发 fast 不报错，
           *      避免发版瞬间整页 400）。
           */
          /**
           * 检索范围：**[事件库] ∪ 配置里放开的额外库**，由服务端解析。
           * 前端不得传 targets —— 那等于把越权入口开放给浏览器（且它拿不到完整授权集）。
           */
          const kiCfg = loadConfig();
          const promptCfg = readPromptConfig(kiCfg).config;
          const { targets, skipped } = resolveFindTargets(scope, promptCfg.find, {
            tokenScopes: ctx.authScopes ?? [ALL_SCOPES],
            config: kiCfg,
          });
          {
            /**
             * 前端关闭弹窗时中止上游请求（一次深度查找可能跑几十秒，白跑既费额度也占并发）。
             * `close` 在正常响应完成后也会触发，故用 `writableEnded` 区分「提前断开」。
             */
            const abortCtl = new AbortController();
            const deepStartedAt = Date.now();
            /*
             * 客户端在响应写完前断开 = 要么用户关了弹窗，要么**网关先把这条长请求掐了**。
             * 两者从服务端看一模一样，所以这里记一条日志（含已耗时）：真实部署里
             * "深度查找总在 N 秒后失败但服务端没有错误"时，先看这条。
             */
            const onClose = (): void => {
              if (res.writableEnded) return;
              const elapsed = Date.now() - deepStartedAt;
              // 1s 内的断开基本是用户点了取消（没有诊断价值），只在"跑了一会儿才断"时记，避免刷屏
              if (elapsed > 1_000) {
                console.error(
                  `[governance/find] 响应前断开（用户取消或网关超时）：scope=${scope} event=${id} elapsed=${elapsed}ms`,
                );
              }
              abortCtl.abort();
            };
            req.once('close', onClose);
            /*
             * 流式模式（REQ-20261118-004 · 2026-11-19）：`?stream=1` 时用 SSE 把**过程**实时吐出去。
             * 不加这个时前端只能等到最后一次性渲染 —— 深度查找要 25~35s，面板整段时间是空白，
             * 用户会以为卡死（实测反馈）。
             *
             * 非流式分支保持原样：其他客户端 / 旧前端不受影响。
             */
            const wantStream = String(req.url ?? '').includes('stream=1');
            let sseStep: ((payload: unknown) => void) | null = null;
            if (wantStream) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              // SSE 必须立刻刷头：否则前端要等到第一条事件才拿到 200
              res.flushHeaders?.();
              res.socket?.setNoDelay?.(true);
              sseStep = (payload) => { res.write(`event: step\ndata: ${JSON.stringify(payload)}\n\n`); };
            }
            try {
              const deepResult = await runDeepFindAsSearchResult(scope, id, {
                targets,
                config: promptCfg.find ?? defaultFindConfig(),
                kiConfig: kiCfg,
                signal: abortCtl.signal,
                ...(sseStep ? { onProgress: (call: { name: string; args: Record<string, unknown>; ms: number; ok: boolean; round: number }) => sseStep?.({ ...call, label: findToolLabel(call.name) }) } : {}),
              });
              const payload = {
                ok: true,
                scope,
                ...deepResult,
                ...(skipped.length > 0 ? { skippedTargets: skipped } : {}),
              };
              if (sseStep) {
                res.write(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
                res.end();
                // 该路由处理器返回 boolean（true = 已处理），`return;` 在这里类型不合法
                return true;
              }
              return sendJson(res, 200, payload);
            } finally {
              req.removeListener('close', onClose);
            }
          }
          /*
           * 以下为**已下线**的确定性通道（REQ-20261118-004）。上面的模型通道恒 return，
           * 故这段不可达；保留一个版本便于回滚，下个版本连同 searchRefCandidates 一起删。
           */
          const result = await searchRefCandidates(
            scope,
            id,
            { search: searchAdapter },
            {
              targets,
              ...(num(b.topK) !== undefined ? { topK: num(b.topK) as number } : {}),
              ...(num(b.limit) !== undefined ? { limit: num(b.limit) as number } : {}),
              ...(num(b.threshold) !== undefined ? { threshold: num(b.threshold) as number } : {}),
            },
          );
          return sendJson(res, 200, {
            ok: true,
            scope,
            ...result,
            ...(skipped.length > 0 ? { skippedTargets: skipped } : {}),
          });
        }
        /**
         * 上传文件并挂为参考文档（REQ-20261118-001）。
         *
         * 必须排在通用 POST 之前分流：`refs/upload` 的 body 是 base64 文件（可达 13MB+），
         * 用本文件的无上限 `readJsonBody` 读它既慢也没有闸门。
         */
        if (method === 'POST' && segs[3] === 'upload') {
          const b = await readEventRefUploadBody(req);
          const scope = scopeFromBody(b);
          return await uploadEventRefDocs({ res, scope, eventRef: id, body: b, authScopes: ctx.authScopes });
        }
        if (method === 'POST' && !segs[3]) {
          const b = await body();
          const scope = scopeFromBody(b);
          const docs = Array.isArray(b.docs)
            ? (b.docs as Array<{ sourceScope?: string; group: string; name: string; score?: number }>)
            : [{ group: String(b.group ?? ''), name: String(b.name ?? '') }];
          const result = addRefs(scope, id, {
            docs,
            addedBy: (str(b.addedBy) as 'ai' | 'manual') ?? 'manual',
            // 跨库引用必须逐库鉴权（缺省不传 = 只允许事件库，由 addRefs 内部按 scope 归一）
            ...(ctx.authScopes ? { tokenScopes: ctx.authScopes } : {}),
          });
          return sendJson(res, 200, { ok: true, scope, ...result });
        }
        if (method === 'DELETE') {
          const scope = scopeFromQuery();
          removeRef(scope, id, {
            ...(str(q.get('sourceScope')) ? { sourceScope: str(q.get('sourceScope'))! } : {}),
            group: str(q.get('group')) ?? '',
            name: str(q.get('name')) ?? '',
          });
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
      // 带 eventId 时排除「该事件已关联 / 已加入参考文档」（R31），排除放服务端而非前端
      const eventId = str(q.get('eventId'));
      return sendJson(res, 200, {
        ok: true,
        scope,
        hits: searchDocsForAdd(scope, str(q.get('q')) ?? '', num(q.get('limit')) ?? 20, {
          ...(eventId ? { eventId } : {}),
        }),
      });
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
          : sendJson(res, httpStatusFor(outcome.code), { ok: false, scope, code: outcome.code, error: outcome.error });
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
      // 只遍历一次回收站目录：total 与实际条目必须来自同一份快照，否则两次数值可能不一致
      const trash = listTrash(scope, { limit: 200 });
      return sendJson(res, 200, {
        ok: true,
        scope,
        pending: { count: pendingCount(scope), items: listPending(scope) },
        failures,
        trash: {
          total: trash.total,
          /**
           * 正文缺失的条目（challenger C1）：`sizeBytes === 0` 意味着快照里没有正文，
           * 恢复只会写进空串。历史上因 `getLocalKbDir` 双 join 产生过一批，
           * 这里持续暴露，避免它们被误恢复成空文档。
           */
          emptyContent: trash.items
            .filter((item) => item.sizeBytes === 0)
            .map((item) => ({ group: item.group, name: item.name, dirName: item.dirName, reason: item.reason })),
          /** `emptyContent` 只扫最近 200 条（limit 上限），更老的条目可能未覆盖 */
          scanned: trash.items.length,
        },
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

/** 「AI 查找」过程区展示的工具名（与 deep-find-core 的映射保持一致） */
function findToolLabel(name: string): string {
  switch (name) {
    case 'ki_search': return '检索知识库';
    case 'ki_get_module_info': return '读取文档正文';
    case 'ki_group_list': return '查看知识树';
    case 'ki_tag_list': return '查看标签';
    default: return name;
  }
}
