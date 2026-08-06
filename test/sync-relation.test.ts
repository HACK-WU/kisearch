/**
 * sync-relation.ts 测试
 *
 * 覆盖：Relation 写入、本地 KB 写入、淘汰逻辑（maxHotCount）、批量模式、单条失败不中断
 *
 * 批次 3（REQ-05）：keywords 校验机制已删除，相关测试移除。
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
  const { initScope } = await import('../src/lib/store.js');
  initScope(scope);
});

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
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
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.relation, '告警规则CRUD流程');
    assert.strictEqual(result.evicted, null);
  });

  it('Relation 已写入 relations-cache.json', async () => {
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');

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
    const { readJson } = await import('../src/lib/store.js');
    const { getLocalKbDir } = await import('../src/lib/scope.js');

    const localKb = readJson<any>(getLocalKbDir(scope, '项目根/监控/告警中心'))!;
    assert.ok(localKb['告警规则CRUD流程']);
    assert.ok(localKb['告警规则CRUD流程'].includes('告警规则CRUD'));
  });

  it('重复写入同一 Relation 不创建新条目', async () => {
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');

    // 先写入
    runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '聚合策略配置',
      '--module-info', '# 聚合策略配置\n\n## 概述\n配置告警聚合策略，包括时间窗口和分组规则。',
    ]);

    const cache1 = readJson<any>(getRelationsCachePath(scope))!;
    const count1 = cache1.groups['项目根/监控/告警中心'].hot_relations.length;

    // 再次写入同一 Relation（内容更新）
    runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '聚合策略配置',
      '--module-info', '# 聚合策略配置\n\n## 概述\n配置告警聚合策略，包括时间窗口和分组规则。支持去重。',
    ]);

    const cache2 = readJson<any>(getRelationsCachePath(scope))!;
    const count2 = cache2.groups['项目根/监控/告警中心'].hot_relations.length;

    // 数量不应增加
    assert.strictEqual(count2, count1);

    // Relation 不应含 keywords 字段（REQ-05 已删除）
    const rel = cache2.groups['项目根/监控/告警中心'].hot_relations.find(
      (r: any) => r.text === '聚合策略配置'
    );
    assert.ok(rel);
    assert.strictEqual(rel.keywords, undefined);
  });
});

describe('sync-relation 淘汰逻辑', () => {
  it('达到 maxHotCount 时淘汰最低分 Relation', async () => {
    // 创建一个新 scope 以控制 maxHotCount
    const evictionScope = `evict-test-${Date.now()}`;
    const { initScope, readJson, writeJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

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
      ]);

      runSync([
        '--scope', evictionScope,
        '--group', '项目根/测试',
        '--relation', '功能B描述',
        '--module-info', '# 功能B\n\n这是功能B的说明文档。',
      ]);

      // 写入第 3 个，应触发淘汰
      const result = runSync([
        '--scope', evictionScope,
        '--group', '项目根/测试',
        '--relation', '功能C描述',
        '--module-info', '# 功能C\n\n这是功能C的说明文档。',
      ]);

      assert.strictEqual(result.ok, true);
      assert.ok(result.evicted !== null, '应有一个被淘汰的 Relation');

      // 验证淘汰后数量不超过 maxHotCount
      const updatedCache = readJson<any>(cachePath)!;
      const groupData = updatedCache.groups['项目根/测试'];
      assert.ok(groupData.hot_relations.length <= 2);
      assert.ok(groupData.hot_relations.some((r: any) => r.text === '功能C描述'));
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
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

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
          },
          {
            group: '项目根/部署/后端',
            relation: '后端部署脚本',
            module_info: '# 后端部署脚本\n\n## 概述\n使用 Docker 部署后端服务。',
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

  it('批量模式中空 module-info 被跳过并计入 failed', async () => {
    const batchScope = `batch-fail-test-${Date.now()}`;
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(batchScope);
      initScope(batchScope);

      const inputFile = path.join(
        path.dirname(getKbDir(batchScope)),
        `batch-fail-${Date.now()}.json`
      );
      // 第二条 module_info 为空 → 跳过并计入 failed
      fs.writeFileSync(inputFile, JSON.stringify({
        items: [
          {
            group: '项目根/测试A',
            relation: '正常功能',
            module_info: '# 正常功能\n\n这是一个正常的功能说明。',
          },
          {
            group: '项目根/测试B',
            relation: '异常功能',
            module_info: '',
          },
        ],
      }));

      const result = runSync([
        '--scope', batchScope,
        '--input', inputFile,
      ]);

      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.results.length, 2);
      assert.strictEqual(result.failed, 1, '空 module-info 应计入 failed');

      fs.unlinkSync(inputFile);
    } finally {
      const kbDir = getKbDir(batchScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});

describe('sync-relation relation 名安全校验', () => {
  it('单条模式：含 "/" 的 relation 直接失败（ok:false）', () => {
    const result = runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '配置/加载流程',
      '--module-info', '# 配置加载流程\n\n## 概述\n配置加载相关流程。',
    ]);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /非法路径字符/);
    assert.match(result.error, /配置\/加载流程/);
  });

  it('单条模式：含 ".." 的 relation 直接失败', () => {
    const result = runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '..evil',
      '--module-info', '# evil\n\n## 概述\n路径穿越测试。',
    ]);
    assert.strictEqual(result.ok, false);
    assert.match(result.error, /非法路径字符/);
  });

  it('单条模式：非法 relation 未写入 cache（无半成品状态）', async () => {
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    runSync([
      '--scope', scope,
      '--group', '项目根/监控/告警中心',
      '--relation', '写不进去/的关系',
      '--module-info', '# x\n\n## 概述\n不应写入。',
    ]);
    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const groupData = cache.groups['项目根/监控/告警中心'];
    const found = (groupData?.hot_relations || []).find(
      (r: any) => r.text === '写不进去/的关系'
    );
    assert.strictEqual(found, undefined, '非法 relation 不应写入 cache');
  });

  it('批量模式：非法 relation 被跳过并计入 failed，合法条目正常写入', async () => {
    const guardScope = `guard-batch-${Date.now()}`;
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');
    try {
      registerTestScope(guardScope);
      initScope(guardScope);
      const inputFile = path.join(
        path.dirname(getKbDir(guardScope)),
        `guard-batch-${Date.now()}.json`
      );
      fs.writeFileSync(inputFile, JSON.stringify({
        items: [
          {
            group: '项目根/正常',
            relation: '合法关系',
            module_info: '# 合法关系\n\n## 概述\n正常写入。',
          },
          {
            group: '项目根/非法',
            relation: '非法/关系',
            module_info: '# 非法关系\n\n## 概述\n应被跳过。',
          },
        ],
      }));
      const result = runSync(['--scope', guardScope, '--input', inputFile]);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.total, 2);
      assert.strictEqual(result.failed, 1, '非法 relation 应计入 failed');

      const cache = readJson<any>(getRelationsCachePath(guardScope))!;
      assert.ok(cache.groups['项目根/正常'], '合法条目应写入');
      assert.strictEqual(cache.groups['项目根/非法'], undefined, '非法条目不应写入');

      fs.unlinkSync(inputFile);
    } finally {
      const kbDir = getKbDir(guardScope);
      if (fs.existsSync(kbDir)) {
        fs.rmSync(kbDir, { recursive: true, force: true });
      }
    }
  });
});
