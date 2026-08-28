/**
 * rebuild-vector 单元测试：从已还原 KB 重建向量（--rebuild-vector）
 *
 * 覆盖：
 *   A. collectContentEntries —— Group 树 index.json 收集（排除元数据键、groupPath 推导、--group 子树过滤）
 *   B. collectPathRelationEntries —— relation(ki-relation) / path(ki-path) 条目（含 --group 过滤）
 *   C. updateMemoryIds —— 内容向量 docId 回写 relations-cache 的 rel.memoryId
 *   D. rebuildScopeVectors 主流程（mock 向量层）—— 三类向量、清空调用、回写、失败路径、局部重建（--group/--tags）
 *   F. mergeRebuildTags —— --tags 打标合并去重（只增不减、子树过滤）
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
  mergeRebuildTags,
  isInGroupScope,
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

  it('--group 过滤：仅收集子树内条目，groupPath 保持完整路径', () => {
    const scopeDir = fs.mkdtempSync(path.join(tmpRoot, 'collect-filter-'));
    makeScopeDir(scopeDir);
    const entries = collectContentEntries(scopeDir, 'BKMonitorWiki/用户界面设计');
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].relationName, '按钮');
    assert.strictEqual(entries[0].groupPath, 'BKMonitorWiki/用户界面设计');
  });

  it('--group 过滤：根 Group 命中自身及子孙；子树不存在 → 空', () => {
    const scopeDir = fs.mkdtempSync(path.join(tmpRoot, 'collect-filter2-'));
    makeScopeDir(scopeDir);
    assert.strictEqual(collectContentEntries(scopeDir, 'BKMonitorWiki').length, 2, '根 Group 含子孙共 2 条');
    assert.deepStrictEqual(collectContentEntries(scopeDir, 'Nope'), []);
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

  it('--group 过滤：仅子树内 group 的 relation/path（前缀边界不误伤）', () => {
    const g = {
      ...groups,
      BKMonitorWikiX: { hot_relations: [{ text: '误伤校验' }] }, // 前缀同名但非子孙，不应命中 'BKMonitorWiki' 之外的过滤…此处验证不会被 'BKMonitorWiki' 过滤误包含之外的反向：
    };
    // 过滤到子树：仅命中子孙（不含根自身）
    const sub = collectPathRelationEntries(g, 'BKMonitorWiki/用户界面设计');
    assert.strictEqual(sub.relationEntries.length, 2);
    assert.strictEqual(sub.pathEntries.length, 1);
    // 过滤到根：含自身 + 子孙，不含前缀同名的 BKMonitorWikiX
    const root = collectPathRelationEntries(g, 'BKMonitorWiki');
    assert.strictEqual(root.relationEntries.length, 3);
    assert.strictEqual(root.pathEntries.length, 2);
    assert.ok(root.relationEntries.every((e) => e.group !== 'BKMonitorWikiX'));
  });

  it('isInGroupScope 边界：自身/子孙命中，前缀同名不误伤，无过滤全命中', () => {
    assert.strictEqual(isInGroupScope('a', 'a'), true);
    assert.strictEqual(isInGroupScope('a/b', 'a'), true);
    assert.strictEqual(isInGroupScope('ab', 'a'), false, '前缀同名非子孙不命中');
    assert.strictEqual(isInGroupScope('anything'), true, '无过滤全命中');
  });
});

describe('F. mergeRebuildTags —— --tags 打标合并去重', () => {
  type TestGroups = Record<string, { hot_relations: { text: string; tags?: string[] }[] }>;
  function makeGroups(): TestGroups {
    return {
      Wiki: {
        hot_relations: [
          { text: 'r1', tags: ['api'] },
          { text: 'r2' },
        ],
      },
      'Wiki/sub': { hot_relations: [{ text: 'r3', tags: ['api'] }] },
      Other: { hot_relations: [{ text: 'r4' }] },
    };
  }

  it('合并去重：已有标签保留、新标签追加（只增不减）', () => {
    const groups = makeGroups();
    const { taggedRelations } = mergeRebuildTags(groups, ['api', 'auth'], undefined);
    // r1: +auth；r2: +api,auth；r3: +auth；r4: +api,auth → 4 个 relation 均有新增
    assert.strictEqual(taggedRelations, 4);
    assert.deepStrictEqual(groups.Wiki.hot_relations[0].tags, ['api', 'auth']);
    assert.deepStrictEqual(groups.Wiki.hot_relations[1].tags, ['api', 'auth']);
    assert.deepStrictEqual(groups['Wiki/sub'].hot_relations[0].tags, ['api', 'auth']);
  });

  it('全部已存在 → 不改动、计数 0（幂等）', () => {
    const groups = makeGroups();
    const { taggedRelations } = mergeRebuildTags(groups, ['api'], undefined);
    assert.strictEqual(taggedRelations, 2); // r2/r4 无 api → 新增；r1/r3 已有不动
    assert.deepStrictEqual(groups.Wiki.hot_relations[0].tags, ['api'], '已有标签不重复');
    // 再次传入同标签 → 0 新增（跨命令幂等）
    assert.strictEqual(mergeRebuildTags(groups, ['api'], undefined).taggedRelations, 0);
  });

  it('--group 过滤：仅子树内 relation 打标', () => {
    const groups = makeGroups();
    const { taggedRelations } = mergeRebuildTags(groups, ['auth'], 'Wiki/sub');
    assert.strictEqual(taggedRelations, 1);
    assert.deepStrictEqual(groups['Wiki/sub'].hot_relations[0].tags, ['api', 'auth']);
    assert.deepStrictEqual(groups.Wiki.hot_relations[0].tags, ['api'], '范围外不动');
    assert.strictEqual(groups.Other.hot_relations[0].tags, undefined);
  });

  it('空 tags → 不操作', () => {
    const groups = makeGroups();
    assert.strictEqual(mergeRebuildTags(groups, [], undefined).taggedRelations, 0);
    assert.deepStrictEqual(groups.Wiki.hot_relations[0].tags, ['api']);
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
    const g: Record<string, { hot_relations: { text: string; memoryId: string; memoryIds?: string[] }[] }> = {
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
    assert.strictEqual(entries[0].groupPath, 'Wiki', 'tag 条目必须携带 groupPath（updateMemoryIds 回填匹配键）');

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

  it('--group 过滤：仅收集子树内 group 的 tag 条目，范围外不动', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'tags-filter-'));
    const dataDir = path.join(dir, 'kb');
    const scopeDir = path.join(dataDir, 's3');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  s3: {}\n`, 'utf-8');
    // 两个 group 各有一个带 tag 的 relation + local KB
    fs.mkdirSync(path.join(scopeDir, 'WikiA'), { recursive: true });
    fs.mkdirSync(path.join(scopeDir, 'WikiB'), { recursive: true });
    fs.writeFileSync(path.join(scopeDir, 'WikiA', 'index.json'), JSON.stringify({ docA: 'A原文' }), 'utf-8');
    fs.writeFileSync(path.join(scopeDir, 'WikiB', 'index.json'), JSON.stringify({ docB: 'B原文' }), 'utf-8');
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    const groups = {
      WikiA: { hot_relations: [{ text: 'docA', tags: ['api'] }] },
      WikiB: { hot_relations: [{ text: 'docB', tags: ['api'] }] },
    };
    const entries = collectTagEntries('s3', groups as never, 'WikiA');
    assert.strictEqual(entries.length, 1, '仅 WikiA 子树的 tag 条目');
    assert.strictEqual(entries[0].groupPath, 'WikiA');
    assert.strictEqual(entries[0].text, 'A原文');

    delete process.env.KI_CONFIG_PATH;
    resetConfigCache();
  });

  it('真实管道贯通：collectTagEntries 产出条目经 updateMemoryIds 回填 tag docId（回归：字段失配会导致重建后 tag docId 丢失）', () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'tags-pipeline-'));
    const dataDir = path.join(dir, 'kb');
    const scopeDir = path.join(dataDir, 's4');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(configPath, `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  s4: {}\n`, 'utf-8');
    makeTagScopeDir(scopeDir);
    process.env.KI_CONFIG_PATH = configPath;
    resetConfigCache();

    const groups = {
      Wiki: { hot_relations: [{ text: '快速开始', tags: ['api'], memoryId: 'old' }] },
    };
    // 真实管道：collectTagEntries 产出条目 + 内容向量一起走 updateMemoryIds
    const tagEntries = collectTagEntries('s4', groups as never);
    assert.strictEqual(tagEntries.length, 1);
    assert.strictEqual(tagEntries[0].groupPath, 'Wiki', 'tag 条目必须携带 groupPath');
    const allEntries: RebuildVectorEntry[] = [
      { text: '快速开始原文', tags: 'ki-search', groupPath: 'Wiki', relationName: '快速开始' },
      ...tagEntries,
    ];
    const results = allEntries.map((_, i) => ({ index: i, memoryId: `mid_${i}`, success: true }));
    updateMemoryIds(groups as never, allEntries, results);
    assert.deepStrictEqual(
      (groups.Wiki.hot_relations[0] as { memoryIds?: string[] }).memoryIds,
      ['mid_0', 'mid_1'],
      '内容 + tag docId 均回填'
    );

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

  it('分批向量化：>200 条分多批提交，聚合结果索引加批偏移（错误定位到全量 entries）', async () => {
    const dir = fs.mkdtempSync(path.join(tmpRoot, 'cfg-batch-'));
    const dataDir = path.join(dir, 'kb');
    const scopeDir = path.join(dataDir, 'rs-batch');
    const configPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(
      configPath,
      `dataDir: ${dataDir}\nvectorDir: ${path.join(dir, 'vector')}\nscopes:\n  rs-batch: {}\n`,
      'utf-8'
    );
    // 210 个内容条目（单 Group）+ 1 条路径向量 = 211 条 → 分 2 批（200 + 11）
    const indexContent: Record<string, string> = {};
    for (let i = 0; i < 210; i++) indexContent[`rel_${i}`] = `文本${i}`;
    fs.mkdirSync(path.join(scopeDir, 'G'), { recursive: true });
    fs.writeFileSync(path.join(scopeDir, 'G', 'index.json'), JSON.stringify(indexContent), 'utf-8');
    fs.writeFileSync(
      path.join(scopeDir, 'relations-cache.json'),
      JSON.stringify({ groups: { G: { hot_relations: [] } } }),
      'utf-8'
    );
    useConfig(configPath);

    const bulkCalls: { entries: { text: string }[] }[] = [];
    const mockBulk = async (p: { entries: { text: string }[] }) => {
      bulkCalls.push(p);
      return {
        total: p.entries.length,
        succeeded: p.entries.filter((e) => e.text !== '文本200').length,
        failed: p.entries.filter((e) => e.text === '文本200').length,
        // 第 2 批的 文本200（批内 index 0）置败，验证聚合后应定位到全量 index 200（而非 0）
        results: p.entries.map((e, i) =>
          e.text === '文本200'
            ? { index: i, success: false, error: 'mock fail' }
            : { index: i, memoryId: `mid_${i}`, success: true }
        ),
      };
    };

    const result = await rebuildScopeVectors('rs-batch', {
      bulkStore: mockBulk as never,
      deleteScope: (async () => ({ deleted: 0 })) as never,
    });

    assert.strictEqual(result.ok, true);
    assert.strictEqual(bulkCalls.length, 2, '211 条应分 2 批提交');
    assert.strictEqual(bulkCalls[0].entries.length, 200);
    assert.strictEqual(bulkCalls[1].entries.length, 11);
    assert.strictEqual(result.stats.succeeded, 210);
    assert.strictEqual(result.stats.failed, 1);
    // 批偏移校正：失败条目应映射到全量第 201 条（文本200），而非第 1 条（文本0）
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].path, '文本200');
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
    assert.strictEqual(result.partial, false, '无过滤参数 = 全量重建');
    assert.deepStrictEqual(result.stats, {
      content: 2,
      relation: 2,
      path: 2,
      tag: 0,
      succeeded: 6,
      failed: 0,
      updatedMemoryId: 2,
      taggedRelations: 0,
      mergedTags: [],
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

  it('局部重建 --group：不清空旧向量、仅提交子树条目、partial=true', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);

    const calls: { deleteScope: number; bulkStore: { entries: { tags: string; groupPath?: string; group?: string }[] }[] } = {
      deleteScope: 0,
      bulkStore: [],
    };
    const mockDelete = async () => {
      calls.deleteScope++;
      return { deleted: 0 };
    };
    const mockBulk = async (p: { entries: { tags: string; groupPath?: string; group?: string }[] }) => {
      calls.bulkStore.push(p);
      return {
        total: p.entries.length,
        succeeded: p.entries.length,
        failed: 0,
        results: p.entries.map((_, i) => ({ index: i, memoryId: `p_${i}`, success: true })),
      };
    };

    const result = await rebuildScopeVectors(
      'rs-a',
      { bulkStore: mockBulk as never, deleteScope: mockDelete as never },
      { groupFilter: 'BKMonitorWiki/用户界面设计' }
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.partial, true, '带 --group = 局部重建');
    assert.strictEqual(calls.deleteScope, 0, '局部重建不得全量清空');
    const submitted = calls.bulkStore[0].entries;
    // 子树内：1 内容(按钮) + 1 relation + 1 path
    assert.strictEqual(submitted.length, 3);
    assert.deepStrictEqual(
      submitted.map((e) => e.tags).sort(),
      ['ki-path', 'ki-relation', 'ki-search']
    );
    const content = submitted.find((e) => e.tags === 'ki-search');
    assert.strictEqual(content?.groupPath, 'BKMonitorWiki/用户界面设计');
  });

  it('局部重建 --group 不存在 → ok:false（group 错误，不触碰向量层）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);

    let deleteCalls = 0;
    let bulkCalls = 0;
    const result = await rebuildScopeVectors(
      'rs-a',
      {
        bulkStore: (async () => { bulkCalls++; return { total: 0, succeeded: 0, failed: 0, results: [] }; }) as never,
        deleteScope: (async () => { deleteCalls++; return { deleted: 0 }; }) as never,
      },
      { groupFilter: 'NotExists' }
    );

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].type, 'group');
    assert.match(result.errors[0].error, /Group 不存在/);
    assert.strictEqual(deleteCalls, 0);
    assert.strictEqual(bulkCalls, 0);
  });

  it('--group 路径含 ./.. 或空段 → 拒绝（非法路径，防归一化后 groupPath 元数据错位）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);
    for (const bad of ['../escape', './wiki', 'wiki/./sub', '.']) {
      const result = await rebuildScopeVectors('rs-a', {}, { groupFilter: bad });
      assert.strictEqual(result.ok, false, `--group ${bad} 应被拒绝`);
      assert.strictEqual(result.errors[0].type, 'group');
      assert.match(result.errors[0].error, /路径非法/);
    }
  });

  it('NEG：tagsProvided 但解析后为空且有 --group → 仅警告，继续局部重建（无全量清空风险）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);

    let deleteCalls = 0;
    const origWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stderr.write;
    let result!: Awaited<ReturnType<typeof rebuildScopeVectors>>;
    try {
      result = await rebuildScopeVectors(
        'rs-a',
        {
          bulkStore: (async (p: { entries: unknown[] }) => ({
            total: p.entries.length,
            succeeded: p.entries.length,
            failed: 0,
            results: p.entries.map((_, i) => ({ index: i, memoryId: `w_${i}`, success: true })),
          })) as never,
          deleteScope: (async () => { deleteCalls++; return { deleted: 0 }; }) as never,
        },
        { groupFilter: 'BKMonitorWiki', tags: 'ki-search', tagsProvided: true }
      );
    } finally {
      process.stderr.write = origWrite;
    }

    assert.strictEqual(result.ok, true, '有 --group 时无全量清空风险，应继续执行');
    assert.strictEqual(result.partial, true);
    assert.strictEqual(deleteCalls, 0, '局部重建不清空');
    assert.strictEqual(result.stats.taggedRelations, 0, '无有效标签，不打标');
    assert.match(captured, /无有效标签/, '应输出保留标签被过滤的警告');
  });

  it('NEG：局部重建范围内零条目 → stderr 显式提示（避免误以为生效）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);
    // 目录存在但无 index.json，且 cache 无该子树条目 → 校验通过但收集为 0 条
    fs.mkdirSync(path.join(s.scopeDir, 'Empty'), { recursive: true });

    const origWrite = process.stderr.write;
    let captured = '';
    process.stderr.write = ((chunk: unknown) => { captured += String(chunk); return true; }) as typeof process.stderr.write;
    let result!: Awaited<ReturnType<typeof rebuildScopeVectors>>;
    try {
      result = await rebuildScopeVectors(
        'rs-a',
        {
          bulkStore: (async (p: { entries: unknown[] }) => ({ total: p.entries.length, succeeded: 0, failed: 0, results: [] })) as never,
          deleteScope: (async () => ({ deleted: 0 })) as never,
        },
        { groupFilter: 'Empty' }
      );
    } finally {
      process.stderr.write = origWrite;
    }

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.partial, true);
    assert.strictEqual(result.stats.content + result.stats.relation + result.stats.path + result.stats.tag, 0);
    assert.match(captured, /未收集到任何条目/, '零条目时应显式提示');
  });

  it('NEG：tagsProvided 但解析后为空且无 --group → 库层拒绝（与 CLI 一致，不静默全量清空）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);
    let deleteCalls = 0;
    const result = await rebuildScopeVectors(
      'rs-a',
      {
        bulkStore: (async () => ({ total: 0, succeeded: 0, failed: 0, results: [] })) as never,
        deleteScope: (async () => { deleteCalls++; return { deleted: 0 }; }) as never,
      },
      { tags: 'ki-search,ki-path', tagsProvided: true }
    );
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errors[0].type, 'tags');
    assert.strictEqual(deleteCalls, 0, '不得执行全量清空');
  });

  it('局部重建 --tags：与已有标签合并去重、写 tag 向量、不清空、回写持久化', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);

    const calls: { deleteScope: number; bulkStore: { entries: { tags: string }[] }[] } = { deleteScope: 0, bulkStore: [] };
    const mockDelete = async () => { calls.deleteScope++; return { deleted: 0 }; };
    const mockBulk = async (p: { entries: { tags: string }[] }) => {
      calls.bulkStore.push(p);
      return {
        total: p.entries.length,
        succeeded: p.entries.length,
        failed: 0,
        results: p.entries.map((_, i) => ({ index: i, memoryId: `t_${i}`, success: true })),
      };
    };

    const result = await rebuildScopeVectors(
      'rs-a',
      { bulkStore: mockBulk as never, deleteScope: mockDelete as never },
      { tags: 'Api, api ,ki-search' } // 验证去空/去重/小写化/过滤保留标签
    );

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.partial, true, '带 --tags = 局部重建');
    assert.strictEqual(calls.deleteScope, 0, '局部重建不得全量清空');
    assert.deepStrictEqual(result.stats.mergedTags, ['api'], '去重 + 过滤保留标签');
    assert.strictEqual(result.stats.taggedRelations, 2, '两个 relation 均新增标签');
    // 提交条目：2 内容 + 2 relation + 2 path + 2 tag（每个 relation 各一条 api 向量）
    const submitted = calls.bulkStore[0].entries;
    assert.strictEqual(submitted.filter((e) => e.tags === 'api').length, 2);
    // rel.tags 回写持久化（跨命令累积的载体）
    const rc = JSON.parse(fs.readFileSync(path.join(s.scopeDir, 'relations-cache.json'), 'utf-8'));
    assert.deepStrictEqual(rc.groups.BKMonitorWiki.hot_relations[0].tags, ['api']);
    assert.deepStrictEqual(rc.groups['BKMonitorWiki/用户界面设计'].hot_relations[0].tags, ['api']);
  });

  it('跨命令标签累积：第二次重建传入新标签 → 并集（restore 打 a 后再打 b = a∪b）', async () => {
    const s = setupScope('rs-a');
    useConfig(s.configPath);
    const noopBulk = (async (p: { entries: unknown[] }) => ({
      total: p.entries.length,
      succeeded: p.entries.length,
      failed: 0,
      results: p.entries.map((_, i) => ({ index: i, memoryId: `m_${i}`, success: true })),
    })) as never;
    const noopDelete = (async () => ({ deleted: 0 })) as never;

    // 第一次：restore --rebuild-vector --tags a
    const r1 = await rebuildScopeVectors('rs-a', { bulkStore: noopBulk, deleteScope: noopDelete }, { tags: 'a' });
    assert.strictEqual(r1.ok, true);
    // 第二次：独立 --rebuild-vector --tags b → 合并为 a∪b
    const r2 = await rebuildScopeVectors('rs-a', { bulkStore: noopBulk, deleteScope: noopDelete }, { tags: 'b' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.stats.taggedRelations, 2, 'b 为新增标签');
    const rc = JSON.parse(fs.readFileSync(path.join(s.scopeDir, 'relations-cache.json'), 'utf-8'));
    assert.deepStrictEqual(rc.groups.BKMonitorWiki.hot_relations[0].tags, ['a', 'b'], '并集累积');
    // tag 向量覆盖并集：a、b 各两条（2 个 relation）
    const tagEntries = collectTagEntries('rs-a', rc.groups);
    assert.strictEqual(tagEntries.filter((e) => e.tags === 'a').length, 2);
    assert.strictEqual(tagEntries.filter((e) => e.tags === 'b').length, 2);
  });
});
