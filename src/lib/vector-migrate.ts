/**
 * vector-migrate.ts —— 旧单 Collection → 按 scope Collection 的显式迁移。
 *
 * 迁移只读取 config.vectorDir 根下的旧 Collection，把已有 doc id、向量、
 * 文本和标量字段原样写入 `vectorDir/collections/<scope>`；旧目录从不覆盖、
 * 删除或改名。每个 scope 完成后写入 checkpoint，进程中断后可用 --resume
 * 继续，发现目标已有不完整数据时 fail-loud，避免静默覆盖用户数据。
 */

import fs from 'node:fs';
import path from 'node:path';
import { ZvecEngine, type Doc, type EmbeddingProvider } from '../../dist/zvec-engine/index.js';
import { loadConfig } from './config.js';
import { ensureVectorLayout, getCollectionsRoot, getLayoutPath, getScopeCollectionPath, VECTOR_LAYOUT_VERSION } from './scope-collection.js';
import { validateScope } from './scope.js';
import { beginExternalEngineOp, closeEngine, endExternalEngineOp, serializeEngineOp } from './vector-client.js';

const COLLECTION_NAME = 'kisearch';
const DENSE_FIELD = 'dense';
const FTS_FIELD = 'content';
const TAG_FIELD = 'tag';
const SCOPE_FIELD = 'scope';
const GROUP_FIELD = 'group';
const MAX_MIGRATION_DOCS = 1_000_000;
const STATE_FILE = 'migration.json';

export interface LegacyVectorDoc extends Doc {
  fields: Record<string, string | number | boolean>;
  vector: number[];
}

export interface MigrationScopeResult {
  scope: string;
  total: number;
  migrated: number;
  status: 'migrated' | 'resumed' | 'skipped';
}

export interface MigrateVectorResult {
  ok: boolean;
  source: string;
  target: string;
  layoutVersion: number;
  scopes: MigrationScopeResult[];
  errors: { scope?: string; error: string }[];
  resumed: boolean;
}

interface MigrationState {
  version: 1;
  source: string;
  layoutVersion: number;
  /**
   * 已完成迁移的 scope 名，仅作审计留痕（“上次跑到哪里”）。
   *
   * resume **不**据此跳过任何 scope：每个 scope 仍会打开目标 Collection 并逐项
   * 核对文本/向量/标量字段，避免目标被人工篡改后静默成功。因此续跑的代价与
   * 全量迁移同量级，不要把它当成“增量续跑”。
   */
  completed: string[];
}

function statePath(): string {
  return path.join(getCollectionsRoot(loadConfig()), STATE_FILE);
}

function readState(source: string, resume: boolean): MigrationState {
  const file = statePath();
  if (!resume || !fs.existsSync(file)) {
    return { version: 1, source, layoutVersion: VECTOR_LAYOUT_VERSION, completed: [] };
  }
  let parsed: Partial<MigrationState>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<MigrationState>;
  } catch {
    throw new Error(`迁移 checkpoint 损坏：${file}；请删除 checkpoint 后重新执行（不会删除旧 Collection）`);
  }
  if (parsed.version !== 1 || parsed.source !== source || parsed.layoutVersion !== VECTOR_LAYOUT_VERSION || !parsed.completed) {
    throw new Error(`迁移 checkpoint 与当前向量目录不匹配：${file}；请使用正确的 vectorDir 或删除 checkpoint 后重试`);
  }
  // completed 早期为对象映射（scope → {total, idsHash}），该结构的字段只写不读，
  // 已改为纯名称数组；两种形式的 `!parsed.completed` 都为 false，必须显式校验类型。
  if (!Array.isArray(parsed.completed)) {
    throw new Error(
      `迁移 checkpoint 格式已变更（期望 completed 为 scope 名称数组）：${file}；`
      + '请删除 checkpoint 后重新执行 ki migrate-vector --yes --resume（不会删除旧 Collection）'
    );
  }
  return parsed as MigrationState;
}

function writeState(state: MigrationState): void {
  const file = statePath();
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** 将旧 Collection 文档按 scope 分组；缺 scope 或非法 scope 直接报错，不猜归属。 */
export function groupLegacyDocuments(docs: LegacyVectorDoc[]): Map<string, LegacyVectorDoc[]> {
  const grouped = new Map<string, LegacyVectorDoc[]>();
  for (const doc of docs) {
    const raw = doc.fields?.[SCOPE_FIELD];
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(`旧 Collection 文档缺少合法 scope：memoryId=${doc.id}`);
    }
    const scope = raw.trim();
    validateScope(scope);
    if (!Array.isArray(doc.vector) || doc.vector.length === 0) {
      throw new Error(`旧 Collection 文档缺少向量：memoryId=${doc.id}，scope=${scope}`);
    }
    const bucket = grouped.get(scope) ?? [];
    bucket.push(doc);
    grouped.set(scope, bucket);
  }
  return grouped;
}

function migrationEmbedding(dimension: number): EmbeddingProvider {
  return { dimension, embed: async () => { throw new Error('迁移只接受预计算向量'); } };
}

function collectionConfig(dbPath: string, dimension: number): Parameters<typeof ZvecEngine.create>[0] {
  const embedding = migrationEmbedding(dimension);
  return {
    dbPath,
    collection: {
      name: COLLECTION_NAME,
      denseField: DENSE_FIELD,
      dimension,
      metric: 'COSINE',
      scalarFields: [
        { name: TAG_FIELD, dataType: 'STRING', indexed: true },
        { name: SCOPE_FIELD, dataType: 'STRING', indexed: true },
        { name: GROUP_FIELD, dataType: 'STRING', indexed: true },
        { name: FTS_FIELD, dataType: 'STRING' },
      ],
      fts: { field: FTS_FIELD, tokenizer: 'jieba' },
    },
    embedding,
  };
}

function sameVector(left: number[] | undefined, right: number[] | undefined): boolean {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function sameFields(left: Record<string, string | number | boolean> | undefined, right: Record<string, string | number | boolean>): boolean {
  if (!left) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function sameDocument(left: LegacyVectorDoc, right: LegacyVectorDoc): boolean {
  return left.id === right.id
    && left.text === right.text
    && sameVector(left.vector, right.vector)
    && sameFields(left.fields, right.fields);
}

async function openTarget(scope: string, docs: LegacyVectorDoc[], resume: boolean): Promise<MigrationScopeResult> {
  const config = loadConfig();
  const target = getScopeCollectionPath(config, scope);
  const ids = docs.map((d) => d.id);
  const existing = fs.existsSync(target) && fs.readdirSync(target).length > 0;

  if (existing) {
    if (!resume) throw new Error(`目标 Collection 已存在：${target}；为避免覆盖，请使用 --resume 或清理目标后重试`);
    // 断点续跑允许补写缺失文档，但绝不覆盖已有内容：先读取并逐项核对
    // 文本、向量和标量字段，发现同 id 内容漂移或额外文档立即 fail-loud。
    const engine = await serializeEngineOp(() => ZvecEngine.open({ dbPath: target, collectionName: COLLECTION_NAME, embedding: migrationEmbedding(config.embedding.dimension) }));
    try {
      const existingIds = await engine.listIds(undefined, MAX_MIGRATION_DOCS + 1);
      if (existingIds.length > MAX_MIGRATION_DOCS) {
        throw new Error(`目标 Collection 文档超过迁移上限 ${MAX_MIGRATION_DOCS}：${target}`);
      }
      const set = new Set(existingIds);
      const sourceById = new Map(docs.map((doc) => [doc.id, doc]));
      const existingDocs = existingIds.length > 0
        ? (await engine.fetch(existingIds, true) as LegacyVectorDoc[])
        : [];
      for (const existingDoc of existingDocs) {
        const expected = sourceById.get(existingDoc.id);
        if (!expected) {
          throw new Error(`目标 Collection 含来源不存在的文档：${target} / ${existingDoc.id}；不会删除或覆盖`);
        }
        if (!sameDocument(existingDoc, expected)) {
          throw new Error(`目标 Collection 文档内容与旧库不一致：${target} / ${existingDoc.id}；不会覆盖`);
        }
      }
      const missing = docs.filter((doc) => !set.has(doc.id));
      if (missing.length > 0) {
        const result = await engine.upsert(missing.map((doc) => ({
          id: doc.id,
          text: doc.text,
          vector: doc.vector,
          fields: doc.fields,
        })));
        if (result.failed > 0 || result.ok !== missing.length) {
          throw new Error(`断点续写不完整：成功 ${result.ok}/${missing.length}，失败 ${result.failed}`);
        }
      }
      return { scope, total: docs.length, migrated: docs.length, status: 'resumed' };
    } finally {
      // close 也必须串行：worker 的 closeSync（释放 LOCK）与任何并发 open 相撞
      // 同样会触发原生竞态永久阻塞。
      await serializeEngineOp(() => engine.close()).catch(() => {});
    }
  }

  // create 要求 dbPath 不存在；已知的空目录是上次 create 失败留下的安全残留，可移除。
  if (fs.existsSync(target)) fs.rmdirSync(target);
  const engine = await serializeEngineOp(() => ZvecEngine.create(collectionConfig(target, config.embedding.dimension)));
  try {
    const result = await engine.upsert(docs.map((doc) => ({
      id: doc.id,
      text: doc.text,
      vector: doc.vector,
      fields: doc.fields,
    })));
    if (result.failed > 0 || result.ok !== docs.length) {
      throw new Error(`目标写入不完整：成功 ${result.ok}/${docs.length}，失败 ${result.failed}`);
    }
    const written = await engine.listIds(undefined, MAX_MIGRATION_DOCS);
    if (written.length !== docs.length || ids.some((id) => !written.includes(id))) {
      throw new Error(`目标校验失败：${target} 中 doc id 数量或内容不一致`);
    }
    return { scope, total: docs.length, migrated: docs.length, status: 'migrated' };
  } finally {
    await serializeEngineOp(() => engine.close()).catch(() => {});
  }
}

export async function migrateLegacyVectorLayout(params: {
  yes: boolean;
  resume?: boolean;
}): Promise<MigrateVectorResult> {
  const config = loadConfig();
  const source = path.resolve(config.vectorDir);
  const target = getCollectionsRoot(config);
  // ensureVectorLayout 会创建 vectorDir/collections；先识别根目录中是否真的
  // 存在旧 Collection，避免把新布局自身误判为“损坏的旧库”。
  const hasLegacyEntries = fs.existsSync(source)
    && fs.readdirSync(source).some((entry) => entry !== path.basename(target));
  if (!params.yes) {
    return { ok: false, source, target, layoutVersion: VECTOR_LAYOUT_VERSION, scopes: [], errors: [{ error: '迁移会在新目录创建按 scope Collection，但不会删除旧数据；请使用 --yes 确认' }], resumed: Boolean(params.resume) };
  }

  ensureVectorLayout(config);

  if (!hasLegacyEntries) {
    return { ok: true, source, target, layoutVersion: VECTOR_LAYOUT_VERSION, scopes: [], errors: [], resumed: Boolean(params.resume) };
  }

  // 迁移全程直接调用原生 ZvecEngine.*（不经 withEngine），因此必须：
  //  1. 先关闭 daemon 已持有的全部 scope engine —— 否则同进程两个 ZVecOpen 打同一
  //     dbPath，按项目实测约 62% 概率触发原生竞态**永久阻塞**；daemon 是唯一 zvec
  //     owner，一旦挂死则 CLI/stdio/HTTP 全部入口不可用，只能 kill -9。
  //  2. 持有在途计数抑制 idle-close —— 它由 setInterval 触发、不经过 coordinator，
  //     全局独占队列拦不住它，会在迁移途中 void closeEngine() 与原生 open 并发。
  //  3. 所有 open/create/probe/close 走 serializeEngineOp，与 vector-client 同队。
  await closeEngine();
  beginExternalEngineOp();
  try {
    const probe = await serializeEngineOp(() => ZvecEngine.probe(source));
    if (!probe.exists) {
      return { ok: true, source, target, layoutVersion: VECTOR_LAYOUT_VERSION, scopes: [], errors: [], resumed: Boolean(params.resume) };
    }
    if (probe.locked) {
      return { ok: false, source, target, layoutVersion: VECTOR_LAYOUT_VERSION, scopes: [], errors: [{ error: `旧 Collection 被占用：${source}；请停止旧 owner 后重试` }], resumed: Boolean(params.resume) };
    }
    if (!probe.healthy) {
      return { ok: false, source, target, layoutVersion: VECTOR_LAYOUT_VERSION, scopes: [], errors: [{ error: `旧 Collection 不健康：${source}；请先从备份恢复或重新 import` }], resumed: Boolean(params.resume) };
    }

    const embedding = migrationEmbedding(config.embedding.dimension);
    const legacy = await serializeEngineOp(() => ZvecEngine.open({ dbPath: source, collectionName: COLLECTION_NAME, embedding, readOnly: true }));
    const state = readState(source, Boolean(params.resume));
    const scopes: MigrationScopeResult[] = [];
    const errors: { scope?: string; error: string }[] = [];
    try {
      const ids = await legacy.listIds(undefined, MAX_MIGRATION_DOCS + 1);
      if (ids.length > MAX_MIGRATION_DOCS) throw new Error(`旧 Collection 文档超过迁移上限 ${MAX_MIGRATION_DOCS}，请拆分后重试`);
      const docs = (await legacy.fetch(ids, true)) as LegacyVectorDoc[];
      if (docs.length !== ids.length) throw new Error(`旧 Collection 读取不完整：listIds=${ids.length}，fetch=${docs.length}`);
      const grouped = groupLegacyDocuments(docs);
      for (const [scope, scopeDocs] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        // 即使 checkpoint 标记 scope 已完成，resume 仍会核对目标 Collection 的
        // 文本/向量/字段；不依赖 checkpoint 直接跳过，避免目标被人工篡改后静默成功。
        // 代价：续跑与全量迁移同量级（见 MigrationState.completed 注释）。
        try {
          const result = await openTarget(scope, scopeDocs, Boolean(params.resume));
          scopes.push(result);
          if (!state.completed.includes(scope)) state.completed.push(scope);
          writeState(state);
        } catch (err) {
          errors.push({ scope, error: (err as Error).message });
          break;
        }
      }
    } finally {
      await serializeEngineOp(() => legacy.close()).catch(() => {});
    }
    return { ok: errors.length === 0, source, target, layoutVersion: VECTOR_LAYOUT_VERSION, scopes, errors, resumed: Boolean(params.resume) };
  } finally {
    endExternalEngineOp();
  }
}

export function migrationStatePath(): string {
  return statePath();
}

export function migrationLayoutPath(): string {
  return getLayoutPath(loadConfig());
}
