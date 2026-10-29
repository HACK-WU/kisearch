/**
 * relation-map.ts 测试 —— memoryId 反查映射 + TTL/mtime 缓存
 *
 * 背景：ki search 命中向量层结果后按 memoryId 反查 relations-cache.json，
 * 附加 group / relation / keywords / isFullText 定位原文。缓存策略为 TTL
 * （默认 10 分钟）+ 文件 mtime 优先失效（写入后立即重建）。
 *
 * 运行：npx jiti test/relation-map.test.ts
 */

import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRelationMap, clearRelationMapCache } from '../src/lib/relation-map.js';
import { getRelationsCachePath } from '../src/lib/scope.js';
import { resetConfigCache } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'relation-map-'));

function setupConfig(): { configPath: string; dataDir: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-'));
  const dataDir = path.join(dir, 'kb');
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    [
      `dataDir: ${dataDir}`,
      `vectorDir: ${path.join(dir, 'vector')}`,
      'scopeMode: default',
      'scopes:',
      '  default: {}',
      '  alpha: {}',
      '',
    ].join('\n'),
    'utf-8'
  );
  process.env.KI_CONFIG_PATH = configPath;
  resetConfigCache();
  return { configPath, dataDir };
}

function writeCache(scope: string, groups: Record<string, unknown>): void {
  const p = getRelationsCachePath(scope);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, scope, groups }, null, 2), 'utf-8');
}

describe('getRelationMap', () => {
  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
    clearRelationMapCache();
  });

  it('构建映射：memoryId 可反查 group / relation（旧数据 keywords/isFullText 字段忽略）', () => {
    setupConfig();
    writeCache('default', {
      'a/b': {
        hot_relations: [
          { id: 'r1', text: '钉钉集成配置', memoryId: 'm1', isFullText: false },
          { id: 'r2', text: '钉钉 webhook 地址', memoryId: 'm2', isFullText: true },
        ],
        keywords: ['钉钉', '集成'],
      },
      'c': {
        hot_relations: [{ id: 'r3', text: '企业微信回调', memoryId: 'm3' }],
        keywords: ['企业微信'],
      },
    });

    const map = getRelationMap('default');
    assert.equal(map.size, 3);
    assert.deepEqual(map.get('m1'), {
      group: 'a/b',
      relation: '钉钉集成配置',
    });
    assert.deepEqual(map.get('m2'), {
      group: 'a/b',
      relation: '钉钉 webhook 地址',
    });
    // 旧数据 keywords / isFullText 字段不进入映射（REQ-05/09 已删除）
    assert.deepEqual(map.get('m3'), {
      group: 'c',
      relation: '企业微信回调',
    });
    assert.equal(map.get('unknown-id'), undefined);
  });

  it('relation.tags 透传到映射条目（多标签文档）；无 tags 时键缺省', () => {
    setupConfig();
    writeCache('default', {
      'a/b': {
        hot_relations: [
          { id: 'r1', text: '多标签文档', memoryId: 'm1', tags: ['api', 'auth'] },
          { id: 'r2', text: '无标签文档', memoryId: 'm2' },
        ],
      },
    });

    const map = getRelationMap('default');
    // 有 tags → 透传（executeSearch 附加到 SearchHit.tags 供前端全量展示）
    assert.deepEqual(map.get('m1'), {
      group: 'a/b',
      relation: '多标签文档',
      tags: ['api', 'auth'],
    });
    // 无 tags → 不注入该键（与旧数据 deepEqual 兼容，JSON 输出不变）
    assert.deepEqual(map.get('m2'), { group: 'a/b', relation: '无标签文档' });
  });

  it('无 memoryId 的条目跳过（不进入映射）', () => {
    setupConfig();
    writeCache('default', {
      'a/b': {
        hot_relations: [
          { id: 'r1', text: '有 memoryId', memoryId: 'm1' },
          { id: 'r2', text: '无 memoryId' },
        ],
      },
    });

    const map = getRelationMap('default');
    assert.equal(map.size, 1);
    assert.ok(map.has('m1'));
  });

  it('FTS-only 的 ftsIds 可反查 Group/Relation 与原文定位元数据', () => {
    setupConfig();
    writeCache('default', {
      'fts/group': {
        hot_relations: [{
          id: 'r-fts',
          text: '全文文档',
          memoryIds: [],
          sourcePath: 'docs/fulltext.md',
          ftsIds: ['fts-1'],
          ftsLocators: [{ ftsId: 'fts-1', sourcePath: 'docs/fulltext.md', chunkIndex: 2, lineStart: 42, lineEnd: 44 }],
        }],
      },
    });

    const map = getRelationMap('default');
    assert.deepEqual(map.get('fts-1'), {
      group: 'fts/group',
      relation: '全文文档',
      sourcePath: 'docs/fulltext.md',
      ftsLocator: { ftsId: 'fts-1', sourcePath: 'docs/fulltext.md', chunkIndex: 2, lineStart: 42, lineEnd: 44 },
    });
  });

  it('relations-cache.json 不存在 → 空 Map（不抛错）', () => {
    setupConfig();
    const map = getRelationMap('default');
    assert.equal(map.size, 0);
  });

  it('元数据损坏（非法 JSON）→ 抛错 fail-loud（不再静默空 Map）', () => {
    // 第二轮审查 P1：原实现整体 catch → 返回空 Map 且被身份三元组「认证」缓存 10 分钟，
    // 把「数据在但读失败」降级成"该 scope 检索结果全部丢失定位字段"，无从感知。
    setupConfig();
    const p = getRelationsCachePath('default');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ invalid json !!!', 'utf-8');

    assert.throws(() => getRelationMap('default'), /损坏|CORRUPT_JSON|解析错误/, '损坏必须 fail-loud');
  });

  it('新布局分片损坏 → 抛错 fail-loud（不缓存空 Map）', async () => {
    setupConfig();
    const { writeGroupCache, getGroupCachePath } = await import('../src/lib/group-cache.js');
    writeGroupCache('default', 'g', { version: 1, scope: 'default', hot_relations: [], keywords: [] });
    fs.writeFileSync(getGroupCachePath('default', 'g'), '{ broken', 'utf-8');

    assert.throws(() => getRelationMap('default'), /损坏|CORRUPT_JSON|解析错误/, '分片损坏必须 fail-loud');
  });

  it('缓存命中：mtime 未变时返回同一 Map 实例（不重复读文件）', () => {
    setupConfig();
    writeCache('default', {
      'a': { hot_relations: [{ id: 'r1', text: 't', memoryId: 'm1' }] },
    });

    const first = getRelationMap('default');
    const second = getRelationMap('default');
    assert.equal(first, second, '两次调用应命中同一缓存实例');
  });

  it('mtime 变化 → 立即失效重建（新写入的数据立即可见）', () => {
    setupConfig();
    writeCache('default', {
      'a': { hot_relations: [{ id: 'r1', text: '旧', memoryId: 'm1' }] },
    });
    const before = getRelationMap('default');
    assert.ok(before.has('m1'));

    // 写入新数据（sync-relation/import 场景）
    writeCache('default', {
      'a': { hot_relations: [{ id: 'r1', text: '旧', memoryId: 'm1' }] },
      'b': { hot_relations: [{ id: 'r2', text: '新', memoryId: 'm2' }] },
    });

    const after = getRelationMap('default');
    assert.notEqual(after, before, 'mtime 变化应重建 Map');
    assert.ok(after.has('m2'), '新写入的 memoryId 应立即可反查');
  });

  it('TTL 过期 → 重建（mtime 未变也重建）', async () => {
    setupConfig();
    writeCache('default', {
      'a': { hot_relations: [{ id: 'r1', text: 't', memoryId: 'm1' }] },
    });

    const first = getRelationMap('default', 20); // TTL 20ms
    await new Promise((r) => setTimeout(r, 60)); // 等待过期
    const second = getRelationMap('default', 20);

    assert.notEqual(second, first, 'TTL 过期应重建 Map');
  });

  it('scope 隔离：各 scope 独立缓存互不污染', () => {
    setupConfig();
    writeCache('default', { 'a': { hot_relations: [{ id: 'r1', text: 'd', memoryId: 'md' }] } });
    writeCache('alpha', { 'b': { hot_relations: [{ id: 'r2', text: 'a', memoryId: 'ma' }] } });

    const def = getRelationMap('default');
    const alpha = getRelationMap('alpha');
    assert.ok(def.has('md'));
    assert.ok(!def.has('ma'));
    assert.ok(alpha.has('ma'));
    assert.ok(!alpha.has('md'));
  });

  it('批次 2 R10：新布局（relations/ 分片，无旧单文件）反查正常——旧实现恒空 Map', async () => {
    setupConfig();
    const { writeGroupCacheBatch } = await import('../src/lib/group-cache.js');
    // 直接种新布局（不经 import 链路）：两分片，dense + FTS 各一
    writeGroupCacheBatch('default', new Map([
      ['a/b', { version: 1, scope: 'default', hot_relations: [{ id: 'r1', text: '文档A', score: 1, memoryIds: ['m-a1', 'm-a2'] } as never], keywords: [] }],
      ['c', { version: 1, scope: 'default', hot_relations: [{ id: 'r2', text: '文档B', score: 1, ftsIds: ['f-b1'] } as never], keywords: [] }],
    ]));

    const map = getRelationMap('default');
    assert.equal(map.size, 3, 'dense 双 ID + FTS 单 ID 全部建立反查（新布局不再恒空）');
    assert.equal(map.get('m-a1')?.group, 'a/b');
    assert.equal(map.get('m-a1')?.relation, '文档A');
    assert.equal(map.get('f-b1')?.relation, '文档B');
  });

  it('批次 2 R10：新布局写路径 bump revision → 身份变化立即失效（不等 TTL）', async () => {
    setupConfig();
    const { writeGroupCache, writeGroupCacheBatch } = await import('../src/lib/group-cache.js');
    writeGroupCacheBatch('default', new Map([
      ['a', { version: 1, scope: 'default', hot_relations: [{ id: 'r1', text: '旧', score: 1, memoryId: 'm-old' } as never], keywords: [] }],
    ]));
    const first = getRelationMap('default');
    assert.ok(first.has('m-old'));

    // 走正式写原语 bump revision（模拟 import/sync 写后）
    writeGroupCache('default', 'a', {
      version: 1, scope: 'default',
      hot_relations: [{ id: 'r1', text: '旧', score: 1, memoryId: 'm-old' }, { id: 'r2', text: '新', score: 1, memoryId: 'm-new' }] as never,
      keywords: [],
      updatedAt: null,
    });
    const second = getRelationMap('default');
    assert.ok(second.has('m-new'), 'revision bump 后新写入数据立即可见（不等 TTL）');
    assert.ok(second.has('m-old'));
  });
});
