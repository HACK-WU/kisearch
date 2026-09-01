/**
 * sync-relation.ts 测试
 *
 * 覆盖：Relation 写入、本地 KB 写入、存储不设上限（maxHotCount 仅展示分区口径）、批量模式、单条失败不中断
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

describe('sync-relation 存储不设上限', () => {
  it('超过 maxHotCount 后新 Relation 全部保留，不再逐出', async () => {
    // 创建一个新 scope 以控制 maxHotCount（展示侧分区口径，非存储上限）
    const evictionScope = `evict-test-${Date.now()}`;
    const { initScope, readJson, writeJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(evictionScope);
      initScope(evictionScope);

      // 设置 maxHotCount = 2（仅影响展示分区，不应影响存储）
      const cachePath = getRelationsCachePath(evictionScope);
      const cache = readJson<any>(cachePath)!;
      cache.partition_config.maxHotCount = 2;
      writeJson(cachePath, cache);

      // 连续写入 3 个 Relation（超过 maxHotCount）
      for (const name of ['功能A描述', '功能B描述', '功能C描述']) {
        runSync([
          '--scope', evictionScope,
          '--group', '项目根/测试',
          '--relation', name,
          '--module-info', `# ${name}\n\n这是${name}的说明文档。`,
        ]);
      }

      // 验证：3 条全部保留，evicted 恒为 null
      const updatedCache = readJson<any>(cachePath)!;
      const groupData = updatedCache.groups['项目根/测试'];
      assert.strictEqual(groupData.hot_relations.length, 3, '存储层不应有上限，3 条应全部保留');
      for (const name of ['功能A描述', '功能B描述', '功能C描述']) {
        assert.ok(groupData.hot_relations.some((r: any) => r.text === name), `${name} 应保留`);
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

describe('sync-relation 自定义 tags 解析', () => {
  it('parseContentTags：逗号分隔 + 去空格 + 去重', async () => {
    const { parseContentTags } = await import('../src/sync-relation.js');
    assert.deepStrictEqual(parseContentTags('api, auth ,api, bugfix'), ['api', 'auth', 'bugfix']);
  });

  it('parseContentTags：过滤内部保留 tag（ki-search/ki-relation/ki-path）', async () => {
    const { parseContentTags } = await import('../src/sync-relation.js');
    assert.deepStrictEqual(parseContentTags('ki-search,api,ki-relation,ki-path'), ['api']);
  });

  it('parseContentTags：空/未传返回空数组', async () => {
    const { parseContentTags } = await import('../src/sync-relation.js');
    assert.deepStrictEqual(parseContentTags(undefined), []);
    assert.deepStrictEqual(parseContentTags(''), []);
    assert.deepStrictEqual(parseContentTags('   '), []);
  });

  it('parseContentTags：统一转小写', async () => {
    const { parseContentTags } = await import('../src/sync-relation.js');
    assert.deepStrictEqual(parseContentTags('API,Auth'), ['api', 'auth']);
  });
});

describe('sync-relation 多 tag docId 唯一性（#M1）', () => {
  it('generateDocId：同内容不同 tag 产生不同 docId（多 tag 各自独立 doc）', async () => {
    const { generateDocId } = await import('../src/lib/vector-client.js');
    const idKi = generateDocId('内容', 'scope1', 'ki-search');
    const idApi = generateDocId('内容', 'scope1', 'api');
    const idAuth = generateDocId('内容', 'scope1', 'auth');
    assert.notStrictEqual(idKi, idApi, 'ki-search 与 api 的 docId 应不同');
    assert.notStrictEqual(idApi, idAuth, 'api 与 auth 的 docId 应不同');
  });

  it('generateDocId：同内容同 tag 同 scope → 同 docId（幂等 upsert）', async () => {
    const { generateDocId } = await import('../src/lib/vector-client.js');
    assert.strictEqual(generateDocId('内容', 'scope1', 'api'), generateDocId('内容', 'scope1', 'api'));
  });

  it('generateDocId：tag 参与生成，与旧版（无 tag）docId 不同', async () => {
    const { generateDocId } = await import('../src/lib/vector-client.js');
    assert.notStrictEqual(generateDocId('内容', 'scope1', 'ki-search'), generateDocId('内容', 'scope1'));
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

// ─── executeBulkSyncRelation 纯函数测试（非向量化模式，离线可测） ───

describe('executeBulkSyncRelation 批量同步（非向量化）', () => {
  it('批量写入多条 Relation 到 cache + 本地 KB（一次落盘）', async () => {
    const bulkScope = `bulk-novec-${Date.now()}`;
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getLocalKbDir, getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(bulkScope);
      initScope(bulkScope);

      const { executeBulkSyncRelation } = await import('../src/sync-relation.js');
      const result = await executeBulkSyncRelation({
        scope: bulkScope,
        vector: false,
        items: [
          {
            group: '项目根/模块A',
            relation: '功能A流程',
            module_info: '# 功能A\n\n## 概述\n功能A的说明。',
          },
          {
            group: '项目根/模块B',
            relation: '功能B流程',
            module_info: '# 功能B\n\n## 概述\n功能B的说明。',
          },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.total, 2);
        assert.strictEqual(result.succeeded, 2);
        assert.strictEqual(result.failed, 0);
        assert.strictEqual(result.results.length, 2);
        assert.strictEqual(result.vectorStored, false);
        // 非向量化时 contentTags 为空数组
        assert.deepStrictEqual(result.results[0].contentTags, []);
      }

      // 验证 cache 写入
      const cache = readJson<any>(getRelationsCachePath(bulkScope))!;
      assert.ok(cache.groups['项目根/模块A']);
      assert.ok(cache.groups['项目根/模块B']);

      // 验证本地 KB 写入
      const kbA = readJson<any>(getLocalKbDir(bulkScope, '项目根/模块A'))!;
      assert.ok(kbA['功能A流程']);
      const kbB = readJson<any>(getLocalKbDir(bulkScope, '项目根/模块B'))!;
      assert.ok(kbB['功能B流程']);
    } finally {
      const kbDir = getKbDir(bulkScope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('空 module_info / 非法 relation 被跳过并计入 failed，合法条目正常写入', async () => {
    const bulkScope = `bulk-skip-${Date.now()}`;
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(bulkScope);
      initScope(bulkScope);

      const { executeBulkSyncRelation } = await import('../src/sync-relation.js');
      const result = await executeBulkSyncRelation({
        scope: bulkScope,
        vector: false,
        items: [
          {
            group: '项目根/正常',
            relation: '合法关系',
            module_info: '# 合法关系\n\n正常内容。',
          },
          {
            group: '项目根/空',
            relation: '空内容',
            module_info: '',
          },
          {
            group: '项目根/非法',
            relation: '非法/关系',
            module_info: '# 不应写入\n\n内容。',
          },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        assert.strictEqual(result.total, 3);
        assert.strictEqual(result.failed, 2);
        assert.strictEqual(result.succeeded, 1);

        // 跳过的条目有 skipped 标记
        const skipped = result.results.filter((r) => r.skipped);
        assert.strictEqual(skipped.length, 2);
        assert.ok(skipped.some((r) => r.relation === '空内容'));
        assert.ok(skipped.some((r) => r.relation === '非法/关系'));
      }

      // 合法条目写入，非法条目未写入
      const cache = readJson<any>(getRelationsCachePath(bulkScope))!;
      assert.ok(cache.groups['项目根/正常'], '合法条目应写入');
      assert.strictEqual(cache.groups['项目根/空'], undefined, '空内容条目不应写入');
      assert.strictEqual(cache.groups['项目根/非法'], undefined, '非法条目不应写入');
    } finally {
      const kbDir = getKbDir(bulkScope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('自定义 tags 持久化到 cache 的 relRec.tags', async () => {
    const bulkScope = `bulk-tags-${Date.now()}`;
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(bulkScope);
      initScope(bulkScope);

      const { executeBulkSyncRelation } = await import('../src/sync-relation.js');
      const result = await executeBulkSyncRelation({
        scope: bulkScope,
        vector: false,
        items: [
          {
            group: '项目根/带标签',
            relation: '带标签关系',
            module_info: '# 带标签\n\n内容。',
            tags: 'api,auth',
          },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        // 非向量化时 contentTags 仍为空（因为没写向量）
        assert.deepStrictEqual(result.results[0].contentTags, []);
      }

      // tags 持久化到 cache
      const cache = readJson<any>(getRelationsCachePath(bulkScope))!;
      const rel = cache.groups['项目根/带标签'].hot_relations.find(
        (r: any) => r.text === '带标签关系'
      );
      assert.ok(rel);
      assert.deepStrictEqual(rel.tags, ['api', 'auth']);
    } finally {
      const kbDir = getKbDir(bulkScope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });

  it('空 items 数组返回错误', async () => {
    const { executeBulkSyncRelation } = await import('../src/sync-relation.js');
    const result = await executeBulkSyncRelation({
      scope: 'default',
      vector: false,
      items: [],
    });
    assert.strictEqual(result.ok, false);
  });

  it('单条 syncSingleRelation 异常不中断整个批量（容错隔离）', async () => {
    const bulkScope = `bulk-fault-${Date.now()}`;
    const { initScope, readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getKbDir } = await import('../src/lib/scope.js');

    try {
      registerTestScope(bulkScope);
      initScope(bulkScope);

      const { executeBulkSyncRelation } = await import('../src/sync-relation.js');
      const result = await executeBulkSyncRelation({
        scope: bulkScope,
        vector: false,
        items: [
          {
            group: '项目根/正常',
            relation: '正常关系',
            module_info: '# 正常\n\n内容。',
          },
          // 故意传一个 group 为空格的条目（通过首层校验但 trim 后为空）
          {
            group: '   ',
            relation: '异常关系',
            module_info: '# 异常\n\n内容。',
          },
        ],
      });

      assert.strictEqual(result.ok, true);
      if (result.ok) {
        // 异常条目被跳过，正常条目正常写入
        assert.strictEqual(result.total, 2);
        assert.ok(result.failed >= 1, '异常条目应计入 failed');
        assert.ok(result.skipped >= 1, '异常条目应被标记 skipped');
        // 正常条目写入 cache
        const cache = readJson<any>(getRelationsCachePath(bulkScope))!;
        assert.ok(cache.groups['项目根/正常'], '正常条目应写入');
      }
    } finally {
      const kbDir = getKbDir(bulkScope);
      if (fs.existsSync(kbDir)) fs.rmSync(kbDir, { recursive: true, force: true });
    }
  });
});
