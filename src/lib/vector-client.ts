/**
 * vector-client.ts —— Vector Adapter（S-03）
 *
 * 封装 ZvecEngine 基座（worker proxy），
 * 为 CLI / MCP 提供 async 语义检索 / 存储接口。
 *
 * 设计要点（与 zvec-probe-node / S-03 对齐）：
 *   - 单一 collection（config.vectorDir），scope/tag 以标量字段过滤隔离
 *   - tag：单值 STRING 字段，写入时统一转小写（实现 D2「== 忽略大小写」）
 *   - scope：单值 STRING 字段，一 doc 一个 scope，查询按 scope 过滤
 *   - doc id = sha256(text + scope) 截 32（S-03 generateDocId，幂等 upsert）
 *   - 检索走 hybridSearch（queryText 语义 + fts 关键词 + RRF，kisearch 召回主路径）
 *   - content 字段兼作 FTS 字段（jieba 分词）
 */

import fs from 'node:fs';
import { createHash } from 'crypto';
// 注意：从 dist（编译产物）而非源码导入——zvec-engine 的 worker_threads 需要加载
// 编译后的 worker.js，源码目录无法直接运行；故 dist 是运行时必需品，
// 源码变更后需 npx tsc -p tsconfig.src.json（npm run build）重建。
import {
  ZvecEngine,
  SiliconFlowProvider,
  CollectionLockedException,
  type Hit,
  type Filter,
  type ProbeResult,
  type ZvecEngineConfig,
  type ZvecEngineOpenConfig,
} from '../../dist/zvec-engine/index.js';
import { loadConfig, getVectorDir, getEmbeddingConfig, resolveScope } from './config.js';
import { validateScope } from './scope.js';
import { interruptGuidance } from './interrupt.js';

// ─── 公开类型（对齐 mem-client 返回结构，便于上层平滑替换） ───

export interface VectorSearchResult {
  memoryId: string;    // = zvec Hit.id（doc id，sha256(text+scope) 截 32）
  content: string;
  score: number;       // 越大越相关（基座已归一化）
  tag?: string;
  /** 结构化 Group 字段（ki-relation 向量写入时的归属 Group 路径，可能缺失） */
  group?: string;
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
    `向量库被其他进程占用或存在崩溃残留（${dbPath}）。\n` +
    `  处置方式：\n` +
    `  1) 若有 ki mcp/server 常驻进程在运行，请先停止它；\n` +
    `  2) 确认无其他 ki 命令正在写入（并发写会互斥）；\n` +
    `  3) 若进程已异常退出，锁会在片刻后自动释放，可稍后重试；\n` +
    `  4) 若上次导入被中断（Ctrl+C/kill），可能存在 crash residue（如 "already exists"/"crash residue" 报错）——` +
    `     可执行 ki restore <scope> --rebuild-vector 或 ki restore <scope> --from-snapshot --rebuild-vector 全量重建恢复；\n` +
    `  5) 若确认无任何进程占用仍持续报此错（如向量库目录为空/状态异常），\n` +
    `     可执行 ki restore <scope> --from-snapshot 重建向量库`
  );
}

/**
 * probe 带撞锁重试：检测到 locked 时等待对方释放后重试（错开共享向量库）。
 * 多 stdio MCP 实例 / CLI 短命令共享同一向量库，空闲释放锁会让持锁方空闲后自动
 * 释放，此处重试即可「撞了多等几秒」而非立即失败。最多 LOCK_RETRY_MAX 次。
 */
async function probeWithRetry(dbPath: string): Promise<ProbeResult> {
  for (let attempt = 0; ; attempt++) {
    const probe = await ZvecEngine.probe(dbPath);
    if (!probe.locked || attempt >= LOCK_RETRY_MAX) {
      return probe;
    }
    process.stderr.write(
      `[kisearch] 向量库被其他进程占用，等待 ${LOCK_RETRY_INTERVAL_MS / 1000}s 后重试（${attempt + 1}/${LOCK_RETRY_MAX}）...\n`,
    );
    await sleep(LOCK_RETRY_INTERVAL_MS);
  }
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
const GROUP_FIELD = 'group';
const DEFAULT_TAG = 'ki-search';
const MAX_TEXT_LENGTH = 50_000;

// ─── 撞锁重试 + 空闲释放锁（错开共享向量库） ───
//
// 背景：向量库为单进程独占锁。多个常驻 MCP 实例（stdio 多实例）与 CLI 短命令
// 需在「错开使用」的前提下共享同一向量库：
//   - 撞锁重试：probe/open 检测到 locked 时，等对方空闲释放后重试（而非立即失败）；
//   - 空闲释放锁：常驻 MCP 层调用 enableIdleClose，空闲超时后自动 closeEngine 释放锁，
//     让其他实例 / CLI 能抢到。CLI 短命令不启用（per-call 结束即 closeEngine）。

/** 撞锁后重试等待间隔（ms） */
const LOCK_RETRY_INTERVAL_MS = 2_000;
/** 撞锁重试上限次数（最多额外等待 LOCK_RETRY_INTERVAL_MS × LOCK_RETRY_MAX 后仍锁则报错） */
const LOCK_RETRY_MAX = 3;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 空闲释放锁状态：仅常驻 MCP 层经 enableIdleClose 启用；CLI 不启用（_idleCloseMs 恒 0）。
let _idleCloseMs = 0;
let _lastUseAt = 0;
let _idleTimer: NodeJS.Timeout | null = null;
/** 在途 engine 操作计数（idle close 判定依据：>0 时禁止空闲释放，见 enableIdleClose） */
let _inFlightOps = 0;

/** 记录一次引擎使用（空闲计时起点）；未启用空闲释放时无副作用 */
function touchEngineUse(): void {
  if (_idleCloseMs > 0) _lastUseAt = Date.now();
}

/**
 * 启用向量库空闲释放锁（仅供常驻 MCP 层调用，CLI 勿用）。
 * 空闲超过 idleMs 后自动 closeEngine 释放 LOCK，让其他 MCP 实例 / CLI 能错开抢锁；
 * 下次向量调用时 getEngine 惰性 reopen（实测约 0.7s）。
 * 安全：close 底层会 drain 在途操作，故不会中断正在执行的写入/检索。
 */
export function enableIdleClose(idleMs: number): void {
  _idleCloseMs = idleMs;
  _lastUseAt = Date.now();
  if (_idleTimer) clearInterval(_idleTimer);
  _idleTimer = setInterval(() => {
    if (_idleCloseMs <= 0) return;
    // 在途保护（竞态修复）：有进行中的 engine 操作（含 embedding 网络阶段）时禁止空闲释放。
    // 此前竞态：hybridSearch 主线程 embedding（网络 0.5s~数秒）超过 idle 窗口时，
    // proxy.close() 的 drain 只等已 postMessage 的请求，embedding 阶段不可见 → drain
    // 立即完成 → worker closed → embedding 返回后 proxy.send 报
    // "worker not open (state=closed)"。
    if (_enginePromise && _inFlightOps === 0 && Date.now() - _lastUseAt >= _idleCloseMs) {
      void closeEngine(); // 空闲超时，释放锁（不阻塞定时器）
    }
  }, Math.max(500, Math.floor(idleMs / 2)));
  // 不阻止进程退出（正常退出由各自 closeEngine / shutdown 负责）
  _idleTimer.unref?.();
}

// ─── Engine 单例（进程内缓存） ───

let _enginePromise: Promise<ZvecEngine> | null = null;

// 进程内 probe/open 串行化队尾：zvec 同进程并发 ZVecOpen 同一 dbPath 会以
// 高概率（实测约 62%）触发原生竞态永久阻塞，故所有涉及原生 open 的操作
//（probe / create / open）必须串行排队，禁止并发。
let _engineOpTail: Promise<unknown> = Promise.resolve();

function serializeEngineOp<T>(op: () => Promise<T>): Promise<T> {
  const run = _engineOpTail.then(op, op);
  // 队尾吞掉异常，避免一次失败阻断后续排队
  _engineOpTail = run.catch(() => {});
  return run;
}

// open/create 上限：小于工具护栏 READ 30s，保证 _enginePromise 必定 settle，
// 避免原生挂死时 promise 永久 pending 导致向量层失去自愈能力
const ENGINE_OPEN_TIMEOUT_MS = 20_000;

function withOpenTimeout(p: Promise<ZvecEngine>, label: string): Promise<ZvecEngine> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // 超时后若底层迟到成功，关掉这个孤儿 engine 释放 LOCK（fire-and-forget）
      p.then((e) => { void e.close().catch(() => {}); }).catch(() => {});
      reject(new Error(
        `向量库${label}超过 ${ENGINE_OPEN_TIMEOUT_MS}ms 未完成，已中断本次调用；`
        + '后续调用会自动重试，若持续失败请检查向量库目录与磁盘状态',
      ));
    }, ENGINE_OPEN_TIMEOUT_MS);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!));
}

/**
 * 规范化 tag：转小写（D2「== 忽略大小写」靠写入/查询双侧小写化实现）
 */
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/**
 * 生成 doc id：sha256(text + scope + tag) 截 32
 *
 * tag 参与 id 生成：同 scope + text 打不同 tag → 不同 docId → 各自独立 doc，
 * 支撑「一个内容多 tag 各写一条」的多标签能力（tag 单值字段，多 tag 必须分 doc）。
 * 同 scope + text + tag → 同 docId → 幂等 upsert（重复写入覆盖）。
 *
 * ⚠️ 迁移影响（breaking）：tag 参与生成后，**所有调用 vectorStore/vectorBulkStore 的链路**
 * （sync-relation、scan-kb import、bulk-store、path-vectorize、batch-vectorize）产出的 docId 均改变，
 * 存量向量 docId 与新 scheme 失配。后果：
 *   - 存量 cache 的 memoryId/memoryIds 指向的 docId 失效 → REQ-20260807-001 的「原文召回」、
 *     按 docId 精确删除、scan-kb 幂等重导（旧 scheme 孤儿向量）在迁移前不可靠；
 *   - delete 有 search 兜底可清，原文召回需 re-import 或 `ki restore <scope> --rebuild-vector` 迁移。
 * 部署含存量向量数据时，发布后需全量 re-import 或 rebuild-vector 迁移。
 */
export function generateDocId(text: string, scope: string, tag?: string): string {
  return createHash('sha256').update(text + scope + (tag ?? '')).digest('hex').slice(0, 32);
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
        { name: GROUP_FIELD, dataType: 'STRING', indexed: true },
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
 *
 * 并发安全：probe→create/open 全链路经 serializeEngineOp 串行化，且 open 带超时，
 * 保证 _enginePromise 必定 settle（失败即重置缓存，后续调用可重试自愈）。
 */
export function getEngine(): Promise<ZvecEngine> {
  // 每次引擎访问刷新空闲计时（空闲释放锁依据）；CLI 未启用时无副作用
  touchEngineUse();
  if (!_enginePromise) {
    const createCfg = buildCreateConfig();
    _enginePromise = serializeEngineOp(async () => {
      const exists = await probeWithRetry(createCfg.dbPath);
      if (exists.locked) {
        throw new CollectionLockedException(lockedHint(createCfg.dbPath));
      }
      if (!exists.exists) {
        // zvec create 要求 dbPath 不存在；probe 对空目录返回 NOT_FOUND 时目录仍存在，
        // 先移除空目录（rmdirSync 仅删空目录，非空即抛错回退给 create 报错兜底）
        try {
          fs.rmdirSync(createCfg.dbPath);
        } catch {
          /* 忽略：非空目录/不可删，交由 create 报错 */
        }
        return withOpenTimeout(ZvecEngine.create(createCfg), '创建');
      }
      return withOpenTimeout(ZvecEngine.open(buildOpenConfig()), '打开');
    });
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
  // 先置空缓存再 close：close 期间新 getEngine 会走 reopen + 撞锁重试，
  // 而非拿到正在 closing 的旧 engine（避免 WorkerCrashedError 竞态）。
  const promise = _enginePromise;
  _enginePromise = null;
  if (promise) {
    // close 也经 serializeEngineOp 串行化：worker 的 closeSync（释放 LOCK）+ terminate
    // 同样是原生操作，若与 reopen 的 probe/open 并发会触发 zvec 同进程原生竞态
    // （62% 概率永久阻塞，见 _engineOpTail 注释）。串行化后 close 与后续 open 互斥。
    await serializeEngineOp(async () => {
      try {
        const engine = await promise;
        await engine.close();
      } catch { /* ignore */ }
    });
  }
}

/** 测试用别名（等价 closeEngine） */
export const resetEngine = closeEngine;

/**
 * worker 不可用判定（duck-typing，与 dist 构建版本解耦）：
 * err.name === 'WorkerUnavailableError'（ZvecEngineError 基类以 new.target.name 设置）
 * 或消息含 "worker not open"（proxy.ts 状态检查的固定文案）。
 * 不用 instanceof/命名导入——旧构建产物缺新导出时 instanceof undefined 会崩。
 */
function isWorkerUnavailable(err: unknown): boolean {
  return err instanceof Error && (
    err.name === 'WorkerUnavailableError' || /worker not open/i.test(err.message)
  );
}

/**
 * engine 操作包装：在途保护 + 空闲续期 + worker 不可用自愈重试。
 *
 * 1. 在途保护：进入即 _inFlightOps++（idle timer 见此计数不打断）；
 *    完成后 finally 减计数并续期空闲起点（上一次调用的耗时不计入空闲）。
 * 2. 自愈重试：worker 已 closed 等（残余竞态兜底）时重置 engine 重开一次重试。
 *
 * 所有 engine 使用一律经此包装（getEngine 的直接 await 不受在途保护，
 * 会重演 idle close 竞态——见 enableIdleClose 注释）。
 */
async function withEngine<T>(op: (engine: ZvecEngine) => Promise<T>): Promise<T> {
  touchEngineUse();
  _inFlightOps++;
  try {
    try {
      const engine = await getEngine();
      return await op(engine);
    } catch (err) {
      if (!isWorkerUnavailable(err)) throw err;
      // worker 已不可用（如 state=closed）：重置后重开重试一次
      await closeEngine();
      const engine = await getEngine();
      return await op(engine);
    }
  } finally {
    _inFlightOps--;
    touchEngineUse();
  }
}

// ─── 可用性检测（替代 ensureMemAvailable） ───

/**
 * 检测向量服务是否可用。
 * - 本进程 engine 已打开/正在打开 → 直接复用单例状态（不重新 probe：
 *   重 probe 会被自家 LOCK 挡住而误报「被其他进程占用」，常驻服务内
 *   向量层会变成每进程只能用一次）
 * - dbPath 不存在 → 可用（首次 store 会 create）
 * - 被其他进程持锁 → 不可用（提示）
 * - 损坏 → 不可用（提示重建）
 */
export async function ensureVectorAvailable(scope?: string): Promise<VectorAvailableResult> {
  // REQ-02：中断标记前置检测（传入 scope 时）——中断后给出可执行恢复引导（不阻断，继续执行）
  if (scope) {
    const guidance = interruptGuidance(scope);
    if (guidance) {
      process.stderr.write(`  ⚠ ${guidance}\n`);
    }
  }
  // engine 单例已存在（open 中或已 open）：等它 settle 即可，跳过 probe
  if (_enginePromise) {
    try {
      await _enginePromise;
      return { available: true };
    } catch (err) {
      // getEngine 已自行重置缓存；这里将失败原因直接作为不可用理由返回，
      // 不再另发一次 probe（避免重复开销与竞态窗口）
      if (err instanceof CollectionLockedException) {
        return { available: false, reason: err.message, code: 'LOCKED' };
      }
      return { available: false, reason: `向量服务初始化失败: ${(err as Error).message}`, code: 'PROBE_ERROR' };
    }
  }
  const config = loadConfig();
  const dbPath = getVectorDir(config);
  try {
    const probe = await serializeEngineOp(() => probeWithRetry(dbPath));
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
 *
 * tags：可选。不传/空 → 不按 tag 过滤（搜索 scope 下全部 tag）；
 * 传单个 tag 或逗号分隔多个 tag → 多 tag 以 OR 组合（复用 buildScopeTagFilter）。
 */
export async function vectorSearch(params: {
  scope: string;
  query: string;
  limit?: number;
  tags?: string;        // 单个或多个 tag（逗号分隔）；不传/空 → 全部 tag；忽略大小写
  threshold?: number;
}): Promise<VectorSearchResult[]> {
  const scope = resolveScope(loadConfig(), params.scope);
  const tagList = params.tags
    ? params.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : undefined;
  const filter = buildScopeTagFilter(scope, tagList);

  const hits: Hit[] = await withEngine((engine) => engine.hybridSearch({
    queryText: params.query,
    fts: params.query,
    topk: params.limit ?? 10,
    filter,
  }));

  return hits
    .map((h) => ({
      memoryId: h.id,
      content: h.text ?? String(h.fields?.[FTS_FIELD] ?? ''),
      score: h.score,
      tag: h.fields?.[TAG_FIELD] !== undefined ? String(h.fields[TAG_FIELD]) : undefined,
      group: h.fields?.[GROUP_FIELD] !== undefined ? String(h.fields[GROUP_FIELD]) : undefined,
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
  group?: string;
}): Promise<VectorStoreResult> {
  if (params.text.length > MAX_TEXT_LENGTH) {
    throw new Error(`text 超过 ${MAX_TEXT_LENGTH} 字符限制（当前 ${params.text.length}）`);
  }

  const scope = resolveScope(loadConfig(), params.scope);
  const tag = normalizeTag(params.tags ?? DEFAULT_TAG);

  const docId = generateDocId(params.text, scope, tag);
  const result = await withEngine((engine) => engine.upsert([{
    id: docId,
    text: params.text,
    fields: {
      [TAG_FIELD]: tag,
      [SCOPE_FIELD]: scope,
      ...(params.group ? { [GROUP_FIELD]: params.group } : {}),
    },
  }]));

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
  entries: { text: string; tags?: string; group?: string }[];
}): Promise<VectorBulkStoreResult> {
  if (params.entries.length === 0) {
    return { total: 0, succeeded: 0, failed: 0, results: [] };
  }

  const scope = resolveScope(loadConfig(), params.scope);

  const docs = params.entries.map((e) => {
    const tag = normalizeTag(e.tags ?? DEFAULT_TAG);
    return {
      id: generateDocId(e.text, scope, tag),
      text: e.text,
      fields: {
        [TAG_FIELD]: tag,
        [SCOPE_FIELD]: scope,
        ...(e.group ? { [GROUP_FIELD]: e.group } : {}),
      },
    };
  });

  const result = await withEngine((engine) => engine.upsert(docs));

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
}): Promise<{ deleted: number; errors: { id: string; code: string; reason: string }[] }> {
  // strict 档下校验 scope（删除按 doc id 全局定位，scope 仅用于护栏一致性）
  resolveScope(loadConfig(), params.scope);
  const result = await withEngine((engine) => engine.delete(params.ids));
  return {
    deleted: result.ok,
    errors: (result.errors ?? []).map((e) => ({ id: e.id, code: e.code, reason: e.reason })),
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
  const filter = buildScopeTagFilter(params.scope, params.tags);
  return withEngine(async (engine) => {
    const ids = await engine.listIds(filter, params.limit ?? 10);
    if (ids.length === 0) return [];
    const docs = await engine.fetch(ids, false);
    return docs.map(toDocInfo);
  });
}

/**
 * 按 doc id 批量取回文档（供 doc delete 删前预览）。
 */
export async function vectorFetchDocs(ids: string[]): Promise<VectorDocInfo[]> {
  if (ids.length === 0) return [];
  return withEngine(async (engine) => {
    const docs = await engine.fetch(ids, false);
    return docs.map(toDocInfo);
  });
}

/**
 * 枚举向量层出现过的所有 scope（distinct）。
 * 引擎无 distinct/count API：listIds 全量 + fetch 取 scope 字段去重，
 * 受 scanLimit 约束（默认 10000）——大库下为"已扫描范围内"的 scope。
 */
export async function vectorListScopes(scanLimit: number = LIST_ALL_LIMIT): Promise<string[]> {
  return withEngine(async (engine) => {
    const ids = await engine.listIds(undefined, scanLimit);
    if (ids.length === 0) return [];
    const docs = await engine.fetch(ids, false);
    const set = new Set<string>();
    for (const d of docs) {
      const s = d.fields?.[SCOPE_FIELD];
      if (s !== undefined && s !== null) set.add(String(s));
    }
    return [...set];
  });
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
  const scopeCond: Filter = { field: SCOPE_FIELD, op: '==', value: params.scope };
  return withEngine(async (engine) => {
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
  });
}

/**
 * 统计指定 scope（可选 tag）下文档数（listIds 长度，受 LIST_ALL_LIMIT 约束）。
 */
export async function vectorCountScope(params: { scope: string; tags?: string[] }): Promise<number> {
  validateScope(params.scope);
  const filter = buildScopeTagFilter(params.scope, params.tags);
  return withEngine((engine) => engine.listIds(filter, LIST_ALL_LIMIT).then((ids) => ids.length));
}

/**
 * 删除指定 scope（可选 tag）下的全部文档。循环处理以覆盖 > LIST_ALL_LIMIT 的情况。
 * onProgress 可选：每批删除后回调（deleted 累计值），用于导入覆盖场景的动态进度展示。
 */
export async function vectorDeleteScope(
  params: { scope: string; tags?: string[] },
  onProgress?: (deleted: number) => void
): Promise<{ deleted: number }> {
  validateScope(params.scope);
  const filter = buildScopeTagFilter(params.scope, params.tags);
  return withEngine(async (engine) => {
    let total = 0;
    for (;;) {
      const ids = await engine.listIds(filter, LIST_ALL_LIMIT);
      if (ids.length === 0) break;
      const res = await engine.delete(ids);
      total += res.ok;
      onProgress?.(total);
      // 无进展保护：本批一条都没删掉（全部报错/被锁），再循环仍是同一批 ids，
      // 直接退出避免死循环空转（P1 健壮性）
      if (res.ok === 0) break;
      if (ids.length < LIST_ALL_LIMIT) break;
    }
    return { deleted: total };
  });
}
