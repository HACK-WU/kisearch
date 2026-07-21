/**
 * sync-relation.ts 测试
 *
 * 覆盖：关键词校验、代码符号拒绝、Relation 写入、本地 KB 写入、
 *       淘汰逻辑（maxHotCount）、批量模式、单条失败不中断
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

// ─── 辅助 ───

const SCRIPT_PATH = path.resolve(
  import.meta.dirname,
  '..',
  'src',
  'sync-relation.ts'
);

function runSync(args: string[]): any {
  try {
    const output = execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv()
    });
    return JSON.parse(output);
  } catch (err: any) {
    if (err.stdout) {
      try { return JSON.parse(err.stdout); } catch { /* ignore */ }
    }
    return { ok: false, error: err.message };
  }
}

// ─── 测试 ───

const scope = `sync-test-${Date.now()}`;

before(async () => {
  // 注册 scope 到测试配置，然后初始化 scope 目录
  registerTestScope(scope);
  const { initScope } = await import('../scripts/lib/store.js');
  initScope(scope);
});

after(async () => {
  const { getKbDir } = await import('../scripts/lib/scope.js');
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

describe('sync-relation 单条模式', () => {
  it('成功写入 Relation 到缓存和本地 KB', () => {
    const result = runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '告警规则CRUD流程',
      '--module-info', '# 告警规则CRUD\n\n## 概述\n告警规则的创建、查询、更新、删除流程。\n## 关键模块\n- 规则引擎\n- 阈值校验',
      '--keywords', '告警,规则,阈值,创建,删除',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.relation, '告警规则CRUD流程');
    assert.ok(result.keywords.length > 0);
    assert.strictEqual(result.invalid_keywords.length, 0);
    assert.strictEqual(result.evicted, null);
  });

  it('Relation 已写入 relations-cache.json', async () => {
    const { readJson } = await import('../scripts/lib/store.js');
    const { getRelationsCachePath } = await import('../scripts/lib/scope.js');

    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const groupData = cache.groups['项目根/监控/告警中心'];
    assert.ok(groupData);
    assert.ok(groupData.hot_relations.length >= 1);

    const rel = groupData.hot_relations.find((r: any) => r.text === '告警规则CRUD流程');
    assert.ok(rel);
    assert.ok(rel.id.startsWith('rel_'));
    assert.strictEqual(rel.isImported, false);
  });

  it('本地 KB index.json 已写入 Markdown', async () => {
    const { readJson } = await import('../scripts/lib/store.js');
    const { getLocalKbDir } = await import('../scripts/lib/scope.js');

    const localKb = readJson<any>(getLocalKbDir(scope, '项目根/监控/告警中心'))!;
    assert.ok(localKb['告警规则CRUD流程']);
    assert.ok(localKb['告警规则CRUD流程'].includes('告警规则CRUD'));
  });

  it('关键词中包含代码符号被拒绝', () => {
    const result = runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '通知渠道配置',
      '--module-info', '# 通知渠道配置\n\n## 概述\n支持邮件和短信两种通知渠道。',
      '--keywords', '通知,渠道,src/services/notify.ts,AlertController',
    ]);

    assert.strictEqual(result.ok, true);
    assert.ok(result.invalid_keywords.length > 0);
    assert.ok(result.invalid_keywords.includes('src/services/notify.ts'));
    // 通知、渠道 应该在原文中出现
    assert.ok(result.keywords.includes('通知'));
    assert.ok(result.keywords.includes('渠道'));
  });

  it('关键词不在原文中被拒绝', () => {
    const result = runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '静默规则管理',
      '--module-info', '# 静默规则管理\n\n## 概述\n管理静默规则的增删改查。',
      '--keywords', '静默,规则,分布式,微服务',
    ]);

    assert.strictEqual(result.ok, true);
    // "分布式" 和 "微服务" 不在原文中
    assert.ok(result.invalid_keywords.includes('分布式'));
    assert.ok(result.invalid_keywords.includes('微服务'));
    assert.ok(result.keywords.includes('静默'));
  });

  it('重复写入同一 Relation 更新关键词而非创建新条目', async () => {
    const { readJson } = await import('../scripts/lib/store.js');
    const { getRelationsCachePath } = await import('../scripts/lib/scope.js');

    // 先写入
    runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '聚合策略配置',
      '--module-info', '# 聚合策略配置\n\n## 概述\n配置告警聚合策略，包括时间窗口和分组规则。',
      '--keywords', '聚合,策略',
    ]);

    const cache1 = readJson<any>(getRelationsCachePath(scope))!;
    const count1 = cache1.groups['项目根/监控/告警中心'].hot_relations.length;

    // 再次写入同一 Relation，添加更多关键词
    runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '聚合策略配置',
      '--module-info', '# 聚合策略配置\n\n## 概述\n配置告警聚合策略，包括时间窗口和分组规则。支持去重。',
      '--keywords', '时间窗口,去重',
    ]);

    const cache2 = readJson<any>(getRelationsCachePath(scope))!;
    const count2 = cache2.groups['项目根/监控/告警中心'].hot_relations.length;

    // 数量不应增加
    assert.strictEqual(count2, count1);

    // 关键词应合并到 Group 级
    const groupData = cache2.groups['项目根/监控/告警中心'];
    const rel = groupData.hot_relations.find(
      (r: any) => r.text === '聚合策略配置'
    );
    assert.ok(rel);
    assert.strictEqual(rel.keywords, undefined, 'Relation 不应再含 keywords 字段');
    assert.ok(groupData.keywords.includes('聚合'));
    assert.ok(groupData.keywords.includes('时间窗口'));
  });
});

describe('sync-relation 淘汰逻辑', () => {
  it('达到 maxHotCount 时淘汰最低分 Relation', async () => {
    // 创建一个新 scope 以控制 maxHotCount
    const evictionScope = `evict-test-${Date.now()}`;
    const { initScope, readJson, writeJson } = await import('../scripts/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../scripts/lib/scope.js');

    try {
      registerTestScope(evictionScope);
      initScope(evictionScope);

      // 设置 maxHotCount = 2
      const cachePath = getRelationsCachePath(evictionScope);
      const cache = readJson<any>(cachePath)!;
      cache.partition_config.maxHotCount = 2;
      writeJson(cachePath, cache);

      // 写入 2 个 Relation（达到上限）
      runSync([
        '--scope', evictionScope,
        '--group', '项目根/测试',
        '--relation', '功能A描述',
        '--module-info', '# 功能A\n\n这是功能A的说明文档。',
        '--keywords', '功能A,说明',
      ]);

      runSync([
        '--scope', evictionScope,
        '--group', '项目根/测试',
        '--relation', '功能B描述',
        '--module-info', '# 功能B\n\n这是功能B的说明文档。',
        '--keywords', '功能B,说明',
      ]);

      // 写入第 3 个，应触发淘汰
      const result = runSync([
        '--scope', evictionScope,
        '--group', '项目根/测试',
        '--relation', '功能C描述',
        '--module-info', '# 功能C\n\n这是功能C的说明文档。',
        '--keywords', '功能C,说明',
      ]);

      assert.strictEqual(result.ok, true);
      assert.ok(result.evicted !== null, '应有一个被淘汰的 Relation');

      // 验证淘汰后数量不超过 maxHotCount
      const updatedCache = readJson<any>(cachePath)!;
      const groupData = updatedCache.groups['项目根/测试'];
      assert.ok(groupData.hot_relations.length <= 2);

      // keywords 已在 Group 级别累积（含 A/B/C 各自的关键词）
      assert.ok(groupData.keywords.length > 0);
      assert.ok(groupData.keywords.includes('功能C'));
      // 确认旧字段已不存在
      assert.strictEqual(groupData.word_cloud_keywords, undefined);
      // 确认 Relation 上不再写 keywords
      for (const rel of groupData.hot_relations) {
        assert.strictEqual(rel.keywords, undefined);
      }
    } finally {
      const kbDir = getKbDir(evictionScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});

describe('sync-relation 批量模式', () => {
  it('批量写入多条 Relation', async () => {
    const batchScope = `batch-test-${Date.now()}`;
    const { initScope, readJson } = await import('../scripts/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../scripts/lib/scope.js');

    try {
      registerTestScope(batchScope);
      initScope(batchScope);

      // 创建批量输入文件
      const inputFile = path.join(
        path.dirname(getKbDir(batchScope)),
        `batch-input-${Date.now()}.json`
      );
      fs.writeFileSync(inputFile, JSON.stringify({
        items: [
          {
            group: '项目根/部署/前端',
            relation: '前端构建流程',
            module_info: '# 前端构建流程\n\n## 概述\n使用 npm 构建前端项目，输出到 dist 目录。',
            keywords: ['构建', '前端', '部署'],
          },
          {
            group: '项目根/部署/后端',
            relation: '后端部署脚本',
            module_info: '# 后端部署脚本\n\n## 概述\n使用 Docker 部署后端服务。',
            keywords: ['部署', '后端', '容器'],
          },
        ],
      }));

      const result = runSync([
        '--scope', batchScope,
        '--input', inputFile,
      ]);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.failed, 0);
      assert.strictEqual(result.results.length, 2);

      // 验证写入
      const cache = readJson<any>(getRelationsCachePath(batchScope))!;
      assert.ok(cache.groups['项目根/部署/前端']);
      assert.ok(cache.groups['项目根/部署/后端']);

      // 清理输入文件
      fs.unlinkSync(inputFile);
    } finally {
      const kbDir = getKbDir(batchScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });

  it('批量模式中单条失败不中断其余', async () => {
    const batchScope = `batch-fail-test-${Date.now()}`;
    const { initScope, readJson } = await import('../scripts/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../scripts/lib/scope.js');

    try {
      registerTestScope(batchScope);
      initScope(batchScope);

      const inputFile = path.join(
        path.dirname(getKbDir(batchScope)),
        `batch-fail-${Date.now()}.json`
      );
      // 构造一个包含无效 JSON 格式的 items（但整体 JSON 有效）
      // 第二条的 keywords 全包含代码符号
      fs.writeFileSync(inputFile, JSON.stringify({
        items: [
          {
            group: '项目根/测试A',
            relation: '正常功能',
            module_info: '# 正常功能\n\n这是一个正常的功能说明。',
            keywords: ['正常', '功能'],
          },
          {
            group: '项目根/测试B',
            relation: '异常功能',
            module_info: '# 异常功能\n\n这是一个异常的功能说明。',
            keywords: ['src/main.ts', 'App.tsx'],  // 全是代码符号
          },
        ],
      }));

      const result = runSync([
        '--scope', batchScope,
        '--input', inputFile,
      ]);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total, 2);
      // 两条都应该成功（只是第二条的 keywords 全被拒绝）
      assert.strictEqual(result.results.length, 2);

      // 第一条有有效关键词
      assert.ok(result.results[0].keywords.length > 0);
      // 第二条关键词全被拒绝
      assert.ok(result.results[1].invalid_keywords.length > 0);

      fs.unlinkSync(inputFile);
    } finally {
      const kbDir = getKbDir(batchScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});
