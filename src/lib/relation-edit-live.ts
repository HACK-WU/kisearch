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
