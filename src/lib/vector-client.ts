/**
 * vector-client.ts —— Vector Adapter（S-03）
 *
 * 封装 ZvecEngine 基座（worker proxy），
 * 为 CLI / MCP 提供 async 语义检索 / 存储接口。
 *
 * 设计要点（与 zvec-probe-node / S-03 对齐）：
 *   - 一个 scope 一个 collection（config.vectorDir/collections/<scope>），scope 以物理目录隔离
 *   - tag：单值 STRING 字段，写入时统一转小写（实现 D2「== 忽略大小写」）
 *   - scope：单值 STRING 字段，一 doc 一个 scope，查询按 scope 过滤
 *   - doc id = sha256(text + scope + tag) 截 32（S-03 generateDocId，幂等 upsert）
 *   - 检索走 hybridSearch（queryText 语义 + fts 关键词 + RRF，kisearch 召回主路径）
 *   - content 字段兼作 FTS 字段（jieba 分词）
 */

import fs from 'node:fs';
import os from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
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
import type { EmbeddingProvider } from '../zvec-engine/embedding/provider.js';
import { EmbeddingSchedulerRuntime, type EmbeddingSchedulerConfig, type EmbeddingSchedulerMetrics } from '../zvec-engine/embedding/batch-scheduler.js';
import type { ZvecWriteOptions } from '../zvec-engine/types.js';
import { loadConfig, getEmbeddingConfig, resolveScope } from './config.js';
import { validateScope } from './scope.js';
import { interruptGuidance } from './interrupt.js';
import { ensureVectorLayout, getScopeCollectionPath, getCollectionsRoot } from './scope-collection.js';
import { getPrecomputedQueryVector } from './query-vector-precompute.js';
import { DEFAULT_QUERY_EMBED_TIMEOUT_MS } from './query-timeout.js';
import { ftsSearch as ftsOnlySearch } from './fts-client.js';

// ─── 公开类型（对齐 mem-client 返回结构，便于上层平滑替换） ───

export interface VectorSearchResult {
  /** 兼容字段：dense 结果是 memory/doc ID；FTS-only 结果暂复用 ftsId，调用方应看 indexType/ftsId。 */
  memoryId: string;
  /** 结果的索引来源；FTS-only 命中不应被误解为 dense 向量。 */
  indexType?: 'dense' | 'fts';
  /** FTS-only Collection 的稳定 ID；仅 indexType=fts 时存在。 */
  ftsId?: string;
  content: string;
  score: number;       // 越大越相关（基座已归一化）
  tag?: string;
  /** 结构化 Group 字段（ki-relation 向量写入时的归属 Group 路径，可能缺失） */
  group?: string;
  /** 命中所属 scope（多 scope 检索时供上层区分来源/反查定位；旧库缺字段时可能缺失） */
  scope?: string;
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
  /** 兼容旧字段；与 totalItems 相同。 */
  totalItems?: number;
  /** 已进入 scheduler 的条目数，取消未启动项不计入。 */
  attempted?: number;
  succeeded: number;
  failed: number;
  results: BulkStoreItemResult[];
  metadataPending?: number;
  metadataPendingItems?: string[];
  cancelled?: number;
  cancelledItems?: number;
  failedItems?: string[];
  status?: 'succeeded' | 'partial' | 'failed' | 'cancelled';
}

export interface VectorBulkStoreOptions {
  /** 可选任务级覆盖；daemon 全局 limiter 仍按相同配置 key 共享。 */
  scheduler?: Partial<EmbeddingSchedulerConfig>;
  abortSignal?: AbortSignal;
  onProgress?: ZvecWriteOptions['onProgress'];
  onBatchPersisted?: ZvecWriteOptions['onBatchPersisted'];
}

const schedulerRuntimes = new Map<string, EmbeddingSchedulerRuntime>();

function getEmbeddingSchedulerRuntime(override?: Partial<EmbeddingSchedulerConfig>): EmbeddingSchedulerRuntime {
  const base = getEmbeddingConfig(loadConfig()).scheduler as EmbeddingSchedulerConfig;
  const scheduler = { ...base, ...(override ?? {}) };
  const key = JSON.stringify(scheduler);
  const existing = schedulerRuntimes.get(key);
  if (existing) return existing;
  const runtime = new EmbeddingSchedulerRuntime(scheduler);
  schedulerRuntimes.clear();
  schedulerRuntimes.set(key, runtime);
  return runtime;
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
 * 当前异步链的向量操作来源（HTTP 端点 / MCP 工具名）。
 * HTTP 层在请求入口用 runWithVectorSource 标注，probeWithRetry 的撞锁日志
 * 附带该来源，便于从服务端日志直接定位是哪个端点/工具触发的撞锁。
 */
const vectorSourceStorage = new AsyncLocalStorage<string>();

/** 标注向量操作来源：fn 执行期间 probeWithRetry 的撞锁日志会附带该来源 */
export function runWithVectorSource<T>(source: string, fn: () => T): T {
  return vectorSourceStorage.run(source, fn);
}

/** 读取当前异步链的向量操作来源（未标注时 undefined）；诊断/测试用 */
export function getVectorOpSource(): string | undefined {
  return vectorSourceStorage.getStore();
}

/**
 * probe 带撞锁重试：检测到 locked 时等待外部维护进程释放后重试。
 * 正常 CLI/stdio/HTTP 请求均由 daemon 内部调度，不会互相抢锁；重试仅作为
 * daemon 启动期间或显式维护模式的兜底，最多 LOCK_RETRY_MAX 次。
 */
async function probeWithRetry(dbPath: string): Promise<ProbeResult> {
  for (let attempt = 0; ; attempt++) {
    const probe = await ZvecEngine.probe(dbPath);
    if (!probe.locked || attempt >= LOCK_RETRY_MAX) {
      return probe;
    }
    // 撞锁日志附带来源（HTTP 端点/MCP 工具名；CLI 路径未标注则无来源段）
    const source = vectorSourceStorage.getStore();
    process.stderr.write(
      `[kisearch]${source ? `[${source}]` : ''} 向量库被其他进程占用，等待 ${LOCK_RETRY_INTERVAL_MS / 1000}s 后重试（${attempt + 1}/${LOCK_RETRY_MAX}）...\n`,
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

/**
 * 预计算一次查询向量。
 *
 * zvec 的 hybridSearch 支持 `vector + fts`，因此多 Collection fan-out 时
 * 可以把 embedding 从每个 engine 内部提升到 fan-out 外层，避免 scope 数量
 * 放大 embedding HTTP 请求次数。
 */
export async function embedQueryOnce(
  query: string,
  provider: Pick<EmbeddingProvider, 'embed' | 'dimension'> = buildEmbedding(),
  opts?: { timeoutMs?: number; retries?: number },
): Promise<number[]> {
  const vectors = await provider.embed([query], {
    batchSize: 1,
    ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    ...(opts?.retries !== undefined ? { retries: opts.retries } : {}),
  });
  const vector = vectors[0];
  if (!vector) throw new Error('查询 embedding 未返回向量');
  if (vector.length !== provider.dimension) {
    throw new Error(`查询 embedding 维度不匹配：期望 ${provider.dimension}，实际 ${vector.length}`);
  }
  return vector;
}

/** 应用层合并各 scope 的候选命中，并截断为全局 top-k（纯函数，供测试/对照复用）。 */
export function mergeVectorSearchHits(
  perScope: VectorSearchResult[][],
  limit: number,
): VectorSearchResult[] {
  return perScope
    .flat()
    // Node 的稳定排序保留同分命中在 scope/engine 返回中的顺序，避免单 scope
    // 检索因 fan-out 适配层引入额外 tie-break 而发生无意义的排序漂移。
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
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

/** 查询 embedding 固定 0 重试；超时由配置或请求级 timeout 决定。 */
const QUERY_EMBED_RETRIES = 0;
/** @deprecated 仅为旧调用方保留；查询运行时不再读取该常量。 */
export const QUERY_EMBED_TIMEOUT_MS = DEFAULT_QUERY_EMBED_TIMEOUT_MS;

/**
 * 查询 embedding 失败是否可降级（FTS-only）。
 *
 * 可降级 = 瞬时外部问题（超时 / 网络 / 429 / 5xx，即 nonRetryable !== true）；
 * 不可降级 = 配置与请求类（EmbeddingConfigError、4xx、响应结构异常）——降级会
 * 静默掩盖"apiKey 失效"这类必须暴露的问题，故保持原样抛出。
 *
 * 导出供 MCP HTTP 层预计算复用：两处判定必须同源，否则会出现
 * "预计算标 failed → 工具侧静默降级" 与 "CLI 路径 fail-loud" 的语义分叉。
 */
export function isQueryEmbedDegradable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; data?: { nonRetryable?: unknown } };
  return e.name === 'EmbeddingError' && e.data?.nonRetryable !== true;
}

// ─── 撞锁重试 + 空闲释放锁（daemon owner 兜底） ───
//
// 背景：向量库为单进程独占锁。正常 CLI/MCP 请求都由 daemon owner 调度，
// 这里的重试和空闲释放只服务于 daemon 启动/维护模式等兜底路径：
//   - 撞锁重试：probe/open 检测到 locked 时，等外部进程释放后重试；
//   - 空闲释放锁：常驻 daemon 空闲超时后释放所有 Collection；CLI 短命令不启用。

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
    if (_enginePromises.size > 0 && _inFlightOps === 0 && Date.now() - _lastUseAt >= _idleCloseMs) {
      void closeEngine(); // 空闲超时，释放锁（不阻塞定时器）
    }
  }, Math.max(500, Math.floor(idleMs / 2)));
  // 不阻止进程退出（正常退出由各自 closeEngine / shutdown 负责）
  _idleTimer.unref?.();
}

// ─── Engine 单例（进程内缓存） ───

const _enginePromises = new Map<string, Promise<ZvecEngine>>();

/**
 * scope → 已打开句柄的 dbPath。
 *
 * _enginePromises 只以 scope 名为键，命中即返回、不校验路径。而 loadConfig 已支持
 * 热失效，长操作（import/restore 可达数分钟）中途 vectorDir 变化时，缓存会返回
 * **指向旧路径的已打开句柄**，而同一次操作里的 getScopeCollectionPath /
 * scopeCollectionExists 已按新路径解析 → 读旧句柄、写新路径，数据静默落错位置。
 * 入口的身份守卫只在请求开始时检查一次，拦不住这类中途漂移，故在此记录并在
 * 命中缓存前比对（见 getEngine）。
 */
const _engineDbPaths = new Map<string, string>();

interface EngineMeta {
  lastUsedAt: number;
  activeUses: number;
  ready: boolean;
}

const _engineMeta = new Map<string, EngineMeta>();
const DEFAULT_MAX_OPEN_COLLECTIONS = 8;
const resourceMetrics = {
  openCount: 0,
  peakOpenCount: 0,
  opened: 0,
  closed: 0,
  openMsTotal: 0,
  closeMsTotal: 0,
  lastOpenMs: 0,
  lastCloseMs: 0,
};

export interface VectorResourceMetrics {
  openCount: number;
  peakOpenCount: number;
  opened: number;
  closed: number;
  openMsTotal: number;
  closeMsTotal: number;
  lastOpenMs: number;
  lastCloseMs: number;
}

export function getVectorResourceMetrics(): VectorResourceMetrics {
  return { ...resourceMetrics };
}

export interface VectorizationMetrics extends EmbeddingSchedulerMetrics {
  rssBytes: number;
  mmapCount: number;
  fdCount: number;
  machineAvailableMemoryBytes: number;
}

function countProcEntries(name: string): number {
  try { return fs.readdirSync(`/proc/self/${name}`).length; } catch { return 0; }
}

/**
 * Embedding 调度指标与 OS 资源指标分开读取，避免把 Node heap 当成 daemon
 * 的真实内存占用；/proc 不可用的平台返回 0，但不伪造一个“健康”数值。
 */
export function getVectorizationMetrics(): VectorizationMetrics {
  const metrics: EmbeddingSchedulerMetrics = {
    activeTasks: 0,
    inFlightRequests: 0,
    bufferedVectorBytes: 0,
    submittedBatches: 0,
    completedBatches: 0,
    failedBatches: 0,
    cancelledItems: 0,
    providerRequests: 0,
    retries: 0,
    rateLimited: 0,
    timeouts: 0,
  };
  for (const runtime of schedulerRuntimes.values()) {
    const current = runtime.getMetrics();
    for (const key of Object.keys(metrics) as (keyof EmbeddingSchedulerMetrics)[]) {
      metrics[key] += current[key];
    }
  }
  return {
    ...metrics,
    rssBytes: process.memoryUsage().rss,
    mmapCount: countProcEntries('maps'),
    fdCount: countProcEntries('fd'),
    machineAvailableMemoryBytes: os.freemem(),
  };
}

function maxOpenCollections(): number {
  const configured = loadConfig().vector?.maxOpenCollections;
  return configured && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_OPEN_COLLECTIONS;
}

async function closeEntry(scope: string, promise: Promise<ZvecEngine>): Promise<void> {
  if (_enginePromises.get(scope) === promise) _enginePromises.delete(scope);
  _engineDbPaths.delete(scope);
  _engineMeta.delete(scope);
  const startedAt = Date.now();
  try {
    await (await promise).close();
  } catch {
    /* 释放失败仍从缓存移除，后续调用可重新探测并暴露真实状态。 */
  } finally {
    const elapsed = Date.now() - startedAt;
    resourceMetrics.closed++;
    resourceMetrics.closeMsTotal += elapsed;
    resourceMetrics.lastCloseMs = elapsed;
    resourceMetrics.openCount = Math.max(0, resourceMetrics.openCount - 1);
  }
}

/** 在 serializeEngineOp 内执行；只淘汰已 ready 且没有活跃使用者的最老 entry。 */
async function enforceEngineLimit(excludeScope: string): Promise<void> {
  const limit = maxOpenCollections();
  for (;;) {
    // 只把已经 ready 的句柄计入上限。尚未开始的 open 请求本身已经排在
    // serializeEngineOp 队列中，若在这里等待它们会形成自等待：当前 open
    // 队列项必须先返回，后续 open 才有机会执行并释放 LRU。
    const readyEntries = [..._engineMeta.entries()]
      .filter(([scope, meta]) => scope !== excludeScope && meta.ready);
    if (readyEntries.length < limit) return;
    const candidate = [..._engineMeta.entries()]
      .filter(([scope, meta]) => scope !== excludeScope && meta.ready && meta.activeUses === 0)
      .sort(([, a], [, b]) => a.lastUsedAt - b.lastUsedAt)[0];
    if (candidate) {
      const [scope] = candidate;
      const promise = _enginePromises.get(scope);
      if (promise) await closeEntry(scope, promise);
      continue;
    }
    // 达到上限且所有 ready 句柄都在使用中：等待使用者释放租约后再淘汰，
    // 不能强行关闭活跃 worker。用短轮询避免额外引入一套通知状态机；该等待
    // 发生在原生操作队列内，但活跃使用者不占用该队列，故不会自锁。
    if (readyEntries.some(([, meta]) => meta.activeUses > 0)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      continue;
    }
    return;
  }
}

// 进程内 probe/open 串行化队尾：zvec 同进程并发 ZVecOpen 同一 dbPath 会以
// 高概率（实测约 62%）触发原生竞态永久阻塞，故所有涉及原生 open 的操作
//（probe / create / open）必须串行排队，禁止并发。
let _engineOpTail: Promise<unknown> = Promise.resolve();

export function serializeEngineOp<T>(op: () => Promise<T>): Promise<T> {
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
      // 超时后若底层迟到成功，仍须经统一原生操作队列关闭孤儿 engine，释放 LOCK。
      // 不能直接调用 close：它会与同进程的 open/probe/close 发生原生竞态。
      p.then((e) => {
        void serializeEngineOp(async () => { await e.close(); }).catch(() => {});
      }).catch(() => {});
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
 * （sync-relation、ki import、bulk-store、path-vectorize、batch-vectorize）产出的 docId 均改变，
 * 存量向量 docId 与新 scheme 失配。后果：
 *   - 存量 cache 的 memoryId/memoryIds 指向的 docId 失效 → REQ-20260807-001 的「原文召回」、
 *     按 docId 精确删除、ki import 幂等重导（旧 scheme 孤儿向量）在迁移前不可靠；
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
function buildCreateConfig(scope: string): ZvecEngineConfig {
  const config = loadConfig();
  const emb = getEmbeddingConfig(config);
  ensureVectorLayout(config);
  return {
    dbPath: getScopeCollectionPath(config, scope),
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

function buildOpenConfig(scope: string): ZvecEngineOpenConfig {
  const config = loadConfig();
  return {
    dbPath: getScopeCollectionPath(config, scope),
    collectionName: COLLECTION_NAME,
    embedding: buildEmbedding(),
  };
}

/**
 * 获取（或创建/打开）指定 scope 的进程内 ZvecEngine 实例。
 * 首次：dbPath 不存在 → create；已存在 → open。
 * 若已被其他进程持锁（如 ki mcp/server 常驻），直接抛 CollectionLockedException，
 * 避免 open 撞锁时挂起/抛出不可读的底层错误（MCP 路径未走 ensureVectorAvailable 时的兵底）。
 *
 * 并发安全：probe→create/open 全链路经 serializeEngineOp 串行化，且 open 带超时，
 * 保证 _enginePromise 必定 settle（失败即重置缓存，后续调用可重试自愈）。
 */
export function getEngine(scope = 'default'): Promise<ZvecEngine> {
  validateScope(scope);
  const normalizedScope = scope;
  // 每次引擎访问刷新空闲计时（空闲释放锁依据）；CLI 未启用时无副作用
  touchEngineUse();
  const existing = _enginePromises.get(normalizedScope);
  if (existing) {
    const meta = _engineMeta.get(normalizedScope);
    if (meta) meta.lastUsedAt = Date.now();
    // 命中缓存前校验 dbPath。仅 daemon owner 需要：CLI 是短命进程，单命令内配置
    // 不会中途变化，且这里要调 ensureVectorLayout/getScopeCollectionPath（内含路径
    // 规范化 IO），会破坏
    // 原本“零 IO”的缓存命中快路径。
    if (process.env.KI_DAEMON_OWNER === '1') {
      const openedAt = _engineDbPaths.get(normalizedScope);
      const currentConfig = loadConfig();
      ensureVectorLayout(currentConfig);
      const current = getScopeCollectionPath(currentConfig, normalizedScope);
      if (openedAt !== undefined && openedAt !== current) {
        throw Object.assign(
          new Error(
            `scope "${normalizedScope}" 的向量目录在操作进行中发生变化：已打开句柄指向 ${openedAt}，`
            + `而当前配置解析为 ${current}。继续使用会把数据写到错误位置。`
            + '请执行 ki mcp stop && ki mcp --http --daemon 以新配置重启 daemon。'
          ),
          { code: 'DAEMON_IDENTITY_DRIFT' },
        );
      }
    }
    return existing;
  }
  const createCfg = buildCreateConfig(normalizedScope);
  // withEngine 会在 await getEngine 前预占 activeUses，避免句柄刚 ready 但调用方
  // 尚未恢复执行时被另一个 scope 误判为空闲并提前 LRU 淘汰。直接调用 getEngine
  // 的维护路径不预占，因此仍以 0 个活跃使用者登记。
  const reservedMeta = _engineMeta.get(normalizedScope);
  const enginePromise = serializeEngineOp(async () => {
      await enforceEngineLimit(normalizedScope);
      const openStartedAt = Date.now();
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
        const engine = await withOpenTimeout(ZvecEngine.create(createCfg), '创建');
        const elapsed = Date.now() - openStartedAt;
        resourceMetrics.opened++;
        resourceMetrics.openMsTotal += elapsed;
        resourceMetrics.lastOpenMs = elapsed;
        resourceMetrics.openCount++;
        resourceMetrics.peakOpenCount = Math.max(resourceMetrics.peakOpenCount, resourceMetrics.openCount);
        return engine;
      }
      const engine = await withOpenTimeout(ZvecEngine.open(buildOpenConfig(normalizedScope)), '打开');
      const elapsed = Date.now() - openStartedAt;
      resourceMetrics.opened++;
      resourceMetrics.openMsTotal += elapsed;
      resourceMetrics.lastOpenMs = elapsed;
      resourceMetrics.openCount++;
      resourceMetrics.peakOpenCount = Math.max(resourceMetrics.peakOpenCount, resourceMetrics.openCount);
      return engine;
    });
  _enginePromises.set(normalizedScope, enginePromise);
  // 必须与 _enginePromises 同时登记：缺少这一步时 getEngine 的 dbPath 校验会因
  // openedAt 恒为 undefined 而永不触发，中途漂移保护形同虚设。
  _engineDbPaths.set(normalizedScope, createCfg.dbPath);
  // 若 withEngine 已预占租约，必须复用同一个对象；替换对象会让 finally
  // 递减旧引用，map 中的 activeUses 永远不归零，后续 LRU 会永久等待。
  const engineMeta = reservedMeta ?? { lastUsedAt: Date.now(), activeUses: 0, ready: false };
  engineMeta.lastUsedAt = Date.now();
  engineMeta.ready = false;
  _engineMeta.set(normalizedScope, engineMeta);
  enginePromise.then(() => {
    const meta = _engineMeta.get(normalizedScope);
    if (meta) meta.ready = true;
  }).catch(() => {});
  // 失败时重置缓存，允许下次重试
  enginePromise.catch(() => {
    if (_enginePromises.get(normalizedScope) === enginePromise) {
      _enginePromises.delete(normalizedScope);
      _engineDbPaths.delete(normalizedScope);
      _engineMeta.delete(normalizedScope);
    }
  });
  return enginePromise;
}

/**
 * 关闭 engine（terminate worker + 释放 LOCK）并重置缓存。
 * CLI per-call 命令结束时必须调用，否则 worker 线程持引用导致进程无法退出。
 */
export async function closeEngine(scope?: string): Promise<void> {
  // 传 scope 时只释放该 Collection；scope delete 等 daemon 内操作不能因为
  // 删除一个分片而关闭其他 scope 正在使用的 engine。无参仍保留全量关闭语义，
  // 供 CLI 进程收尾与 daemon shutdown 使用。
  const entries = scope
    ? [..._enginePromises.entries()].filter(([key]) => key === scope)
    : [..._enginePromises.entries()];
  for (const [key, promise] of entries) {
    // 同步清理两个 map 与 LRU 元数据：否则下次 open 时残留值可能误报漂移，
    // 或资源上限错误地把已关闭句柄算作占用。
    if (_enginePromises.get(key) === promise) _enginePromises.delete(key);
    _engineDbPaths.delete(key);
    _engineMeta.delete(key);
  }
  const promises = entries.map(([, promise]) => promise);
  if (promises.length > 0) {
    // close 也经 serializeEngineOp 串行化：worker 的 closeSync（释放 LOCK）+ terminate
    // 同样是原生操作，若与 reopen 的 probe/open 并发会触发 zvec 同进程原生竞态
    // （62% 概率永久阻塞，见 _engineOpTail 注释）。串行化后 close 与后续 open 互斥。
    await serializeEngineOp(async () => {
      try {
        for (const [key, promise] of entries) {
          const startedAt = Date.now();
          try { await (await promise).close(); } catch { /* ignore */ }
          const elapsed = Date.now() - startedAt;
          resourceMetrics.closed++;
          resourceMetrics.closeMsTotal += elapsed;
          resourceMetrics.lastCloseMs = elapsed;
          resourceMetrics.openCount = Math.max(0, resourceMetrics.openCount - 1);
        }
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

/** 为一次 withEngine 调用预占租约，覆盖首次打开和 worker 自愈重试。 */
function reserveEngineLease(scope: string): EngineMeta {
  const meta = _engineMeta.get(scope) ?? { lastUsedAt: Date.now(), activeUses: 0, ready: false };
  meta.activeUses++;
  meta.lastUsedAt = Date.now();
  _engineMeta.set(scope, meta);
  return meta;
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
async function withEngine<T>(scope: string, op: (engine: ZvecEngine) => Promise<T>): Promise<T> {
  touchEngineUse();
  _inFlightOps++;
  // 预占租约必须在 getEngine 前完成：首次打开的 promise 解析后到调用方恢复
  // 之间存在 microtask 窗口，其他 scope 不得在此期间把该句柄当作空闲 LRU。
  let leasedMeta = reserveEngineLease(scope);
  try {
    try {
      const engine = await getEngine(scope);
      const current = _engineMeta.get(scope);
      if (current && current !== leasedMeta) {
        current.activeUses++;
        current.lastUsedAt = Date.now();
        leasedMeta = current;
      }
      return await op(engine);
    } catch (err) {
      if (!isWorkerUnavailable(err)) throw err;
      // worker 已不可用（如 state=closed）：重置后重开重试一次
      // 只重置当前 scope；不同 scope 的 worker 允许并行，不能因一个分片
      // 的自愈重连而关闭其他 scope 正在执行的请求。
      await closeEngine(scope);
      // closeEngine 已移除旧 metadata；重开前重新预占，避免新句柄 ready
      // 后到 retry 调用方恢复之间再次被其他 scope 误判为空闲。
      leasedMeta = reserveEngineLease(scope);
      const engine = await getEngine(scope);
      const current = _engineMeta.get(scope);
      if (current && current !== leasedMeta) {
        current.activeUses++;
        current.lastUsedAt = Date.now();
        leasedMeta = current;
      }
      return await op(engine);
    }
  } finally {
    _inFlightOps--;
    if (leasedMeta) {
      leasedMeta.activeUses = Math.max(0, leasedMeta.activeUses - 1);
      leasedMeta.lastUsedAt = Date.now();
    }
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
export async function ensureVectorAvailable(
  scope?: string,
  opts?: { fastFail?: boolean },
): Promise<VectorAvailableResult> {
  // REQ-02：中断标记前置检测（传入 scope 时）——中断后给出可执行恢复引导（不阻断，继续执行）
  if (scope) {
    const guidance = interruptGuidance(scope);
    if (guidance) {
      process.stderr.write(`  ⚠ ${guidance}\n`);
    }
  }
  // engine 单例已存在（open 中或已 open）：等它 settle 即可，跳过 probe
  let normalizedScope: string | undefined;
  try { normalizedScope = scope ? resolveScope(loadConfig(), scope) : undefined; } catch (err) {
    return { available: false, reason: (err as Error).message, code: 'PROBE_ERROR' };
  }
  if (normalizedScope && _enginePromises.has(normalizedScope)) {
    try {
      await _enginePromises.get(normalizedScope);
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
  const embedding = getEmbeddingConfig(config);
  if (!embedding.apiKey) {
    return { available: false, reason: 'embedding.apiKey 未配置', code: 'PROBE_ERROR' };
  }
  ensureVectorLayout(config);
  if (!scope) return { available: true };
  normalizedScope = resolveScope(config, scope);
  const dbPath = getScopeCollectionPath(config, normalizedScope);
  try {
    // fastFail（scope 枚举等轻量路径）：单次 probe 不重试，撞锁立即返回不可用。
    // 轻量接口不应为等锁白耗十余秒（重试留给必须过向量层的写入/检索路径）。
    const probe = await serializeEngineOp(() =>
      opts?.fastFail ? ZvecEngine.probe(dbPath) : probeWithRetry(dbPath),
    );
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
 * scope：单个或数组；多 scope 在各 Collection fan-out 后由应用层合并。
 * tags：可选。不传/空 → 不按 tag 过滤（搜索 scope 下全部 tag）；
 * 传单个 tag 或逗号分隔多个 tag → 多 tag 以 OR 组合（复用 buildScopeTagFilter）。
 */
export async function vectorSearch(params: {
  scope?: string;
  /** 多 scope：优先于 scope；数组成员逐个 resolve（strict 模式逐个校验） */
  scopes?: string[];
  query: string;
  limit?: number;
  tags?: string | string[]; // 数组：tag 值本身可能含逗号，join/split 往返会错拆；字符串：逗号分隔多 tag
  threshold?: number;
  /** 查询 embedding 超时（ms）；未传时使用 embedding.queryTimeoutMs。 */
  timeoutMs?: number;
  /** 测试/嵌入适配器注入；生产调用不传，默认使用配置中的 provider。 */
  embeddingProvider?: Pick<EmbeddingProvider, 'embed' | 'dimension'>;
  /**
   * 降级回调（O1）：embedding 因瞬时外部问题失败、改用 FTS-only 检索时同步调用一次。
   * 调用方据此在响应上标注 degraded，避免"静默降级"被误认为语义检索正常。
   */
  onDegrade?: (reason: string) => void;
}): Promise<VectorSearchResult[]> {
  const config = loadConfig();
  const scopes = (params.scopes ?? [params.scope ?? '']).map((s) => resolveScope(config, s));
  if (scopes.length === 0) throw new Error('scope 不能为空：至少传入一个 scope');
  const tagList = Array.isArray(params.tags)
    ? params.tags
    : params.tags
      ? params.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;
  // fan-out 前只做一次 embedding；engine 侧改用预计算 vector + fts，
  // 保证多 scope 搜索不会按 scope 数量重复调用 embedding 服务。
  const existingScopes = scopes.filter((scope) => scopeCollectionExists(scope));
  if (existingScopes.length === 0) return [];
  const queryTimeoutMs = params.timeoutMs ?? config.embedding.queryTimeoutMs ?? DEFAULT_QUERY_EMBED_TIMEOUT_MS;
  // 查询向量（O3 + O1）：
  //   1) 复用 HTTP 层预计算结果——embedding 已移出 scope 占用窗口，慢 provider 不再
  //      拖同 scope 队列；预计算已失败时直接降级，不再重复等待第二个超时；
  //   2) 无预计算（CLI/stdio 等）现场 embed：短超时 + 0 重试（在线检索不接受 30s×3 长尾）；
  //   3) 瞬时外部问题（超时/网络/429/5xx）失败 → FTS-only 降级，而非整次查询失败。
  let queryVector: number[] | undefined;
  let degradeReason: string | undefined;
  const precomputed = getPrecomputedQueryVector(params.query, queryTimeoutMs);
  if (precomputed?.kind === 'vector') {
    queryVector = precomputed.vector;
  } else if (precomputed?.kind === 'failed') {
    degradeReason = precomputed.reason;
  } else {
    try {
      queryVector = await embedQueryOnce(params.query, params.embeddingProvider ?? buildEmbedding(), {
        timeoutMs: queryTimeoutMs,
        retries: QUERY_EMBED_RETRIES,
      });
    } catch (err) {
      if (!isQueryEmbedDegradable(err)) throw err;
      degradeReason = `向量检索降级为关键词检索（查询 embedding 失败：${(err as Error).message}）`;
    }
  }
  if (degradeReason !== undefined) params.onDegrade?.(degradeReason);
  const perScope = await Promise.all(existingScopes.map(async (scope) => {
    const filter = buildScopeTagFilter([scope], tagList);
    try {
      return await withEngine(scope, (engine) => engine.hybridSearch({
        ...(queryVector !== undefined ? { vector: queryVector } : {}),
        fts: params.query,
        topk: params.limit ?? 10,
        filter,
      }));
    } catch (err) {
      throw new Error(`scope "${scope}" 检索失败：${(err as Error).message}`);
    }
  }));
  const hits: Hit[] = perScope.flat();
  const normalized = hits
    .map((h) => ({
      memoryId: h.id,
      content: h.text ?? String(h.fields?.[FTS_FIELD] ?? ''),
      score: h.score,
      tag: h.fields?.[TAG_FIELD] !== undefined ? String(h.fields[TAG_FIELD]) : undefined,
      group: h.fields?.[GROUP_FIELD] !== undefined ? String(h.fields[GROUP_FIELD]) : undefined,
      scope: h.fields?.[SCOPE_FIELD] !== undefined ? String(h.fields[SCOPE_FIELD]) : undefined,
    }))
    // 降级（FTS-only）时跳过 threshold：FTS 分数尺度（BM25 量级）与混合 RRF 分数
    // （~0.01–0.03 量级）不可比，套用用户按混合分数设定的阈值会造成不可预期的空结果；
    // 宁可多返回，由上层 degraded 标记告知调用方。
    .filter((r) => degradeReason !== undefined
      || params.threshold === undefined
      || r.score >= params.threshold);
  return mergeVectorSearchHits([normalized], params.limit ?? 10);
}

/**
 * 纯全文检索：不调用 embedding，只 fan-out 查询 hybrid Collection 的 FTS 索引
 * 与独立的 FTS-only Collection。两类结果统一为 VectorSearchResult，供上层沿用
 * Group/Relation/原文反查与去重逻辑。
 */
export async function fullTextSearch(params: {
  scope?: string;
  scopes?: string[];
  query: string;
  limit?: number;
  tags?: string | string[];
}): Promise<VectorSearchResult[]> {
  const config = loadConfig();
  const scopes = (params.scopes ?? [params.scope ?? '']).map((s) => resolveScope(config, s));
  if (scopes.length === 0) throw new Error('scope 不能为空：至少传入一个 scope');
  const limit = params.limit ?? 10;
  const tagList = Array.isArray(params.tags)
    ? params.tags
    : params.tags
      ? params.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : undefined;

  const hybridScopes = scopes.filter((scope) => scopeCollectionExists(scope));
  const hybridHits = await Promise.all(hybridScopes.map(async (scope) => {
    const filter = buildScopeTagFilter([scope], tagList);
    const hits = await withEngine(scope, (engine) => engine.ftsSearch({
      match: params.query,
      topk: limit,
      filter,
    }));
    return hits.map((hit) => ({
      memoryId: hit.id,
      indexType: 'dense' as const,
      content: hit.text ?? String(hit.fields?.[FTS_FIELD] ?? ''),
      score: hit.score,
      tag: hit.fields?.[TAG_FIELD] !== undefined ? String(hit.fields[TAG_FIELD]) : undefined,
      group: hit.fields?.[GROUP_FIELD] !== undefined ? String(hit.fields[GROUP_FIELD]) : undefined,
      scope: hit.fields?.[SCOPE_FIELD] !== undefined ? String(hit.fields[SCOPE_FIELD]) : scope,
    } satisfies VectorSearchResult));
  }));

  const ftsOnlyHits = await Promise.all(scopes.flatMap((scope) => {
    const requestedTags = tagList && tagList.length > 0 ? tagList : [undefined];
    return requestedTags.map(async (tag) => {
      const hits = await ftsOnlySearch({ scope, query: params.query, limit, tag });
      return hits.map((hit) => ({
        memoryId: hit.ftsId,
        indexType: 'fts' as const,
        ftsId: hit.ftsId,
        content: hit.content,
        score: hit.score,
        tag: hit.tag,
        group: hit.group,
        scope: hit.scope ?? scope,
      } satisfies VectorSearchResult));
    });
  }));

  return mergeVectorSearchHits([...hybridHits, ...ftsOnlyHits], limit);
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
  const result = await withEngine(scope, (engine) => engine.upsert([{
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
}, options: VectorBulkStoreOptions = {}): Promise<VectorBulkStoreResult> {
  if (params.entries.length === 0) {
    return { total: 0, totalItems: 0, attempted: 0, succeeded: 0, failed: 0, cancelledItems: 0, results: [] };
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

  // 相同 text+scope+tag 会生成同一个幂等 docId。调度器要求批内 docId
  // 唯一，因此按最终 docId 合并请求；结果仍按原始 entries 回映射。
  // 保留最后一次 fields，使行为与旧的顺序 upsert 一致。
  const uniqueDocs: typeof docs = [];
  const uniqueById = new Map<string, number>();
  for (const doc of docs) {
    const existingIndex = uniqueById.get(doc.id);
    if (existingIndex === undefined) {
      uniqueById.set(doc.id, uniqueDocs.length);
      uniqueDocs.push(doc);
    } else {
      uniqueDocs[existingIndex] = doc;
    }
  }

  const writeOptions: ZvecWriteOptions = {
    scheduler: getEmbeddingSchedulerRuntime(options.scheduler),
    abortSignal: options.abortSignal,
    onProgress: options.onProgress,
    onBatchPersisted: options.onBatchPersisted,
  };
  const result = await withEngine(scope, (engine) => engine.upsert(uniqueDocs, writeOptions));

  // 组装逐项结果（WriteResult.errors 按 doc id 定位）
  const errorById = new Map<string, string>();
  for (const e of result.errors ?? []) {
    errorById.set(e.id, e.reason);
  }
  const cancelledIds = new Set(result.cancelledItems ?? []);
  const failedIds = new Set(result.failedItems ?? []);
  const metadataPendingIds = new Set(result.metadataPendingItems ?? []);
  const results: BulkStoreItemResult[] = docs.map((d, i) => {
    const err = errorById.get(d.id);
    if (cancelledIds.has(d.id)) {
      return { index: i, success: false, error: '向量化已取消，条目尚未提交' };
    }
    if (metadataPendingIds.has(d.id)) {
      return { index: i, success: false, error: 'zvec 已写入但元数据尚未完成，请重试元数据回写' };
    }
    if (failedIds.has(d.id)) {
      return { index: i, success: false, error: '批次持久化失败，后续批次已停止' };
    }
    return err
      ? { index: i, success: false, error: err }
      : { index: i, memoryId: d.id, success: true };
  });

  const succeeded = results.filter((item) => item.success).length;
  const cancelled = results.filter((item) => cancelledIds.has(docs[item.index].id)).length;
  const metadataPending = results.filter((item) => metadataPendingIds.has(docs[item.index].id)).length;
  const failed = results.length - succeeded - cancelled - metadataPending;
  const attempted = results.length - cancelled;
  const status: VectorBulkStoreResult['status'] = cancelled > 0
    ? (succeeded > 0 ? 'partial' : 'cancelled')
    : failed > 0 || metadataPending > 0
      ? (succeeded > 0 ? 'partial' : 'failed')
      : 'succeeded';

  return {
    total: params.entries.length,
    totalItems: params.entries.length,
    attempted,
    succeeded,
    failed,
    results,
    metadataPending,
    metadataPendingItems: result.metadataPendingItems,
    cancelled,
    cancelledItems: result.cancelled,
    failedItems: result.failedItems,
    status,
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
  const scope = resolveScope(loadConfig(), params.scope);
  const result = await withEngine(scope, (engine) => engine.delete(params.ids));
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
 * 构建 scope + tag 过滤：scope 单值必等 / 多值 OR；tags 非空时多 tag 以 OR 组合。
 * tags 为空/未传 → 不按 tag 过滤（覆盖该（些）scope 下全部 tag）。
 */
function buildScopeTagFilter(scopes: string[], tags?: string[]): Filter {
  if (scopes.length === 0) throw new Error('scope 不能为空：至少传入一个 scope');
  const scopeConds: Filter[] = scopes.map((s) => ({ field: SCOPE_FIELD, op: '==', value: s }));
  const scopeCond: Filter = scopeConds.length === 1 ? scopeConds[0] : { or: scopeConds };
  const cleaned = (tags ?? []).map((t) => normalizeTag(t)).filter((t) => t.length > 0);
  if (cleaned.length === 0) return scopeCond;
  const tagConds: Filter[] = cleaned.map((t) => ({ field: TAG_FIELD, op: '==', value: t }));
  const tagFilter: Filter = tagConds.length === 1 ? tagConds[0] : { or: tagConds };
  return { and: [scopeCond, tagFilter] };
}

/** 只读路径使用：不存在/空 Collection 视为空 scope，避免查询意外创建新库。 */
function scopeCollectionExists(scope: string): boolean {
  const config = loadConfig();
  const dbPath = getScopeCollectionPath(config, scope);
  try {
    return fs.statSync(dbPath).isDirectory() && fs.readdirSync(dbPath).length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * 找出「已解析为合法 scope、但 Collection 目录不存在或为空」的 scope。
 *
 * vectorSearch 的 fan-out 会静默过滤掉这些 scope（避免查询意外创建新库），
 * 但过滤本身就是一次静默漏召回：调用方必须能拿到名单并显式告知用户，
 * 否则“迁移未完成 / 目录被外部删除”会表现为“搜不到”，无任何可诊断信息。
 */
export function findMissingScopeCollections(scopes: string[]): string[] {
  return scopes.filter((scope) => !scopeCollectionExists(scope));
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
  if (!scopeCollectionExists(params.scope)) return [];
  const filter = buildScopeTagFilter([params.scope], params.tags);
  return withEngine(params.scope, async (engine) => {
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
  const config = loadConfig();
  ensureVectorLayout(config);
  const root = getCollectionsRoot(config);
  if (!fs.existsSync(root)) return [];
  const scopes = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((scope) => /^[a-zA-Z0-9_-]+$/.test(scope));
  const found: VectorDocInfo[] = [];
  for (const scope of scopes) {
    if (!scopeCollectionExists(scope)) continue;
    const docs = await withEngine(scope, (engine) => engine.fetch(ids, false));
    found.push(...docs.map(toDocInfo));
    if (found.length >= ids.length) break;
  }
  return found;
}

/**
 * 枚举向量层出现过的所有 scope（distinct）。
 * 引擎无 distinct/count API：listIds 全量 + fetch 取 scope 字段去重，
 * 受 scanLimit 约束（默认 10000）——大库下为"已扫描范围内"的 scope。
 */
export async function vectorListScopes(scanLimit: number = LIST_ALL_LIMIT): Promise<string[]> {
  void scanLimit;
  const config = loadConfig();
  ensureVectorLayout(config);
  if (!fs.existsSync(getCollectionsRoot(config))) return [];
  return fs.readdirSync(getCollectionsRoot(config), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name))
    .map((entry) => entry.name);
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
  if (!scopeCollectionExists(params.scope)) return { tags: [], scanned: 0, truncated: false };
  const limit = params.scanLimit ?? LIST_ALL_LIMIT;
  const scopeCond: Filter = { field: SCOPE_FIELD, op: '==', value: params.scope };
  return withEngine(params.scope, async (engine) => {
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
  if (!scopeCollectionExists(params.scope)) return 0;
  const filter = buildScopeTagFilter([params.scope], params.tags);
  return withEngine(params.scope, (engine) => engine.listIds(filter, LIST_ALL_LIMIT).then((ids) => ids.length));
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
  if (!scopeCollectionExists(params.scope)) return { deleted: 0 };
  const filter = buildScopeTagFilter([params.scope], params.tags);
  return withEngine(params.scope, async (engine) => {
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
