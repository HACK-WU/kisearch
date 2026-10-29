/**
 * group-cache.test.ts —— per-Group 分片存储原语单测（批次 2 工作项 2）
 *
 * 覆盖 design.md §2-§5：双读优先级、惰性迁移守恒/幂等/**键原样（不剥 `项目根/`）**、
 * 三步曲（bump→写→失效广播）、批操作共享 bump、穿越校验、缓存身份戳。
 * 隔离 KI_CONFIG_PATH + 临时目录（不触真实数据，护栏 #4）。
 *
 * 运行：npx jiti test/group-cache.test.ts
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resetConfigCache } from '../src/lib/config.js';
import { DEFAULT_PARTITION_CONFIG } from '../src/lib/constants.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ki-group-cache-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  vectorDir: path.join(tmpDir, 'vector'),
  dataDir: path.join(tmpDir, 'kb'),
  scopes: { default: {} },
}), 'utf-8');
process.env.KI_CONFIG_PATH = configPath;

let gc: typeof import('../src/lib/group-cache.js');
let scopeLib: typeof import('../src/lib/scope.js');

before(async () => {
  gc = await import('../src/lib/group-cache.js');
  scopeLib = await import('../src/lib/scope.js');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetConfigCache();
  gc.clearInvalidateListeners();
});

/** 构造旧布局 relations-cache.json（直写，模拟既有数据） */
function seedLegacyCache(scope: string, groups: Record<string, { hot_relations: unknown[] }>, partition_config?: unknown): string {
  const kbDir = path.join(tmpDir, 'kb', scope);
  fs.mkdirSync(kbDir, { recursive: true });
  const p = path.join(kbDir, 'relations-cache.json');
  fs.writeFileSync(p, JSON.stringify({
    version: 1, scope, partition_config: partition_config ?? {}, groups, updatedAt: null,
  }));
  return p;
}

const rel = (id: string, text: string) => ({ id, text, score: 1, useCount: 0, lastUsedTime: 0 });

describe('路径与穿越校验', () => {
  it('合法 groupPath → 镜像 local-kb 布局的分片路径', () => {
    const p = gc.getGroupCachePath('default', 'wiki/deploy');
    assert.ok(p.endsWith(path.join('.relations', 'wiki', 'deploy', 'cache.json')), p);
  });

  it('绝对路径 / 含 .. / 空段 → 拒绝', () => {
    assert.throws(() => gc.getGroupCachePath('default', '/etc/passwd'), /非法的 Group 路径/);
    assert.throws(() => gc.getGroupCachePath('default', '../escape'), /非法的 Group 路径/);
    assert.throws(() => gc.getGroupCachePath('default', 'a//b'), /非法的 Group 路径/);
    assert.throws(() => gc.getGroupCachePath('default', 'a/./b'), /非法的 Group 路径/);
  });
});

describe('双读：新布局优先、旧布局 fallback、空库', () => {
  it('空库：loadGroupCache null、readAllGroupCaches 空、partition_config 走默认', () => {
    const scope = 't-empty';
    assert.equal(gc.loadGroupCache(scope, 'g'), null);
    assert.equal(gc.readAllGroupCaches(scope).size, 0);
    assert.ok(gc.loadPartitionConfig(scope).halfLifeHours > 0, '默认 partition_config 生效');
    assert.equal(gc.loadPartitionConfig(scope), DEFAULT_PARTITION_CONFIG, '空库走默认分区参数（非自比）');
  });

  it('仅旧布局：loadGroupCache 原样读旧 groups[g]（兼容读不清洗——前缀键与树成对使用）', () => {
    const scope = 't-legacy';
    seedLegacyCache(scope, {
      'wiki/docs': { hot_relations: [rel('r1', 'doc1'), rel('r2', 'doc2')] },
      '项目根/old': { hot_relations: [rel('r3', 'doc3')] },
    });
    // 兼容读语义（R2 教训）：旧布局原样返回，`项目根/old` 键不被清洗——
    // 旧数据 cache 键与 group-index 树根成对使用前缀，清洗只发生在迁移时
    const g = gc.loadGroupCache(scope, 'wiki/docs')!;
    assert.equal(g.hot_relations.length, 2);
    assert.equal(gc.loadGroupCache(scope, '项目根/old')?.hot_relations[0]?.text, 'doc3', '前缀键原样可读');
    const all = gc.readAllGroupCaches(scope);
    assert.deepEqual([...all.keys()].sort(), ['wiki/docs', '项目根/old'], '全量聚合同样不清洗');
    // 未迁移：旧文件原样
    assert.ok(fs.existsSync(path.join(tmpDir, 'kb', scope, 'relations-cache.json')));
  });

  it('新布局优先：迁移后旧文件不再读（loadGroupCache 走分片）', () => {
    const scope = 't-mixed';
    seedLegacyCache(scope, { g: { hot_relations: [rel('r1', 'a')] } });
    const n = gc.migrateLegacyRelationsCache(scope);
    assert.equal(n, 1, '迁移 1 个组');
    // 手动改旧文件（此时已是 .bak）——新布局读不受影响
    assert.ok(fs.existsSync(path.join(tmpDir, 'kb', scope, 'relations-cache.json.bak')));
    const g = gc.loadGroupCache(scope, 'g')!;
    assert.equal(g.hot_relations.length, 1);
  });
});

describe('惰性迁移：守恒 / 幂等 / 键原样 / .bak', () => {
  it('守恒：relation 总数、每组数量、字段逐一相等；partition_config 平移', () => {
    const scope = 't-conserv';
    seedLegacyCache(scope, {
      'a/b': { hot_relations: [rel('r1', 'x1'), { ...rel('r2', 'x2'), memoryIds: ['m1'], tags: ['t'] }] },
      c: { hot_relations: [rel('r3', 'x3')] },
    }, { hotPercent: 0.4, warmPercent: 0.4, reservedEmerging: 5, recentHours: 24, halfLifeHours: 120 });
    const before = gc.readAllGroupCaches(scope);
    gc.migrateLegacyRelationsCache(scope);
    const after = gc.readAllGroupCaches(scope);
    assert.equal(after.size, before.size, '组数守恒');
    let total = 0;
    for (const [gp, data] of after) {
      assert.deepEqual(data.hot_relations, before.get(gp)!.hot_relations, `组 ${gp} relation 逐一相等`);
      total += data.hot_relations.length;
    }
    assert.equal(total, 3);
    assert.deepEqual(gc.loadPartitionConfig(scope), { hotPercent: 0.4, warmPercent: 0.4, reservedEmerging: 5, recentHours: 24, halfLifeHours: 120 });
  });

  it('幂等：重复迁移 no-op（返回 0，不重复写）', () => {
    const scope = 't-idem';
    seedLegacyCache(scope, { g: { hot_relations: [rel('r1', 'a')] } });
    assert.equal(gc.migrateLegacyRelationsCache(scope), 1);
    const stat1 = fs.statSync(gc.getGroupCachePath(scope, 'g'));
    assert.equal(gc.migrateLegacyRelationsCache(scope), 0);
    const stat2 = fs.statSync(gc.getGroupCachePath(scope, 'g'));
    assert.equal(stat2.mtimeMs, stat1.mtimeMs, '幂等：分片未重写');
  });

  it('键原样不改写：`项目根/g` 与 `g` 是两个独立组，各自独立分片（不合并/不覆盖）', () => {
    // 第二轮审查 P0 修复：早期实现剥 `项目根/` 前缀并同名合并 → 分片键与
    // group-index 树路径 / local-kb 目录分叉（export 静默丢组、delete-group 分片残留），
    // 且「`项目根/g` 与 `g` 撞同一分片、后写覆盖前写」。键必须原样。
    const scope = 't-nokeysanitize';
    seedLegacyCache(scope, {
      '项目根/g': { hot_relations: [rel('r1', 'dup'), rel('r2', 'only-old')] },
      g: { hot_relations: [rel('r3', 'dup'), rel('r4', 'only-new')] },
    });
    gc.migrateLegacyRelationsCache(scope);
    const all = gc.readAllGroupCaches(scope);
    assert.deepEqual([...all.keys()].sort(), ['g', '项目根/g'], '两组并存（键不被清洗）');
    assert.deepEqual(all.get('g')!.hot_relations.map((r) => r.text).sort(), ['dup', 'only-new']);
    assert.deepEqual(all.get('项目根/g')!.hot_relations.map((r) => r.text).sort(), ['dup', 'only-old']);
    assert.notEqual(
      gc.getGroupCachePath(scope, 'g'),
      gc.getGroupCachePath(scope, '项目根/g'),
      '两个组必须落到不同分片路径（映射单射）',
    );
  });
});

describe('listGroupPaths：轻量键枚举（S0-5 上下文 / W4 级联依赖）', () => {
  it('新布局：返回全部含 cache.json 的目录（含层级跳跃——父无分片子有）', () => {
    const scope = 't-listpaths';
    gc.writeGroupCacheBatch(scope, new Map([
      ['a', { version: 1, scope, hot_relations: [], keywords: [] as string[] }],
      ['b/c', { version: 1, scope, hot_relations: [rel('r1', 'x')], keywords: [] as string[] }],
      ['b/c/d', { version: 1, scope, hot_relations: [], keywords: [] as string[] }],
    ]));
    // 'b' 无自身分片（只有子组 b/c、b/c/d）→ 不列出；层级跳跃 b/c/d 仍可达
    const paths = gc.listGroupPaths(scope).sort();
    assert.deepEqual(paths, ['a', 'b/c', 'b/c/d'], 'P0 回归：walk 必须收集含 cache.json 的目录（原实现恒返回空）');
  });

  it('旧布局：返回 groups 键集合（原样，不清洗）', () => {
    const scope = 't-listpaths-legacy';
    seedLegacyCache(scope, { 'wiki/docs': { hot_relations: [] }, '项目根/old': { hot_relations: [] } });
    const paths = gc.listGroupPaths(scope).sort();
    assert.deepEqual(paths, ['wiki/docs', '项目根/old']);
  });
});

describe('写原语三步曲', () => {
  it('writeGroupCache：新布局写分片 + 失效广播触发 + revision 递增', () => {
    const scope = 't-write';
    let invalidated = 0;
    gc.onScopeRelationsInvalidated((s) => { if (s === scope) invalidated++; });
    const id0 = gc.getRelationsCacheIdentity(scope);
    assert.equal(id0, null, '全新 scope 尚无身份');

    gc.writeGroupCache(scope, 'g1', {
      version: 1, scope, hot_relations: [rel('r1', 'a')], keywords: [],
    });
    assert.equal(invalidated, 1, '失效广播触发一次');
    const id1 = gc.getRelationsCacheIdentity(scope)!;
    assert.ok(id1.revision >= 1, 'revision 已 bump');
    const g = gc.loadGroupCache(scope, 'g1')!;
    assert.equal(g.hot_relations[0].text, 'a');

    gc.writeGroupCache(scope, 'g2', { version: 1, scope, hot_relations: [], keywords: [] });
    const id2 = gc.getRelationsCacheIdentity(scope)!;
    assert.ok(id2.revision > id1.revision, '第二次写 revision 继续递增');
    assert.equal(invalidated, 2);
  });

  it('writeGroupCacheBatch：批内共享一次 bump + 一次失效', () => {
    const scope = 't-batch';
    let invalidated = 0;
    gc.onScopeRelationsInvalidated((s) => { if (s === scope) invalidated++; });
    const docs = new Map([
      ['a', { version: 1, scope, hot_relations: [rel('r1', 'a')], keywords: [] as string[] }],
      ['b/c', { version: 1, scope, hot_relations: [rel('r2', 'b')], keywords: [] as string[] }],
      ['d', { version: 1, scope, hot_relations: [], keywords: [] as string[] }],
    ]);
    gc.writeGroupCacheBatch(scope, docs);
    assert.equal(invalidated, 1, '批操作只失效一次');
    assert.equal(gc.readAllGroupCaches(scope).size, 3);
    const id = gc.getRelationsCacheIdentity(scope)!;
    // 惰性初始化 manifest（revision 0）+ 批一次 bump = 1
    assert.equal(id.revision, 1, '批共享一次 bump');
  });

  it('写路径遇旧布局：惰性迁移自动发生（旧文件 → .bak）', () => {
    const scope = 't-lazy';
    seedLegacyCache(scope, { old: { hot_relations: [rel('r1', 'keep')] } });
    gc.writeGroupCache(scope, 'new', { version: 1, scope, hot_relations: [rel('r2', 'add')], keywords: [] });
    assert.ok(fs.existsSync(path.join(tmpDir, 'kb', scope, 'relations-cache.json.bak')), '旧文件改名 .bak');
    const all = gc.readAllGroupCaches(scope);
    assert.deepEqual([...all.keys()].sort(), ['new', 'old'], '旧数据保留 + 新组写入');
  });

  it('deleteGroupCache：删分片目录 + 失效 + revision 递增；子组级联语义由调用方组合', () => {
    const scope = 't-del';
    gc.writeGroupCacheBatch(scope, new Map([
      ['p/child', { version: 1, scope, hot_relations: [rel('r1', 'c')], keywords: [] }],
      ['other', { version: 1, scope, hot_relations: [rel('r2', 'o')], keywords: [] }],
    ]));
    const id1 = gc.getRelationsCacheIdentity(scope)!.revision;
    gc.deleteGroupCache(scope, 'p/child');
    assert.equal(gc.loadGroupCache(scope, 'p/child'), null, '分片已删');
    assert.ok(gc.loadGroupCache(scope, 'other') !== null, '其他组不受影响');
    assert.ok(gc.getRelationsCacheIdentity(scope)!.revision > id1, '删除也 bump revision');
  });
});

describe('缓存身份戳', () => {
  it('身份三元组随写变化（revision 单调递增）', () => {
    const scope = 't-ident';
    gc.writeGroupCache(scope, 'g', { version: 1, scope, hot_relations: [], keywords: [] });
    const id1 = gc.getRelationsCacheIdentity(scope)!;
    gc.writeGroupCache(scope, 'g', { version: 1, scope, hot_relations: [rel('r1', 'x')], keywords: [] });
    const id2 = gc.getRelationsCacheIdentity(scope)!;
    assert.notDeepEqual([id1.mtimeMs, id1.size, id1.revision], [id2.mtimeMs, id2.size, id2.revision]);
    assert.ok(id2.revision > id1.revision);
  });

  it('失效监听抛错不阻断写路径（其他监听器仍收到）', () => {
    const scope = 't-err-listener';
    let received = false;
    gc.onScopeRelationsInvalidated(() => { throw new Error('消费方失效失败'); });
    gc.onScopeRelationsInvalidated((s) => { if (s === scope) received = true; });
    assert.doesNotThrow(() => {
      gc.writeGroupCache(scope, 'g', { version: 1, scope, hot_relations: [], keywords: [] });
    });
    assert.ok(received, '一个监听器抛错不影响其他监听器');
  });
});

describe('迁移残留与保留名（批次 2 审查修复）', () => {
  it('P1-7 二次迁移清理孤儿分片：中断迁移留下的、旧文件里已不存在的组不得复活', () => {
    const scope = 't-orphan';
    seedLegacyCache(scope, { keep: { hot_relations: [rel('r1', '保留')] } });
    // 模拟"上次迁移写到一半被杀"：分片根里已有 keep 与 doomed 两份分片，但没有 manifest
    const root = gc.getRelationsRoot(scope);
    fs.mkdirSync(path.join(root, 'keep'), { recursive: true });
    fs.writeFileSync(path.join(root, 'keep', 'cache.json'), JSON.stringify({
      version: 1, scope, hot_relations: [rel('r-old', '旧快照')], keywords: [],
    }));
    fs.mkdirSync(path.join(root, 'doomed'), { recursive: true });
    fs.writeFileSync(path.join(root, 'doomed', 'cache.json'), JSON.stringify({
      version: 1, scope, hot_relations: [rel('r-x', '幽灵')], keywords: [],
    }));
    assert.ok(!gc.hasShardedLayout(scope), '无 manifest = 仍是旧布局（崩溃残留态）');

    const migrated = gc.migrateLegacyRelationsCache(scope);
    assert.equal(migrated, 1, '只迁移旧文件里的 1 个组');
    assert.deepEqual([...gc.readAllGroupCaches(scope).keys()], ['keep'], '孤儿分组分片被清理，不复活');
    assert.deepEqual(
      gc.readAllGroupCaches(scope).get('keep')!.hot_relations.map((r) => r.text),
      ['保留'],
      '存量组以旧文件为准重写（不是残留快照）',
    );
  });

  it('P1-7 保护：无旧文件但分片存在时（manifest 被删）不得清理分片', () => {
    const scope = 't-nolegacy';
    gc.writeGroupCache(scope, 'g', { version: 1, scope, hot_relations: [rel('r1', '仅存数据')], keywords: [] });
    fs.rmSync(gc.getRelationsManifestPath(scope), { force: true });
    assert.ok(!gc.hasShardedLayout(scope));

    const migrated = gc.migrateLegacyRelationsCache(scope);
    assert.equal(migrated, 0);
    assert.deepEqual([...gc.readAllGroupCaches(scope).keys()], ['g'], '分片是唯一数据源时不得被清掉');
    assert.ok(gc.hasShardedLayout(scope), '重建 manifest 使 scope 重新可用');
  });

  it('分片根用保留名 .relations：不与同名组路径冲突，且有 isRelationsRootPath 护栏', () => {
    const scope = 't-reserved';
    const root = gc.getRelationsRoot(scope);
    assert.ok(root.endsWith(`${path.sep}.relations`), root);
    assert.equal(gc.RELATIONS_ROOT_DIR, '.relations');
    assert.equal(gc.isRelationsRootPath(scope, root), true);
    assert.equal(gc.isRelationsRootPath(scope, path.join(root, 'relations')), false);
    // 名为 relations 的组：其 local-kb 目录（<scope>/relations）与分片根不同路径
    const localKbDir = path.join(tmpDir, 'kb', scope, 'relations');
    assert.equal(gc.isRelationsRootPath(scope, localKbDir), false, '旧撞名场景已被保留名消除');
  });

  it('P1-2 buildGroupMatchContext 的值必须是真值：resolveGroupPath 才能命中"relations 有、树无"的兜底', async () => {
    const { resolveGroupPath } = await import('../src/lib/group-resolve.js');
    const tree = { version: 1, scope: 't', groups: { wiki: {} }, updatedAt: null } as never;
    const ctx = gc.buildGroupMatchContext(['wiki/deploy']);
    const direct = await resolveGroupPath('wiki/deploy', tree, ctx);
    assert.equal(direct.matched, true, '直接匹配应命中（占位值真值）');
    const completed = await resolveGroupPath('deploy', tree, ctx);
    assert.equal(completed.matched, true, '整段补全应命中（占位值真值）');
  });
});
