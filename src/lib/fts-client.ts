/**
 * fts-client.ts —— FTS-only Collection 适配层。
 *
 * 与 vector-client 的 hybrid Collection 完全分离：不声明 dense schema、
 * 不构造 embedding provider，只负责文本/标量写入和 FTS 查询。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  ZvecEngine,
  type Filter,
  type Hit,
  type ZvecEngineConfig,
} from '../../dist/zvec-engine/index.js';
import { loadConfig, resolveScope } from './config.js';
import { getScopeFtsCollectionPath } from './scope-collection.js';

const COLLECTION_NAME = 'kisearch_fts';
const CONTENT_FIELD = 'content';
const SCOPE_FIELD = 'scope';
const GROUP_FIELD = 'group';
const RELATION_FIELD = 'relation';
const TAG_FIELD = 'tag';

export interface FtsStoreEntry {
  text: string;
  scope: string;
  group: string;
  relation: string;
  tag?: string;
}

export interface FtsSearchResult {
  ftsId: string;
  content: string;
  score: number;
  scope?: string;
  group?: string;
  relation?: string;
  tag?: string;
}

const engines = new Map<string, Promise<ZvecEngine>>();
let operationTail: Promise<void> = Promise.resolve();

function serializeFtsOp<T>(op: () => Promise<T>): Promise<T> {
  const run = operationTail.then(op, op);
  operationTail = run.then(() => undefined, () => undefined);
  return run;
}

function buildConfig(scope: string): ZvecEngineConfig {
  const config = loadConfig();
  return {
    dbPath: getScopeFtsCollectionPath(config, scope),
    collection: {
      name: COLLECTION_NAME,
      scalarFields: [
        { name: CONTENT_FIELD, dataType: 'STRING' },
        { name: SCOPE_FIELD, dataType: 'STRING', indexed: true },
        { name: GROUP_FIELD, dataType: 'STRING', indexed: true },
        { name: RELATION_FIELD, dataType: 'STRING', indexed: true },
        { name: TAG_FIELD, dataType: 'STRING', indexed: true },
      ],
      fts: { field: CONTENT_FIELD, tokenizer: 'jieba' },
    },
  };
}

function collectionExists(scope: string): boolean {
  const path = getScopeFtsCollectionPath(loadConfig(), scope);
  try {
    return fs.statSync(path).isDirectory() && fs.readdirSync(path).length > 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

function ftsId(entry: FtsStoreEntry): string {
  return createHash('sha256')
    .update(`fts\0${entry.scope}\0${entry.group}\0${entry.relation}\0${entry.tag ?? ''}\0${entry.text}`)
    .digest('hex')
    .slice(0, 32);
}

export function getFtsDocId(entry: FtsStoreEntry): string {
  return ftsId(entry);
}

async function getEngine(scope: string): Promise<ZvecEngine> {
  const existing = engines.get(scope);
  if (existing) return existing;
  let promise: Promise<ZvecEngine>;
  promise = serializeFtsOp(async () => {
    const current = engines.get(scope);
    // 当前 promise 已先登记到 map 供并发调用复用；不能把自己作为结果返回，
    // 否则 await promise 会形成自等待，短进程里表现为 pending promise。
    if (current && current !== promise) return current;
    const cfg = buildConfig(scope);
    fs.mkdirSync(path.dirname(cfg.dbPath), { recursive: true, mode: 0o700 });
    const engine = collectionExists(scope)
      ? await ZvecEngine.open({ dbPath: cfg.dbPath, collectionName: COLLECTION_NAME })
      : await ZvecEngine.create(cfg);
    engines.set(scope, Promise.resolve(engine));
    return engine;
  });
  engines.set(scope, promise);
  try {
    return await promise;
  } catch (err) {
    if (engines.get(scope) === promise) engines.delete(scope);
    throw err;
  }
}

async function withEngine<T>(scope: string, op: (engine: ZvecEngine) => Promise<T>): Promise<T> {
  const engine = await getEngine(scope);
  try {
    return await op(engine);
  } catch (err) {
    // 与 vector-client 的自愈策略一致：句柄损坏时下次调用重新打开。
    engines.delete(scope);
    try { await engine.close(); } catch { /* best effort */ }
    throw err;
  }
}

function filterForScope(scope: string, group?: string, relation?: string, tag?: string): Filter {
  const clauses: Filter[] = [{ field: SCOPE_FIELD, op: '==', value: scope }];
  if (group !== undefined) clauses.push({ field: GROUP_FIELD, op: '==', value: group });
  if (relation !== undefined) clauses.push({ field: RELATION_FIELD, op: '==', value: relation });
  if (tag !== undefined) clauses.push({ field: TAG_FIELD, op: '==', value: tag });
  return clauses.length === 1 ? clauses[0] : { and: clauses };
}

export async function ftsBulkStore(entries: FtsStoreEntry[]): Promise<{ ids: string[]; failed: number }> {
  if (entries.length === 0) return { ids: [], failed: 0 };
  const byScope = new Map<string, FtsStoreEntry[]>();
  for (const entry of entries) {
    const scope = resolveScope(loadConfig(), entry.scope);
    const list = byScope.get(scope) ?? [];
    list.push({ ...entry, scope });
    byScope.set(scope, list);
  }
  const ids: string[] = [];
  let failed = 0;
  for (const [scope, scoped] of byScope) {
    const result = await withEngine(scope, (engine) => engine.upsert(scoped.map((entry) => ({
      id: ftsId(entry),
      text: entry.text,
      fields: {
        [SCOPE_FIELD]: scope,
        [GROUP_FIELD]: entry.group,
        [RELATION_FIELD]: entry.relation,
        [TAG_FIELD]: entry.tag ?? 'ki-search',
      },
    }))));
    ids.push(...scoped.filter((_, i) => !result.errors?.some((e) => e.id === ftsId(scoped[i]))).map(ftsId));
    failed += result.failed;
  }
  return { ids, failed };
}

function toResult(hit: Hit): FtsSearchResult {
  return {
    ftsId: hit.id,
    content: hit.text ?? String(hit.fields[CONTENT_FIELD] ?? ''),
    score: hit.score,
    scope: hit.fields[SCOPE_FIELD] !== undefined ? String(hit.fields[SCOPE_FIELD]) : undefined,
    group: hit.fields[GROUP_FIELD] !== undefined ? String(hit.fields[GROUP_FIELD]) : undefined,
    relation: hit.fields[RELATION_FIELD] !== undefined ? String(hit.fields[RELATION_FIELD]) : undefined,
    tag: hit.fields[TAG_FIELD] !== undefined ? String(hit.fields[TAG_FIELD]) : undefined,
  };
}

export async function ftsSearch(params: {
  scope: string;
  query: string;
  limit?: number;
  group?: string;
  relation?: string;
  tag?: string;
}): Promise<FtsSearchResult[]> {
  const scope = resolveScope(loadConfig(), params.scope);
  if (!collectionExists(scope)) return [];
  const hits = await withEngine(scope, (engine) => engine.ftsSearch({
    match: params.query,
    topk: params.limit ?? 10,
    filter: filterForScope(scope, params.group, params.relation, params.tag),
  }));
  return hits.map(toResult);
}

export async function ftsDeleteByFilter(params: {
  scope: string;
  group?: string;
  relation?: string;
}): Promise<number> {
  const scope = resolveScope(loadConfig(), params.scope);
  if (!collectionExists(scope)) return 0;
  return withEngine(scope, async (engine) => {
    const ids = await engine.listIds(filterForScope(scope, params.group, params.relation), 10_000);
    if (ids.length === 0) return 0;
    const result = await engine.delete(ids);
    return result.ok;
  });
}

/** 删除 FTS-only collection 中已登记的文档 ID；NOT_FOUND 视为幂等成功。 */
export async function ftsDeleteByIds(params: { scope: string; ids: string[] }): Promise<{ deleted: number; failed: number; failedIds: string[] }> {
  const scope = resolveScope(loadConfig(), params.scope);
  const ids = [...new Set(params.ids.filter(Boolean))];
  if (ids.length === 0 || !collectionExists(scope)) return { deleted: 0, failed: 0, failedIds: [] };
  return withEngine(scope, async (engine) => {
    const result = await engine.delete(ids);
    const reportedErrors = result.errors ?? [];
    const failedErrors = reportedErrors.filter((error) => error.code !== 'NOT_FOUND');
    // 如底层只报告失败总数而未给出逐 ID 错误，保守保留本次全部待删 ID，避免
    // 调用方丢失对潜在残留文档的追踪能力。
    const hasUnattributedFailures = result.failed > reportedErrors.length || failedErrors.some((error) => !error.id);
    const failedIds = hasUnattributedFailures
      ? ids
      : [...new Set(failedErrors.map((error) => error.id).filter(Boolean))];
    return {
      deleted: Math.max(0, result.ok),
      failed: hasUnattributedFailures ? result.failed : failedIds.length,
      failedIds,
    };
  });
}

export async function closeFtsEngine(scope?: string): Promise<void> {
  const targets = scope ? [[scope, engines.get(scope)] as const] : [...engines.entries()];
  for (const [key, promise] of targets) {
    if (!promise) continue;
    engines.delete(key);
    try { await (await promise).close(); } catch { /* best effort */ }
  }
}
