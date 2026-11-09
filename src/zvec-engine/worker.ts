/**
 * worker.ts —— zvec worker 线程入口（dedicated worker_threads）
 *
 * 与设计文档对齐：S-04 §3.1 / §3.4 / §3.5
 *
 * 职责：
 *   - 启动时经 'create'/'open' 消息获得唯一 collection 句柄
 *   - 串行处理后续所有 db 操作消息（actor 模型）
 *   - 写入分批 + setImmediate 让出（查询插队）
 *   - close 时 drain 在途 → closeSync 释放 LOCK → 回 ok
 *   - destroy 时 closeSync → ZVecDestroy → 回 ok
 *
 * 本文件由 new Worker(new URL('./worker.js', import.meta.url)) 加载，
 * 不参与主线程 import。
 */

import { parentPort, type MessagePort } from 'node:worker_threads';

// Node worker_threads 的 Transferable 类型
type Transferable = ArrayBuffer | MessagePort;
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecDataType,
  type ZVecCollection,
  type ZVecDoc,
  type ZVecDocInput,
  type ZVecVector,
} from '@zvec/zvec';
import { mapZvecOpenError } from './schema/validator.js';
import { normalizeVectorScore } from './search/normalize.js';
import { buildCollectionSchema } from './schema/builder.js';
import type {
  CreateRequestPayload,
  DocPayload,
  InfoResultPayload,
  MultiQueryPayload,
  OpenRequestPayload,
  QueryPayload,
  RawHitPayload,
  SerializedError,
  WorkerRequest,
  WorkerResponse,
  WritePayload,
  WriteResultPayload,
} from './worker-protocol.js';
import { serializeError } from './worker-protocol.js';
import { RRF_FLOOR, SEMANTIC_BONUS, SINGLE_SCOPE_RANKING, dynamicRatioScore, ftsWeightedRrfScore } from './scoring.js';

if (!parentPort) {
  throw new Error('worker.ts must be run as a worker_threads worker');
}

// ─── 全局状态 ───

let collection: ZVecCollection | null = null;
let denseFieldName: string | undefined;
let ftsFieldName: string | undefined;

const port = parentPort;

// ─── 消息循环 ───

port.on('message', (req: WorkerRequest) => {
  void handleRequest(req);
});

async function handleRequest(req: WorkerRequest): Promise<void> {
  try {
    const result = await dispatch(req);
    if (req.kind === 'create' || req.kind === 'open') {
      const ready: WorkerResponse = {
        id: '__ready__',
        kind: 'ready',
        persistedSchema: result as InfoResultPayload,
      };
      port.postMessage(ready);
      const resp: WorkerResponse = { id: req.id, ok: true, result };
      port.postMessage(resp);
      return;
    }
    const resp: WorkerResponse = { id: req.id, ok: true, result };
    postWithTransfer(resp, result);
  } catch (err) {
    const se: SerializedError = serializeError(err);
    const resp: WorkerResponse = { id: req.id, ok: false, error: se };
    port.postMessage(resp);
  }
}

function postWithTransfer(resp: WorkerResponse, result: unknown): void {
  const transfer: Transferable[] = [];
  const collect = (v: unknown): void => {
    if (v === null || v === undefined) return;
    if (v instanceof Float32Array) {
      const buf = v.buffer;
      if (buf instanceof ArrayBuffer) {
        transfer.push(buf);
      }
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(collect);
      return;
    }
    if (typeof v === 'object') {
      Object.values(v as Record<string, unknown>).forEach(collect);
    }
  };
  collect(result);
  if (transfer.length > 0) {
    port.postMessage(resp, transfer);
  } else {
    port.postMessage(resp);
  }
}

// ─── 消息分发 ───

async function dispatch(req: WorkerRequest): Promise<unknown> {
  switch (req.kind) {
    case 'create':
      return handleCreate(req.payload as CreateRequestPayload);
    case 'open':
      return handleOpen(req.payload as OpenRequestPayload);
    case 'close':
      return handleClose();
    case 'destroy':
      return handleDestroy((req.payload as { dbPath: string }).dbPath);
    case 'info':
      return handleInfo();
    case 'upsert':
      return handleWrite(req.payload as WritePayload, 'upsert');
    case 'insert':
      return handleWrite(req.payload as WritePayload, 'insert');
    case 'update':
      return handleWrite(req.payload as WritePayload, 'update');
    case 'delete':
      return handleDelete((req.payload as { ids: string[] }).ids);
    case 'fetch':
      return handleFetch(req.payload as { ids: string[]; includeVector?: boolean });
    case 'listIds':
      return handleListIds(req.payload as { filterSql?: string; limit: number });
    case 'query':
      return handleQuery(req.payload as QueryPayload);
    case 'multiQuery':
      return await handleMultiQuery(req.payload as MultiQueryPayload);
    case 'optimize': {
      // S-01（REQ-20261009-003）：改原生**异步** optimize(options)，支持限核
      //（原实现 optimizeSync 阻塞 worker 且无法限核）。
      // 说明（勿误读为 actor 串行）：本文件消息循环是 `void handleRequest(req)`
      // **并发派发**，await 原生异步 optimize 期间其它消息仍会被处理 ⇒ 同 collection
      // 的查询/写入**不会被本调用挡在消息队列外**。实际争用程度取决于原生内部实现
      //（实验 1 测的是 sync 版：233ms 的 optimize 期间 `info()` 延迟 212ms），
      // 异步版需实测（见 S-01「整理期检索延迟」验收项）。
      const p = req.payload as { concurrency?: number };
      const coll = ensureCollection();
      // ★ 未传 concurrency 时必须走**零参调用**：实测 `optimize(undefined)` 会被原生拒绝
      //   （`Collection.optimize(): Expected 0 to 1 argument. Argument must be an OptimizeOptions object.`）
      //   —— 这正是"默认路径"（未配置 concurrency）必踩的坑，由 S-02 端到端验收捕获。
      if (p.concurrency !== undefined) {
        await coll.optimize({ concurrency: p.concurrency });
      } else {
        await coll.optimize();
      }
      return null;
    }
    case 'createIndex': {
      const p = req.payload as { field: string; indexParam: unknown };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ensureCollection().createIndexSync({ fieldName: p.field, indexParams: p.indexParam as any });
      return null;
    }
    case 'dropIndex': {
      const p = req.payload as { field: string };
      ensureCollection().dropIndexSync(p.field);
      return null;
    }
    default:
      throw new Error(`unknown worker request kind: ${(req as { kind: string }).kind}`);
  }
}

// ─── 生命周期 ───

function handleCreate(payload: CreateRequestPayload): InfoResultPayload {
  const { config } = payload;
  denseFieldName = config.collection.denseField;
  ftsFieldName = config.collection.fts?.field;

  // config 是 Omit<ZvecEngineConfig, 'embedding'>，buildCollectionSchema 只读 collection 字段
  // 此处强转还原为 ZvecEngineConfig（embedding 不参与 schema 构建）
  const schema = buildCollectionSchema(config as unknown as import('./types.js').ZvecEngineConfig);
  collection = ZVecCreateAndOpen(config.dbPath, schema);
  return buildInfoResult();
}

function handleOpen(payload: OpenRequestPayload): InfoResultPayload {
  try {
    collection = ZVecOpen(payload.dbPath, { readOnly: payload.readOnly ?? false });
  } catch (err) {
    throw mapZvecOpenError(err, payload.dbPath);
  }
  const info = buildInfoResult();
  denseFieldName = info.denseField;
  ftsFieldName = info.fts?.field;
  return info;
}

function handleClose(): null {
  if (collection) {
    collection.closeSync();
    collection = null;
  }
  return null;
}

function handleDestroy(dbPath: string): null {
  if (collection) {
    collection.closeSync();
    collection = null;
  }
  // ZVecDestroy 等价于 collection.destroySync()；重新 open 后 destroy 会失败，
  // 故直接用静态方法（zvec 0.6.0 经 collection.destroySync 提供；此处
  // 因句柄已释放，再 open 一次仅为 destroy。为简洁起见，先用 destroySync 路径：
  // 先 open 再 destroySync 再 return）
  const c = ZVecOpen(dbPath);
  c.destroySync();
  return null;
}

function handleInfo(): InfoResultPayload {
  return buildInfoResult();
}

function buildInfoResult(): InfoResultPayload {
  const c = ensureCollection();
  const schema = c.schema;
  const vectors = schema.vectors();
  const denseVec = vectors[0];
  const fields = schema.fields();
  const scalarFields: InfoResultPayload['scalarFields'] = [];
  let ftsConfig: InfoResultPayload['fts'];

  for (const f of fields) {
    const ip = f.indexParams;
    const isFts = ip !== undefined && 'tokenizerName' in (ip as object);
    const isInvert = ip !== undefined && !isFts;
    scalarFields.push({
      name: f.name,
      dataType: reverseDataType(f.dataType),
      indexed: isInvert,
    });
    if (isFts) {
      const fip = ip as { tokenizerName?: string; filters?: string[]; extraParams?: string };
      let jiebaDictDir: string | undefined;
      if (fip.extraParams) {
        try {
          const parsed = JSON.parse(fip.extraParams) as { jieba_dict_dir?: string };
          jiebaDictDir = parsed.jieba_dict_dir;
        } catch { /* ignore */ }
      }
      ftsConfig = {
        field: f.name,
        tokenizer: (fip.tokenizerName ?? 'standard') as 'standard' | 'whitespace' | 'jieba',
        filters: (fip.filters ?? ['lowercase']) as ('lowercase' | 'ascii_folding' | 'stemmer')[],
        ...(jiebaDictDir ? { jiebaDictDir } : {}),
      };
    }
  }

  const denseDataType = denseVec
    ? (denseVec.dataType === ZVecDataType.VECTOR_FP16 ? 'FP16' : 'FP32')
    : undefined;
  const metricNum = (denseVec?.indexParams as { metricType?: number } | undefined)?.metricType;
  const metric = denseVec
    ? (metricNum === 3 ? 'COSINE' : metricNum === 2 ? 'IP' : metricNum === 1 ? 'L2' : 'COSINE')
    : undefined;

  return {
    name: schema.name,
    ...(denseVec?.name ? { denseField: denseVec.name } : {}),
    ...(denseVec?.dimension !== undefined ? { dimension: denseVec.dimension } : {}),
    metric,
    ...(denseDataType ? { denseDataType } : {}),
    scalarFields,
    fts: ftsConfig,
    docCount: c.stats.docCount,
    // REQ-20261009-003 S-02：接出索引完成度（0~1），用于"索引到底建没建"的可观测判定
    indexCompleteness: c.stats.indexCompleteness ?? {},
    locked: false,
  };
}

function reverseDataType(dt: number): 'STRING' | 'BOOL' | 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'UINT32' | 'UINT64' {
  switch (dt) {
    case ZVecDataType.STRING: return 'STRING';
    case ZVecDataType.BOOL: return 'BOOL';
    case ZVecDataType.INT32: return 'INT32';
    case ZVecDataType.INT64: return 'INT64';
    case ZVecDataType.FLOAT: return 'FLOAT';
    case ZVecDataType.DOUBLE: return 'DOUBLE';
    case ZVecDataType.UINT32: return 'UINT32';
    case ZVecDataType.UINT64: return 'UINT64';
    default: return 'STRING';
  }
}

// ─── 写入 ───

async function handleWrite(
  payload: WritePayload,
  mode: 'upsert' | 'insert' | 'update',
): Promise<WriteResultPayload> {
  const c = ensureCollection();
  const batchSize = payload.batchSize ?? 100;
  const errors: WriteResultPayload['errors'] = [];
  let ok = 0;

  for (let i = 0; i < payload.docs.length; i += batchSize) {
    const batch = payload.docs.slice(i, i + batchSize);
    const zvecDocs: ZVecDocInput[] = batch.map((d) => toZvecDocInput(d));

    let statuses;
    if (mode === 'upsert') {
      statuses = c.upsertSync(zvecDocs);
    } else if (mode === 'insert') {
      statuses = c.insertSync(zvecDocs);
    } else {
      statuses = c.updateSync(zvecDocs);
    }

    const statusArr = Array.isArray(statuses) ? statuses : [statuses];
    for (let j = 0; j < statusArr.length; j++) {
      const s = statusArr[j];
      if (s.ok) {
        ok++;
      } else {
        const docId = batch[j].id;
        const code = s.code === 'ZVEC_ALREADY_EXISTS'
          ? 'ID_CONFLICT'
          : s.code === 'ZVEC_NOT_FOUND'
            ? 'NOT_FOUND'
            : 'ZVEC_WRITE_ERROR';
        errors.push({ id: docId, code, reason: s.message ?? '' });
      }
    }

    // 让出事件循环（查询插队）
    if (i + batchSize < payload.docs.length) {
      await new Promise((r) => setImmediate(r));
    }
  }

  return { ok, failed: errors.length, errors };
}

function toZvecDocInput(d: WritePayload['docs'][number]): ZVecDocInput {
  const vectors: Record<string, ZVecVector> = {};
  if (d.vector !== undefined && denseFieldName !== undefined) {
    vectors[denseFieldName] = d.vector;
  }
  const fields: Record<string, unknown> = { ...(d.fields ?? {}) };
  if (d.text !== undefined && ftsFieldName) {
    fields[ftsFieldName] = d.text;
  }
  // zvec 要求 vectors/fields 至少为 object（不能是 undefined）
  return {
    id: d.id,
    vectors,
    fields,
  };
}

// ─── 删除 / 取回 / listIds ───

function handleDelete(ids: string[]): WriteResultPayload {
  const c = ensureCollection();
  const statuses = c.deleteSync(ids);
  const statusArr = Array.isArray(statuses) ? statuses : [statuses];
  const errors: WriteResultPayload['errors'] = [];
  let ok = 0;
  for (let i = 0; i < statusArr.length; i++) {
    const s = statusArr[i];
    if (s.ok) {
      ok++;
    } else {
      const code = s.code === 'ZVEC_NOT_FOUND' ? 'NOT_FOUND' : 'ZVEC_WRITE_ERROR';
      errors.push({ id: ids[i], code, reason: s.message ?? '' });
    }
  }
  return { ok, failed: errors.length, errors };
}

function handleFetch(payload: { ids: string[]; includeVector?: boolean }): DocPayload[] {
  const c = ensureCollection();
  const record = c.fetchSync({
    ids: payload.ids,
    includeVector: payload.includeVector ?? false,
  });
  const out: DocPayload[] = [];
  for (const id of payload.ids) {
    const doc = record[id];
    if (!doc) continue;
    out.push(toDocPayload(doc, payload.includeVector ?? false));
  }
  return out;
}

function handleListIds(payload: { filterSql?: string; limit: number }): string[] {
  const c = ensureCollection();
  const docs = c.querySync({
    topk: payload.limit,
    ...(payload.filterSql !== undefined ? { filter: payload.filterSql } : {}),
  });
  return docs.map((d) => d.id);
}

// ─── 检索 ───

function handleQuery(payload: QueryPayload): RawHitPayload[] {
  const c = ensureCollection();
  const isFts = payload.ftsMatchString !== undefined || payload.ftsQueryString !== undefined;
  const docs = c.querySync({
    fieldName: payload.fieldName,
    topk: payload.topk,
    ...(payload.vector !== undefined ? { vector: payload.vector } : {}),
    ...(isFts
      ? {
          fts: payload.ftsMatchString !== undefined
            ? { matchString: payload.ftsMatchString }
            : { queryString: payload.ftsQueryString! },
        }
      : {}),
    ...(payload.filterSql !== undefined ? { filter: payload.filterSql } : {}),
    ...(payload.outputFields !== undefined ? { outputFields: payload.outputFields } : {}),
    includeVector: payload.includeVector ?? false,
  });
  return docs.map((d) => toRawHit(d, isFts, payload.includeVector ?? false));
}

async function handleMultiQuery(payload: MultiQueryPayload): Promise<RawHitPayload[]> {
  const c = ensureCollection();
  const rankConstant = payload.rerankRrf?.rankConstant ?? 60;

  /**
   * 需要分路分数时：逐路查询 + 自行融合。
   *
   * 为什么不能继续用 `multiQuerySync`：它内部融合后只返回一个 `score`，
   * 两路各自的分数被丢弃。而上层做跨库合并时必须拿到「字面路的 BM25」与
   * 「向量路的绝对相似度」，否则只能再跑一整轮跨库检索（实测 12 库会把 3s 拖到分钟级）。
   *
   * 融合公式与原实现一致（RRF `Σ 1/(k+rank)`；加权则按权重求和），所以**排序不变**，
   * 只是额外带出分路分数。仅多库请求走这条路径，单库仍用 `multiQuerySync`（零变化）。
   */
  if (payload.withRouteScores) {
    /**
     * 每路取 **2 倍候选**（下限 40）作为「算分原料」，而不是只取 `topk` 条。
     *
     * ★ 为什么必须放大：两路召回的文档集几乎不重叠（实测同一次查询里重合 0~3 条）。
     *   各取 `topk` 条时，「只在字面路排第一、语义路没召回」的文档会漏在外面，
     *   后面的评分公式根本没机会看到它 —— 这正是「字面分最高的文档排不进前 20」的原因。
     */
    // 按「最终分」截断的算法必须先拿够原料，否则名次一般但字面强的文档会在库内被提前挤掉；
    // 其余算法仍按融合分截断（不放大 = 不为拿不到收益的路径付双倍查询成本）。
    const engineFinalScoring = payload.ranking === 'dynamic-ratio'
      || payload.ranking === 'calibrated-semantic'
      || payload.ranking === 'calibrated-adaptive'
      || payload.ranking === SINGLE_SCOPE_RANKING;
    const routeTopk = engineFinalScoring
      ? Math.min(Math.max(payload.topk * 2, 40), 1000)
      : payload.topk;
    // 两路**并行**（原生异步 query）：串行会让每个库的耗时翻倍，
    // 12 库并发时总耗时也跟着涨（实测 3s → 7s）；并行后回到接近单次查询。
    const perRoute = await Promise.all(payload.queries.map((q) => c.query({
      fieldName: q.fieldName,
      topk: routeTopk,
      ...(q.vector !== undefined ? { vector: q.vector } : {}),
      ...(q.ftsMatchString !== undefined ? { fts: { matchString: q.ftsMatchString } } : {}),
      ...(payload.filterSql !== undefined ? { filter: payload.filterSql } : {}),
      ...(payload.outputFields !== undefined ? { outputFields: payload.outputFields } : {}),
      includeVector: payload.includeVector ?? false,
    })));

    // 按文档 id 对齐：同一条文档把两路分数都留下（不是「去重留一份」）
    const acc = new Map<string, { doc: ZVecDoc; ranks: number[]; scores: number[] }>();
    perRoute.forEach((docs, routeIdx) => {
      /**
       * ★ 向量路的 `doc.score` 是**距离**（COSINE，越小越相似），必须转成相似度。
       *   漏转会让 `vectorScore` 语义反掉（0.75 实际比 0.63 更不相似），
       *   「语义优先」算法也会把排序算反。
       */
      const isVectorRoute = payload.queries[routeIdx]?.vector !== undefined;
      docs.forEach((d, i) => {
        const cur = acc.get(d.id) ?? { doc: d, ranks: [], scores: [] };
        cur.ranks[routeIdx] = i + 1;
        cur.scores[routeIdx] = isVectorRoute
          ? normalizeVectorScore(d.score ?? 0, 'COSINE')
          : (d.score ?? 0);
        acc.set(d.id, cur);
      });
    });

    /**
     * 动态比值：**在库内就算出最终分，并按最终分截断**。
     *
     * 分数 = (名次分 + 字面分 / 10^(d+1)) / 2，d = 名次分首位有效数字的位置。
     * 它只依赖名次分的**量级**（不含候选池最大值），所以库内算完即可跨库比较 ——
     * 不需要上层再重排一次。
     */
    if (
      payload.ranking === 'dynamic-ratio'
      || payload.ranking === 'calibrated-semantic'
      || payload.ranking === 'calibrated-adaptive'
    ) {
      // 后两者的基线都是定标加权；calibrated-adaptive 还要由上层做候选池自适应校正
      const scored = [...acc.values()].map((e) => {
        const rrf = e.ranks.reduce((sum, r) => sum + (r ? 1 / (rankConstant + r) : 0), 0);
        // rrf=0 只会出现在「两路都没名次」的防御场景：按单路 rank1 归入 d=2 档
        const rrfSafe = rrf > 0 ? rrf : RRF_FLOOR;
        const ftsScore = e.scores[1] ?? 0; // queries[1] = 字面路（router 固定顺序）
        const vecScore = e.scores[0] ?? 0; // 已转成相似度（0.33~1）；未被向量路召回时为 0
        const base = dynamicRatioScore(rrfSafe, ftsScore);
        // 定标加权 + 语义补充：语义分为 0 表示未被语义路召回，该项即为 0，不做补偿
        const bonus = payload.semanticBonus ?? SEMANTIC_BONUS;
        const score = payload.ranking === 'calibrated-semantic'
          ? base + bonus * vecScore
          : base;
        return { e, score, rrf: rrfSafe, base };
      });
      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, payload.topk)
        .map(({ e, score, rrf, base }) => ({
          ...toRawHit(e.doc, false, payload.includeVector ?? false, true),
          score,
          routeScores: e.scores.map((v) => v ?? 0),
          rrf,
          baseScore: base,
        }));
    }

    /**
     * 单库：**字面加权 RRF** —— `向量名次分 + 字面权重 × 字面名次分`（见 scoring.ts）。
     *
     * 为什么在库内算：字面强度高的文档名次可能一般，按融合分截断会让它先在库内被挤掉；
     * 而单库只有一个库，算完即可直接按最终分截断，不需要上层再排一次。
     *
     * 路序按字段判定（向量路 = 带 vector、字面路 = 带 ftsMatchString），不依赖数组下标 ——
     * `queries` 的顺序由 router 决定，硬编码下标在只有一路时会把字面分当向量分用。
     */
    if (payload.ranking === SINGLE_SCOPE_RANKING) {
      const vectorRouteIdx = payload.queries.findIndex((q) => q.vector !== undefined);
      const ftsRouteIdx = payload.queries.findIndex((q) => q.ftsMatchString !== undefined);
      return [...acc.values()]
        .map((e) => ({
          e,
          score: ftsWeightedRrfScore(
            vectorRouteIdx >= 0 ? e.ranks[vectorRouteIdx] : undefined,
            ftsRouteIdx >= 0 ? e.ranks[ftsRouteIdx] : undefined,
            ftsRouteIdx >= 0 ? (e.scores[ftsRouteIdx] ?? 0) : 0,
            rankConstant,
          ),
        }))
        .sort((a, b) => b.score - a.score)
        .slice(0, payload.topk)
        .map(({ e, score }) => ({
          ...toRawHit(e.doc, false, payload.includeVector ?? false, true),
          score,
          routeScores: e.scores.map((v) => v ?? 0),
        }));
    }

    // 其余算法：仍按融合分截断，由上层统一重排（它们的公式依赖候选池最大值，库里算不出来）
    const weights = payload.rerankWeighted?.weights;
    return [...acc.values()]
      .map((e) => ({
        e,
        fused: weights
          ? e.scores.reduce((sum, v, i) => sum + (v ?? 0) * (weights[i] ?? 1), 0)
          : e.ranks.reduce((sum, r, i) => sum + (r ? 1 / (rankConstant + r) : 0), 0),
      }))
      .sort((a, b) => b.fused - a.fused)
      .slice(0, payload.topk)
      .map(({ e, fused }) => ({
        ...toRawHit(e.doc, false, payload.includeVector ?? false, true),
        rrf: fused,
        // ★ 必须显式写回融合分：`toRawHit` 取的是 `doc.score`，那是**单路查询的原始分**
        //   （fts 路 = BM25，量级几十）。漏掉这行时上层拿 BM25 当 RRF 用，
        //   两种加权公式都会算出离谱的分数（表现为「动态比值恒等于 bm25」「加权恒等于满分」）。
        score: fused,
        routeScores: e.scores.map((v) => v ?? 0),
      }));
  }

  const rerank = payload.rerankWeighted
    ? { type: 'weighted' as const, weights: payload.rerankWeighted.weights }
    : { type: 'rrf' as const, rankConstant };

  const docs = c.multiQuerySync({
    queries: payload.queries.map((q) => ({
      fieldName: q.fieldName,
      ...(q.vector !== undefined ? { vector: q.vector } : {}),
      ...(q.ftsMatchString !== undefined ? { fts: { matchString: q.ftsMatchString } } : {}),
    })),
    topk: payload.topk,
    ...(payload.filterSql !== undefined ? { filter: payload.filterSql } : {}),
    ...(payload.outputFields !== undefined ? { outputFields: payload.outputFields } : {}),
    includeVector: payload.includeVector ?? false,
    rerank,
  });
  return docs.map((d) => toRawHit(d, false, payload.includeVector ?? false, true));
}

// ─── 转换工具 ───

function toRawHit(
  doc: ZVecDoc,
  isFts: boolean,
  includeVector: boolean,
  isHybrid = false,
): RawHitPayload {
  const fields: Record<string, ScalarValue> = {};
  let text: string | undefined;
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      fields[k] = v;
      if (k === ftsFieldName) text = v as string;
    }
  }
  const out: RawHitPayload = {
    id: doc.id,
    fields,
    text,
  };
  if (isFts || isHybrid) {
    out.score = doc.score;
  } else {
    out.distance = doc.score;   // COSINE 返回 distance（越小越相似）
  }
  if (includeVector) {
    const v = denseFieldName === undefined ? undefined : doc.vectors?.[denseFieldName];
    if (v instanceof Float32Array) {
      out.vector = v;
    } else if (Array.isArray(v)) {
      out.vector = Float32Array.from(v as number[]);
    }
  }
  return out;
}

function toDocPayload(doc: ZVecDoc, includeVector: boolean): DocPayload {
  const fields: Record<string, ScalarValue> = {};
  let text: string | undefined;
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      fields[k] = v;
      if (k === ftsFieldName) text = v as string;
    }
  }
  const out: DocPayload = { id: doc.id, fields, text };
  if (includeVector) {
    const v = denseFieldName === undefined ? undefined : doc.vectors?.[denseFieldName];
    if (v instanceof Float32Array) {
      out.vector = v;
    } else if (Array.isArray(v)) {
      out.vector = Float32Array.from(v as number[]);
    }
  }
  return out;
}

function ensureCollection(): ZVecCollection {
  if (!collection) {
    throw new Error('collection not opened (send create/open first)');
  }
  return collection;
}

type ScalarValue = string | number | boolean;
