/**
 * atlas/scope-map —— 主库 × 图集库映射（设计 S-01，2026-11-27）
 *
 * 只测纯函数：不碰磁盘、不读真实 config.yaml。`resolveAtlasMap` 用最小 KiConfig 构造，
 * 避免测试被默认配置的其它字段牵连。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  atlasScopeFor,
  mainScopeFor,
  isAtlasScope,
  resolveAtlasMap,
  AtlasScopeMapError,
  DEFAULT_ATLAS_SUFFIX,
} from '../src/lib/atlas/scope-map.js';
import type { KiConfig } from '../src/lib/config.js';

const map = (mappings: Record<string, string> = {}, suffix = DEFAULT_ATLAS_SUFFIX) => ({
  suffix,
  mappings,
});

const cfg = (atlas?: { suffix?: string; mappings?: Record<string, string> }): KiConfig => ({
  dataDir: '/tmp/ki-test',
  backupDir: '/tmp/ki-test-backup',
  vectorDir: '/tmp/ki-test-vector',
  embedding: {} as KiConfig['embedding'],
  scopeMode: 'default',
  scopes: {},
  scopeReadonly: [],
  ...(atlas ? { atlas } : {}),
});

test('默认后缀：主库 → <主库>-atlas', () => {
  assert.equal(atlasScopeFor('kisearch', map()), 'kisearch-atlas');
  assert.equal(atlasScopeFor('monitor', map()), 'monitor-atlas');
});

test('自指：已带后缀不再二次追加', () => {
  assert.equal(atlasScopeFor('kisearch-atlas', map()), 'kisearch-atlas');
});

test('显式映射优先于后缀', () => {
  const m = map({ consul: 'consul-map' });
  assert.equal(atlasScopeFor('consul', m), 'consul-map');
});

test('映射的 value 视为图集库本体（自指）', () => {
  const m = map({ consul: 'consul-map' });
  assert.equal(atlasScopeFor('consul-map', m), 'consul-map');
});

test('反查：图集库 → 主库；非图集库返回 null', () => {
  const m = map({ consul: 'consul-map' });
  assert.equal(mainScopeFor('consul-map', m), 'consul');
  assert.equal(mainScopeFor('kisearch-atlas', m), 'kisearch');
  assert.equal(mainScopeFor('kisearch', m), null);
  assert.equal(isAtlasScope('kisearch-atlas', m), true);
  assert.equal(isAtlasScope('kisearch', m), false);
});

test('自定义后缀同样生效', () => {
  const m = map({}, '_atlas');
  assert.equal(atlasScopeFor('kisearch', m), 'kisearch_atlas');
  assert.equal(mainScopeFor('kisearch_atlas', m), 'kisearch');
});

test('resolveAtlasMap：缺省配置给出 -atlas / 空映射', () => {
  assert.deepEqual(resolveAtlasMap(cfg()), { suffix: DEFAULT_ATLAS_SUFFIX, mappings: {} });
});

test('resolveAtlasMap：显式映射与后缀透传', () => {
  assert.deepEqual(
    resolveAtlasMap(cfg({ suffix: '-map', mappings: { monitor: 'monitor-map' } })),
    { suffix: '-map', mappings: { monitor: 'monitor-map' } },
  );
});

test('环检测：A→B、B→A 抛错并打印环路径', () => {
  assert.throws(
    () => resolveAtlasMap(cfg({ mappings: { a: 'b', b: 'a' } })),
    (err: unknown) => err instanceof AtlasScopeMapError && /环/.test((err as Error).message),
  );
});

test('后缀非法（空 / 含斜杠 / 超长）抛错', () => {
  assert.throws(() => resolveAtlasMap(cfg({ suffix: '' })), AtlasScopeMapError);
  assert.throws(() => resolveAtlasMap(cfg({ suffix: '-a/b' })), AtlasScopeMapError);
  assert.throws(() => resolveAtlasMap(cfg({ suffix: '-' + 'x'.repeat(40) })), AtlasScopeMapError);
});

test('映射里的非法 scope 名抛错', () => {
  assert.throws(
    () => resolveAtlasMap(cfg({ mappings: { 'bad name': 'ok-atlas' } })),
    AtlasScopeMapError,
  );
});
