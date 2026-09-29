/**
 * engine.ts —— ZvecEngine 门面
 *
 * 与设计文档对齐：S-06 §3 / §4a / §4b / §5
 *
 * 编排：
 *   - create/open 静态工厂：S-01 validator + builder → S-04 proxy.spawn
 *   - 写入：按是否需 embed 切分 → S-03 embed → Float32Array 转换 → proxy.send
 *   - 检索：S-05 router 路由 → 必要时 embed → proxy.send → S-05 normalize
 *   - 生命周期：close / destroy / isHealthy / isLocked / isOpen / probe
 */

import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isAbsolute } from 'node:path';
import {
  CollectionCorruptedException,
  CollectionLockedException,
  CollectionNotFoundError,
  DimensionMismatchError,
  InconsistentUpdateError,
  InvalidDocInputError,
  InvalidSchemaError,
  WorkerCrashedError,
  ZvecEngineError,
  classifyVectorizationStop,
} from './errors.js';
import { compileFilter, buildAllowedFields } from './filter/compiler.js';
import type { EmbeddingProvider } from './embedding/provider.js';
import { isSplittableParameterError, parseProviderBatchLimit } from './embedding/batch-scheduler.js';
import { ZvecEngineProxy } from './proxy.js';
import { routeSearch, type RouterContext } from './search/router.js';
import { toHit } from './search/normalize.js';
import { validateCreateConfig, validateOpenConfig } from './schema/validator.js';
import type {
  CollectionInfo,
  Doc,
  DocInput,
  Filter,
  FtsSearchReq,
  Hit,
  HybridSearchReq,
  PersistedSchema,
  ProbeResult,
  ScalarValue,
  SemanticSearchReq,
  VectorSearchReq,
  WriteErrorCode,
  WriteResult,
  VectorWriteBatchPersistedEvent,
  ZvecWriteOptions,
  ZvecEngineConfig,
  ZvecEngineOpenConfig,
} from './types.js';
import type {
  DocPayload,
  InfoResultPayload,
  MultiQueryPayload,
  QueryPayload,
  RawHitPayload,
  WriteDocPayload,
  WritePayload,
  WriteResultPayload,
} from './worker-protocol.js';

const DEFAULT_WRITE_BATCH_SIZE = 100;
const DEFAULT_LIST_IDS_LIMIT = 10_000;
// embedding 小批大小：失败粒度 = 小批（S-03 §3.2/§4a.2）。与 SiliconFlowProvider 默认 batchSize 对齐，
// 使 engine 的每个失败单元恰好对应 provider 的一次 HTTP 调用。
const EMBED_BATCH_SIZE = 64;

export class ZvecEngine {
  private readonly proxy: ZvecEngineProxy;
  private readonly embedding?: EmbeddingProvider;
  private readonly dbPath: string;
  private schema: PersistedSchema;
  private routerCtx: RouterContext;
  private allowedFields: ReadonlySet<string>;
  private destroyed = false;

  private constructor(
    proxy: ZvecEngineProxy,
    embedding: EmbeddingProvider | undefined,
    dbPath: string,
    schema: PersistedSchema,
  ) {
    this.proxy = proxy;
    this.embedding = embedding;
    this.dbPath = dbPath;
    this.schema = schema;
    this.routerCtx = {
      denseField: schema.denseField,
      ftsField: schema.fts?.field,
      dimension: schema.dimension,
    };
    this.allowedFields = buildAllowedFields(schema.scalarFields, schema.fts?.field);
  }

  // ─── 静态工厂 ───

  static async create(config: ZvecEngineConfig): Promise<ZvecEngine> {
    assertAbsolutePath(config.dbPath);
    const dbPathExists = existsSync(config.dbPath);
    validateCreateConfig(config, dbPathExists);

    const proxy = new ZvecEngineProxy();
    try {
      const schema = await proxy.spawn(config, 'create');
      return new ZvecEngine(proxy, config.embedding, config.dbPath, schema);
    } catch (err) {
      await proxy.terminate();
      throw err;
    }
  }

  static async open(config: ZvecEngineOpenConfig): Promise<ZvecEngine> {
    assertAbsolutePath(config.dbPath);
    // 预检路径存在性（zvec ZVecOpen 对不存在路径会阻塞，提前失败）
    if (!existsSync(config.dbPath)) {
      throw new CollectionNotFoundError(
        `collection not found: ${config.dbPath}`,
        { data: { dbPath: config.dbPath } },
      );
    }

    const proxy = new ZvecEngineProxy();
    try {
      const schema = await proxy.spawn(config, 'open');
      validateOpenConfig(config, schema);
      return new ZvecEngine(proxy, config.embedding, config.dbPath, schema);
    } catch (err) {
      await proxy.terminate();
      throw err;
    }
  }

  /**
   * tryOpen 仅用于"能否用"的布尔判断；任意 open 失败返回 null 不抛。
   * 若需判别失败原因，请用 `open`（拿类型化异常）或 `probe`（拿 ProbeResult）。
   */
  static async tryOpen(config: ZvecEngineOpenConfig): Promise<ZvecEngine | null> {
    try {
      return await ZvecEngine.open(config);
    } catch {
      return null;
    }
  }

  /**
   * 无句柄探测 dbPath 状态（不存在/被持锁/健康/损坏）
   *
   * 实现注：zvec `ZVecOpen` 在持锁时**会阻塞等待**而非立即抛错，
   * 故 probe 加超时（默认 3s）：超时即判定为 locked。
   */
  static async probe(dbPath: string, timeoutMs: number = 3000): Promise<ProbeResult> {
    assertAbsolutePath(dbPath);
    if (!existsSync(dbPath)) {
      return { exists: false, locked: false, healthy: false, error: 'NOT_FOUND' };
    }
    // 空目录预检：目录存在但无任何集合文件 → 视为不存在（NOT_FOUND）。
    // 背景：zvec 原生 ZVecOpen 对空目录会挂起不返回，若直接 open 将触发
    // 超时并被误判为 locked（实测约 5s 返回 locked:true），导致「空库」永远
    // 无法走 create 自愈路径。读取失败时保守跳过预检，回退原 open 逻辑。
    try {
      if (readdirSync(dbPath).length === 0) {
        return { exists: false, locked: false, healthy: false, error: 'NOT_FOUND' };
      }
    } catch {
      /* 目录不可读：回退原 probe 路径 */
    }

    const probeProxy = new ZvecEngineProxy();
    // openPromise 必须在 try 外声明：超时/异常路径要拿它判断 worker 是否已落定，
    // 据此决定"安全 close"还是"登记孤儿"，避免 terminate 掉已持锁的 worker。
    const openPromise = probeProxy.spawn(
      { dbPath, collectionName: '', embedding: dummyEmbeddingProvider, readOnly: true },
      'open',
    );
    try {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new ProbeTimeoutError('probe timeout')), timeoutMs),
      );
      await Promise.race([openPromise, timeoutPromise]);
      // 先经 worker closeSync 释放句柄/LOCK 再 terminate：直接 terminate 不会触发
      // 原生 close，会泄漏 rocksdb 后台线程与文件锁（常驻进程内永久泄漏）
      await closeProbeProxyNow(probeProxy);
      return { exists: true, locked: false, healthy: true };
    } catch (err) {
      if (err instanceof ProbeTimeoutError) {
        // 超时未返回 → 判定为锁占用（zvec 持锁时 ZVecOpen 阻塞）。
        // 此刻 worker 仍卡在原生 ZVecOpen 内：绝不能 terminate（它可能刚拿到 flock），
        // 登记孤儿等它落定后立即 close 释放 LOCK；本次立即返回，不阻塞调用方重试。
        registerProbeOrphan(probeProxy, openPromise);
        return { exists: true, locked: true, healthy: true };
      }
      // 非超时错误 = open 已落定（拒绝），无锁可泄，可直接安全关闭。
      await closeProbeProxyNow(probeProxy);
      if (err instanceof CollectionLockedException) {
        return { exists: true, locked: true, healthy: true };
      }
      if (err instanceof CollectionCorruptedException) {
        return { exists: true, locked: false, healthy: false, error: 'CORRUPTED' };
      }
      if (err instanceof CollectionNotFoundError) {
        return { exists: false, locked: false, healthy: false, error: 'NOT_FOUND' };
      }
      return { exists: true, locked: false, healthy: false, error: 'UNKNOWN' };
    }
  }

  // ─── 生命周期 ───

  async info(): Promise<CollectionInfo> {
    const info = await this.proxy.send<InfoResultPayload>('info', {});
    return {
      name: info.name,
      dimension: info.dimension,
      ...(info.metric ? { metric: info.metric as 'COSINE' } : {}),
      ...(info.denseDataType ? { denseDataType: info.denseDataType as 'FP32' | 'FP16' } : {}),
      docCount: info.docCount,
      scalarFields: info.scalarFields,
      fts: info.fts,
      locked: false,
    };
  }

  async close(): Promise<void> {
    await this.proxy.close();
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    await this.proxy.send('destroy', { dbPath: this.dbPath });
    await this.proxy.terminate();
  }

  isHealthy(): boolean {
    return this.proxy.isOpen() && !this.destroyed;
  }

  isLocked(): boolean {
    // 本实例持锁时返回 false；"是否被其他进程持锁"语义仅 probe 提供
    return false;
  }

  isOpen(): boolean {
    return this.proxy.isOpen();
  }

  // ─── 写入 ───

  async upsert(docs: DocInput[], options?: ZvecWriteOptions): Promise<WriteResult> {
    return this.writeDocs(docs, 'upsert', options);
  }

  async insert(docs: DocInput[], options?: ZvecWriteOptions): Promise<WriteResult> {
    return this.writeDocs(docs, 'insert', options);
  }

  async update(docs: DocInput[], options?: ZvecWriteOptions): Promise<WriteResult> {
    // Z-03 / v6 契约：更新必须提供 text（FTS-only）或 vector/text（hybrid）；
    // scalar-only update 无法保证索引同步。
    for (const d of docs) {
      if (d.vector === undefined && d.text === undefined) {
        throw new InconsistentUpdateError(
          `update doc "${d.id}": dense vector or text is required (provide text, or vector for hybrid collection; scalar-only update is not supported)`,
          { data: { id: d.id } },
        );
      }
    }
    // 仅 vector 不传 text 且配 FTS → InconsistentUpdateError
    if (this.schema.fts) {
      for (const d of docs) {
        if (d.vector !== undefined && d.text === undefined) {
          throw new InconsistentUpdateError(
            `update doc "${d.id}": providing vector without text would desync FTS index (collection has fts config)`,
            { data: { id: d.id } },
          );
        }
      }
    }
    return this.writeDocs(docs, 'update', options);
  }

  async delete(ids: string[]): Promise<WriteResult> {
    const result = await this.proxy.send<WriteResultPayload>('delete', { ids });
    return toWriteResult(result);
  }

  async fetch(ids: string[], includeVector = false): Promise<Doc[]> {
    const result = await this.proxy.send<DocPayload[]>('fetch', { ids, includeVector });
    return result.map((d) => ({
      id: d.id,
      fields: d.fields,
      text: d.text,
      vector: d.vector ? Array.from(d.vector) : undefined,
    }));
  }

  async listIds(filter?: Filter, limit: number = DEFAULT_LIST_IDS_LIMIT): Promise<string[]> {
    const filterSql = filter ? compileFilter(filter, this.allowedFields) : undefined;
    return this.proxy.send<string[]>('listIds', { filterSql, limit });
  }

  // ─── 检索 ───

  async semanticSearch(req: SemanticSearchReq): Promise<Hit[]> {
    return this.search({ ...req });
  }

  async vectorSearch(req: VectorSearchReq): Promise<Hit[]> {
    return this.search({ ...req });
  }

  async ftsSearch(req: FtsSearchReq): Promise<Hit[]> {
    return this.search({ ...req });
  }

  async hybridSearch(req: HybridSearchReq): Promise<Hit[]> {
    return this.search({ ...req });
  }

  // ─── 索引 ───

  async createIndex(field: string, indexParam: object): Promise<void> {
    await this.proxy.send('createIndex', { field, indexParam });
  }

  async dropIndex(field: string): Promise<void> {
    await this.proxy.send('dropIndex', { field });
  }

  async optimize(): Promise<void> {
    await this.proxy.send('optimize', {});
  }

  // ─── 内部：写入编排 ───

  private async writeDocs(
    docs: DocInput[],
    mode: 'upsert' | 'insert' | 'update',
    options: ZvecWriteOptions = {},
  ): Promise<WriteResult> {
    this.assertWritable();

    if (docs.length === 0) return { ok: 0, failed: 0 };

    // 按是否需 embed 切分（S-06 §3.3）
    const needsEmbed: DocInput[] = [];
    const noEmbed: DocInput[] = [];
    for (const d of docs) {
      if (d.text !== undefined && d.vector === undefined && this.schema.denseField && this.embedding) {
        needsEmbed.push(d);
      } else {
        noEmbed.push(d);
      }
    }

    // Open 阶段允许 embedding 配置与持久化 schema 暂时不同，以支持 FTS/读取/删除；
    // 但任何需要 dense embedding 的写入必须在调用 provider 前拒绝维度不匹配。
    if (
      needsEmbed.length > 0
      && this.schema.dimension !== undefined
      && this.embedding
      && this.embedding.dimension !== this.schema.dimension
    ) {
      throw new DimensionMismatchError(
        `embedding.dimension (${this.embedding.dimension}) !== persisted dimension (${this.schema.dimension})`,
        { data: { embeddingDim: this.embedding.dimension, persistedDim: this.schema.dimension } },
      );
    }

    const allErrors: Array<{ id: string; code: WriteErrorCode; reason: string }> = [];

    // 新调度路径：provider 批次可并行，批次完成后进入同一 writer 链；
    // 不传 scheduler 的旧调用继续走下方稳定的串行实现。
    if (options.scheduler && needsEmbed.length > 0) {
      return this.writeDocsWithScheduler(docs, mode, needsEmbed, noEmbed, allErrors, options);
    }

    // embed needsEmbed：engine 自己按批切分、逐批 embed（S-03 §4a.2 步骤 2-3）。
    // 小批为最小失败单元：某批抛错只把该批 doc 标 EMBEDDING_FAILED，其余批次与 noEmbed 组不受影响，
    // 兑现「失败项进 errors[]，成功项正常写入」契约（S-03 §+6），避免单次抖动导致整批静默存 0。
    //
    // provider 可能对单请求 inputs 数设硬上限（实测阿里云百炼兼容模式为 25）：此时固定的 64 条切分
    // 会被整批 400 拒绝，上面的"失败粒度"保护完全失效（一次 400 让 64 条全部判失败）。
    // 故命中「批次超限」类 4xx 时按 provider 声明的上限下调本进程后续批大小并重试本片——一次自愈，
    // 不把已能成功的文本判失败（与 batch-scheduler 的降批策略同源）。
    let effectiveEmbedBatchSize = EMBED_BATCH_SIZE;
    const embeddedVectors = new Map<string, number[]>();
    const notProcessedDocs: DocInput[] = [];
    let stopReason: WriteResult['stopReason'];
    for (let start = 0; start < needsEmbed.length; ) {
      const size = Math.min(effectiveEmbedBatchSize, needsEmbed.length - start);
      const batch = needsEmbed.slice(start, start + size);
      // 批内去重（M5）：相同 text 只需 embed 一次，向量复用给所有同文本 doc。
      // 同文本必产出同向量，故语义完全一致；仅消除重复 embedding HTTP 调用
      // （sync-relation 多 tag 场景：同一 moduleInfo 打 N 个 tag → N 个 doc 同 text，原先被 embed N 次）。
      // 去重只在批内进行（批间跨 batch 相同文本不合并，避免失败粒度从「小批」上浮到「整批」）。
      const uniqueByText = new Map<string, DocInput>();
      const order: string[] = [];
      for (const d of batch) {
        if (!uniqueByText.has(d.text!)) {
          uniqueByText.set(d.text!, d);
          order.push(d.text!);
        }
      }
      const uniqueTexts = order;
      try {
        // 传 batchSize 使 provider 不再二次细分，令失败粒度恰好等于本批
        if (!this.embedding) throw new InvalidDocInputError('embedding provider is required for vectorized writes');
        const vectors = await this.embedding.embed(uniqueTexts, { batchSize: uniqueTexts.length });
        const vectorByText = new Map<string, number[]>();
        for (let i = 0; i < vectors.length; i++) {
          vectorByText.set(uniqueTexts[i], vectors[i]);
        }
        for (const d of batch) {
          const vec = vectorByText.get(d.text!);
          if (vec) embeddedVectors.set(d.id, vec);
        }
        start += size;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        // provider 声明了更小的单请求上限：降批重试本片（不改判失败），下一次循环用新的批大小
        const declaredLimit = parseProviderBatchLimit(error);
        if (declaredLimit !== undefined && declaredLimit < size) {
          effectiveEmbedBatchSize = declaredLimit;
          continue;
        }
        const reason = error.message;
        for (const d of batch) {
          allErrors.push({ id: d.id, code: 'EMBEDDING_FAILED', reason });
        }
        start += size;
        // 明确属于单条内容参数错误时，沿用既有逐批隔离行为；其余错误视为
        // provider/配置等系统性故障，停止发起后续批次并明确标记未处理项。
        if (!isSplittableParameterError(error)) {
          stopReason = classifyVectorizationStop(error, 'embedding');
          notProcessedDocs.push(...needsEmbed.slice(start));
          break;
        }
      }
    }

    // 组装待写 docs（embed 成功 + noEmbed）
    // embed 失败的 doc 已在 allErrors 中标记，跳过不再写入
    const embedFailedIds = new Set(
      allErrors.filter((e) => e.code === 'EMBEDDING_FAILED').map((e) => e.id),
    );
    const notProcessedIds = new Set([
      ...notProcessedDocs.map((doc) => doc.id),
      ...(stopReason ? noEmbed.map((doc) => doc.id) : []),
    ]);
    const toWrite: WriteDocPayload[] = [];
    for (const d of [...needsEmbed, ...noEmbed]) {
      if (embedFailedIds.has(d.id) || notProcessedIds.has(d.id)) continue;
      const vector = embeddedVectors.get(d.id) ?? d.vector;
      // 校验：写入路径必须至少有 vector 或 text（upsert/insert）
      // update 模式的输入校验由 update() 入口负责（Z-03：缺 dense vector 抛 InconsistentUpdateError）
      if (mode !== 'update' && vector === undefined && d.text === undefined) {
        allErrors.push({
          id: d.id,
          code: 'UNKNOWN',
          reason: 'doc must provide at least one of text/vector',
        });
        continue;
      }
      // 校验：FTS-only collection 不接受 dense vector；hybrid collection 校验维度。
      if (vector !== undefined && this.schema.dimension === undefined) {
        throw new InvalidDocInputError(
          `doc "${d.id}" provides a vector but collection has no dense vector field`,
          { data: { id: d.id } },
        );
      }
      if (vector !== undefined && this.schema.dimension !== undefined && vector.length !== this.schema.dimension) {
        throw new DimensionMismatchError(
          `doc "${d.id}" vector dimension ${vector.length} !== collection dimension ${this.schema.dimension}`,
          { data: { id: d.id, expected: this.schema.dimension, actual: vector.length } },
        );
      }
      // 校验：fields 字段白名单
      if (d.fields) {
        for (const k of Object.keys(d.fields)) {
          if (!this.allowedFields.has(k)) {
            throw new InvalidDocInputError(
              `doc "${d.id}" field "${k}" not declared in scalarFields`,
              { data: { id: d.id, field: k } },
            );
          }
        }
      }
      toWrite.push({
        id: d.id,
        text: d.text,
        vector: vector ? Float32Array.from(vector) : undefined,
        fields: d.fields,
      });
    }

    // 发 worker
    let writeResult: WriteResultPayload = { ok: 0, failed: 0, errors: [] };
    if (toWrite.length > 0) {
      const payload: WritePayload = { docs: toWrite, batchSize: DEFAULT_WRITE_BATCH_SIZE };
      writeResult = await this.proxy.send<WriteResultPayload>(mode, payload);
    }

    // 聚合 errors
    const zvecErrors = (writeResult.errors ?? []).map((e) => ({
      id: e.id,
      code: e.code as WriteErrorCode,
      reason: e.reason,
    }));
    const merged = [...allErrors, ...zvecErrors];
    const failed = writeResult.failed + allErrors.length;
    const notProcessedItems = [...notProcessedIds];
    const systemicWriteError = zvecErrors.find((error) => error.code === 'ZVEC_WRITE_ERROR');
    if (systemicWriteError && !stopReason) {
      stopReason = classifyVectorizationStop(
        Object.assign(new Error(systemicWriteError.reason || 'zvec collection write failed'), { code: 'ZVEC_WRITE_ERROR' }),
        'persist',
      );
    }
    return {
      ok: writeResult.ok,
      failed,
      attempted: docs.length - notProcessedItems.length,
      notProcessed: notProcessedItems.length,
      notProcessedItems: notProcessedItems.length > 0 ? notProcessedItems : undefined,
      status: stopReason ? 'failed' : writeResult.ok === docs.length ? 'succeeded' : writeResult.ok > 0 ? 'partial' : failed > 0 ? 'failed' : 'succeeded',
      stopReason,
      errors: merged.length > 0 ? merged : undefined,
    };
  }

  /**
   * 有界并行 embedding + 单 writer 持久化。
   * provider 失败按批转换为逐项 EMBEDDING_FAILED；zvec/回调异常则交给
   * scheduler 触发 failure-drain，禁止继续提交新的 payload。
   */
  private async writeDocsWithScheduler(
    docs: DocInput[],
    mode: 'upsert' | 'insert' | 'update',
    needsEmbed: DocInput[],
    noEmbed: DocInput[],
    allErrors: Array<{ id: string; code: WriteErrorCode; reason: string }>,
    options: ZvecWriteOptions,
  ): Promise<WriteResult> {
    let persisted = 0;
    let metadataPending = 0;
    let failed = 0;
    const metadataPendingItems: string[] = [];
    let fatalWriteError: Error | undefined;
    let writerTail: Promise<import('./embedding/batch-scheduler.js').BatchPersistOutcome> = Promise.resolve({ persisted: 0, failed: 0 });

    const validateAndBuild = (doc: DocInput, vector: number[] | undefined): WriteDocPayload => {
      if (mode !== 'update' && vector === undefined && doc.text === undefined) {
        throw new InvalidDocInputError(`doc "${doc.id}" must provide at least one of text/vector`);
      }
      if (vector !== undefined && this.schema.dimension === undefined) {
        throw new InvalidDocInputError(
          `doc "${doc.id}" provides a vector but collection has no dense vector field`,
          { data: { id: doc.id } },
        );
      }
      if (vector !== undefined && this.schema.dimension !== undefined && vector.length !== this.schema.dimension) {
        throw new DimensionMismatchError(
          `doc "${doc.id}" vector dimension ${vector.length} !== collection dimension ${this.schema.dimension}`,
          { data: { id: doc.id, expected: this.schema.dimension, actual: vector.length } },
        );
      }
      if (doc.fields) {
        for (const key of Object.keys(doc.fields)) {
          if (!this.allowedFields.has(key)) {
            throw new InvalidDocInputError(
              `doc "${doc.id}" field "${key}" not declared in scalarFields`,
              { data: { id: doc.id, field: key } },
            );
          }
        }
      }
      return {
        id: doc.id,
        text: doc.text,
        vector: vector ? Float32Array.from(vector) : undefined,
        fields: doc.fields,
      };
    };

    const persistBatch = async (
      batch: import('./embedding/batch-scheduler.js').EmbeddingBatch<DocInput>,
    ): Promise<import('./embedding/batch-scheduler.js').BatchPersistOutcome> => {
      if (fatalWriteError) throw fatalWriteError;
      if (batch.error) {
        for (const item of batch.items) {
          allErrors.push({ id: item.docId, code: 'EMBEDDING_FAILED', reason: batch.error.message });
        }
        failed += batch.items.length;
        options.onProgress?.({ phase: 'embedding', done: persisted + failed, total: docs.length, persisted, failed, metadataPending });
        return { persisted: 0, failed: batch.items.length };
      }

      const payloadDocs: WriteDocPayload[] = [];
      const payloadItems: Array<{ id: string; inputIndex: number }> = [];
      let embeddingFailed = 0;
      for (let i = 0; i < batch.items.length; i++) {
        const item = batch.items[i];
        const vector = batch.vectors[i];
        if (!vector) {
          allErrors.push({
            id: item.docId,
            code: 'EMBEDDING_FAILED',
            reason: batch.itemErrors?.[i]?.message ?? 'Embedding 未返回向量',
          });
          embeddingFailed++;
          failed++;
          continue;
        }
        payloadDocs.push(validateAndBuild(item.item, vector));
        payloadItems.push({ id: item.docId, inputIndex: item.inputIndex });
      }
      if (payloadDocs.length === 0) {
        options.onProgress?.({ phase: 'persist', done: persisted + failed, total: docs.length, persisted, failed, metadataPending });
        return { persisted: 0, failed: embeddingFailed };
      }

      const writeResult = await this.proxy.send<WriteResultPayload>(mode, {
        docs: payloadDocs,
        batchSize: DEFAULT_WRITE_BATCH_SIZE,
      });
      const zvecErrors = new Map((writeResult.errors ?? []).map((error) => [error.id, error]));
      for (const error of zvecErrors.values()) {
        allErrors.push({ id: error.id, code: error.code as WriteErrorCode, reason: error.reason });
      }
      const zvecPersisted = Math.max(0, writeResult.ok);
      const zvecFailed = Math.max(0, writeResult.failed);
      persisted += zvecPersisted;
      failed += zvecFailed;

      let batchMetadataPending = 0;
      if (options.onBatchPersisted && zvecPersisted > 0 && zvecFailed === 0) {
        const event: VectorWriteBatchPersistedEvent = {
          sequence: batch.batchIndex,
          items: payloadItems
            .filter((item) => !zvecErrors.has(item.id))
            .map((item) => ({ docId: item.id, inputIndex: item.inputIndex, memoryId: item.id })),
          zvecPersisted,
          failed: zvecFailed,
        };
        const successfulItems = event.items;
        try {
          const outcome = await options.onBatchPersisted(event, batch);
          // metadata 回调若报告任意 pending，按设计将整个 callback batch
          // 视为待补偿，避免没有逐项事务结果时误报部分条目已完全成功。
          batchMetadataPending = outcome?.metadataPending && outcome.metadataPending > 0
            ? successfulItems.length
            : 0;
        } catch (err) {
          // zvec 已成功但元数据不是同一事务；保留幂等重试入口，且停止后续批次。
          batchMetadataPending = zvecPersisted;
          metadataPending += batchMetadataPending;
          persisted -= batchMetadataPending;
          metadataPendingItems.push(...successfulItems.map((item) => item.docId));
          throw Object.assign(new Error(`批次元数据回调失败（${zvecPersisted} 条已写入 zvec）：${(err as Error).message}`), {
            code: 'METADATA_PERSIST_FAILED',
          });
        }
        if (batchMetadataPending > 0) {
          metadataPending += batchMetadataPending;
          persisted -= batchMetadataPending;
        }
      }
      const systemicWriteError = (writeResult.errors ?? []).find((error) => error.code === 'ZVEC_WRITE_ERROR');
      if (systemicWriteError) {
        fatalWriteError = Object.assign(new Error(
          systemicWriteError.reason || `zvec 批次持久化失败（成功 ${zvecPersisted}，失败 ${zvecFailed}），已停止后续批次`,
        ), {
          code: 'ZVEC_WRITE_ERROR',
        });
      }
      options.onProgress?.({ phase: 'persist', done: persisted + failed + metadataPending, total: docs.length, persisted, failed, metadataPending });
      return {
        persisted: zvecPersisted - batchMetadataPending,
        failed: embeddingFailed + zvecFailed,
        metadataPending: batchMetadataPending,
      };
    };

    const scheduler = options.scheduler;
    if (!scheduler) throw new Error('内部错误：调度器未提供');
    if (!this.embedding) throw new InvalidDocInputError('embedding provider is required for vectorized writes');
    const scheduleOutcome = await scheduler.schedule(this.embedding, needsEmbed, {
      getText: (doc) => doc.text!,
      getDocId: (doc) => doc.id,
      dedupeKey: (doc) => doc.text!,
      abortSignal: options.abortSignal,
      onBatchComplete: (batch) => {
        const current = writerTail.then(() => persistBatch(batch));
        writerTail = current;
        return current;
      },
    });
    try {
      await writerTail;
    } catch {
      // scheduler 已把 writer 失败转换为 failure-drain 结果；这里继续汇总，
      // 让调用方拿到逐项 failed/cancelled，而不是丢失批次级诊断。
    }
    // 最后一批没有后续 writer 回调触发 fatalWriteError 守门时，也要把系统性
    // zvec 失败写入任务终态；否则结果会被误报为普通部分成功。
    if (fatalWriteError) {
      scheduleOutcome.fatalError ??= fatalWriteError;
      scheduleOutcome.stopReason ??= classifyVectorizationStop(fatalWriteError, 'persist');
    }

    const cancelledItems = scheduleOutcome.cancelledItems.map((item) => item.docId);
    const notProcessedItems = scheduleOutcome.notProcessedItems.map((item) => item.docId);
    // noEmbed 文档不需要 provider；仍沿用同一 zvec writer 进行一次持久化。
    if (!scheduleOutcome.fatalError && !options.abortSignal?.aborted && noEmbed.length > 0) {
      const noEmbedPayload = noEmbed.map((doc) => validateAndBuild(doc, doc.vector));
      const noEmbedResult = await this.proxy.send<WriteResultPayload>(mode, {
        docs: noEmbedPayload,
        batchSize: DEFAULT_WRITE_BATCH_SIZE,
      });
      persisted += noEmbedResult.ok;
      failed += noEmbedResult.failed;
      for (const error of noEmbedResult.errors ?? []) {
        allErrors.push({ id: error.id, code: error.code as WriteErrorCode, reason: error.reason });
      }
      const systemicWriteError = (noEmbedResult.errors ?? []).find((error) => error.code === 'ZVEC_WRITE_ERROR');
      if (systemicWriteError) {
        scheduleOutcome.fatalError ??= Object.assign(new Error(systemicWriteError.reason || 'zvec collection write failed'), {
          code: 'ZVEC_WRITE_ERROR',
        });
        scheduleOutcome.stopReason ??= classifyVectorizationStop(scheduleOutcome.fatalError, 'persist');
      }
    }

    if (scheduleOutcome.fatalError) {
      allErrors.push({ id: '<batch>', code: 'ZVEC_WRITE_ERROR', reason: scheduleOutcome.fatalError.message });
    }
    const cancelled = scheduleOutcome.cancelled;
    const failedItems = scheduleOutcome.failedItems.map((item) => item.docId);
    const totalFailed = failed + Math.max(0, allErrors.length - failed - metadataPending);
    const ok = Math.max(0, persisted);
    const notProcessed = scheduleOutcome.notProcessed + (scheduleOutcome.stopReason ? noEmbed.length : 0);
    if (scheduleOutcome.stopReason) notProcessedItems.push(...noEmbed.map((doc) => doc.id));
    const status: WriteResult['status'] = scheduleOutcome.stopReason
      ? 'failed'
      : cancelled > 0
      ? (ok > 0 ? 'partial' : 'cancelled')
      : ok === docs.length ? 'succeeded' : ok > 0 ? 'partial' : 'failed';
    options.onProgress?.({ phase: 'persist', done: Math.min(docs.length, ok + metadataPending + totalFailed + cancelled + notProcessed), total: docs.length, persisted: ok, failed: totalFailed, metadataPending, cancelled });
    return {
      ok,
      failed: Math.max(0, docs.length - ok - metadataPending - cancelled - notProcessed),
      attempted: scheduleOutcome.attempted,
      errors: allErrors.length > 0 ? allErrors : undefined,
      cancelled,
      cancelledItems,
      notProcessed,
      notProcessedItems,
      failedItems,
      metadataPending,
      metadataPendingItems,
      status,
      stopReason: scheduleOutcome.stopReason,
    };
  }

  // ─── 内部：检索编排 ───

  private async search(req: SemanticSearchReq | VectorSearchReq | FtsSearchReq | HybridSearchReq): Promise<Hit[]> {
    this.assertReadable();

    // filter 编译（若带 filter，先编译好；router 输出 payload 后再注入 filterSql）
    const filterSql = req.filter ? compileFilter(req.filter, this.allowedFields) : undefined;

    const routed = routeSearch(req, this.routerCtx);

    // 需要 embed 的：主线程 embed → Float32Array
    if (routed.needsEmbed && routed.embedTexts) {
      if (!this.embedding) {
        throw new InvalidSchemaError('query embedding is unavailable for this collection');
      }
      if (this.schema.dimension !== undefined && this.embedding.dimension !== this.schema.dimension) {
        throw new DimensionMismatchError(
          `embedding.dimension (${this.embedding.dimension}) !== persisted dimension (${this.schema.dimension})`,
          { data: { embeddingDim: this.embedding.dimension, persistedDim: this.schema.dimension } },
        );
      }
      const vectors = await this.embedding.embed(routed.embedTexts);
      const vector = Float32Array.from(vectors[0]);
      if (routed.kind === 'query') {
        (routed.payload as QueryPayload).vector = vector;
      } else {
        // multiQuery：把向量填到第一路（dense 路）
        const mq = routed.payload as MultiQueryPayload;
        const denseQuery = mq.queries.find((q) => q.fieldName === this.routerCtx.denseField);
        if (denseQuery) denseQuery.vector = vector;
      }
    }

    // 注入 filterSql
    (routed.payload as QueryPayload | MultiQueryPayload).filterSql = filterSql;

    // 发 worker
    const rawHits = routed.kind === 'query'
      ? await this.proxy.send<RawHitPayload[]>('query', routed.payload)
      : await this.proxy.send<RawHitPayload[]>('multiQuery', routed.payload);

    // 归一化
    const hits: Hit[] = [];
    for (const raw of rawHits) {
      const hit = toHit(raw, {
        queryType: routed.queryType,
        metric: 'COSINE',
        includeVector: req.includeVector ?? false,
      });
      if (hit) hits.push(hit);
    }
    return hits;
  }

  // ─── 内部：防御 ───

  private assertWritable(): void {
    if (this.destroyed) throw new InvalidSchemaError('engine destroyed');
    if (!this.proxy.isOpen()) {
      throw new WorkerCrashedError('worker not open');
    }
  }

  private assertReadable(): void {
    this.assertWritable();
  }
}

// ─── 工具 ───

function assertAbsolutePath(p: string): void {
  if (!isAbsolute(p)) {
    throw new InvalidSchemaError(`dbPath must be absolute, got: ${p}`);
  }
  if (p.includes('..')) {
    throw new InvalidSchemaError(`dbPath must not contain '..', got: ${p}`);
  }
  // normalize（防尾随 / 等差异）
  resolve(p);
}

function toWriteResult(payload: WriteResultPayload): WriteResult {
  return {
    ok: payload.ok,
    failed: payload.failed,
    errors: payload.errors.length > 0
      ? payload.errors.map((e) => ({ id: e.id, code: e.code as WriteErrorCode, reason: e.reason }))
      : undefined,
  };
}

// probe 用的占位 embedding（不会被实际调用）
const dummyEmbeddingProvider: EmbeddingProvider = {
  dimension: 4096,
  embed: async () => {
    throw new ZvecEngineError('probe does not embed');
  },
};

// probe 内部超时信号（不对外暴露）
class ProbeTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProbeTimeoutError';
  }
}

/**
 * 限时关闭 probe 临时 proxy：
 * - 正常路径：close（worker closeSync 释放 LOCK/句柄）后 terminate
 * - worker 若阻塞在原生 ZVecOpen 内，close/terminate 可能永不返回，
 *   故整体加 2s 上限：超时则放弃等待（宁可泄漏一个 worker，不能让
 *   probe 自身挂死拖垂整个调用链）
 */
/** probe 临时 proxy 的 close 超时与孤儿上限 */
const PROBE_CLOSE_TIMEOUT_MS = 3_000;
/** 同时滞留的孤儿 probe worker 上限：超过后对最老的做兜底 terminate（见注释的取舍） */
const MAX_PROBE_ORPHANS = 32;
const probeOrphans = new Set<ZvecEngineProxy>();

/**
 * 关闭已落定的 probe proxy（open 成功或已拒绝）。
 * 正常路径下 state=open → closeSync 释放 LOCK 后 terminate；已 failed/crashed 则立即返回。
 */
async function closeProbeProxyNow(proxy: ZvecEngineProxy): Promise<void> {
  try { await proxy.close(PROBE_CLOSE_TIMEOUT_MS); } catch { /* 已无句柄可泄 */ }
}

/**
 * 登记"未落定"的 probe 孤儿 worker。
 *
 * **关键约束**：worker 卡在原生 ZVecOpen 内（opening）时绝不能 terminate ——
 * 原生 open 一旦已拿到 flock 而 JS 侧未收到 ready，terminate 会让 `<dbPath>/LOCK`
 * 永久留在本进程内，形成"幽灵占用"：此后所有进程（含本进程自己）probe 都超时判 locked，
 * CLI 只能刷"向量库被其他进程占用"，而持锁者其实是一个早已死掉的 worker。
 * 历史实现正是「close(500) 与 2s 赛跑，超时即 terminate」，在锁竞争下必然命中该窗口
 * （实测 daemon 自报 openCount=0，却持有 8 个 scope 的 LOCK，连自己都打不开）。
 *
 * 改为：等 open 落定（成功→closeSync 释放 LOCK；失败→无锁可泄）后立即 close。
 * 超过 MAX_PROBE_ORPHANS 才兜底 terminate，避免线程/内存无界增长（极端场景的最后手段）。
 */
function registerProbeOrphan(proxy: ZvecEngineProxy, openPromise: Promise<unknown>): void {
  if (probeOrphans.size >= MAX_PROBE_ORPHANS) {
    const oldest = probeOrphans.values().next().value as ZvecEngineProxy | undefined;
    if (oldest) {
      probeOrphans.delete(oldest);
      process.stderr.write(
        `[kisearch] probe 孤儿 worker 超过 ${MAX_PROBE_ORPHANS} 个，对最老的执行兜底 terminate；`
        + '若此时该 worker 已持有 LOCK，锁会滞留在本进程直到退出（请检查向量库是否长期被占用）。\n',
      );
      void oldest.terminate().catch(() => { /* ignore */ });
    }
  }
  probeOrphans.add(proxy);
  // 不让孤儿 worker 吊住进程退出：CLI 短命令 probe 到被占用的库时，旧实现 terminate 立即
  // 结束进程（但泄漏 flock）；本实现改为等它落定后 close，若不 unref 则进程要等原生 open
  // 返回才退出——表现为"命令卡住不退出"（实测 30s+ 直到持锁方释放）。
  // unref 后：进程退出由 OS 释放其 fd/锁；常驻进程内该 worker 照常完成 close 并回收。
  proxy.unrefWorker();
  const reap = (): void => {
    probeOrphans.delete(proxy);
    void closeProbeProxyNow(proxy);
  };
  openPromise.then(reap, reap);
}
