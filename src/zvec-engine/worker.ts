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

if (!parentPort) {
  throw new Error('worker.ts must be run as a worker_threads worker');
}

// ─── 全局状态 ───

let collection: ZVecCollection | null = null;
let denseFieldName = 'dense';
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
      return handleMultiQuery(req.payload as MultiQueryPayload);
    case 'optimize':
      ensureCollection().optimizeSync();
      return null;
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

  const denseDataType = denseVec?.dataType === ZVecDataType.VECTOR_FP16 ? 'FP16' : 'FP32';
  const metricNum = (denseVec?.indexParams as { metricType?: number } | undefined)?.metricType;
  const metric = metricNum === 3 ? 'COSINE' : metricNum === 2 ? 'IP' : metricNum === 1 ? 'L2' : 'COSINE';

  return {
    name: schema.name,
    denseField: denseVec?.name ?? denseFieldName,
    dimension: denseVec?.dimension ?? 0,
    metric,
    denseDataType,
    scalarFields,
    fts: ftsConfig,
    docCount: c.stats.docCount,
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
  if (d.vector !== undefined) {
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

function handleMultiQuery(payload: MultiQueryPayload): RawHitPayload[] {
  const c = ensureCollection();
  const rerank = payload.rerankWeighted
    ? { type: 'weighted' as const, weights: payload.rerankWeighted.weights }
    : { type: 'rrf' as const, rankConstant: payload.rerankRrf?.rankConstant ?? 60 };

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
    const v = doc.vectors?.[denseFieldName];
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
    const v = doc.vectors?.[denseFieldName];
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
