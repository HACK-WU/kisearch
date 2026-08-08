/**
 * memory-id-map.test.ts —— 方案 D buildMemoryIdMap 字段直读 + 旧数据回退（diff 链路）
 *
 * 契约：
 *   - 方案 D：文件级 relation 挂 memoryIds 多值 + sourcePath 无 #N → 字段直读 Map<文件, id[]>
 *   - 旧数据回退：单值 memoryId + chunk 级 sourcePath（#N）按前缀聚合
 *   - 无字段 relation（sync-relation 手动写入，无 memoryIds/memoryId）→ 返回空（不可被向量召回）
 *
 * 运行：npx jiti test/memory-id-map.test.ts
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import { registerTestScope, cleanupTestConfig } from './test-config.js';
import { ensureScopeDir, writeJson } from '../src/lib/store.js';
import { getRelationsCachePath } from '../src/lib/scope.js';
import { buildMemoryIdMap } from '../src/lib/diff.js';

const scope = `memmap-${Date.now()}`;

function writeCache(groups: Record<string, any>): void {
  writeJson(getRelationsCachePath(scope), {
    version: 1,
    scope,
    partition_config: {},
    groups,
    updatedAt: null,
  } as unknown as Record<string, unknown>);
}

describe('buildMemoryIdMap 字段直读（方案 D）', () => {
  before(() => {
    registerTestScope(scope);
    ensureScopeDir(scope);
  });

  after(() => {
    cleanupTestConfig();
  });

  it('方案 D：文件级 relation memoryIds 多值字段直读', () => {
    writeCache({
      'Wiki/docs': {
        hot_relations: [
          {
            id: 'rel_001',
            text: 'api',
            memoryIds: ['m1', 'm2', 'm3'],
            sourcePath: 'docs/api.md', // 无 #N
          },
        ],
        keywords: [],
        max_hot_count: 10,
      },
    });
    const map = buildMemoryIdMap(scope);
    assert.deepStrictEqual([...(map.get('docs/api.md') ?? [])].sort(), ['m1', 'm2', 'm3']);
  });

  it('旧数据回退：chunk 级 sourcePath（#N）按前缀聚合', () => {
    writeCache({
      'Wiki/docs': {
        hot_relations: [
          { id: 'rel_001', text: 'api-01', memoryId: 'm1', sourcePath: 'docs/api.md#1' },
          { id: 'rel_002', text: 'api-02', memoryId: 'm2', sourcePath: 'docs/api.md#2' },
          { id: 'rel_003', text: 'api-03', memoryId: 'm3', sourcePath: 'docs/api.md#3' },
        ],
        keywords: [],
        max_hot_count: 10,
      },
    });
    const map = buildMemoryIdMap(scope);
    assert.deepStrictEqual([...(map.get('docs/api.md') ?? [])].sort(), ['m1', 'm2', 'm3']);
  });

  it('旧数据单值：sourcePath 无 # 时 key 即文件路径', () => {
    writeCache({
      'Wiki/docs': {
        hot_relations: [
          { id: 'rel_001', text: 'old', memoryId: 'm9', sourcePath: 'docs/old.md' },
        ],
        keywords: [],
        max_hot_count: 10,
      },
    });
    const map = buildMemoryIdMap(scope);
    assert.deepStrictEqual(map.get('docs/old.md'), ['m9']);
  });

  it('无字段 relation（sync-relation 手动写入）→ 不产生映射（不可向量召回）', () => {
    writeCache({
      'Wiki/docs': {
        hot_relations: [
          { id: 'rel_001', text: 'manual', sourcePath: 'docs/manual.md' }, // 无 memoryIds/memoryId
        ],
        keywords: [],
        max_hot_count: 10,
      },
    });
    const map = buildMemoryIdMap(scope);
    assert.strictEqual(map.get('docs/manual.md'), undefined);
  });

  it('memoryIds 去重（内容相同 chunk 生成同 id 时）', () => {
    writeCache({
      'Wiki/docs': {
        hot_relations: [
          { id: 'rel_001', text: 'dup', memoryIds: ['m1', 'm1', 'm2'], sourcePath: 'docs/dup.md' },
        ],
        keywords: [],
        max_hot_count: 10,
      },
    });
    const map = buildMemoryIdMap(scope);
    assert.deepStrictEqual([...(map.get('docs/dup.md') ?? [])].sort(), ['m1', 'm2']);
  });

  it('损坏 cache → 返回空 Map 不抛错', () => {
    fs.writeFileSync(getRelationsCachePath(scope), 'not-json{{{', 'utf-8');
    const map = buildMemoryIdMap(scope);
    assert.ok(map instanceof Map);
  });
});
