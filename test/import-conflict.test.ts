/**
 * import-conflict.test.ts —— 同名导入策略与逻辑 relation 命名契约。
 * 运行：npx jiti test/import-conflict.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IMPORT_CONFLICT_MODE,
  resolveImportConflict,
  validateImportConflictMode,
  validateImportConflictSuffix,
} from '../src/lib/import-conflict.js';
import { buildChunkEntries } from '../src/lib/chunk-entries.js';
import type { Relation } from '../src/lib/scoring.js';

function relation(text: string, sourcePath: string): Relation {
  return {
    id: `rel-${text}`,
    text,
    score: 0,
    useCount: 0,
    lastUsedTime: null,
    isImported: true,
    sourcePath,
  };
}

describe('import conflict resolution', () => {
  it('same sourcePath first: suffix mode remains idempotent after prior rename', () => {
    const result = resolveImportConflict({
      relations: [relation('foo_1', 'docs/foo.md'), relation('foo', 'old/foo.md')],
      baseRelation: 'foo',
      sourcePath: 'docs/foo.md',
      mode: 'suffix',
    });
    assert.equal(result.relation, 'foo_1');
    assert.equal(result.action, 'overwrite');
    assert.equal(result.conflicted, false);
  });

  it('supports skip, overwrite and suffix for different sourcePath', () => {
    const relations = [relation('foo', 'old/foo.md'), relation('foo_1', 'other/foo.md')];
    assert.equal(resolveImportConflict({ relations, baseRelation: 'foo', sourcePath: 'new/foo.md', mode: 'skip' }).action, 'skip');
    assert.equal(resolveImportConflict({ relations, baseRelation: 'foo', sourcePath: 'new/foo.md', mode: 'overwrite' }).relation, 'foo');
    assert.equal(resolveImportConflict({ relations, baseRelation: 'foo', sourcePath: 'new/foo.md', mode: 'suffix' }).relation, 'foo_2');
  });

  it('R3: 默认策略为增量导入（CLI 与 Web 同默认）', () => {
    assert.equal(validateImportConflictMode(undefined), 'incremental');
    assert.equal(DEFAULT_IMPORT_CONFLICT_MODE, 'incremental');
  });

  it('validates mode and suffix template', () => {
    assert.equal(validateImportConflictMode(undefined), 'incremental');
    assert.equal(validateImportConflictSuffix(undefined), `_{n}`);
    assert.throws(() => validateImportConflictMode('merge'), /允许值/);
    assert.throws(() => validateImportConflictSuffix('副本'), /必须包含/);
    assert.throws(() => validateImportConflictSuffix('../_{n}'), /不能包含/);
  });
});

describe('R2（REQ-20261010-001）：同批重复 rel 交给策略、不再静默覆盖', () => {
  // 现场：剥离顶层目录段后「多目录同拖」→ a/foo.md 与 b/foo.md 剥后同为 foo.md
  const batch = [relation('foo', 'a/foo.md')];

  it('增量导入（默认）对同名不同来源 = 直接覆盖（不留后缀副本）', () => {
    const result = resolveImportConflict({
      relations: [], batchRelations: batch, baseRelation: 'foo', sourcePath: 'b/foo.md',
    });
    assert.equal(result.relation, 'foo');
    assert.equal(result.action, 'overwrite');
    assert.equal(result.conflictFromBatch, true);
  });

  it('skip 会真的跳过后者（此前被幂等覆盖分支截胡）', () => {
    const result = resolveImportConflict({
      relations: [], batchRelations: batch, baseRelation: 'foo', sourcePath: 'b/foo.md', mode: 'skip',
    });
    assert.equal(result.action, 'skip');
    assert.equal(result.conflictFromBatch, true);
  });

  it('overwrite 仍解析到同一 relation，并标记 conflictFromBatch（调用方据此丢弃前者）', () => {
    const result = resolveImportConflict({
      relations: [], batchRelations: batch, baseRelation: 'foo', sourcePath: 'b/foo.md', mode: 'overwrite',
    });
    assert.equal(result.relation, 'foo');
    assert.equal(result.action, 'overwrite');
    assert.equal(result.conflictFromBatch, true);
  });

  it('R4：skip 模式下同 sourcePath 也真的跳过（此前被幂等覆盖分支截胡，选跳过仍全量重做）', () => {
    const result = resolveImportConflict({
      relations: [relation('foo', 'a/foo.md')], batchRelations: [{ ...relation('foo_1', 'a/foo.md') }],
      baseRelation: 'foo', sourcePath: 'a/foo.md', mode: 'skip',
    });
    assert.equal(result.action, 'skip', 'skip 语义 = 库中已有就什么都不做');
    assert.equal(result.relation, 'foo');
    assert.equal(result.conflictFromBatch, false);
    assert.equal(result.conflicted, true, '计入冲突明细，供结果摘要报告"已存在跳过"');
  });

  it('R4：其余策略下同 sourcePath 仍走幂等覆盖（重导更新语义不被 skip 改动影响）', () => {
    for (const mode of ['incremental', 'overwrite', 'suffix', undefined]) {
      const result = resolveImportConflict({
        relations: [relation('foo', 'a/foo.md')],
        baseRelation: 'foo', sourcePath: 'a/foo.md', mode,
      });
      assert.equal(result.action, 'overwrite', `mode=${mode} 应保持幂等覆盖`);
      assert.equal(result.relation, 'foo', `mode=${mode} 不应另生成副本名`);
      assert.equal(result.conflicted, false, `mode=${mode} 的幂等更新不算冲突`);
    }
  });
});

describe('chunk entries with logical relation name', () => {
  it('keeps sourcePath while using suffixed relation for chunk/path names', () => {
    const { entries } = buildChunkEntries({
      fileKey: 'docs/foo.md',
      relationName: 'foo_1',
      groupPath: 'wiki',
      text: 'hello',
      chunkSize: 100,
      chunkOverlap: 0,
    });
    assert.equal(entries[0].path, 'docs/foo.md#1');
    assert.equal(entries[0].fileRelation, 'foo_1');
    assert.equal(entries[0].chunkRelation, 'foo_1-01');
  });
});
