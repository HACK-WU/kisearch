/**
 * 从 KB 层重建 FTS-only Collection。
 *
 * 快照只包含 scope 数据目录，不包含 vectorDir；因此 restore 后必须能够在不调用
 * embedding 的情况下恢复 --no-vector 文档的正文索引。这里复用 import/rebuild 的
 * 清洗与 chunk 规则，FTS ID 仍与写入链路保持确定性。
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, getScopeCleanConfig } from './config.js';
import { getLocalKbDir, getRelationsCachePath, getSource } from './scope.js';
import { loadCacheShape, persistCacheShape, migrateLegacyRelationsCache, hasShardedLayout, type LegacyRelationsCacheShape } from './group-cache.js';
import { buildChunkEntries } from './chunk-entries.js';
import { cleanMarkdownText, runCleanHooks } from './clean.js';
import { parseContentTags } from './constants.js';
import { writeJson } from './store.js';
import { ftsBulkStore, ftsDeleteByIds, getFtsDocId, type FtsStoreEntry } from './fts-client.js';
import { buildChunkLineRanges, type FtsLocator } from './original-locator.js';

interface FtsRelation {
  text: string;
  memoryId?: string | null;
  memoryIds?: string[];
  ftsIds?: string[];
  ftsIndexComplete?: boolean;
  ftsLocators?: FtsLocator[];
  sourcePath?: string;
  tags?: string[];
}

interface FtsCache {
  groups?: Record<string, { hot_relations?: FtsRelation[] }>;
}

export interface FtsRebuildResult {
  indexed: number;
  relations: number;
  errors: { group: string; relation: string; error: string }[];
}

function hasDenseRelation(rel: FtsRelation): boolean {
  // 新版导入显式写入 memoryIds=[] 表示无 dense；即使旧兼容字段 memoryId 残留，
  // 也不能把该 Relation 跳过，否则历史 FTS-only 文档无法重建全文索引。
  return Array.isArray(rel.memoryIds) ? rel.memoryIds.length > 0 : !!rel.memoryId;
}

/** 重建 scope 中所有没有 dense memoryId 的 relation（可安全重复执行）。 */
export async function rebuildFtsOnlyScope(scope: string, groupFilter?: string): Promise<FtsRebuildResult> {
  // 批次 2（R4）：双轨读（FtsCache 内存形状不变；新布局分片聚合，旧布局整文件）
  const cachePath = getRelationsCachePath(scope);
  let cache: FtsCache;
  try {
    cache = loadCacheShape(scope) as unknown as FtsCache;
  } catch (err) {
    // 批次 2 审查 P1-3：必须区分「两布局均无数据（空 scope）」与「数据在但读失败（损坏）」。
    // 原实现一律返回 indexed:0 —— 分片损坏时 restore 尾部重建会静默假成功（旧实现是 fail-loud）。
    if (!hasShardedLayout(scope) && !fs.existsSync(cachePath)) {
      return { indexed: 0, relations: 0, errors: [] };
    }
    return { indexed: 0, relations: 0, errors: [{ group: '-', relation: '-', error: `读取 relations 元数据失败：${(err as Error).message}` }] };
  }
  // 触达组采集（两处落盘点只写这些组）
  const touchedGroups = new Set<string>();
  const config = loadConfig();
  const cleanConfig = getScopeCleanConfig(config, scope);
  const source = getSource(scope);
  const chunkSize = source?.chunkSize ?? 1000;
  const chunkOverlap = source?.chunkOverlap ?? 150;
  const cleanEnabled = cleanConfig?.enabled !== false;
  const allEntries: FtsStoreEntry[] = [];
  const records: { group: string; relation: FtsRelation; original: string; oldIds: string[]; entryStart: number; entryEnd: number; chunks: Array<{ index: number; text: string }> }[] = [];
  const errors: FtsRebuildResult['errors'] = [];
  let completionStateChanged = false;

  for (const [group, groupData] of Object.entries(cache.groups ?? {})) {
    if (groupFilter && group !== groupFilter && !group.startsWith(`${groupFilter}/`)) continue;
    for (const relation of groupData.hot_relations ?? []) {
      if (!relation.text || hasDenseRelation(relation)) continue;
      if (relation.ftsIndexComplete !== false) {
        relation.ftsIndexComplete = false;
        completionStateChanged = true;
        touchedGroups.add(group);
      }
      const localKbPath = getLocalKbDir(scope, group);
      let localKb: Record<string, string>;
      try {
        localKb = JSON.parse(fs.readFileSync(localKbPath, 'utf-8')) as Record<string, string>;
      } catch (err) {
        errors.push({ group, relation: relation.text, error: `读取 local KB 失败：${(err as Error).message}` });
        continue;
      }
      const original = localKb[relation.text];
      if (typeof original !== 'string' || original.length === 0) {
        errors.push({ group, relation: relation.text, error: 'local KB 缺少原文，无法重建全文索引' });
        continue;
      }

      let text = cleanEnabled ? cleanMarkdownText(original, cleanConfig?.rules) : original;
      if (cleanEnabled && (cleanConfig?.hooks?.length ?? 0) > 0) {
        const hookResult = await runCleanHooks(text, cleanConfig!.hooks!);
        if (!hookResult.ok) {
          errors.push({ group, relation: relation.text, error: `清洗 hook 失败：${hookResult.failedHooks.join(', ')}` });
          continue;
        }
        text = hookResult.text;
      }
      const { chunks, entries } = buildChunkEntries({
        fileKey: relation.text,
        groupPath: group,
        text,
        chunkSize,
        chunkOverlap,
        relationName: relation.text,
      });
      const tags = ['ki-search', ...parseContentTags(relation.tags?.join(','))];
      const entryStart = allEntries.length;
      for (const entry of entries) {
        for (const tag of tags) {
          allEntries.push({ text: entry.text, scope, group, relation: relation.text, tag });
        }
      }
      records.push({
        group,
        relation,
        original,
        oldIds: relation.ftsIds ?? [],
        entryStart,
        entryEnd: allEntries.length,
        chunks,
      });
    }
  }

  // 若本地原文缺失，或后续 FTS 写入抛错，不能继续沿用快照/旧 cache 中的成功状态。
  // 批次 2：预写改触达组（中断安全语义保持——预写必须立即落盘）
  if (completionStateChanged) {
    migrateLegacyRelationsCache(scope);
    persistCacheShape(scope, cache as unknown as LegacyRelationsCacheShape, touchedGroups);
  }

  if (allEntries.length === 0) {
    return { indexed: 0, relations: records.length, errors };
  }

  const stored = await ftsBulkStore(allEntries);
  const storedIds = new Set(stored.ids);
  let indexed = 0;
  for (const record of records) {
    const expected = allEntries.slice(record.entryStart, record.entryEnd).map(getFtsDocId);
    const newIds = expected.filter((id) => storedIds.has(id));
    indexed += newIds.length;
    let complete = newIds.length === expected.length;
    let trackedIds = complete ? [...newIds] : [...record.oldIds, ...newIds];
    const chunkRanges = buildChunkLineRanges(
      record.original,
      record.chunks,
    );
    const tagCount = Math.max(1, parseContentTags(record.relation.tags?.join(',')).length + 1);
    const newLocators: FtsLocator[] = expected.flatMap((id, index) => {
      const chunk = record.chunks[Math.floor(index / tagCount)];
      const range = chunk ? chunkRanges.get(chunk.index) : undefined;
      return range ? [{ ftsId: id, chunkIndex: chunk.index, sourcePath: record.relation.sourcePath, ...range }] : [];
    }).filter((locator) => storedIds.has(locator.ftsId));
    const locatorMap = new Map<string, FtsLocator>();
    if (complete) {
      const staleIds = record.oldIds.filter((id) => !newIds.includes(id));
      if (staleIds.length > 0) {
        try {
          const deleted = await ftsDeleteByIds({ scope, ids: staleIds });
          if (deleted.failed > 0) {
            complete = false;
            trackedIds = [...newIds, ...deleted.failedIds];
            errors.push({ group: record.group, relation: record.relation.text, error: `旧全文索引清理失败 ${deleted.failed} 条` });
          }
        } catch (err) {
          complete = false;
          trackedIds = [...newIds, ...staleIds];
          errors.push({ group: record.group, relation: record.relation.text, error: `旧全文索引清理失败：${(err as Error).message}` });
        }
      }
    }
    if (newIds.length !== expected.length) {
      errors.push({ group: record.group, relation: record.relation.text, error: `全文索引部分写入成功（${newIds.length}/${expected.length}）` });
    }
    record.relation.ftsIndexComplete = complete;
    const trackedIdSet = new Set(trackedIds);
    record.relation.ftsIds = [...trackedIdSet];
    for (const locator of [...(record.relation.ftsLocators ?? []), ...newLocators]) {
      if (trackedIdSet.has(locator.ftsId)) locatorMap.set(locator.ftsId, locator);
    }
    record.relation.ftsLocators = [...locatorMap.values()];
  }
  if (stored.failed > 0) errors.push({ group: '<batch>', relation: '<fts>', error: `全文索引写入失败 ${stored.failed} 条` });
  // 批次 2：最终落盘改触达组批写（records 的组；到达此处必然 records.length > 0）
  {
    const finalTouched = new Set(records.map((r) => r.group));
    if (finalTouched.size > 0) {
      migrateLegacyRelationsCache(scope);
      persistCacheShape(scope, cache as unknown as LegacyRelationsCacheShape, finalTouched);
    }
  }
  return { indexed, relations: records.length, errors };
}
