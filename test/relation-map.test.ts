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

  it('构建映射：memoryId 可反查 group / relation / keywords / isFullText', () => {
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
      keywords: ['钉钉', '集成'],
      isFullText: false,
    });
    assert.deepEqual(map.get('m2'), {
      group: 'a/b',
      relation: '钉钉 webhook 地址',
      keywords: ['钉钉', '集成'],
      isFullText: true,
    });
    // 字段缺失 → isFullText 为 undefined（search 按默认 false=摘要处理）
    assert.deepEqual(map.get('m3'), {
      group: 'c',
      relation: '企业微信回调',
      keywords: ['企业微信'],
      isFullText: undefined,
    });
    assert.equal(map.get('unknown-id'), undefined);
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

  it('relations-cache.json 不存在 → 空 Map（不抛错）', () => {
    setupConfig();
    const map = getRelationMap('default');
    assert.equal(map.size, 0);
  });

  it('relations-cache.json 损坏（非法 JSON）→ 空 Map（不抛错）', () => {
    setupConfig();
    const p = getRelationsCachePath('default');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{ invalid json !!!', 'utf-8');

    const map = getRelationMap('default');
    assert.equal(map.size, 0);
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
});
