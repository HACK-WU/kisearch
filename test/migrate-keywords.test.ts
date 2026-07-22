/**
 * migrate-keywords 迁移脚本测试
 *
 * 覆盖：旧格式迁移 → Group.keywords 正确、幂等性、空 scope、Relation 字段清理
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { registerTestScope, getTestEnv, testConfigPath } from './test-config.ts';

let testScope: string;

before(async () => {
  const { initScope, readJson, writeJson } = await import('../src/lib/store.js');
  const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

  testScope = `migrate-kw-${Date.now()}`;
  registerTestScope(testScope);
  initScope(testScope);

  // 写入旧格式 relations-cache.json
  const cachePath = getRelationsCachePath(testScope);
  const cache = readJson<any>(cachePath)!;
  cache.groups = {
    '项目根/监控/告警中心': {
      hot_relations: [
        {
          id: 'rel_001',
          text: '告警规则CRUD流程',
          score: 5.2,
          useCount: 8,
          lastUsedTime: 1716458400000,
          keywords: ['规则', '阈值', '触发条件'],
          isImported: false,
        },
        {
          id: 'rel_002',
          text: '通知渠道配置',
          score: 3.8,
          useCount: 5,
          lastUsedTime: 1716454800000,
          keywords: ['邮件', '短信'],
          isImported: false,
        },
      ],
      word_cloud_keywords: ['静默', '聚合', '升级', '值班表'],
      max_hot_count: 10,
    },
    '项目根/监控/日志查询': {
      hot_relations: [
        {
          id: 'rel_003',
          text: '日志检索API',
          score: 5.5,
          useCount: 8,
          lastUsedTime: 1716458400000,
          keywords: ['日志', '检索'],
          isImported: false,
        },
      ],
      word_cloud_keywords: ['ELK', '索引', '日志'],
      max_hot_count: 10,
    },
  };
  writeJson(cachePath, cache);
});

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  const kbDir = getKbDir(testScope);
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
});

// 直接调用 migrateScope（不通过 CLI，避免 process.exit）
async function runMigrate(): Promise<any> {
  const { migrateScope } = await import('../src/migrate-keywords.js');
  // migrate-keywords.ts 只导出 CLI，需要走 exec 方式
  // 改用 require 方式加载模块并直接调用内部函数
  return null;
}

describe('migrate-keywords 幂等性', () => {
  it('重复执行迁移结果不变', async () => {
    const { execSync } = await import('child_process');
    const scope = testScope;

    // 第一次迁移
    const r1 = execSync(
      `npx tsx src/migrate-keywords.ts --scope ${scope}`,
      { encoding: 'utf-8', cwd: path.resolve(import.meta.dirname, '..'), env: getTestEnv() }
    );
    const result1 = JSON.parse(r1);
    assert.strictEqual(result1.ok, true);
    assert.strictEqual(result1.stats[0].scope, scope);
    assert.ok(result1.stats[0].groups_migrated > 0);

    // 第二次迁移（幂等）
    const r2 = execSync(
      `npx tsx src/migrate-keywords.ts --scope ${scope}`,
      { encoding: 'utf-8', cwd: path.resolve(import.meta.dirname, '..'), env: getTestEnv() }
    );
    const result2 = JSON.parse(r2);
    assert.strictEqual(result2.ok, true);
    assert.strictEqual(result2.stats[0].groups_migrated, 0, '第二次迁移应无新迁移');

    // 验证数据完整性
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    const cache = readJson<any>(getRelationsCachePath(scope))!;

    const g1 = cache.groups['项目根/监控/告警中心'];
    assert.ok(g1.keywords.length > 0);
    // 验证合并：旧 Relation 上的关键词 + word_cloud_keywords 都进入 Group.keywords
    assert.ok(g1.keywords.includes('规则'));
    assert.ok(g1.keywords.includes('阈值'));
    assert.ok(g1.keywords.includes('触发条件'));
    assert.ok(g1.keywords.includes('邮件'));
    assert.ok(g1.keywords.includes('短信'));
    assert.ok(g1.keywords.includes('静默'));
    assert.ok(g1.keywords.includes('聚合'));
    assert.ok(g1.keywords.includes('升级'));
    assert.ok(g1.keywords.includes('值班表'));

    // 验证旧字段已删除
    assert.strictEqual(g1.word_cloud_keywords, undefined);

    // 验证 Relation 上 keywords 已删除
    for (const rel of g1.hot_relations) {
      assert.strictEqual(rel.keywords, undefined);
    }

    // 验证日志查询 Group：重复词（日志）只保留一份
    const g2 = cache.groups['项目根/监控/日志查询'];
    const logCount = g2.keywords.filter((k: string) => k === '日志').length;
    assert.strictEqual(logCount, 1, '重复关键词"日志"应去重为 1 份');
  });

  it('dry-run 不写盘', async () => {
    const { execSync } = await import('child_process');
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

    const dryScope = `migrate-dry-${Date.now()}`;
    registerTestScope(dryScope);
    initScope(dryScope);

    try {
      const cachePath = getRelationsCachePath(dryScope);
      const cache = readJson<any>(cachePath)!;
      cache.groups = {
        '项目根/测试': {
          hot_relations: [
            { id: 'rel_001', text: '功能', score: 1, useCount: 1, lastUsedTime: null, keywords: ['旧词'], isImported: false },
          ],
          word_cloud_keywords: ['遗留'],
          max_hot_count: 10,
        },
      };
      const { writeJson } = await import('../src/lib/store.js');
      writeJson(cachePath, cache);

      // dry-run
      const r1 = execSync(
        `npx tsx src/migrate-keywords.ts --scope ${dryScope} --dry-run`,
        { encoding: 'utf-8', cwd: path.resolve(import.meta.dirname, '..'), env: getTestEnv() }
      );
      const result1 = JSON.parse(r1);
      assert.strictEqual(result1.ok, true);
      assert.strictEqual(result1.dry_run, true);

      // 验证 dry-run 未写盘
      const cacheAfter = readJson<any>(cachePath)!;
      const g = cacheAfter.groups['项目根/测试'];
      assert.ok(g.word_cloud_keywords !== undefined, 'dry-run 后 word_cloud_keywords 应仍存在');
      assert.strictEqual(g.keywords, undefined, 'dry-run 后 keywords 不应被写入');
    } finally {
      const kbDir = getKbDir(dryScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});
