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
import { resolveGovernanceTargets } from './governance-scope.js';
import {
  assertNotScopeView,
  isScopeViewWriteError,
  isScopeReadonlyError,
  scopeReadonlyBody,
} from './scope-policy.js';
import { listTypes, createType, updateType, deleteType } from './events/type-service.js';
import {
  listEvents, createEventWithBinding, updateEvent, transitionEvent, deleteEvent, reopenEvent, setEventPinned,
  type CreateEventOutcome,
} from './events/event-service.js';
// 列表响应形状的唯一组装点（返回类型绑契约 DTO，见 event-view.ts 头注释）
import { toEventListView } from './events/event-view.js';
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
  resetAnalysis,
  saveDraftEdits,
} from './events/analysis-store.js';
import {
  cancelEventAnalysis,
  forgetFinishedAnalysis,
  isAnalysisActive,
  listActiveAnalysisIds,
  readNormalizedAnalysisDoc,
  startEventAnalysis,
  listFinishedAnalysis,
} from './events/analysis-runner.js';
import { clearResume, hasResume } from './events/analysis-resume.js';
import {
  ASK_DOC_MAX_BYTES,
  ASK_DOC_MAX_TURNS,
  clearAskTurns,
  markAskProposalAccepted,
  readAskDoc,
  readAskRunning,
  removeAskFile,
} from './events/analysis-ask-store.js';
import {
  askEventAnalysis,
  listActiveAskIds,
  listFinishedAsks,
  type AskTargetEvent,
} from './events/analysis-ask-runner.js';
import {
  listTrash, readTrashSettings, writeTrashSettings, removeTrashItem, readTrashItem, isSafeTrashDirName,
} from './trash-store.js';
import { restoreAnyFromTrash, purgeExpired } from './trash-service.js';
import { withScopeWriteLock } from './scope-write-lock.js';
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
  /*
   * **响应头已发出时不能再写 JSON**（流式 / SSE 分支）。
   *
   * 二次 `writeHead` 会抛 `ERR_HTTP_HEADERS_SENT`，而这里处于请求处理器的 `catch` 里，
   * 该异常没有上层捕获 → `unhandledRejection` → **整个 daemon 退出**（实测复现，
   * 见 `.debug/find-stream-error-20261120/`）。流式分支已自行以事件下发错误，这里只需收尾。
   */
  if (res.headersSent) {
    console.error(`[governance] 响应头已发出后仍走了统一错误出口：${(err as Error)?.message ?? String(err)}`);
    if (!res.writableEnded) res.end();
    return;
  }
  if (err instanceof GovernanceError) {
    sendJson(res, httpStatusFor(err.code), {
      ok: false,
      code: err.code,
      error: err.message,
      ...(err.details ? { details: err.details } : {}),
    });
    return;
  }
  /*
   * 视图不是知识库：写操作必须给 409 + 可执行提示，而不是 500。
   *
   * 之前这里只认 GovernanceError，写锁抛出的 `ScopeViewWriteError` 被打成 500，
   * 前端只能显示「服务器错误」，用户看不出要切到具体库。
   */
  if (isScopeViewWriteError(err)) {
    sendJson(res, 409, {
      ok: false,
      code: 'VIEW_NOT_WRITABLE',
      error: err.message,
      view: err.view,
      members: err.members,
      action: err.action,
    });
    return;
  }
  if (isScopeReadonlyError(err)) {
    sendJson(res, 409, scopeReadonlyBody(err));
    return;
  }
  sendJson(res, 500, { ok: false, error: (err as Error).message });
}

/**
 * 单库的「文档 + 分类」列表（分类页数据源）。
 *
 * 视图模式下逐成员调用本函数再合并 —— 事件与阶段名是**库内**关系
 * （`rel.eventId` 只可能指向同库事件），所以每库各建一次索引即可，
 * 不存在「跨库合并事件」的问题。
 *
 * `lifecycleCounts` 与 `total` 统计的是**同一集合**（已应用 group / 关键字过滤）：
 * 分类页的 tab 计数必须随搜索变化，否则「搜出 3 篇、tab 仍写 128」。
 */
function buildDocsPayload(
  scope: string,
  groupFilter: string | undefined,
  keyword: string,
  now: number,
): {
  total: number;
  items: Record<string, unknown>[];
  lifecycleCounts: { all: number; wiki: number; temp: number; event: number };
} {
  // 事件与阶段名：列表要显示「#3 登录页白屏 · 排查中」，逐个查会变成 N+1
  const eventIndex = new Map(
    readAllEvents(scope).map((e) => [e.id, e] as const),
  );
  const typeStageNames = new Map<string, string>();
  for (const type of listTypes(scope)) {
    for (const stage of type.stages) typeStageNames.set(`${type.id}\u0000${stage.key}`, stage.name);
  }

  const items: Record<string, unknown>[] = [];
  const lifecycleCounts: { all: number; wiki: number; temp: number; event: number } = {
    all: 0, wiki: 0, temp: 0, event: 0,
  };
  for (const [group, doc] of readAllGroupCaches(scope)) {
    if (groupFilter && group !== groupFilter) continue;
    for (const rel of doc.hot_relations) {
      if (keyword && !rel.text.toLowerCase().includes(keyword)) continue;
      const lifecycle = resolveLifecycle(rel);
      const visibility = resolveVisibilityOfRelation(scope, rel).mode;
      lifecycleCounts.all += 1;
      lifecycleCounts[lifecycle.kind as 'wiki' | 'temp' | 'event'] += 1;
      items.push({
        /**
         * 条目所属物理库。**单库也带**：前端键统一为 `scope\0group\0name`，
         * 双形态同一套代码，不必为「是不是视图」写两条渲染分支。
         */
        scope,
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
  return { total: items.length, items, lifecycleCounts };
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

  /**
   * **只读**端点的 scope 解析：视图展开 + 全有或全无鉴权。
   *
   * 写端点必须继续用 {@link scopeFromQuery} / {@link scopeFromBody} 拿原始库名 ——
   * 视图名交给写锁里的 `assertNotScopeView` 去拒（`VIEW_NOT_WRITABLE`）。
   * 若在写侧也展开，视图下的「改分类」会静默落到第一个成员库。
   */
  const readTargets = (raw: string | undefined) =>
    resolveGovernanceTargets(loadConfig(), raw, { authScopes: ctx.authScopes });

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
          /*
           * 视图门禁：`writeGovernance` 走 `writeJson → walWrite`，后者会 `mkdirSync`，
           * 不拦就会在 `dataDir/<视图名>/` 建出幽灵库（视图本不落盘）。
           * 该端点不经 `withScopeWriteLock`，所以必须自己调。
           */
          assertNotScopeView(scope, 'governance-preset');
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
          // 同 POST：该端点不经写锁，视图名会直接落到 writeGovernance
          assertNotScopeView(scope, 'governance-preset');
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
        const targets = readTargets(str(q.get('scope')));
        if (targets.view) {
          const buckets: Array<{ scope: string; total?: number; error?: string }> = [];
          const types: Array<Record<string, unknown>> = [];
          for (const member of targets.members) {
            try {
              const list = listTypes(member);
              buckets.push({ scope: member, total: list.length });
              /*
               * `et_1/et_2/et_3` 每个库都有（内置类型 id 固定）—— 裸 id 合并必撞车，
               * 故补 `typeKey = scope:typeId`；前端下拉与筛选都用它。
               */
              for (const t of list) types.push({ ...t, scope: member, typeKey: `${member}:${t.id}` });
            } catch (err) {
              buckets.push({ scope: member, error: (err as Error).message });
            }
          }
          return sendJson(res, 200, {
            ok: true,
            scope: targets.requested,
            view: targets.view,
            members: targets.members,
            types,
            buckets,
            ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
            ...(targets.truncated ? { truncated: true } : {}),
          });
        }
        return sendJson(res, 200, { ok: true, scope: targets.requested, types: listTypes(targets.members[0]) });
      }
      if (method === 'POST' && !segs[1]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const type = await createType(scope, {
          name: String(b.name ?? ''),
          // hasOwnProperty 而非 str()：空串是合法输入（= 未描述），不能被当成「没传」
          ...(Object.prototype.hasOwnProperty.call(b, 'description') ? { description: b.description as string | null } : {}),
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
          // 三态：未传=不改 / 传空串=清除 / 传值=写入（见 type-service.normalizeTypeDescription）
          ...(Object.prototype.hasOwnProperty.call(b, 'description') ? { description: b.description as string | null } : {}),
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
        const targets = readTargets(str(q.get('scope')));
        const status = (str(q.get('status')) ?? 'open') as 'open' | 'closed' | 'all';
        const limit = num(q.get('limit')) ?? 20;
        const offset = num(q.get('offset')) ?? 0;
        const docsPreviewLimit = num(q.get('docsPreviewLimit')) ?? 3;
        const keyword = str(q.get('q'));
        /*
         * 置顶免疫开关（2026-11-19）：只在显式传 `includePinned=1` 时生效。
         * 默认关 —— MCP / 脚本走同一函数，它们要的是精确集合，不能被列表偏好污染。
         */
        const includePinned = q.get('includePinned') === '1' || q.get('includePinned') === 'true';
        /**
         * 类型筛选：视图下是 `<scope>:<typeId>` —— `et_1/et_2/et_3` 每个库都有，
         * 裸 id 会同时命中最外层的多库。不带冒号时按裸 id 对每库生效（兼容旧调用）。
         */
        const typeRaw = str(q.get('type'));
        const typeSep = typeRaw ? typeRaw.indexOf(':') : -1;
        const typeScope = typeRaw && typeSep > 0 ? typeRaw.slice(0, typeSep) : null;
        const typeId = typeRaw ? (typeSep > 0 ? typeRaw.slice(typeSep + 1) : typeRaw) : null;

        // 形状组装已抽到 events/event-view.ts（返回类型绑契约 DTO），这里不再本地拼

        if (targets.view) {
          const buckets: Array<{ scope: string; total?: number; error?: string }> = [];
          const merged: Array<{ scope: string; item: ReturnType<typeof listEvents>['items'][number] }> = [];
          let total = 0;
          /*
           * 类型筛选带库前缀时**只查那一个库**：否则其余库会带着「无类型筛选」的结果
           * 混进来，表现为「选了 A 库的类型，列表里却有 B 库的事件」。
           */
          const effectiveMembers = typeScope
            ? targets.members.filter((m) => m === typeScope)
            : targets.members;
          for (const member of effectiveMembers) {
            try {
              const r = listEvents(member, {
                status,
                ...(typeId ? { typeId } : {}),
                ...(keyword ? { q: keyword } : {}),
                limit,
                offset: 0,
                docsPreviewLimit,
                includePinned,
              });
              buckets.push({ scope: member, total: r.total });
              total += r.total;
              for (const item of r.items) merged.push({ scope: member, item });
            } catch (err) {
              // 单成员失败只污染自己的桶：一个库坏掉不该让整个事件页变空
              buckets.push({ scope: member, error: (err as Error).message });
            }
          }
          /*
           * 跨库重排：置顶区（pinnedAt 降序）在前、普通区按 updatedAt 降序 ——
           * 与单库 `listEvents` 同一套语义，否则合并后的顺序会与页面的
           * 「置顶分组 + 最近更新」两套排序打架。
           */
          merged.sort((a, b) => {
            const pa = a.item.event.pinnedAt ?? null;
            const pb = b.item.event.pinnedAt ?? null;
            if (pa !== null && pb !== null) return pb - pa;
            if (pa !== null) return -1;
            if (pb !== null) return 1;
            return b.item.event.updatedAt - a.item.event.updatedAt;
          });
          const page = merged.slice(offset, offset + limit);
          return sendJson(res, 200, {
            ok: true,
            scope: targets.requested,
            view: targets.view,
            members: targets.members,
            total,
            /*
             * 用**全量合计**判断，不用 merged.length：merged 只含各库前 `limit` 条，
             * 某库 total > limit 时会误报「没有更多」（47 条只加载 20 条却 hasMore=false）。
             */
            hasMore: offset + page.length < total,
            events: page.map(({ scope: member, item }) => toEventListView(item, member)),
            buckets,
            ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
            ...(targets.truncated ? { truncated: true } : {}),
          });
        }

        const result = listEvents(targets.members[0], {
          status,
          ...(typeId ? { typeId } : {}),
          ...(keyword ? { q: keyword } : {}),
          limit,
          offset,
          docsPreviewLimit,
          includePinned,
        });
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          total: result.total,
          hasMore: result.hasMore,
          events: result.items.map((item) => toEventListView(item, targets.members[0])),
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

      /*
       * 正在跑分析的事件 id 清单（2026-11-19）：事件列表行上的「分析中」标记。
       * 只读进程内 activeRuns，无磁盘 I/O，可以秒级轮询。
       */
      if (method === 'GET' && segs[1] === 'running' && !segs[2]) {
        const targets = readTargets(str(q.get('scope')));
        // 分析中的 id 是 `evt_…`（近似全局唯一），直接合并即可
        const ids = targets.members.flatMap((member) => listActiveAnalysisIds(member));
        /*
         * `finished`（2026-11-20）：最近结束的分析，供列表行显示「分析完成 / 分析失败」。
         * 与 `ids` 同源（进程内缓存，无磁盘 IO）—— 重启后为空，只是少一个提示，不会显示错状态。
         */
        const finished = targets.members.flatMap((member) => listFinishedAnalysis(member));
        /*
         * 追问的两类标记（2026-11-23）：与 `ids` / `finished` 同源（进程内 Map，无磁盘 IO）。
         * `asking` = 正在追问，`finishedAsks` = 刚结束（供「追问完成 / 追问失败」徽标）。
         */
        const asking = targets.members.flatMap((member) => listActiveAskIds(member));
        const finishedAsks = targets.members.flatMap((member) => listFinishedAsks(member));
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          ...(targets.view ? { view: targets.view } : {}),
          ids,
          finished,
          asking,
          finishedAsks,
        });
      }

      const id = segs[1];
      if (id && method === 'GET' && !segs[2]) {
        const targets = readTargets(str(q.get('scope')));
        let scope = targets.members[0];
        let found: { id: string } | null = null;
        if (targets.view) {
          /*
           * 视图下只接受 `evt_…`：`#N` 是各库独立的 shortId 计数（store.ts:81-84），
           * 跨库必然歧义 —— 猜库会把用户带到另一个库的另一个事件，属静默串数据。
           */
          if (!/^evt_/.test(id)) {
            // 路径段是 URL 编码的（`#1` → `%231`）：给人看的文案要解码，否则「%231」像乱码
            const shown = (() => { try { return decodeURIComponent(id); } catch { return id; } })();
            throw new GovernanceError(
              'EVENT_SCOPE_REQUIRED',
              `视图下打开事件详情请使用事件 id（evt_…）：「${shown}」是各库独立编号，跨库有歧义`,
              { view: targets.view, ref: shown },
            );
          }
          const hits: Array<{ scope: string; id: string }> = [];
          for (const member of targets.members) {
            const e = findEventIn(readAllEvents(member), id);
            if (e) hits.push({ scope: member, id: e.id });
          }
          if (hits.length === 0) {
            return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          }
          if (hits.length > 1) {
            // 同一 id 命中多个库 = 数据异常：明确拒绝，不静默取第一个
            throw new GovernanceError(
              'EVENT_SCOPE_REQUIRED',
              `事件 ${id} 在多个成员库中命中（${hits.map((h) => h.scope).join('、')}），请切到具体知识库查看`,
              { view: targets.view, scopes: hits.map((h) => h.scope) },
            );
          }
          scope = hits[0].scope;
          found = { id: hits[0].id };
        } else {
          // 404 判定保持不变（错误码/状态码不动），找到后再走共用读取
          const single = findEventIn(readAllEvents(scope), id);
          if (!single) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          found = { id: single.id };
        }
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
          /*
           * 视图下 `scope` 回填**事件所属库**而不是视图名：前端后续的 refs / analysis /
           * ask 请求都直接复用它，天然落到正确的库，不需要再判断"当前是不是视图"。
           */
          scope,
          ...(targets.view ? { view: targets.view, viewMembers: targets.members } : {}),
          event: detail.event,
          members: detail.members.map((m) => ({ group: m.group, name: m.name })),
          logs: detail.logs,
          analysis: {
            draft: detail.analysis.draft,
            confirmed: detail.analysis.confirmed,
            /*
             * 是否还有可继续的断点（2026-11-20）：只 stat 一个文件，代价可忽略。
             * 前端据此把「重新分析」换成「继续分析」—— 不能靠 status 猜，断点可能已过期或被清理。
             */
            resumeAvailable: hasResume(scope, detail.event.id),
          },
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
        const started = await startEventAnalysis(scope, id, {
          forceOverwrite: b.forceOverwrite === true,
          resume: b.resume === true,
        });
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
              onEvent: (progress) => send(progress),
            });
            /*
             * 结论补丁（S03 §3.5）：`done` **之前**下发，且带 `turnId` ——
             * 用户点「确认覆盖」时要用它回写 `.ask.json` 的 `proposalAccepted`（R-23）。
             * 旧前端忽略未知 type，天然向后兼容。
             */
            if (result.proposal) send({ type: 'proposal', turnId: result.turn.id, ...result.proposal });
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
            /*
             * 进行中的那一轮（2026-11-23 · #82）：追问是单次请求上的 SSE 流，
             * 切页 / 刷新会断开连接、前端内存态随之消失。把运行态一并下发，
             * 前端回来即可先展示「正在追答 + 半截答案」并轮询到落库。
             * 僵尸记录（进程被杀）由 readAskRunning 按过期处理并清掉。
             */
            const live = readAskRunning(scope, event.id);
            return sendJson(res, 200, {
              ok: true,
              scope,
              eventId: event.id,
              turns,
              total: turns.length,
              truncated: doc.turns.length > ASK_DOC_MAX_TURNS
                || Buffer.byteLength(JSON.stringify(doc.turns)) > ASK_DOC_MAX_BYTES,
              activeRunId,
              running: live
                ? {
                  question: live.question,
                  runId: live.runId,
                  startedAt: live.startedAt,
                  updatedAt: live.updatedAt,
                  answer: live.answer,
                  steps: live.steps,
                }
                : null,
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
        /*
         * 人工校正三块产物（2026-11-23 · REQ-20261123-001）：`PATCH /analysis` 整块提交。
         *
         * 三个刻意的取舍（设计 S01 §3.4 / D3）：
         *   · 字段**可省略**：只是"改一句位置理由"不必回传整条链（省略 = 不改该块）；
         *     前端仍按整块提交，因此正常情况下三块都带。
         *   · `conclusion: null` 与 `chain: []` 是**合法输入**（人工清空），
         *     不能当成"没传"——所以判据用 `hasOwnProperty` 而不是真值判断。
         *   · `expectedRunId: null` 表示"我期望此刻没有草稿"，与省略（不校验）不同。
         */
        if (method === 'PATCH' && !segs[3]) {
          const b = await body();
          const scope = scopeFromBody(b);
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(b, key);
          const confirmedRaw = b.confirmed;
          const confirmed = confirmedRaw && typeof confirmedRaw === 'object' && !Array.isArray(confirmedRaw)
            ? confirmedRaw as Record<string, unknown>
            : {};
          const doc = await saveDraftEdits(scope, event.id, {
            ...(has('expectedRunId')
              ? { expectedRunId: b.expectedRunId === null ? null : String(b.expectedRunId) }
              : {}),
            ...(has('conclusion') ? { conclusion: b.conclusion as string | null } : {}),
            ...(has('chain') ? { chain: b.chain } : {}),
            ...(has('unconfirmed') ? { unconfirmed: b.unconfirmed } : {}),
            ...(confirmed.add !== undefined ? { confirmedAdd: confirmed.add } : {}),
            ...(confirmed.update !== undefined ? { confirmedUpdate: confirmed.update } : {}),
          });
          /*
           * 采纳审计（S03 R-23）：**只在写盘成功后**标记 —— 失败时用户并没有采纳。
           * 标记失败不回滚主流程：审计字段不该让一次成功的覆盖变成 500。
           */
          const acceptedTurnId = str(b.acceptedProposalTurnId);
          if (acceptedTurnId) {
            await markAskProposalAccepted(scope, event.id, acceptedTurnId).catch((err: unknown) => {
              console.warn(`[analysis] 补丁采纳标记写入失败（忽略）：${(err as Error).message}`);
            });
          }
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: event.id,
            editedAt: doc.draft?.editedAt,
            draft: doc.draft,
            confirmed: doc.confirmed,
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
        /*
         * 整份重置（2026-11-23 · 用户要求「事件详情加一个重置 AI 分析的按钮」）：
         * 清空 `draft`（结论 / 因果链 / 未确认点 / 候选 / 过程）与 `confirmed[]`（已确认代码位置）。
         *
         * 与相邻的 `DELETE .../analysis/draft` 的区别：那个只丢草稿、**保留**已确认位置；
         * 这里两者都清，因此必须由前端给独立的第二次确认（不可恢复）。
         *
         * 除 `.analysis.json` 外还要收拾三处**附属产物**，否则会出现"清不干净"的表象：
         *   · `.analysis.resume.json`（断点）：中断态最长留 7 天 / 8MB；而且 draft 为空时
         *     resume 的 runId 守卫失效（`startEventAnalysis` 要求 `draft?.runId` 为真），
         *     后续带 `resume:true` 的请求可能续到一份过期上下文；
         *   · `.ask.json`（追问记录）：`AskBlock` 拉取不带 runId，不清会让下一轮分析把
         *     上一轮的问答与新结论同屏（问的是已经删掉的旧结论）；
         *   · 进程内 `finishedRuns`：列表行「分析失败」徽标不判已读，不清就常亮。
         *
         * 运行中一律拒（与 confirm / draft 同口径）：此时清掉 draft 会让后台收尾的
         * `updateDraftIfMatch` 因 runId 不匹配而 no-op —— 这一轮 LLM 白跑。
         */
        if (method === 'DELETE' && !segs[3]) {
          const scope = scopeFromQuery();
          const event = findEventIn(readAllEvents(scope), id);
          if (!event) return sendJson(res, 404, { ok: false, code: 'EVENT_NOT_FOUND', error: `事件 ${id} 不存在` });
          if (isAnalysisRunning(scope, event.id)) {
            return sendJson(res, 409, {
              ok: false,
              code: 'ANALYSIS_ALREADY_RUNNING',
              error: '分析仍在进行中：请先「停止」或等待完成，再重置分析',
            });
          }
          const doc = await resetAnalysis(scope, event.id);
          /*
           * 附属清理一律用**同步强删**（`clearResume` / `removeAskFile` 内部都吞掉 IO 异常）：
           * 主数据此时已经清完了，这里再抛（比如去抢写锁遇到 SCOPE_BUSY）只会让一次
           * 成功的重置表现为"失败"——用户看着报错、数据其实已经没了。
           * 与 `deleteEvent` 的清理口径一致（它也是 sync 强删 `.refs.json` / `.analysis.json`）。
           */
          clearResume(scope, event.id);
          removeAskFile(scope, event.id);
          forgetFinishedAnalysis(scope, event.id);
          return sendJson(res, 200, {
            ok: true,
            scope,
            eventId: event.id,
            draft: doc.draft,
            confirmed: doc.confirmed,
            resumeAvailable: false,
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

      /*
       * 置顶 / 取消置顶（2026-11-19）。幂等：已在目标态直接 200。
       * 缺省 `pinned=true`（POST 到 /pin 就是置顶），显式传 false 才取消 ——
       * 这样 curl 手敲一次不带 body 也能用。
       * 不要求 revision：置顶不是内容变更，不该被乐观锁挡（详见 setEventPinned 注释）。
       */
      if (id && segs[2] === 'pin' && method === 'POST' && !segs[3]) {
        const b = await body();
        const scope = scopeFromBody(b);
        const event = await setEventPinned(scope, id, b.pinned !== false);
        return sendJson(res, 200, {
          ok: true,
          scope,
          event,
          pinned: event.pinnedAt !== undefined,
          hint: event.pinnedAt !== undefined
            ? `已将事件 #${event.shortId}「${event.title}」置顶`
            : `已取消置顶事件 #${event.shortId}「${event.title}」`,
        });
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
            /**
             * 写一帧 SSE。两个护栏的依据不同（2026-11-20 实测）：
             * · `writableEnded`：已 `end()` 再写会以**异步 `error` 事件**抛
             *   `ERR_STREAM_WRITE_AFTER_END`，无监听器 → 进程退出；成功分支 `res.end()`
             *   之后若还有迟到的 progress 回调就会踩中，必须拦。
             * · `destroyed`：客户端断开后写只是被静默丢弃（不崩），这里提前拦掉省一次无意义写入。
             */
            const writeFrame = (frame: string): void => {
              if (res.destroyed || res.writableEnded) return;
              res.write(frame);
            };
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
              sseStep = (payload) => { writeFrame(`event: step\ndata: ${JSON.stringify(payload)}\n\n`); };
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
                writeFrame(`event: result\ndata: ${JSON.stringify(payload)}\n\n`);
                res.end();
                // 该路由处理器返回 boolean（true = 已处理），`return;` 在这里类型不合法
                return true;
              }
              return sendJson(res, 200, payload);
            } catch (err) {
              /*
               * **流式分支没有 HTTP 状态码可用**：200 + text/event-stream 在跑查找之前就发出去了，
               * 门禁失败（FIND_LLM_UNAVAILABLE / FIND_TIMEOUT / FIND_BUSY …）只能以事件下发。
               *
               * 不加这段时的实测后果（2026-11-20 复现）：错误冒到下面的统一出口 → 二次 writeHead
               * → ERR_HTTP_HEADERS_SENT → 未捕获 → daemon 退出；客户端只看到连接被掐断，
               * 面板显示「流式响应未返回结果（连接可能被中断）」，真实原因（超时 / 模型不可用）全丢。
               */
              if (!sseStep) throw err;
              const ge = err instanceof GovernanceError ? err : null;
              writeFrame(`event: error\ndata: ${JSON.stringify({
                ok: false,
                code: ge?.code ?? 'FIND_FAILED',
                error: (err as Error)?.message ?? String(err),
                ...(ge?.details ? { details: ge.details } : {}),
              })}\n\n`);
              res.end();
              return true;
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
      const targets = readTargets(str(q.get('scope')));
      const groupFilter = str(q.get('group'));
      const keyword = (str(q.get('q')) ?? '').toLowerCase();
      const limit = Math.min(Math.max(num(q.get('limit')) ?? 50, 1), 200);
      const offset = Math.max(num(q.get('offset')) ?? 0, 0);
      const now = Date.now();

      /**
       * 视图分支：逐成员读 → 合并 → 条目带 `scope`。
       *
       * 单成员失败只污染自己的桶（其余库照常返回）：一个库目录缺失
       * 不该让整页变成「加载失败」。
       */
      if (targets.view) {
        const buckets: Array<{ scope: string; total?: number; error?: string }> = [];
        const items: Record<string, unknown>[] = [];
        const lifecycleCounts = { all: 0, wiki: 0, temp: 0, event: 0 };
        let total = 0;
        for (const member of targets.members) {
          try {
            const payload = buildDocsPayload(member, groupFilter, keyword, now);
            buckets.push({ scope: member, total: payload.total });
            /*
             * 每库各取 `limit` 条后直接拼接，**不再按总条数二次截断**。
             *
             * 真机踩到的坑：第一库 211 篇 > limit 200 时，按总条数切片会让
             * 后面的成员库**一条都看不到** —— 而用户切视图恰恰是为了看各库。
             * 代价是响应最多 `members × limit` 条（12 × 200，已由 S-01 的成员上限兜住）。
             */
            items.push(...payload.items.slice(0, limit));
            total += payload.total;
            lifecycleCounts.all += payload.lifecycleCounts.all;
            lifecycleCounts.wiki += payload.lifecycleCounts.wiki;
            lifecycleCounts.temp += payload.lifecycleCounts.temp;
            lifecycleCounts.event += payload.lifecycleCounts.event;
          } catch (err) {
            buckets.push({ scope: member, error: (err as Error).message });
          }
        }
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          view: targets.view,
          members: targets.members,
          total,
          // 每库已各取 limit 条（见上面的注释）；视图下不支持跨库 offset 偏移
          items,
          lifecycleCounts,
          buckets,
          ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
          ...(targets.truncated ? { truncated: true } : {}),
        });
      }

      const payload = buildDocsPayload(targets.members[0], groupFilter, keyword, now);
      return sendJson(res, 200, {
        ok: true,
        scope: targets.requested,
        total: payload.total,
        items: payload.items.slice(offset, offset + limit),
        lifecycleCounts: payload.lifecycleCounts,
      });
    }

    // ─── 文档搜索（手动添加参考文档）────────────────────
    if (segs[0] === 'docs' && segs[1] === 'search' && method === 'GET') {
      const targets = readTargets(str(q.get('scope')));
      const keyword = str(q.get('q')) ?? '';
      const limit = num(q.get('limit')) ?? 20;
      // 带 eventId 时排除「该事件已关联 / 已加入参考文档」（R31），排除放服务端而非前端
      const eventId = str(q.get('eventId'));
      const opts = { ...(eventId ? { eventId } : {}) };

      if (targets.view) {
        const buckets: Array<{ scope: string; total?: number; error?: string }> = [];
        const hits: Array<Record<string, unknown>> = [];
        for (const member of targets.members) {
          try {
            const found = searchDocsForAdd(member, keyword, limit, opts);
            buckets.push({ scope: member, total: found.length });
            // 每条带来源库：同名文档在成员库里都可能存在，前端/脚本要能区分
            for (const h of found) hits.push({ ...h, scope: member } as unknown as Record<string, unknown>);
          } catch (err) {
            buckets.push({ scope: member, error: (err as Error).message });
          }
        }
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          view: targets.view,
          members: targets.members,
          hits,
          buckets,
          ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
          ...(targets.truncated ? { truncated: true } : {}),
        });
      }

      return sendJson(res, 200, {
        ok: true,
        scope: targets.requested,
        hits: searchDocsForAdd(targets.members[0], keyword, limit, opts),
      });
    }

    // ─── 回收站 ─────────────────────────────────────────
    if (segs[0] === 'trash') {
      if (method === 'GET' && !segs[1]) {
        const targets = readTargets(str(q.get('scope')));
        const reason = str(q.get('reason'));
        const limit = num(q.get('limit')) ?? 50;
        const offset = num(q.get('offset')) ?? 0;
        const query = {
          ...(reason ? { reason: reason as never } : {}),
          limit,
          offset,
        };

        /**
         * 视图分支：逐成员列回收站 → 合并。
         *
         * **不返回单一 `settings`**：各库保留天数可能不同，取哪个都是撒谎；
         * 视图下前端的设置入口本来就禁用（写请求 409）。
         */
        if (targets.view) {
          const buckets: Array<{ scope: string; total?: number; error?: string }> = [];
          const settingsByScope: Array<{ scope: string; settings: unknown }> = [];
          const items: Array<Record<string, unknown>> = [];
          let total = 0;
          for (const member of targets.members) {
            try {
              const result = listTrash(member, { ...query, offset: 0 });
              buckets.push({ scope: member, total: result.total });
              settingsByScope.push({ scope: member, settings: readTrashSettings(member) });
              // groupSnapshot 只在磁盘上有意义：下发前压成 docCount / groupCount（契约形状）
              items.push(...result.items.map(({ dir, groupSnapshot, ...rest }) => ({
                ...rest,
                ...(groupSnapshot
                  ? { docCount: groupSnapshot.docCount, groupCount: groupSnapshot.groups.length }
                  : {}),
              }) as unknown as Record<string, unknown>));
              total += result.total;
            } catch (err) {
              buckets.push({ scope: member, error: (err as Error).message });
            }
          }
          return sendJson(res, 200, {
            ok: true,
            scope: targets.requested,
            view: targets.view,
            members: targets.members,
            total,
            // 每库已各取 limit 条（与 /docs 同口径）；视图下不支持跨库 offset 偏移
            items,
            settingsByScope,
            buckets,
            ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
            ...(targets.truncated ? { truncated: true } : {}),
          });
        }

        const scope = targets.members[0];
        const result = listTrash(scope, query);
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          total: result.total,
          items: result.items.map(({ dir, groupSnapshot, ...rest }) => ({
            ...rest,
            ...(groupSnapshot
              ? { docCount: groupSnapshot.docCount, groupCount: groupSnapshot.groups.length }
              : {}),
          })),
          settings: readTrashSettings(scope),
        });
      }

      /*
       * 回收站条目正文（删除时的快照）。
       *
       * 为什么不能复用 `/api/doc/get`：文档进站时已从 KB 摘除（正文只剩 `.trash/…/content.md`），
       * doc/get 会直接 404「未匹配到有效路径」。这里读的是快照，不是知识库当前内容。
       *
       * `dirName` 必须过 `isSafeTrashDirName`：它是单段目录名，未校验时 `../` 会逃出
       * `.trash/`，把本端点变成「任意 content.md 读取」（事件 #80）。
       */
      if (segs[1] === 'content' && method === 'GET') {
        const scope = scopeFromQuery();
        const group = str(q.get('group')) ?? '';
        const dirName = str(q.get('dirName')) ?? str(q.get('dir_name')) ?? '';
        /*
         * group 自己也要判：`readTrashItem` 内部用 `safeGroupSegments` 兜底，
         * 但它是**抛错**（会被下面 catch 成 409「条目损坏」）—— 那是误报，
         * 非法 group 是请求错误（400），不是数据坏掉。
         *
         * ⚠ 这里**不能**用 `path.isAbsolute`：本函数顶部的 `const path = url.pathname…`
         * 把 `node:path` 模块遮蔽了（`path` 此刻是字符串）→ 调 `.isAbsolute` 直接 TypeError（500）。
         * 绝对路径用平台无关的字面判定（POSIX `/`、UNC `\\`、Windows 盘符）。
         */
        if (!group.trim()
          || /^[\\/]/.test(group)
          || /^[A-Za-z]:[\\/]/.test(group)
          || group.split(/[\\/]/).some((seg) => seg === '..' || seg === '.' || seg === '')) {
          return sendJson(res, 400, { ok: false, code: 'TRASH_BAD_GROUP', error: `非法的 Group 路径：${group}` });
        }
        if (!isSafeTrashDirName(dirName)) {
          return sendJson(res, 400, { ok: false, code: 'TRASH_BAD_DIRNAME', error: `非法的回收站条目名：${dirName}` });
        }
        let found: ReturnType<typeof readTrashItem>;
        try {
          found = readTrashItem(scope, group, dirName);
        } catch (err) {
          // meta.json 损坏：条目坏掉是既定事实，别报成 500（页面要能说清"这篇读不了"）
          return sendJson(res, 409, { ok: false, scope, code: 'TRASH_CORRUPTED', error: (err as Error).message });
        }
        if (!found) {
          return sendJson(res, 404, { ok: false, scope, code: 'TRASH_NOT_FOUND', error: '回收站条目不存在（可能已被恢复或彻底删除）' });
        }
        if (found.item.kind === 'group') {
          return sendJson(res, 400, {
            ok: false, scope, code: 'TRASH_GROUP_NO_CONTENT',
            error: '分组条目没有单篇正文，请先「恢复整组」再从知识库查看',
          });
        }
        return sendJson(res, 200, {
          ok: true,
          scope,
          group,
          dirName,
          name: found.item.name,
          content: found.content,
          // 空串不是错误：正文缺失的历史条目照样能点开，页面据 empty 给「快照里没有正文」的说明
          empty: found.content.length === 0,
          sizeBytes: found.item.sizeBytes,
          hasAssets: found.item.hasAssets,
          reason: found.item.reason,
          deletedAt: found.item.deletedAt,
          expiresAt: found.item.expiresAt,
          ttlDays: found.item.ttlDays,
        });
      }

      if (segs[1] === 'restore' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        const group = String(b.group ?? '');
        const dirName = String(b.dirName ?? b.dir_name ?? '');
        /*
         * 纵深防御：视图下回收站列表恒为空，正常入口点不到「恢复」；
         * 但直接调 API 仍可能带视图名。视图不是库，一律拒。
         */
        assertNotScopeView(scope, 'trash-restore');
        // 目录名来自请求体，未校验时 `../` 会落到 `.trash/` 之外（事件 #80）
        if (!isSafeTrashDirName(dirName)) {
          return sendJson(res, 400, { ok: false, scope, code: 'TRASH_BAD_DIRNAME', error: `非法的回收站条目名：${dirName}` });
        }
        /*
         * 必须持 scope 写锁（REQ-20261123-005 · S04）：组恢复要写树 + N 篇 KB + N 份分片，
         * 与并发写入强冲突；文档恢复一并纳入（行为不变，只是并发时排队）。
         * 分派在 `restoreAnyFromTrash` 里按条目 kind 走，端点与坐标都不变。
         */
        const outcome = await withScopeWriteLock(scope, 'trash-restore', async () => restoreAnyFromTrash({
          scope,
          group,
          dirName,
          ...(str(b.targetLifecycle) ? { targetLifecycle: str(b.targetLifecycle) as 'wiki' | 'temp' } : {}),
        }));
        return outcome.ok
          ? sendJson(res, 200, { ...outcome, scope })
          : sendJson(res, httpStatusFor(outcome.code), { ok: false, scope, code: outcome.code, error: outcome.error });
      }

      if (segs[1] === 'purge' && method === 'POST') {
        const b = await body();
        const scope = scopeFromBody(b);
        assertNotScopeView(scope, 'trash-purge');
        const group = String(b.group ?? '');
        const dirName = String(b.dirName ?? b.dir_name ?? '');
        /*
         * ⚠ 这一处曾可删宿主机任意目录（事件 #80）：`removeTrashItem` 内部先 existsSync
         * 再 `rmSync(recursive)`，而 `path.join` 会把 `../../` 归一化掉。
         */
        if (!isSafeTrashDirName(dirName)) {
          return sendJson(res, 400, { ok: false, scope, code: 'TRASH_BAD_DIRNAME', error: `非法的回收站条目名：${dirName}` });
        }
        const removed = removeTrashItem(scope, group, dirName);
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
          // 与 presets 同因：回收站设置也走 writeGovernance（walWrite 会建目录），不经写锁
          assertNotScopeView(scope, 'trash-settings');
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
      const targets = readTargets(str(q.get('scope')));
      /** 诊断文件损坏时按空处理：诊断页不能因为一个坏文件打不开 */
      const readFailures = (s: string): FailureFile => {
        try {
          const raw = readJson<FailureFile>(failureFilePath(s));
          if (raw && Array.isArray(raw.items)) return raw;
        } catch { /* 损坏即空 */ }
        return { version: 1, items: [] };
      };

      if (targets.view) {
        const buckets: Array<Record<string, unknown>> = [];
        const pendingItems: Array<Record<string, unknown>> = [];
        const failureItems: Array<Record<string, unknown>> = [];
        const emptyContent: Array<Record<string, unknown>> = [];
        let pendingTotal = 0;
        let trashTotal = 0;
        let scanned = 0;
        for (const member of targets.members) {
          try {
            const failures = readFailures(member);
            // 只遍历一次回收站目录：total 与实际条目必须来自同一份快照
            const trash = listTrash(member, { limit: 200 });
            const pending = { count: pendingCount(member), items: listPending(member) };
            buckets.push({ scope: member, pending: pending.count, failures: failures.items.length, trash: trash.total });
            pendingTotal += pending.count;
            for (const i of pending.items) pendingItems.push({ ...i, scope: member } as unknown as Record<string, unknown>);
            for (const i of failures.items) failureItems.push({ ...i, scope: member } as unknown as Record<string, unknown>);
            trashTotal += trash.total;
            scanned += trash.items.length;
            // 只对 doc 条目判「正文缺失」：空组快照本来就没有正文，否则每次诊断都报假告警
            for (const item of trash.items.filter((i) => i.kind !== 'group' && i.sizeBytes === 0)) {
              emptyContent.push({ scope: member, group: item.group, name: item.name, dirName: item.dirName, reason: item.reason });
            }
          } catch (err) {
            buckets.push({ scope: member, error: (err as Error).message });
          }
        }
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          view: targets.view,
          members: targets.members,
          pending: { count: pendingTotal, items: pendingItems },
          failures: { version: 1, items: failureItems },
          trash: { total: trashTotal, emptyContent, scanned },
          buckets,
          ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
          ...(targets.truncated ? { truncated: true } : {}),
        });
      }

      const scope = targets.members[0];
      // 只遍历一次回收站目录：total 与实际条目必须来自同一份快照，否则两次数值可能不一致
      const trash = listTrash(scope, { limit: 200 });
      return sendJson(res, 200, {
        ok: true,
        scope: targets.requested,
        pending: { count: pendingCount(scope), items: listPending(scope) },
        failures: readFailures(scope),
        trash: {
          total: trash.total,
          /**
           * 正文缺失的条目（challenger C1）：`sizeBytes === 0` 意味着快照里没有正文，
           * 恢复只会写进空串。历史上因 `getLocalKbDir` 双 join 产生过一批，
           * 这里持续暴露，避免它们被误恢复成空文档。
           */
          emptyContent: trash.items
            // 组条目排除在外：空组快照本来就没有正文，不该被当成「坏条目」
            .filter((item) => item.kind !== 'group' && item.sizeBytes === 0)
            .map((item) => ({ group: item.group, name: item.name, dirName: item.dirName, reason: item.reason })),
          /** `emptyContent` 只扫最近 200 条（limit 上限），更老的条目可能未覆盖 */
          scanned: trash.items.length,
        },
      });
    }

    if (segs[0] === 'counts' && method === 'GET') {
      const targets = readTargets(str(q.get('scope')));
      const sum = { docs: 0, eventsOpen: 0, eventsClosed: 0, trash: 0, pendingIndex: 0 };

      // 视图分支：逐成员累加。侧栏 badge 与分类页头部同源，两处口径不能各算一套。
      if (targets.view) {
        const buckets: Array<Record<string, unknown>> = [];
        for (const member of targets.members) {
          try {
            let docs = 0;
            for (const [, doc] of readAllGroupCaches(member)) docs += doc.hot_relations.length;
            const events = readAllEvents(member);
            const row = {
              scope: member,
              docs,
              eventsOpen: events.filter((e) => e.closedAt === null).length,
              eventsClosed: events.filter((e) => e.closedAt !== null).length,
              trash: listTrash(member).total,
              pendingIndex: pendingCount(member),
            };
            buckets.push(row);
            sum.docs += row.docs;
            sum.eventsOpen += row.eventsOpen;
            sum.eventsClosed += row.eventsClosed;
            sum.trash += row.trash;
            sum.pendingIndex += row.pendingIndex;
          } catch (err) {
            // 单成员失败只降级自己：侧栏宁可少一个库的数字，也不要整块变 0
            buckets.push({ scope: member, error: (err as Error).message });
          }
        }
        return sendJson(res, 200, {
          ok: true,
          scope: targets.requested,
          view: targets.view,
          members: targets.members,
          ...sum,
          buckets,
          ...(targets.skipped.length > 0 ? { skipped: targets.skipped } : {}),
          ...(targets.truncated ? { truncated: true } : {}),
        });
      }

      const scope = targets.members[0];
      let docs = 0;
      for (const [, doc] of readAllGroupCaches(scope)) docs += doc.hot_relations.length;
      const events = readAllEvents(scope);
      return sendJson(res, 200, {
        ok: true,
        scope: targets.requested,
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
