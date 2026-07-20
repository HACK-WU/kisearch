/**
 * worker-protocol.ts —— 主线程 ↔ worker 消息协议
 *
 * 与设计文档对齐：S-04 §3.3 / §4a
 *
 *   - 请求/响应通过 id 关联（UUID v4）
 *   - 向量经 Float32Array + transfer list 零拷贝传递
 *   - 错误序列化为 SerializedError，主线程侧 deserializeError 重建类型化异常
 */

import { randomUUID } from 'node:crypto';
import type { MessagePort } from 'node:worker_threads';
import { ERROR_CONSTRUCTORS, ZvecEngineError } from './errors.js';
import type { PersistedSchema, ScalarValue, ZvecEngineConfig, ZvecEngineOpenConfig } from './types.js';

// Node worker_threads 的 Transferable 类型（@types/node 未全局导出）
export type Transferable = ArrayBuffer | MessagePort;

// ─── 消息 id ───

export function newMessageId(): string {
  return randomUUID();
}

// ─── Payload 类型 ───

export interface WriteDocPayload {
  id: string;
  text?: string;
  vector?: Float32Array;      // Transferable
  fields?: Record<string, ScalarValue>;
}

export interface WritePayload {
  docs: WriteDocPayload[];
  batchSize?: number;         // worker 内分批插入批大小，默认 100
}

export interface QueryPayload {
  fieldName: string;
  vector?: Float32Array;      // Transferable
  ftsMatchString?: string;
  ftsQueryString?: string;
  topk: number;
  filterSql?: string;
  outputFields?: string[];
  includeVector?: boolean;
}

export interface MultiQueryItem {
  fieldName: string;
  vector?: Float32Array;      // Transferable
  ftsMatchString?: string;
}

export interface MultiQueryPayload {
  queries: MultiQueryItem[];
  topk: number;
  rerankRrf?: { rankConstant?: number };
  rerankWeighted?: { weights: number[] };
  filterSql?: string;
  outputFields?: string[];
  includeVector?: boolean;
}

export interface CreateRequestPayload {
  config: Omit<ZvecEngineConfig, 'embedding'>;
}

export interface OpenRequestPayload {
  dbPath: string;
  collectionName?: string;    // probe 时不传；open 时必传
  readOnly?: boolean;
}

// ─── 请求消息 ───

export type WorkerRequest =
  | { id: string; kind: 'create';      payload: CreateRequestPayload }
  | { id: string; kind: 'open';        payload: OpenRequestPayload }
  | { id: string; kind: 'close';       payload: { drainTimeoutMs?: number } }
  | { id: string; kind: 'destroy';     payload: { dbPath: string } }
  | { id: string; kind: 'info';        payload: Record<string, never> }
  | { id: string; kind: 'upsert';      payload: WritePayload }
  | { id: string; kind: 'insert';      payload: WritePayload }
  | { id: string; kind: 'update';      payload: WritePayload }
  | { id: string; kind: 'delete';      payload: { ids: string[] } }
  | { id: string; kind: 'fetch';       payload: { ids: string[]; includeVector?: boolean } }
  | { id: string; kind: 'listIds';     payload: { filterSql?: string; limit: number } }
  | { id: string; kind: 'query';       payload: QueryPayload }
  | { id: string; kind: 'multiQuery';  payload: MultiQueryPayload }
  | { id: string; kind: 'optimize';    payload: Record<string, never> }
  | { id: string; kind: 'createIndex'; payload: { field: string; indexParam: unknown } }
  | { id: string; kind: 'dropIndex';   payload: { field: string } };

// ─── 响应消息 ───

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
  stack?: string;
  data?: Record<string, unknown>;
}

export interface WriteResultPayload {
  ok: number;
  failed: number;
  errors: Array<{ id: string; code: string; reason: string }>;
}

export interface RawHitPayload {
  id: string;
  distance?: number;
  score?: number;
  fields: Record<string, ScalarValue>;
  text?: string;
  vector?: Float32Array;      // Transferable
}

export interface DocPayload {
  id: string;
  vector?: Float32Array;      // Transferable
  fields?: Record<string, ScalarValue>;
  text?: string;
}

export interface InfoResultPayload extends PersistedSchema {
  docCount: number;
  locked: false;
}

export type WorkerResponse =
  | { id: string; ok: true;  result: unknown }
  | { id: string; ok: false; error: SerializedError }
  | { id: '__ready__'; kind: 'ready'; persistedSchema?: PersistedSchema };

// ─── 错误序列化 ───

export function serializeError(err: unknown): SerializedError {
  if (err instanceof ZvecEngineError) {
    return {
      name: err.name,
      message: err.message,
      code: err.code,
      stack: err.stack,
      data: err.data,
    };
  }
  if (err instanceof Error) {
    return {
      name: err.name || 'Error',
      message: err.message,
      stack: err.stack,
    };
  }
  return { name: 'Error', message: String(err) };
}

export function deserializeError(se: SerializedError): Error {
  const Ctor = ERROR_CONSTRUCTORS[se.name];
  if (Ctor) {
    return new Ctor(se.message, { code: se.code, data: se.data });
  }
  const err = new Error(se.message);
  err.name = se.name;
  if (se.stack) err.stack = se.stack;
  return err;
}

// ─── Transferable 收集 ───

/**
 * 扫描 payload 中所有 Float32Array，返回其 buffer 列表（供 postMessage transfer list）。
 * 同一 buffer 只收集一次（防御重复引用）。
 */
export function collectTransferables(payload: unknown): Transferable[] {
  const seen = new Set<ArrayBufferLike>();
  const out: Transferable[] = [];
  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (value instanceof Float32Array) {
      const buf = value.buffer;
      // 仅 ArrayBuffer 可 transfer；SharedArrayBuffer 不可 transfer
      if (buf instanceof ArrayBuffer && !seen.has(buf)) {
        seen.add(buf);
        out.push(buf);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object') {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };
  walk(payload);
  return out;
}
