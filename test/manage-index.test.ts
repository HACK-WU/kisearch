/**
 * manage-index.ts 集成测试
 * 
 * 覆盖：create、delete、查询树结构、删除非空节点拒绝
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

// ─── 辅助函数 ───

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'manage-index.ts'
);

function runManageIndex(args: string[]): { ok: boolean; [key: string]: unknown } {
  try {
    const output = execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv()
    });
    return JSON.parse(output);
  } catch (err: any) {
    // commander 错误退出码也会抛异常，尝试解析 stderr/stdout
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // ignore
      }
    }
    return { ok: false, error: err.message };
  }
}

// ─── 测试 ───

let tmpKbDir: string;
let testScope: string;

before(() => {
  // 创建临时目录作为 KB 根目录
  tmpKbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-manage-test-'));
  testScope = 'test-scope';
});

after(() => {
  fs.rmSync(tmpKbDir, { recursive: true, force: true });
  cleanupTestConfig();
});

describe('manage-index 核心逻辑', () => {
  it('scope 校验拒绝非法字符', () => {
    const result = runManageIndex(['--scope', '../bad', '--action', 'create', '--name', 'test']);
    assert.strictEqual(result.ok, false);
  });

  it('scope 校验拒绝路径遍历', () => {
    const result = runManageIndex(['--scope', 'a/b', '--action', 'create', '--name', 'test']);
    assert.strictEqual(result.ok, false);
  });
});

describe('manage-index 功能验证（通过模块直接调用）', () => {
  it('initScope 创建正确的目录结构（新格式 groups）', async () => {
    const { initScope } = await import('../src/lib/store.js');
    const { getKbDir, getGroupIndexPath, getRelationsCachePath } = await import('../src/lib/scope.js');

    const scope = 'init-test-' + Date.now();
    try {
      initScope(scope);

      const kbDir = getKbDir(scope);
      assert.ok(fs.existsSync(kbDir));

      const groupIndexPath = getGroupIndexPath(scope);
      assert.ok(fs.existsSync(groupIndexPath));

      const groupIndex = JSON.parse(fs.readFileSync(groupIndexPath, 'utf-8'));
      assert.strictEqual(groupIndex.version, 1);
      assert.strictEqual(groupIndex.scope, scope);
      assert.ok(groupIndex.groups !== undefined);
      assert.strictEqual(Object.keys(groupIndex.groups).length, 0);

      const relationsCachePath = getRelationsCachePath(scope);
      assert.ok(fs.existsSync(relationsCachePath));

      const relationsCache = JSON.parse(fs.readFileSync(relationsCachePath, 'utf-8'));
      assert.strictEqual(relationsCache.version, 1);
      assert.ok(relationsCache.partition_config !== undefined);
    } finally {
      const kbDir = getKbDir(scope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('Group 树 CRUD 操作（顶层 + 子节点）', async () => {
    const { readJson, writeJson, initScope } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getKbDir } = await import('../src/lib/scope.js');

    const scope = 'crud-test-' + Date.now();
    try {
      initScope(scope);

      const indexPath = getGroupIndexPath(scope);
      const data = readJson<any>(indexPath)!;

      // 创建顶层 Group
      data.groups['wiki'] = {};
      writeJson(indexPath, data);

      let updated = readJson<any>(indexPath)!;
      assert.ok(updated.groups['wiki'] !== undefined);

      // 创建子节点
      updated.groups['wiki']['监控'] = {};
      updated.groups['wiki']['监控']['告警中心'] = {};
      writeJson(indexPath, updated);

      updated = readJson<any>(indexPath)!;
      assert.ok(updated.groups['wiki']['监控']['告警中心'] !== undefined);

      // 删除叶子节点
      delete updated.groups['wiki']['监控']['告警中心'];
      writeJson(indexPath, updated);

      updated = readJson<any>(indexPath)!;
      assert.strictEqual(updated.groups['wiki']['监控']['告警中心'], undefined);
    } finally {
      const kbDir = getKbDir(scope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('新格式 group-index.json 无 roots 字段', async () => {
    const { initScope } = await import('../src/lib/store.js');
    const { getGroupIndexPath: getIndexPath, getKbDir: getDir } = await import('../src/lib/scope.js');

    const scope = 'format-test-' + Date.now();
    try {
      initScope(scope);
      const data = JSON.parse(fs.readFileSync(getIndexPath(scope), 'utf-8'));
      assert.ok(data.groups !== undefined);
      assert.strictEqual(data.roots, undefined);
    } finally {
      const kbDir = getDir(scope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});

describe('自动迁移（旧格式 → 新格式）', () => {
  it('旧格式 roots → 自动迁移为 groups（"项目根"子节点提升）', async () => {
    const { readGroupIndex } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getKbDir, getRelationsCachePath } = await import('../src/lib/scope.js');

    const scope = 'migrate-test-' + Date.now();
    const kbDir = getKbDir(scope);
    try {
      // 手动创建旧格式 group-index.json（含 roots）
      fs.mkdirSync(kbDir, { recursive: true });
      const oldGroupIndex = {
        version: 1,
        scope,
        roots: {
          '项目根': {
            'API': {},
            '部署': { '运维': {} },
          },
        },
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(getGroupIndexPath(scope), JSON.stringify(oldGroupIndex, null, 2), 'utf-8');

      // 创建最小 relations-cache.json（迁移需要）
      const cachePath = getRelationsCachePath(scope);
      fs.writeFileSync(cachePath, JSON.stringify({
        version: 1, scope, groups: {}, updatedAt: null,
      }), 'utf-8');

      // 触发自动迁移
      const migrated = readGroupIndex(scope);
      assert.ok(migrated !== null);
      assert.ok(migrated!.groups !== undefined);

      // "项目根"的子节点应被提升到顶层
      assert.ok(migrated!.groups['API'] !== undefined);
      assert.ok(migrated!.groups['部署'] !== undefined);
      assert.strictEqual(Object.keys(migrated!.groups).length, 2);

      // 文件应被写回
      const fileData = JSON.parse(fs.readFileSync(getGroupIndexPath(scope), 'utf-8'));
      assert.strictEqual(fileData.roots, undefined);
      assert.ok(fileData.groups['API'] !== undefined);
    } finally {
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('roots + groups 共存 → 迁移时保留已有 groups 数据', async () => {
    const { readGroupIndex } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getKbDir, getRelationsCachePath } = await import('../src/lib/scope.js');

    const scope = 'merge-test-' + Date.now();
    const kbDir = getKbDir(scope);
    try {
      fs.mkdirSync(kbDir, { recursive: true });
      // 同时存在 roots 和 groups
      const mixedData = {
        version: 1,
        scope,
        roots: {
          '项目根': { '监控': {} },
        },
        groups: {
          'wiki': { 'FAQ': {} },
        },
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(getGroupIndexPath(scope), JSON.stringify(mixedData, null, 2), 'utf-8');

      fs.writeFileSync(getRelationsCachePath(scope), JSON.stringify({
        version: 1, scope, groups: {}, updatedAt: null,
      }), 'utf-8');

      const migrated = readGroupIndex(scope);
      assert.ok(migrated !== null);

      // roots 中的"监控"被提升 + groups 中的 "wiki" 被保留
      assert.ok(migrated!.groups['监控'] !== undefined, '"监控"应从 roots 提升');
      assert.ok(migrated!.groups['wiki'] !== undefined, '"wiki"应保留已有 groups');
      assert.ok(migrated!.groups['wiki']['FAQ'] !== undefined);
    } finally {
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('外部导入的 rootName 作为顶层 Group 保留（非 "项目根"）', async () => {
    const { readGroupIndex } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getKbDir, getRelationsCachePath } = await import('../src/lib/scope.js');

    const scope = 'import-migrate-' + Date.now();
    const kbDir = getKbDir(scope);
    try {
      fs.mkdirSync(kbDir, { recursive: true });
      const oldData = {
        version: 1,
        scope,
        roots: {
          'BK-Monitor-Wiki': {
            '部署': {},
            'API': { '告警': {} },
          },
        },
        updatedAt: '2024-01-01T00:00:00.000Z',
      };
      fs.writeFileSync(getGroupIndexPath(scope), JSON.stringify(oldData, null, 2), 'utf-8');

      fs.writeFileSync(getRelationsCachePath(scope), JSON.stringify({
        version: 1, scope, groups: {}, updatedAt: null,
      }), 'utf-8');

      const migrated = readGroupIndex(scope);
      assert.ok(migrated !== null);

      // "BK-Monitor-Wiki" 作为顶层 Group 保留
      assert.ok(migrated!.groups['BK-Monitor-Wiki'] !== undefined);
      assert.ok(migrated!.groups['BK-Monitor-Wiki']['部署'] !== undefined);
      assert.ok(migrated!.groups['BK-Monitor-Wiki']['API'] !== undefined);
      assert.ok(migrated!.groups['BK-Monitor-Wiki']['API']['告警'] !== undefined);
    } finally {
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('relations-cache key 迁移：去掉 "项目根/" 前缀', async () => {
    const { readGroupIndex } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getKbDir, getRelationsCachePath } = await import('../src/lib/scope.js');

    const scope = 'cache-migrate-' + Date.now();
    const kbDir = getKbDir(scope);
    try {
      fs.mkdirSync(kbDir, { recursive: true });

      // 旧格式 group-index
      const oldGroupIndex = { version: 1, scope, roots: { '项目根': { 'API': {} } }, updatedAt: null };
      fs.writeFileSync(getGroupIndexPath(scope), JSON.stringify(oldGroupIndex, null, 2), 'utf-8');

      // 旧格式 relations-cache（含 "项目根/" 前缀的 key）
      const oldCache = {
        version: 1, scope,
        groups: {
          '项目根/API': { hot_relations: [], keywords: ['endpoint', 'auth'] },
          '项目根/API/配置': { hot_relations: [], keywords: ['config'] },
          'normal-group': { hot_relations: [], keywords: ['normal'] },
        },
        updatedAt: null,
      };
      fs.writeFileSync(getRelationsCachePath(scope), JSON.stringify(oldCache, null, 2), 'utf-8');

      // 触发起迁移
      readGroupIndex(scope);

      // 验证 relations-cache 已迁移
      const migratedCache = JSON.parse(fs.readFileSync(getRelationsCachePath(scope), 'utf-8'));
      assert.ok(migratedCache.groups['API'] !== undefined);
      assert.ok(migratedCache.groups['API/配置'] !== undefined);
      assert.strictEqual(migratedCache.groups['项目根/API'], undefined);
      assert.strictEqual(migratedCache.groups['项目根/API/配置'], undefined);

      // 非 "项目根/" 前缀的 key 不受影响
      assert.ok(migratedCache.groups['normal-group'] !== undefined);
    } finally {
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('relations-cache 冲突 key 合并（"项目根/API" 和 "API" 同时存在）', async () => {
    const { readGroupIndex } = await import('../src/lib/store.js');
    const { getGroupIndexPath, getKbDir, getRelationsCachePath } = await import('../src/lib/scope.js');

    const scope = 'cache-merge-' + Date.now();
    const kbDir = getKbDir(scope);
    try {
      fs.mkdirSync(kbDir, { recursive: true });

      const oldGroupIndex = { version: 1, scope, roots: { '项目根': { 'API': {} } }, updatedAt: null };
      fs.writeFileSync(getGroupIndexPath(scope), JSON.stringify(oldGroupIndex, null, 2), 'utf-8');

      // 旧 prefix key 和新 key 同时存在
      const cache = {
        version: 1, scope,
        groups: {
          '项目根/API': {
            hot_relations: [{ id: 'rel_001', text: 'old-relation', score: 10, useCount: 1, lastUsedTime: null, isImported: false }],
            keywords: ['kw1', 'kw2'],
          },
          'API': {
            hot_relations: [{ id: 'rel_002', text: 'new-relation', score: 20, useCount: 2, lastUsedTime: null, isImported: false }],
            keywords: ['kw2', 'kw3'],
          },
        },
        updatedAt: null,
      };
      fs.writeFileSync(getRelationsCachePath(scope), JSON.stringify(cache, null, 2), 'utf-8');

      readGroupIndex(scope);

      const merged = JSON.parse(fs.readFileSync(getRelationsCachePath(scope), 'utf-8'));

      // 旧 key 应被删除
      assert.strictEqual(merged.groups['项目根/API'], undefined);

      // "API" 应包含合并后的数据
      assert.ok(merged.groups['API'] !== undefined);
      const apiGroup = merged.groups['API'];

      // hot_relations 合并去重
      assert.strictEqual(apiGroup.hot_relations.length, 2);

      // keywords 合并去重（kw2 只保留一份）
      assert.ok(apiGroup.keywords.includes('kw1'));
      assert.ok(apiGroup.keywords.includes('kw2'));
      assert.ok(apiGroup.keywords.includes('kw3'));
      // kw2 不应重复
      assert.strictEqual(apiGroup.keywords.filter((k: string) => k === 'kw2').length, 1);
    } finally {
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});
