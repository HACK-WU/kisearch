import { getSharedOperationCoordinator } from './operation-coordinator.js';
import { loadConfig, getScopeCleanConfig } from './config.js';
import { getSource, getLocalKbDir, getRelationsCachePath } from './scope.js';
import { readJson, writeJson } from './store.js';
import type { Relation } from './scoring.js';
import { buildChunkEntries } from './chunk-entries.js';
import { MAX_CHUNKS_PER_FILE } from './chunker.js';
import { cleanMarkdownText, runCleanHooks } from './clean.js';
import { buildChunkLineRanges, type FtsLocator } from './original-locator.js';
import { buildRelationContent } from './path-vectorize.js';
import { generateDocId, vectorBulkStore, vectorDelete, vectorFetchDocs } from './vector-client.js';
import { ftsBulkStore, ftsDeleteByIds, getFtsDocId } from './fts-client.js';
import { writeBackToWiki } from './wiki-sync.js';
import { contentRevision, metadataRevision, loadDraft, saveDraft, type RelationEditDraft } from './relation-edit-draft.js';
import { readLiveRelation, relationIndexMode } from './relation-edit-live.js';

type IndexEntry = { text: string; tags: string; group?: string };
type FtsEntry = { text: string; scope: string; group: string; relation: string; tag: string };

interface IndexPlan {
  mode: 'dense' | 'fts';
  denseEntries: IndexEntry[];
  denseContentIds: string[];
  denseIds: string[];
  ftsEntries: FtsEntry[];
  ftsIds: string[];
  ftsLocators: FtsLocator[];
  oldDenseIds: string[];
  oldFtsIds: string[];
  chunkCount: number;
}

const activeJobs = new Map<string, Promise<void>>();

export function isRelationEditJobActive(editId: string): boolean {
  return activeJobs.has(editId);
}

/**
 * 确定性失败：重试必然再次失败（校验不通过、配置错误、超限）。
 * 与瞬时 I/O 失败区分，避免调用方按工具说明无限重试同一 request_id。
 */
export class NonRetryableEditError extends Error {
  readonly retryable = false;
  constructor(message: string) { super(message); this.name = 'NonRetryableEditError'; }
}

function nonRetryable(message: string): never {
  throw new NonRetryableEditError(message);
}

function relationDenseIds(relation: Relation): string[] {
  return [...new Set(relation.memoryIds?.length ? relation.memoryIds : relation.memoryId ? [relation.memoryId] : [])];
}

function sameIds(actual: string[], expected: string[]): boolean {
  const left = [...new Set(actual)].sort();
  const right = [...new Set(expected)].sort();
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function cacheHasPublishedIds(draft: RelationEditDraft, relation: Relation): boolean {
  if (draft.newDenseContentIds?.length) return sameIds(relationDenseIds(relation), draft.newDenseContentIds);
  if (draft.newFtsIds?.length) return sameIds(relation.ftsIds ?? [], draft.newFtsIds);
  return false;
}

async function buildIndexPlan(draft: RelationEditDraft, relation: Relation): Promise<IndexPlan> {
  const config = loadConfig();
  const tags = relation.tags ?? [];
  const source = getSource(draft.scope);
  const cleanCfg = getScopeCleanConfig(config, draft.scope);
  const imported = !!relation.sourcePath;
  const chunked = imported || draft.content.length > 5_000 || (relation.editChunkCount ?? 0) > 1;
  const mode = relationIndexMode(relation);
  let indexedText = draft.content;
  if (chunked && cleanCfg?.enabled !== false) {
    indexedText = cleanMarkdownText(indexedText, cleanCfg?.rules);
    if (cleanCfg?.hooks?.length) {
      const hooked = await runCleanHooks(indexedText, cleanCfg.hooks);
      if (!hooked.ok) throw new Error(`清洗 hook 失败：${hooked.failedHooks.join(', ')}`);
      indexedText = hooked.text;
    }
  }
  const chunks = chunked
    ? buildChunkEntries({ fileKey: relation.sourcePath ?? `${draft.relation}.md`, groupPath: draft.group,
      text: indexedText, chunkSize: source?.chunkSize ?? 1000, chunkOverlap: source?.chunkOverlap ?? 150,
      relationName: draft.relation })
    : { chunks: [{ index: 1, text: indexedText }], entries: [{ text: indexedText, chunkRelation: draft.relation }] };
  if (chunks.chunks.length > MAX_CHUNKS_PER_FILE) throw new Error(`编辑后 chunk 数超过 ${MAX_CHUNKS_PER_FILE}，请拆分文档`);
  if (chunks.chunks.length === 0) throw new Error('编辑后无可索引内容');

  const denseEntries: IndexEntry[] = [];
  const denseContentIds: string[] = [];
  const ftsEntries: FtsEntry[] = [];
  for (const entry of chunks.entries) {
    denseEntries.push({ text: entry.text, tags: 'ki-search' });
    denseContentIds.push(generateDocId(entry.text, draft.scope, 'ki-search'));
    for (const tag of mode === 'fts' || !imported ? tags : []) {
      denseEntries.push({ text: entry.text, tags: tag });
      denseContentIds.push(generateDocId(entry.text, draft.scope, tag));
    }
    for (const tag of ['ki-search', ...tags]) {
      ftsEntries.push({ text: entry.text, scope: draft.scope, group: draft.group, relation: draft.relation, tag });
    }
  }
  // 导入的 dense 文档沿用文件级 tag 向量；内容 chunk 与自定义标签的粒度不变。
  if (mode === 'dense' && imported) {
    for (const tag of tags) {
      denseEntries.push({ text: draft.content, tags: tag });
      denseContentIds.push(generateDocId(draft.content, draft.scope, tag));
    }
  }
  if (mode === 'dense') {
    for (const entry of chunks.entries) {
      denseEntries.push({ text: buildRelationContent(entry.chunkRelation ?? draft.relation, draft.group), tags: 'ki-relation', group: draft.group });
    }
  }
  const denseIds = [...new Set(denseEntries.map((entry) => generateDocId(entry.text, draft.scope, entry.tags)))];
  const uniqueFtsEntries = [...new Map(ftsEntries.map((entry) => [getFtsDocId(entry), entry])).values()];
  const ftsIds = uniqueFtsEntries.map((entry) => getFtsDocId(entry));
  const lineRanges = buildChunkLineRanges(draft.content, chunks.chunks);
  const ftsLocators: FtsLocator[] = [];
  for (let i = 0; i < chunks.entries.length; i++) {
    const entry = chunks.entries[i];
    const chunkIndex = chunks.chunks[i].index;
    const range = lineRanges.get(chunkIndex);
    if (!range) continue;
    for (const tag of ['ki-search', ...tags]) {
      const id = getFtsDocId({ text: entry.text, scope: draft.scope, group: draft.group, relation: draft.relation, tag });
      ftsLocators.push({ ftsId: id, sourcePath: relation.sourcePath ?? `${draft.relation}.md`, chunkIndex, ...range });
    }
  }
  const oldDenseIds = relationDenseIds(relation);
  if (oldDenseIds.length > 0) {
    // 旧 ki-relation 路径向量的 chunk 数无法从 cache 可靠反推（editChunkCount 缺失时
    // memoryIds 与 tags 的组合会误导）。改为枚举候选 ID 并实际探测向量层：只有确实
    // 存在的才纳入清理清单，避免残留脏数据，也不会误删不存在的 ID。
    // 候选上界取 editChunkCount（最终发布记录，最可信）；缺失时用 memoryIds/ftsIds
    // 数量兜底并夹到 MAX_CHUNKS_PER_FILE，保证探测范围有界。
    const fallbackBound = Math.max(
      imported ? 1 : 0,
      (relation.memoryIds?.length ?? 0) + (relation.ftsIds?.length ?? 0),
    );
    const upperBound = Math.min(relation.editChunkCount ?? fallbackBound, MAX_CHUNKS_PER_FILE);
    const candidates: string[] = [];
    if (upperBound <= 1) {
      // 单 chunk：历史上写入的是无后缀路径向量（仅非导入文档走此形态）。
      if (!imported) candidates.push(generateDocId(buildRelationContent(draft.relation, draft.group), draft.scope, 'ki-relation'));
    } else {
      for (let i = 1; i <= upperBound; i++) {
        const name = `${draft.relation}-${String(i).padStart(2, '0')}`;
        candidates.push(generateDocId(buildRelationContent(name, draft.group), draft.scope, 'ki-relation'));
      }
      // 非导入文档历史上也可能写入过无后缀的单条路径向量。
      if (!imported) candidates.push(generateDocId(buildRelationContent(draft.relation, draft.group), draft.scope, 'ki-relation'));
    }
    const uniqueCandidates = [...new Set(candidates)];
    if (uniqueCandidates.length > 0) {
      const present = new Set((await vectorFetchDocs(uniqueCandidates)).map((doc) => doc.docId));
      for (const id of uniqueCandidates) if (present.has(id)) oldDenseIds.push(id);
    }
  }
  return { mode, denseEntries, denseContentIds: [...new Set(denseContentIds)], denseIds,
    ftsEntries: uniqueFtsEntries, ftsIds, ftsLocators, oldDenseIds: [...new Set(oldDenseIds)],
    oldFtsIds: [...new Set(relation.ftsIds ?? [])], chunkCount: chunks.chunks.length };
}

function otherReferences(scope: string, targetGroup?: string, targetRelation?: string): Set<string> {
  const cache = readJson<{ groups?: Record<string, { hot_relations?: Relation[] }> }>(getRelationsCachePath(scope));
  const ids = new Set<string>();
  for (const [group, data] of Object.entries(cache?.groups ?? {})) {
    for (const relation of data.hot_relations ?? []) {
      if (targetGroup !== undefined && group === targetGroup && relation.text === targetRelation) continue;
      for (const id of relationDenseIds(relation)) ids.add(id);
      for (const id of relation.ftsIds ?? []) ids.add(id);
    }
  }
  return ids;
}

/** 放弃未发布草稿时只清理由本次新建、且没有正式归属的索引 ID。 */
export async function discardUnpublishedIndex(draft: RelationEditDraft): Promise<void> {
  if (draft.publishedRevision) throw new Error('正文已经发布；请重试 finish 清理旧索引');
  const active = otherReferences(draft.scope);
  const previous = new Set([...(draft.oldDenseIds ?? []), ...(draft.oldFtsIds ?? []),
    ...(draft.preexistingDenseIds ?? [])]);
  const dense = (draft.newDenseIds ?? []).filter((id) => !previous.has(id) && !active.has(id));
  const fts = (draft.newFtsIds ?? []).filter((id) => !previous.has(id) && !active.has(id));
  if (dense.length > 0) {
    const result = await vectorDelete({ scope: draft.scope, ids: dense });
    const failed = result.errors.filter((item) => item.code !== 'NOT_FOUND');
    if (failed.length) throw new Error(`草稿向量清理失败：${failed.map((item) => item.id).join(',')}`);
  }
  if (fts.length > 0) {
    const result = await ftsDeleteByIds({ scope: draft.scope, ids: fts });
    if (result.failed > 0) throw new Error(`草稿全文索引清理失败：${result.failedIds.join(',')}`);
  }
}

function publishLocalKbAndCache(draft: RelationEditDraft, plan: IndexPlan): void {
  const kbPath = getLocalKbDir(draft.scope, draft.group);
  const cachePath = getRelationsCachePath(draft.scope);
  const kb = readJson<Record<string, string>>(kbPath);
  const cache = readJson<{ groups?: Record<string, { hot_relations?: Relation[] }> }>(cachePath);
  const relation = cache?.groups?.[draft.group]?.hot_relations?.find((item) => item.text === draft.relation);
  if (!kb || !cache || !relation) throw new Error('发布前 Relation 已不存在');
  const currentRevision = contentRevision(kb[draft.relation] ?? '');
  if (currentRevision !== draft.baseRevision) {
    throw new Error('正式正文在编辑期间已变化，拒绝覆盖；请重新创建草稿');
  }
  if (metadataRevision({ tags: relation.tags, sourcePath: relation.sourcePath,
    indexMode: relationIndexMode(relation) }) !== draft.baseMetadataRevision) {
    throw new Error('发布前 Relation 标签、来源或索引模式已变化，拒绝覆盖；请重新创建草稿');
  }
  const priorContent = kb[draft.relation];
  kb[draft.relation] = draft.content;
  writeJson(kbPath, kb);
  if (plan.mode === 'dense') {
    relation.memoryIds = plan.denseContentIds;
    relation.memoryId = plan.denseContentIds[0];
    delete relation.ftsIds;
    delete relation.ftsLocators;
    delete relation.ftsIndexComplete;
  } else {
    relation.ftsIds = plan.ftsIds;
    relation.ftsLocators = plan.ftsLocators;
    relation.ftsIndexComplete = true;
    delete relation.memoryIds;
    delete relation.memoryId;
  }
  relation.editChunkCount = plan.chunkCount;
  try {
    writeJson(cachePath, cache as unknown as Record<string, unknown>);
  } catch (err) {
    // 正常异常立即补偿；进程被强杀的窗口由 recoverInterruptedPublication 处理。
    kb[draft.relation] = priorContent;
    writeJson(kbPath, kb);
    throw err;
  }
  draft.publishedRevision = draft.revision;
  saveDraft(draft);
}

/** 重启后发现“KB 已换、cache 仍是旧 ID”时，先恢复旧正文再重试发布。 */
export function recoverInterruptedPublication(draft: RelationEditDraft): boolean {
  if (draft.publishedRevision || !(draft.newDenseIds?.length || draft.newFtsIds?.length)) return false;
  const kbPath = getLocalKbDir(draft.scope, draft.group);
  const kb = readJson<Record<string, string>>(kbPath);
  if (!kb || contentRevision(kb[draft.relation] ?? '') !== draft.revision) return false;
  const cache = readJson<{ groups?: Record<string, { hot_relations?: Relation[] }> }>(getRelationsCachePath(draft.scope));
  const relation = cache?.groups?.[draft.group]?.hot_relations?.find((item) => item.text === draft.relation);
  if (!relation || cacheHasPublishedIds(draft, relation)) return false;
  kb[draft.relation] = draft.baseContent;
  writeJson(kbPath, kb);
  return true;
}

/** 草稿确认写入前中断时，以已发布的正文和 cache ID 恢复提交标记。 */
export function recognizePublishedDraft(draft: RelationEditDraft): boolean {
  if (draft.publishedRevision || !(draft.newDenseIds?.length || draft.newFtsIds?.length)) return false;
  let live;
  try { live = readLiveRelation(draft.scope, draft.group, draft.relation); }
  catch (err) {
    if (String((err as Error).message).includes('Relation 不存在')) return false;
    throw err;
  }
  if (live.revision !== draft.revision || !cacheHasPublishedIds(draft, live.relation)) return false;
  draft.publishedRevision = draft.revision;
  saveDraft(draft);
  return true;
}

async function cleanupOldIds(draft: RelationEditDraft): Promise<void> {
  // 已发布草稿可能在清理失败后的重试前被 sync/import 再次覆盖；目标 Relation
  // 此时也可能重新引用旧 ID，因此与其他 Relation 一样必须受保护。
  const protectedIds = otherReferences(draft.scope);
  const newDense = new Set(draft.newDenseIds ?? []);
  const newFts = new Set(draft.newFtsIds ?? []);
  const oldDense = (draft.oldDenseIds ?? []).filter((id) => !newDense.has(id) && !protectedIds.has(id));
  const oldFts = (draft.oldFtsIds ?? []).filter((id) => !newFts.has(id) && !protectedIds.has(id));
  const errors: string[] = [];
  if (oldDense.length > 0) {
    const deleted = await vectorDelete({ scope: draft.scope, ids: oldDense });
    errors.push(...deleted.errors.filter((item) => item.code !== 'NOT_FOUND').map((item) => `${item.id}: ${item.reason}`));
  }
  if (oldFts.length > 0) {
    const deleted = await ftsDeleteByIds({ scope: draft.scope, ids: oldFts });
    if (deleted.failed > 0) errors.push(`旧全文索引清理失败：${deleted.failedIds.join(',')}`);
  }
  if (errors.length > 0) throw new Error(errors.join('；'));
}

async function runFinish(editId: string, scope: string): Promise<void> {
  const draft = loadDraft(scope, editId);
  draft.status = 'running';
  saveDraft(draft);
  try {
    if (draft.publishedRevision) {
      // 发布后 Relation 被其他入口删除，也要允许清掉本草稿遗留的旧索引。
      try {
        const current = readLiveRelation(scope, draft.group, draft.relation);
        if (current.revision !== draft.publishedRevision) {
          // 新一轮正式写入已经接管目标；只能清理无引用的旧 ID，不能用旧草稿重写 Wiki。
          await cleanupOldIds(draft);
          draft.status = 'published';
          delete draft.error;
          saveDraft(draft);
          return;
        }
      }
      catch (err) {
        if (!String((err as Error).message).includes('Relation 不存在')) throw err;
        await cleanupOldIds(draft);
        draft.status = 'published';
        delete draft.error;
        saveDraft(draft);
        return;
      }
    }
    recoverInterruptedPublication(draft);
    const live = readLiveRelation(scope, draft.group, draft.relation);
    // 进程若在 cache 发布后、草稿写回前中断，依据已持久化的新 ID 识别已发布终态。
    // 此时绝不能按新 cache 再规划旧 ID，否则旧向量清理清单会丢失。
    if (!draft.publishedRevision) recognizePublishedDraft(draft);
    if (!draft.publishedRevision) {
      if (live.revision !== draft.baseRevision) {
        nonRetryable('正式正文在编辑期间已变化，拒绝覆盖；请重新创建草稿');
      }
      if (live.metadataRevision !== draft.baseMetadataRevision) {
        nonRetryable('Relation 标签、来源或索引模式已变化，拒绝覆盖；请重新创建草稿');
      }
      const plan = await buildIndexPlan(draft, live.relation);
      // docId 按正文、scope、tag 生成，可能已被 ki_store 等非 Relation 写入口占用。
      // 仅首次提交前记录既存 ID；重试时重新扫描会把本草稿的部分写入误认成外部数据。
      if (plan.mode === 'dense' && draft.preexistingDenseIds === undefined) {
        const existing = await vectorFetchDocs(plan.denseIds);
        draft.preexistingDenseIds = existing.map((doc) => doc.docId);
      }
      draft.newDenseIds = plan.mode === 'dense' ? plan.denseIds : [];
      draft.newDenseContentIds = plan.mode === 'dense' ? plan.denseContentIds : [];
      draft.newFtsIds = plan.mode === 'fts' ? plan.ftsIds : [];
      draft.newFtsLocators = plan.mode === 'fts' ? plan.ftsLocators : [];
      draft.oldDenseIds = plan.oldDenseIds;
      draft.oldFtsIds = plan.oldFtsIds;
      saveDraft(draft); // 先登记待隐藏 ID，之后才允许 zvec 写入
      if (plan.mode === 'dense') {
        const preexisting = new Set(draft.preexistingDenseIds ?? []);
        const pending = plan.denseEntries.filter((entry) => !preexisting.has(generateDocId(entry.text, scope, entry.tags)));
        if (pending.length > 0) {
          const written = await vectorBulkStore({ scope, entries: pending });
          if (written.results.some((item) => !item.success)) {
            throw new Error(`新内容向量写入不完整（${written.succeeded}/${written.totalItems}）`);
          }
        }
      } else {
        const written = await ftsBulkStore(plan.ftsEntries);
        if (written.failed > 0 || written.ids.length !== plan.ftsEntries.length) {
          throw new Error(`新全文索引写入不完整（${written.ids.length}/${plan.ftsEntries.length}）`);
        }
      }
      const afterIndex = readLiveRelation(scope, draft.group, draft.relation);
      if (afterIndex.revision !== draft.baseRevision) {
        nonRetryable('索引写入期间正式正文发生变化，拒绝发布');
      }
      if (afterIndex.metadataRevision !== draft.baseMetadataRevision) {
        nonRetryable('索引写入期间 Relation 标签、来源或索引模式发生变化，拒绝发布');
      }
      publishLocalKbAndCache(draft, plan);
    }
    const wiki = writeBackToWiki(scope, draft.group, draft.relation, draft.content);
    draft.wikiSynced = wiki.synced;
    if (!wiki.synced) draft.wikiReason = wiki.reason;
    else delete draft.wikiReason;
    await cleanupOldIds(draft);
    draft.status = 'published';
    delete draft.error;
    saveDraft(draft);
  } catch (err) {
    // 记录失败态本身也可能失败（磁盘满/权限/目录被删），不能让异常从 catch 逃逸：
    // 一旦逃逸，任务会停在开头写入的 running 状态，view/finish 的状态判断随之失真。
    try {
      draft.status = 'failed';
      draft.error = (err as Error).message;
      draft.retryable = !(err instanceof NonRetryableEditError);
      saveDraft(draft);
    } catch { /* 尽力而为：无法持久化失败态时保持运行中状态，由 view 的中断恢复兜底 */ }
  }
}

/** 排进同 scope 队列，工具调用立即返回；任务结果通过 view 查询。 */
export function queueRelationEditFinish(draft: RelationEditDraft): void {
  if (activeJobs.has(draft.editId)) return;
  const task = getSharedOperationCoordinator().submit(
    { operation: 'edit-relation-finish', params: { scope: draft.scope, editId: draft.editId } },
    () => runFinish(draft.editId, draft.scope), draft.scope,
  ).then(() => undefined);
  activeJobs.set(draft.editId, task);
  void task.then(() => activeJobs.delete(draft.editId), () => activeJobs.delete(draft.editId));
}
