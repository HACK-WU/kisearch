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

import { existsSync } from 'node:fs';
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
} from './errors.js';
import { compileFilter, buildAllowedFields } from './filter/compiler.js';
import type { EmbeddingProvider } from './embedding/provider.js';
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

export class ZvecEngine {
  private readonly proxy: ZvecEngineProxy;
  private readonly embedding: EmbeddingProvider;
  private readonly dbPath: string;
  private schema: PersistedSchema;
  private routerCtx: RouterContext;
  private allowedFields: ReadonlySet<string>;
  private destroyed = false;

  private constructor(
    proxy: ZvecEngineProxy,
    embedding: EmbeddingProvider,
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

    const probeProxy = new ZvecEngineProxy();
    try {
      const openPromise = probeProxy.spawn(
        { dbPath, collectionName: '', embedding: dummyEmbeddingProvider, readOnly: true },
        'open',
      );
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new ProbeTimeoutError('probe timeout')), timeoutMs),
      );
      await Promise.race([openPromise, timeoutPromise]);
      await probeProxy.terminate();
      return { exists: true, locked: false, healthy: true };
    } catch (err) {
      await probeProxy.terminate();
      if (err instanceof ProbeTimeoutError) {
        // 超时未返回 → 判定为锁占用（zvec 持锁时 ZVecOpen 阻塞）
        return { exists: true, locked: true, healthy: true };
      }
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
      metric: info.metric as 'COSINE',
      denseDataType: info.denseDataType as 'FP32' | 'FP16',
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

  async upsert(docs: DocInput[]): Promise<WriteResult> {
    return this.writeDocs(docs, 'upsert');
  }

  async insert(docs: DocInput[]): Promise<WriteResult> {
    return this.writeDocs(docs, 'insert');
  }

  async update(docs: DocInput[]): Promise<WriteResult> {
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
    return this.writeDocs(docs, 'update');
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

  private async writeDocs(docs: DocInput[], mode: 'upsert' | 'insert' | 'update'): Promise<WriteResult> {
    this.assertWritable();

    if (docs.length === 0) return { ok: 0, failed: 0 };

    // 按是否需 embed 切分（S-06 §3.3）
    const needsEmbed: DocInput[] = [];
    const noEmbed: DocInput[] = [];
    for (const d of docs) {
      if (d.text !== undefined && d.vector === undefined) {
        needsEmbed.push(d);
      } else {
        noEmbed.push(d);
      }
    }

    const allErrors: Array<{ id: string; code: WriteErrorCode; reason: string }> = [];

    // embed needsEmbed（小批失败 → EMBEDDING_FAILED）
    const embeddedVectors = new Map<string, number[]>();
    if (needsEmbed.length > 0) {
      const texts = needsEmbed.map((d) => d.text!);
      const ids = needsEmbed.map((d) => d.id);
      try {
        const vectors = await this.embedding.embed(texts);
        for (let i = 0; i < vectors.length; i++) {
          embeddedVectors.set(ids[i], vectors[i]);
        }
      } catch (err) {
        // 小批整体失败：全部 needsEmbed 标 EMBEDDING_FAILED
        // （S-03 §3.2：失败粒度 = 小批；当前实现 embedding provider 内部已分批，
        //  若 provider 在小批失败时抛错，则整批视为失败）
        const reason = (err as Error).message;
        for (const d of needsEmbed) {
          allErrors.push({ id: d.id, code: 'EMBEDDING_FAILED', reason });
        }
      }
    }

    // 组装待写 docs（embed 成功 + noEmbed）
    // embed 失败的 doc 已在 allErrors 中标记，跳过不再写入
    const embedFailedIds = new Set(
      allErrors.filter((e) => e.code === 'EMBEDDING_FAILED').map((e) => e.id),
    );
    const toWrite: WriteDocPayload[] = [];
    for (const d of [...needsEmbed, ...noEmbed]) {
      if (embedFailedIds.has(d.id)) continue;
      const vector = embeddedVectors.get(d.id) ?? d.vector;
      // 校验：写入路径必须至少有 vector 或 text（upsert/insert）
      if (mode !== 'update' && vector === undefined && d.text === undefined) {
        allErrors.push({
          id: d.id,
          code: 'UNKNOWN',
          reason: 'doc must provide at least one of text/vector',
        });
        continue;
      }
      // 校验：vector 维度
      if (vector !== undefined && vector.length !== this.schema.dimension) {
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
    return {
      ok: writeResult.ok,
      failed: writeResult.failed + allErrors.length,
      errors: merged.length > 0 ? merged : undefined,
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
