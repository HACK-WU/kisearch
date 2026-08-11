/**
 * rebuild-vector 单元测试：从已还原 KB 重建向量（--rebuild-vector）
 *
 * 覆盖：
 *   A. collectContentEntries —— Group 树 index.json 收集（排除元数据键、groupPath 推导）
 *   B. collectPathRelationEntries —— relation(ki-relation) / path(ki-path) 条目
 *   C. updateMemoryIds —— 内容向量 docId 回写 relations-cache 的 rel.memoryId
 *   D. rebuildScopeVectors 主流程（mock 向量层）—— 三类向量、清空调用、回写、失败路径
 *
 * 运行：npx jiti test/rebuild-vector.test.ts
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  collectContentEntries,
  collectPathRelationEntries,
  collectTagEntries,
  updateMemoryIds,
  rebuildScopeVectors,
  type RebuildVectorEntry,
} from '../src/lib/rebuild-vector.js';
import { resetConfigCache } from '../src/lib/config.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'rebuild-vec-'));

/** 构造 scope 数据目录：Group 树 index.json + relations-cache.json（与已还原 KB 同构） */
function makeScopeDir(scopeDir: string): void {
  fs.mkdirSync(path.join(scopeDir, 'BKMonitorWiki', '用户界面设计'), { recursive: true });
  fs.writeFileSync(
    path.join(scopeDir, 'relations-cache.json'),
    JSON.stringify({
      groups: {
        BKMonitorWiki: {
          hot_relations: [{ text: '快速开始', memoryId: 'old_1', sourcePath: '快速开始.md' }],
          keywords: ['蓝鲸'],
        },
        'BKMonitorWiki/用户界面设计': {
          hot_relations: [{ text: '按钮', memoryId: 'old_2', sourcePath: '用户界面设计/按钮.md' }],
          keywords: ['UI'],
        },
      },
    }),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(scopeDir, 'BKMonitorWiki', 'index.json'),
    JSON.stringify({ 快速开始: '快速开始描述', version: 1, updatedAt: '2026-01-01' }),
    'utf-8'
  );
  fs.writeFileSync(
    path.join(scopeDir, 'BKMonitorWiki', '用户界面设计', 'index.json'),
    JSON.stringify({ 按钮: '按钮描述', version: 1, updatedAt: '2026-01-01' }),
    'utf-8'
  );
}

/** 创建配置 + scope 数据目录，返回 { configPath, scopeDir } */
function setupScope(scope: string): { configPath: string; scopeDir: string } {
  const dir = fs.mkdtempSync(path.join(tmpRoot, `cfg-${scope}-`));
  const dataDir = path.join(dir, 'kb');
  const scopeDir = path.join(dataDir, scope);
  const configPath = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    configPath,
    `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  ${scope}: {}\n`,
    'utf-8'
  );
  makeScopeDir(scopeDir);
  return { configPath, scopeDir };
}

describe('A. collectContentEntries —— Group 树 index.json 收集', () => {
  it('收集全部关系条目，排除 version/updatedAt 元数据键', () => {
    const scopeDir = fs.mkdtempSync(path.join(tmpRoot, 'collect-'));
    makeScopeDir(scopeDir);
    const entries = collectContentEntries(scopeDir);

    assert.strictEqual(entries.length, 2);
    assert.ok(entries.every((e) => e.tags === 'ki-search'));
    const byName = Object.fromEntries(entries.map((e) => [e.relationName, e]));
    assert.strictEqual(byName['快速开始'].groupPath, 'BKMonitorWiki');
    assert.strictEqual(byName['按钮'].groupPath, 'BKMonitorWiki/用户界面设计');
    assert.ok(entries.every((e) => !e.text.includes('version')));
  });

  it('content 纯化：text 取 index.json 原始值，不拼接任何前缀', () => {
    const scopeDir = fs.mkdtempSync(path.join(tmpRoot, 'collect-format-'));
    makeScopeDir(scopeDir);
    const entries = collectContentEntries(scopeDir);

    const byName = Object.fromEntries(entries.map((e) => [e.relationName, e]));
    const quick = byName['快速开始'];
    assert.strictEqual(quick.text, '快速开始描述', 'text 应为 index.json 原始值，无 [摘要]/[路径]/[关键词] 前缀');
    assert.strictEqual('keywords' in quick, false, 'RebuildVectorEntry 不再有 keywords 字段（REQ-05）');
  });

  it('scope 目录不存在 → 返回空数组', () => {
    assert.deepStrictEqual(
      collectContentEntries(path.join(tmpRoot, 'not-exists')),
      []
    );
  });
});

describe('B. collectPathRelationEntries —— relation/path 向量条目', () => {
  const groups = {
    BKMonitorWiki: {
      hot_relations: [{ text: '快速开始' }],
      keywords: ['蓝鲸'],
    },
    'BKMonitorWiki/用户界面设计': {
      hot_relations: [{ text: '按钮' }, { text: '表单' }],
      keywords: ['UI'],
    },
  };

  it('每个 relation 一条 ki-relation，每个 group 一条 ki-path', () => {
    const { relationEntries, pathEntries } = collectPathRelationEntries(groups);
    assert.strictEqual(relationEntries.length, 3);
    assert.strictEqual(pathEntries.length, 2);
    assert.ok(relationEntries.every((e) => e.tags === 'ki-relation'));
    assert.ok(pathEntries.every((e) => e.tags === 'ki-path'));
  });

  it('relation 向量文本只含关系名，Group 归属走结构化字段', () => {
    const { relationEntries } = collectPathRelationEntries(groups);
    assert.strictEqual(relationEntries[0].text, '快速开始', 'content 不含 Group 路径，避免误匹配');
    assert.strictEqual(relationEntries[0].group, 'BKMonitorWiki', 'Group 归属经 group 字段传递');
    const pathText = collectPathRelationEntries(groups).pathEntries[0].text;
    assert.match(pathText, /BKMonitorWiki/);
  });

  it('空 groups → 空条目', () => {
    const { relationEntries, pathEntries } = collectPathRelationEntries({});
    assert.strictEqual(relationEntries.length, 0);
    assert.strictEqual(pathEntries.length, 0);
  });
});

describe('C. updateMemoryIds —— memoryId 回写', () => {
  const groups = {
    BKMonitorWiki: { hot_relations: [{ text: '快速开始', memoryId: 'old' }] },
    'BKMonitorWiki/用户界面设计': {
      hot_relations: [{ text: '按钮', memoryId: 'old' }, { text: '表单', memoryId: 'old' }],
    },
  };

  it('按 (groupPath, relationName) 匹配并回写', () => {
    const allEntries: RebuildVectorEntry[] = [
      { text: 'a', tags: 'ki-search', groupPath: 'BKMonitorWiki', relationName: '快速开始' },
      { text: 'b', tags: 'ki-search', groupPath: 'BKMonitorWiki/用户界面设计', relationName: '按钮' },
      { text: 'c', tags: 'ki-relation' },
    ];
    // 内容向量 index 0 成功、index 1 失败、index 2（relation 向量）成功
    const results = [
      { index: 0, memoryId: 'm0', success: true },
      { index: 1, memoryId: 'm1', success: false },
      { index: 2, memoryId: 'm2', success: true },
    ];
    const updated = updateMemoryIds(groups, allEntries, results);

    assert.strictEqual(updated, 1);
    assert.strictEqual(groups.BKMonitorWiki.hot_relations[0].memoryId, 'm0');
    // 失败的按钮保持旧值；无匹配的表单保持旧值
    assert.strictEqual(groups['BKMonitorWiki/用户界面设计'].hot_relations[0].memoryId, 'old');
    assert.strictEqual(groups['BKMonitorWiki/用户界面设计'].hot_relations[1].memoryId, 'old');
  });

  it('自定义 tag 向量 docId 也回填到 memoryIds（首 docId 兼容 memoryId）', () => {
    const g = {
      G1: { hot_relations: [{ text: 'x', memoryId: 'old' }] },
    };
    const allEntries: RebuildVectorEntry[] = [
      // 内容向量（ki-search）在前
      { text: 'x原文', tags: 'ki-search', groupPath: 'G1', relationName: 'x' },
      // 自定义 tag 向量在后（同 relation）
      { text: 'x原文', tags: 'api', groupPath: 'G1', relationName: 'x' },
      { text: 'x原文', tags: 'auth', groupPath: 'G1', relationName: 'x' },
    ];
    const results = [
      { index: 0, memoryId: 'content_id', success: true },
      { index: 1, memoryId: 'tag_api_id', success: true },
      { index: 2, memoryId: 'tag_auth_id', success: true },
    ];
    const updated = updateMemoryIds(g, allEntries, results);

    assert.strictEqual(updated, 1);
    const rel = g.G1.hot_relations[0];
    // memoryId = 首个 docId（内容向量）；memoryIds = 全部（含 tag docId）
    assert.strictEqual(rel.memoryId, 'content_id');
    assert.deepStrictEqual(rel.memoryIds, ['content_id', 'tag_api_id', 'tag_auth_id']);
  });

  it('无匹配条目 → 不改动', () => {
    const g = { G1: { hot_relations: [{ text: 'x', memoryId: 'keep' }] } };
    const updated = updateMemoryIds(g, [], []);
    assert.strictEqual(updated, 0);
    assert.strictEqual(g.G1.hot_relations[0].memoryId, 'keep');
  });
});

describe('E. collectTagEntries —— 从 relations-cache 恢复自定义 tag 向量', () => {
  /** 构造含 tags 的 scope：Group index.json + relations-cache.json */
  function makeTagScopeDir(scopeDir: string): void {
    fs.mkdirSync(path.join(scopeDir, 'Wiki'), { recursive: true });
    // local KB：index.json 键 = relation 名 → 原文
    fs.writeFileSync(
      path.join(scopeDir, 'Wiki', 'index.json'),
      JSON.stringify({ 快速开始: '快速开始原文', version: 1 }),
      'utf-8'
    );
    // relations-cache：relation 带 tags 字段
    fs.writeFileSync(
      path.join(scopeDir, 'relations-cache.json'),
      JSON.stringify({
        groups: {
          Wiki: {
            hot_relations: [
              { text: '快速开始', tags: ['api', 'auth'], memoryId: 'old' },
              { text: '无标签', memoryId: 'old2' }, // 无 tags → 跳过
            ],
          },
        },
      }),
      'utf-8'
    );
  }

  it('有 tags 的 relation 为每个 tag 生成一条条目，text 取 local KB 原文', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'tags-'));
    const dataDir = path.join(dir, 'kb');
    const scopeDir = path.join(dataDir, 's1');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  s1: {}\n`, 'utf-8');
    makeTagScopeDir(scopeDir);
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    const groups = {
      Wiki: { hot_relations: [{ text: '快速开始', tags: ['api', 'auth'] }] },
    };
    const entries = collectTagEntries('s1', groups as never);

    assert.strictEqual(entries.length, 2, '两个 tag 各一条');
    const tags = entries.map((e) => e.tags).sort();
    assert.deepStrictEqual(tags, ['api', 'auth']);
    assert.strictEqual(entries[0].text, '快速开始原文', 'text 取 local KB 原文');
    assert.strictEqual(entries[0].group, 'Wiki');

    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('无 tags 字段的 relation 跳过；local KB 缺键跳过', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'tags-skip-'));
    const dataDir = path.join(dir, 'kb');
    const scopeDir = path.join(dataDir, 's2');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  s2: {}\n`, 'utf-8');
    makeTagScopeDir(scopeDir);
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    // relation 无 tags / local KB 无该键 → 均不生成条目
    const groups = {
      Wiki: {
        hot_relations: [
          { text: '无标签', memoryId: 'old2' }, // 无 tags
          { text: '不存在的文档', tags: ['api'] }, // local KB 无该键
        ],
      },
    };
    const entries = collectTagEntries('s2', groups as never);
    assert.strictEqual(entries.length, 0);

    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });
});

describe('D. rebuildScopeVectors 主流程（mock 向量层）', () => {
  /** 每个测试内自行设置 KI_CONFIG_PATH 并重置缓存（避免 beforeEach 时序问题） */
  function useConfig(configPath: string): void {
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();
  }

  afterEach(() => {
    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('重建三类向量 + 清空旧向量 + memoryId 回写', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);
    const scopeDir = s.scopeDir;

    const calls: { deleteScope: unknown[]; bulkStore: unknown[] } = { deleteScope: [], bulkStore: [] };
    const mockDelete = async (p: unknown) => {
      calls.deleteScope.push(p);
      return { deleted: 0 };
    };
    const mockBulk = async (p: { entries: unknown[] }) => {
      calls.bulkStore.push(p);
      return {
        total: p.entries.length,
        succeeded: p.entries.length,
        failed: 0,
        results: p.entries.map((_, i) => ({ index: i, memoryId: `mid_${i}`, success: true })),
      };
    };

    const result = await rebuildScopeVectors('rs-a', {
      bulkStore: mockBulk as never,
      deleteScope: mockDelete as never,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.scope, 'rs-a');
    assert.deepStrictEqual(result.stats, {
      content: 2,
      relation: 2,
      path: 2,
      succeeded: 6,
      failed: 0,
      updatedMemoryId: 2,
    });
    // 清空调用：一次，scope 正确
    assert.strictEqual(calls.deleteScope.length, 1);
    assert.deepStrictEqual(calls.deleteScope[0], { scope: 'rs-a' });
    // 向量化：一次，6 条（2 内容 + 2 关系 + 2 路径）
    assert.strictEqual(calls.bulkStore.length, 1);
    const submitted = calls.bulkStore[0] as { scope: string; entries: unknown[] };
    assert.strictEqual(submitted.scope, 'rs-a');
    assert.strictEqual(submitted.entries.length, 6);
    // memoryId 回写持久化
    const rc = JSON.parse(fs.readFileSync(path.join(scopeDir, 'relations-cache.json'), 'utf-8'));
    assert.strictEqual(rc.groups.BKMonitorWiki.hot_relations[0].memoryId, 'mid_0');
    assert.strictEqual(
      rc.groups['BKMonitorWiki/用户界面设计'].hot_relations[0].memoryId,
      'mid_1'
    );
  });

  it('scope 数据目录不存在 → ok:false（scope 错误）', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-missing-'));
    const dataDir = path.join(dir, 'kb');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  rs-a: {}\n`,
      'utf-8'
    );
    useConfig(configPath);

    const result = await rebuildScopeVectors('rs-a');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].type, 'scope');
  });

  it('relations-cache.json 缺失 → ok:false（cache 错误）', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-nocache-'));
    const dataDir = path.join(dir, 'kb');
    const scopeDir = path.join(dataDir, 'rs-a');
    fs.mkdirSync(scopeDir, { recursive: true });
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  rs-a: {}\n`,
      'utf-8'
    );
    useConfig(configPath);

    const result = await rebuildScopeVectors('rs-a');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].type, 'cache');
  });

  it('清空旧向量失败 → ok:false（cleanup 错误，不执行向量化）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);

    const mockDelete = async () => {
      throw new Error('vector delete failed');
    };
    const mockBulk = async () => {
      throw new Error('should not be called');
    };

    const result = await rebuildScopeVectors('rs-a', {
      bulkStore: mockBulk as never,
      deleteScope: mockDelete as never,
    });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].type, 'cleanup');
    assert.match(result.errors[0].error, /清空旧向量失败/);
  });

  it('部分向量化失败 → ok:true 且 errors 报告失败条目', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);

    const mockBulk = async (p: { entries: unknown[] }) => {
      return {
        total: p.entries.length,
        succeeded: p.entries.length - 1,
        failed: 1,
        results: p.entries.map((_, i) =>
          i === 0
            ? { index: 0, success: false, error: 'embedding timeout' }
            : { index: i, memoryId: `mid_${i}`, success: true }
        ),
      };
    };

    const result = await rebuildScopeVectors('rs-a', {
      bulkStore: mockBulk as never,
      deleteScope: (async () => ({ deleted: 0 })) as never,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.stats.failed, 1);
    assert.strictEqual(result.stats.updatedMemoryId, 1); // 仅成功的内容向量回写
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].type, 'vectorize');
  });
});
