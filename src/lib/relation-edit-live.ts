import { getLocalKbDir, getRelationsCachePath } from './scope.js';
import { readJson } from './store.js';
import type { Relation } from './scoring.js';
import { isUnsafeRelationName } from './wiki-sync.js';
import { contentRevision, metadataRevision } from './relation-edit-draft.js';

export interface LiveRelation {
  content: string;
  relation: Relation;
  revision: string;
  metadataRevision: string;
}

/**
 * 解析 Relation 的索引模式（写路径的唯一判据）。
 *
 * 优先级：有 FTS ID 且标记完整 → 'fts'；否则 'dense'（含“有 dense、FTS 完整性未知”）。
 * 这是**有意**取舍：`ftsIndexComplete === true` 说明全文索引已完整，此时不该强迫它做
 * embedding（scope 可能是没有 apiKey 的 FTS-only 部署）；完整性未知（多为历史数据）
 * 且有 dense 时按 dense 处理，避免把向量文档误降级成全文。
 *
 * 注意与面向展示的 `scoring.isFtsOnlyIndexedRelation` 的差异：混合态（ftsIds 非空 +
 * memoryIds 非空 + ftsIndexComplete === true）下本函数返回 'fts'，而展示口径因“有向量”
 * 返回 false（显示已向量化）。两者都不是错：写路径只能选一种模式落盘，展示口径描述
 * “当前是否已有向量”。改任一侧前先看本说明与 test/edit-relation.test.ts 的混合态用例。
 */
export function relationIndexMode(record: Relation): 'dense' | 'fts' {
  const hasFts = (record.ftsIds?.length ?? 0) > 0;
  const hasDense = (record.memoryIds?.length ?? 0) > 0 || !!record.memoryId;
  if (hasFts && (record.ftsIndexComplete === true || !hasDense)) return 'fts';
  return 'dense';
}

export function readLiveRelation(scope: string, group: string, relation: string): LiveRelation {
  if (!group || group.includes('\\') || group.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('group 必须是已有 Group 的精确路径，且不能包含空段、点段或反斜杠');
  }
  if (!relation || isUnsafeRelationName(relation)) throw new Error('relation 名称无效');
  const cache = readJson<{ groups?: Record<string, { hot_relations?: Relation[] }> }>(getRelationsCachePath(scope));
  const record = cache?.groups?.[group]?.hot_relations?.find((item) => item.text === relation);
  if (!record) throw new Error(`Relation 不存在：${group}/${relation}；ki_edit_relation 只修改已有 Relation`);
  const kb = readJson<Record<string, string>>(getLocalKbDir(scope, group));
  const content = kb?.[relation];
  if (typeof content !== 'string' || !content.trim()) throw new Error('Relation 本地 KB 正文不存在或为空');
  const indexMode = relationIndexMode(record);
  return {
    content,
    relation: record,
    revision: contentRevision(content),
    metadataRevision: metadataRevision({ tags: record.tags, sourcePath: record.sourcePath, indexMode }),
  };
}
