/**
 * import-conflict.test.ts —— 同名导入策略与逻辑 relation 命名契约。
 * 运行：npx jiti test/import-conflict.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
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

  it('validates mode and suffix template', () => {
    assert.equal(validateImportConflictMode(undefined), 'suffix');
    assert.equal(validateImportConflictSuffix(undefined), `_{n}`);
    assert.throws(() => validateImportConflictMode('merge'), /允许值/);
    assert.throws(() => validateImportConflictSuffix('副本'), /必须包含/);
    assert.throws(() => validateImportConflictSuffix('../_{n}'), /不能包含/);
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
