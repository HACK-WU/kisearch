/**
 * vector-client.ts —— Vector Adapter（S-03）
 *
 * 替换 scripts/lib/mem-client.ts：封装 ZvecEngine 基座（worker proxy），
 * 为 CLI / MCP 提供 async 语义检索 / 存储接口。
 *
 * 设计要点（与 zvec-probe-node / S-03 对齐）：
 *   - 单一 collection（config.vectorDir），scope/tag 以标量字段过滤隔离
 *   - tag：单值 STRING 字段，写入时统一转小写（实现 D2「== 忽略大小写」）
 *   - scope：单值 STRING 字段，一 doc 一个 scope，查询按 scope 过滤
 *   - doc id = sha256(text + scope) 截 32（S-03 generateDocId，幂等 upsert）
 *   - 检索走 hybridSearch（queryText 语义 + fts 关键词 + RRF，KiSearch 召回主路径）
 *   - content 字段兼作 FTS 字段（jieba 分词）
 */

import { createHash } from 'crypto';
import {
  ZvecEngine,
  SiliconFlowProvider,
  CollectionLockedException,
  type Hit,
  type Filter,
  type ZvecEngineConfig,
  type ZvecEngineOpenConfig,
} from '../../dist/zvec-engine/index.js';
import { loadConfig, getVectorDir, getEmbeddingConfig, resolveScope } from './config.js';
import { validateScope } from './scope.js';

// ─── 公开类型（对齐 mem-client 返回结构，便于上层平滑替换） ───

export interface VectorSearchResult {
  memoryId: string;    // = zvec Hit.id（doc id，sha256(text+scope) 截 32）
  content: string;
  score: number;       // 越大越相关（基座已归一化）
  tag?: string;
}

export interface VectorStoreResult {
  docId: string;       // = doc id（Hit.id 同构）
}

export interface BulkStoreItemResult {
  index: number;
  memoryId?: string;
  success: boolean;
  error?: string;
}

export interface VectorBulkStoreResult {
  total: number;
  succeeded: number;
  failed: number;
  results: BulkStoreItemResult[];
}

export interface VectorAvailableResult {
  available: boolean;
  reason?: string;
  /** 不可用原因码（NEG-10：便于上层区分占用/损坏/异常） */
  code?: 'LOCKED' | 'CORRUPTED' | 'PROBE_ERROR';
}

/**
 * 向量库被占用时的可操作处置提示（NEG-10）。
 */
function lockedHint(dbPath: string): string {
  return (
    `向量库被其他进程占用（${dbPath}）。\n` +
    `  处置方式：\n` +
    `  1) 若有 ki mcp/server 常驻进程在运行，请先停止它；\n` +
    `  2) 确认无其他 ki 命令正在写入（并发写会互斥）；\n` +
    `  3) 若进程已异常退出，锁会在片刻后自动释放，可稍后重试`
  );
}

export interface VectorDocInfo {
  docId: string;
  scope?: string;
  tag?: string;
  content: string;
}

export interface VectorTagInfo {
  tag: string;
  count: number;
}

// ─── 常量 ───

const COLLECTION_NAME = 'kisearch';
const DENSE_FIELD = 'dense';
const FTS_FIELD = 'content';
const TAG_FIELD = 'tag';
const SCOPE_FIELD = 'scope';
const DEFAULT_TAG = 'ki-search';
const MAX_TEXT_LENGTH = 50_000;

// ─── Engine 单例（进程内缓存） ───

let _enginePromise: Promise<ZvecEngine> | null = null;

/**
 * 规范化 tag：转小写（D2「== 忽略大小写」靠写入/查询双侧小写化实现）
 */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * 生成 doc id：sha256(text + scope) 截 32（S-03 generateDocId）
 */
function generateDocId(text: string, scope: string): string {
  return createHash('sha256').update(text + scope).digest('hex').slice(0, 32);
}

/**
 * 构建 embedding provider（从 config.embedding）
 */
function buildEmbedding(): SiliconFlowProvider {
  const config = loadConfig();
  const emb = getEmbeddingConfig(config);
  // apiKey 必须来自配置（明文或 ${ENV_VAR} 已在 loadConfig 解析）。
  // 不做任何隐式 env 回退：提供商可经 baseURL 自由配置，若回退到某个固定厂商
  // 的密钥变量（如 SILICONFLOW_API_KEY），在非该厂商 baseURL 下会注入错误密钥。
  // 缺失即 fail-loud（与 provider 无密钥时的构造报错行为一致，getEngine 同步抛出）。
  if (!emb.apiKey) {
    throw new Error(
      'embedding.apiKey 未配置：请在配置文件的 embedding.apiKey 填写明文密钥，'
      + '或用 ${VAR_NAME} 引用环境变量',
    );
  }
  return new SiliconFlowProvider({
    baseURL: emb.baseURL,
    model: emb.model,
    dimension: emb.dimension,
    apiKey: emb.apiKey,
  });
}

/**
 * 构建 create/open 配置
 */
function buildCreateConfig(): ZvecEngineConfig {
  const config = loadConfig();
  const emb = getEmbeddingConfig(config);
  return {
    dbPath: getVectorDir(config),
    collection: {
      name: COLLECTION_NAME,
      denseField: DENSE_FIELD,
      dimension: emb.dimension,
      metric: 'COSINE',
      scalarFields: [
        { name: TAG_FIELD, dataType: 'STRING', indexed: true },
        { name: SCOPE_FIELD, dataType: 'STRING', indexed: true },
        { name: FTS_FIELD, dataType: 'STRING' },
      ],
      fts: {
        field: FTS_FIELD,
        tokenizer: 'jieba',
      },
    },
    embedding: buildEmbedding(),
  };
}

function buildOpenConfig(): ZvecEngineOpenConfig {
  const config = loadConfig();
  return {
    dbPath: getVectorDir(config),
    collectionName: COLLECTION_NAME,
    embedding: buildEmbedding(),
  };
}

/**
 * 获取（或创建/打开）进程内唯一的 ZvecEngine 实例。
 * 首次：dbPath 不存在 → create；已存在 → open。
 * 若已被其他进程持锁（如 ki mcp/server 常驻），直接抛 CollectionLockedException，
 * 避免 open 撞锁时挂起/抛出不可读的底层错误（MCP 路径未走 ensureVectorAvailable 时的兵底）。
 */
export function getEngine(): Promise<ZvecEngine> {
  if (!_enginePromise) {
    const createCfg = buildCreateConfig();
    _enginePromise = (async () => {
      const exists = await ZvecEngine.probe(createCfg.dbPath);
      if (exists.locked) {
        throw new CollectionLockedException(lockedHint(createCfg.dbPath));
      }
      if (!exists.exists) {
        return ZvecEngine.create(createCfg);
      }
      return ZvecEngine.open(buildOpenConfig());
    })();
    // 失败时重置缓存，允许下次重试
    _enginePromise.catch(() => { _enginePromise = null; });
  }
  return _enginePromise;
}

/**
 * 关闭 engine（terminate worker + 释放 LOCK）并重置缓存。
 * CLI per-call 命令结束时必须调用，否则 worker 线程持引用导致进程无法退出。
 */
export async function closeEngine(): Promise<void> {
  if (_enginePromise) {
    try {
      const engine = await _enginePromise;
      await engine.close();
    } catch { /* ignore */ }
    _enginePromise = null;
  }
}

/** 测试用别名（等价 closeEngine） */
export const resetEngine = closeEngine;

// ─── 可用性检测（替代 ensureMemAvailable） ───

/**
 * 检测向量服务是否可用。
 * - dbPath 不存在 → 可用（首次 store 会 create）
 * - 被其他进程持锁 → 不可用（提示）
 * - 损坏 → 不可用（提示重建）
 */
export async function ensureVectorAvailable(): Promise<VectorAvailableResult> {
  const config = loadConfig();
  const dbPath = getVectorDir(config);
  try {
    const probe = await ZvecEngine.probe(dbPath);
    if (probe.locked) {
      return {
        available: false,
        reason: lockedHint(dbPath),
        code: 'LOCKED',
      };
    }
    if (probe.exists && !probe.healthy) {
      return {
        available: false,
        reason: `向量库损坏（${dbPath}），建议执行 ki restore <scope> --from-snapshot 重建`,
        code: 'CORRUPTED',
      };
    }
    return { available: true };
  } catch (err) {
    if (err instanceof CollectionLockedException) {
      return { available: false, reason: lockedHint(dbPath), code: 'LOCKED' };
    }
    return { available: false, reason: `向量服务检测异常: ${(err as Error).message}`, code: 'PROBE_ERROR' };
  }
}

// ─── 检索（替代 memSearch） ───

/**
 * 语义检索（hybrid：语义 + FTS 关键词 + RRF），按 scope + tag 过滤。
 */
export async function vectorSearch(params: {
  scope: string;
  query: string;
  limit?: number;
  tags?: string;        // 单 tag（默认 ki-search）；忽略大小写
  threshold?: number;
}): Promise<VectorSearchResult[]> {
  const scope = resolveScope(loadConfig(), params.scope);
  const engine = await getEngine();
  const tag = normalizeTag(params.tags ?? DEFAULT_TAG);

  const filter: Filter = {
    and: [
      { field: SCOPE_FIELD, op: '==', value: scope },
      { field: TAG_FIELD, op: '==', value: tag },
    ],
  };

  const hits: Hit[] = await engine.hybridSearch({
    queryText: params.query,
    fts: params.query,
    topk: params.limit ?? 10,
    filter,
  });

  return hits
    .map((h) => ({
      memoryId: h.id,
      content: h.text ?? String(h.fields?.[FTS_FIELD] ?? ''),
      score: h.score,
      tag: h.fields?.[TAG_FIELD] !== undefined ? String(h.fields[TAG_FIELD]) : undefined,
    }))
    .filter((r) => params.threshold === undefined || r.score >= params.threshold);
}

// ─── 存储（替代 memStore / memBulkStore） ───

/**
 * 存储单条文本（幂等 upsert）。
 */
export async function vectorStore(params: {
  scope: string;
  text: string;
  tags?: string;
  keywords?: string[];
}): Promise<VectorStoreResult> {
  if (params.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text 超过 ${MAX_TEXT_LENGTH} 字符限制（当前 ${params.text.length}）`);
  }

  const scope = resolveScope(loadConfig(), params.scope);
  const engine = await getEngine();
  const tag = normalizeTag(params.tags ?? DEFAULT_TAG);

  // 关键词追加到 text 末尾（与 mem 行为一致，提升召回）
  const fullText = params.keywords?.length
    ? `${params.text}\n\n[关键词] ${params.keywords.join(', ')}`
    : params.text;

  const docId = generateDocId(fullText, scope);
  const result = await engine.upsert([{
    id: docId,
    text: fullText,
    fields: { [TAG_FIELD]: tag, [SCOPE_FIELD]: scope },
  }]);

  if (result.failed > 0) {
    const reason = result.errors?.[0]?.reason ?? 'unknown';
    throw new Error(`向量存储失败: ${reason}`);
  }
  return { docId };
}

/**
 * 批量存储（幂等 upsert）。
 */
export async function vectorBulkStore(params: {
  scope: string;
  entries: { text: string; tags?: string; keywords?: string[] }[];
}): Promise<VectorBulkStoreResult> {
  if (params.entries.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  const scope = resolveScope(loadConfig(), params.scope);
  const engine = await getEngine();

  const docs = params.entries.map((e) => {
    const tag = normalizeTag(e.tags ?? DEFAULT_TAG);
    const fullText = e.keywords?.length
      ? `${e.text}\n\n[关键词] ${e.keywords.join(', ')}`
      : e.text;
    return {
      id: generateDocId(fullText, scope),
      text: fullText,
      fields: { [TAG_FIELD]: tag, [SCOPE_FIELD]: scope },
    };
  });

  const result = await engine.upsert(docs);

  // 组装逐项结果（WriteResult.errors 按 doc id 定位）
  const errorById = new Map<string, string>();
  for (const e of result.errors ?? []) {
    errorById.set(e.id, e.reason);
  }
  const results: BulkStoreItemResult[] = docs.map((d, i) => {
    const err = errorById.get(d.id);
    return err
      ? { index: i, success: false, error: err }
      : { index: i, memoryId: d.id, success: true };
  });

  return {
    total: params.entries.length,
    succeeded: result.ok,
    failed: result.failed,
    results,
  };
}

// ─── 删除（供 sync-relation / delete-relation 后续使用） ───

/**
 * 按 doc id 删除。
 */
export async function vectorDelete(params: {
  scope: string;
  ids: string[];
}): Promise<{ deleted: number; errors: { id: string; reason: string }[] }> {
  // strict 档下校验 scope（删除按 doc id 全局定位，scope 仅用于护栏一致性）
  resolveScope(loadConfig(), params.scope);
  const engine = await getEngine();
  const result = await engine.delete(params.ids);
  return {
    deleted: result.ok,
    errors: (result.errors ?? []).map((e) => ({ id: e.id, reason: e.reason })),
  };
}

// ─── 管理面（scope / doc 命令；绕过 strict 白名单，仅做字符校验） ───
//
// 注意：管理命令需能操作"未注册但向量层有数据"的 scope，故这些函数一律用
// validateScope（仅字符安全）而非 resolveScope（会按 strict 白名单拒绝）。

const LIST_ALL_LIMIT = 10_000;

/**
 * 构建 scope + tag 过滤：scope 必等；tags 非空时多 tag 以 OR 组合。
 * tags 为空/未传 → 不按 tag 过滤（覆盖该 scope 下全部 tag）。
 */
function buildScopeTagFilter(scope: string, tags?: string[]): Filter {
  const scopeCond: Filter = { field: SCOPE_FIELD, op: '==', value: scope };
  const cleaned = (tags ?? []).map((t) => normalizeTag(t)).filter((t) => t.length > 0);
  if (cleaned.length === 0) return scopeCond;
  const tagConds: Filter[] = cleaned.map((t) => ({ field: TAG_FIELD, op: '==', value: t }));
  const tagFilter: Filter = tagConds.length === 1 ? tagConds[0] : { or: tagConds };
  return { and: [scopeCond, tagFilter] };
}

function toDocInfo(d: { id: string; text?: string; fields?: Record<string, unknown> }): VectorDocInfo {
  return {
    docId: d.id,
    scope: d.fields?.[SCOPE_FIELD] !== undefined && d.fields?.[SCOPE_FIELD] !== null ? String(d.fields[SCOPE_FIELD]) : undefined,
    tag: d.fields?.[TAG_FIELD] !== undefined ? String(d.fields[TAG_FIELD]) : undefined,
    content: d.text ?? String(d.fields?.[FTS_FIELD] ?? ''),
  };
}

/**
 * 列出指定 scope 下文档（listIds + fetch）。
 * 顺序为引擎内部顺序（无排序保证），取前 limit 条。
 */
export async function vectorListDocs(params: {
  scope: string;
  tags?: string[];
  limit?: number;
}): Promise<VectorDocInfo[]> {
  validateScope(params.scope);
  const engine = await getEngine();
  const filter = buildScopeTagFilter(params.scope, params.tags);
  const ids = await engine.listIds(filter, params.limit ?? 10);
  if (ids.length === 0) return [];
  const docs = await engine.fetch(ids, false);
  return docs.map(toDocInfo);
}

/**
 * 按 doc id 批量取回文档（供 doc delete 删前预览）。
 */
export async function vectorFetchDocs(ids: string[]): Promise<VectorDocInfo[]> {
  if (ids.length === 0) return [];
  const engine = await getEngine();
  const docs = await engine.fetch(ids, false);
  return docs.map(toDocInfo);
}

/**
 * 枚举向量层出现过的所有 scope（distinct）。
 * 引擎无 distinct/count API：listIds 全量 + fetch 取 scope 字段去重，
 * 受 scanLimit 约束（默认 10000）——大库下为"已扫描范围内"的 scope。
 */
export async function vectorListScopes(scanLimit: number = LIST_ALL_LIMIT): Promise<string[]> {
  const engine = await getEngine();
  const ids = await engine.listIds(undefined, scanLimit);
  if (ids.length === 0) return [];
  const docs = await engine.fetch(ids, false);
  const set = new Set<string>();
  for (const d of docs) {
    const s = d.fields?.[SCOPE_FIELD];
    if (s !== undefined && s !== null) set.add(String(s));
  }
  return [...set];
}

/**
 * 枚举指定 scope 下出现过的所有 tag（distinct + 计数）。
 * 引擎无 distinct/group-by：一次 listIds(scope) + fetch，内存按 tag 字段分组计数。
 * 受 scanLimit 约束（默认 10000）——大库下 truncated:true 表示为"已扫描范围内"的近似结果。
 */
export async function vectorListTags(params: {
  scope: string;
  scanLimit?: number;
}): Promise<{ tags: VectorTagInfo[]; scanned: number; truncated: boolean }> {
  validateScope(params.scope);
  const limit = params.scanLimit ?? LIST_ALL_LIMIT;
  const engine = await getEngine();
  const scopeCond: Filter = { field: SCOPE_FIELD, op: '==', value: params.scope };
  const ids = await engine.listIds(scopeCond, limit);
  const truncated = ids.length >= limit;
  if (ids.length === 0) return { tags: [], scanned: 0, truncated };
  const docs = await engine.fetch(ids, false);
  const counts = new Map<string, number>();
  for (const d of docs) {
    const raw = d.fields?.[TAG_FIELD];
    const tag = raw !== undefined && raw !== null ? String(raw) : '';
    if (tag.length === 0) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tags: VectorTagInfo[] = [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => (b.count - a.count) || a.tag.localeCompare(b.tag));
  return { tags, scanned: ids.length, truncated };
}

/**
 * 统计指定 scope（可选 tag）下文档数（listIds 长度，受 LIST_ALL_LIMIT 约束）。
 */
export async function vectorCountScope(params: { scope: string; tags?: string[] }): Promise<number> {
  validateScope(params.scope);
  const engine = await getEngine();
  const filter = buildScopeTagFilter(params.scope, params.tags);
  const ids = await engine.listIds(filter, LIST_ALL_LIMIT);
  return ids.length;
}

/**
 * 删除指定 scope（可选 tag）下的全部文档。循环处理以覆盖 > LIST_ALL_LIMIT 的情况。
 */
export async function vectorDeleteScope(params: { scope: string; tags?: string[] }): Promise<{ deleted: number }> {
  validateScope(params.scope);
  const engine = await getEngine();
  const filter = buildScopeTagFilter(params.scope, params.tags);
  let total = 0;
  for (;;) {
    const ids = await engine.listIds(filter, LIST_ALL_LIMIT);
    if (ids.length === 0) break;
    const res = await engine.delete(ids);
    total += res.ok;
    // 无进展保护：本批一条都没删掉（全部报错/被锁），再循环仍是同一批 ids，
    // 直接退出避免死循环空转（P1 健壮性）
    if (res.ok === 0) break;
    if (ids.length < LIST_ALL_LIMIT) break;
  }
  return { deleted: total };
}
