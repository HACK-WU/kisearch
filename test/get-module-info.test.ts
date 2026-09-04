/**
 * get-module-info.ts 测试
 *
 * 覆盖：返回 Markdown、更新 useCount、Relation 不存在、本地 KB 不存在、
 *       防刷间隔内不重复计分
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
  'get-module-info.ts'
);

function runGetModuleInfo(args: string[]): string {
  try {
    return execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv()
    });
  } catch (err: any) {
    if (err.stdout) return err.stdout;
    return '';
  }
}

function runGetModuleInfoJson(args: string[]): any {
  const output = runGetModuleInfo(args);
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output };
  }
}

// ─── 测试 ───

const scope = `getmod-test-${Date.now()}`;
const testGroup = '项目根/监控/告警中心';
const testMarkdown = '# 告警规则CRUD\n\n## 调用链\n1. AlertController.create()\n2. AlertService.validate()\n\n## 关键模块\n- AlertController\n- AlertService';

before(async () => {
  // 初始化 scope 并写入测试数据
  registerTestScope(scope);
  const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
  const { getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');

  initScope(scope);

  // 写入 relations-cache
  const cachePath = getRelationsCachePath(scope);
  const cache = readJson<any>(cachePath)!;
  cache.groups[testGroup] = {
    hot_relations: [
      {
        id: 'rel_001',
        text: '告警规则CRUD流程',
        score: 5.0,
        useCount: 3,
        lastUsedTime: Date.now() - 3600000, // 1小时前
        isImported: false,
      },
    ],
    keywords: ['规则', '阈值', '静默', '聚合'],
  };
  writeJson(cachePath, cache);

  // 写入本地 KB
  const localKbPath = getLocalKbDir(scope, testGroup);
  fs.mkdirSync(path.dirname(localKbPath), { recursive: true });
  writeJson(localKbPath, {
    '告警规则CRUD流程': testMarkdown,
  });
});

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  const kbDir = getKbDir(scope);
  if (fs.existsSync(kbDir)) {
    fs.rmSync(kbDir, { recursive: true, force: true });
  }
  cleanupTestConfig();
});

describe('get-module-info 基本功能', () => {
  it('成功返回 Markdown 内容', () => {
    const output = runGetModuleInfo([
      '--scope', scope,
      '--group', testGroup,
      '--relation', 'rel_001',
    ]);

    assert.ok(output.includes('告警规则CRUD'));
    assert.ok(output.includes('AlertController'));
  });

  it('通过 Relation 名称也能查找', () => {
    const output = runGetModuleInfo([
      '--scope', scope,
      '--group', testGroup,
      '--relation', '告警规则CRUD流程',
    ]);

    assert.ok(output.includes('告警规则CRUD'));
  });

  it('调用后 useCount 增加', async () => {
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');

    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const rel = cache.groups[testGroup].hot_relations.find(
      (r: any) => r.id === 'rel_001'
    );
    // useCount 应该比初始值 3 大（至少被调用了一次）
    assert.ok(rel.useCount >= 4, `useCount should be >= 4, got ${rel.useCount}`);
  });

  it('防刷间隔内不重复计分', async () => {
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');

    // 获取当前 useCount
    const cache1 = readJson<any>(getRelationsCachePath(scope))!;
    const rel1 = cache1.groups[testGroup].hot_relations.find(
      (r: any) => r.id === 'rel_001'
    );
    const useCountBefore = rel1.useCount;

    // 立即再次调用（5分钟防刷间隔内）
    runGetModuleInfo([
      '--scope', scope,
      '--group', testGroup,
      '--relation', 'rel_001',
    ]);

    // useCount 不应增加
    const cache2 = readJson<any>(getRelationsCachePath(scope))!;
    const rel2 = cache2.groups[testGroup].hot_relations.find(
      (r: any) => r.id === 'rel_001'
    );
    assert.strictEqual(rel2.useCount, useCountBefore);
  });
});

describe('get-module-info 异常处理', () => {
  it('Relation 不存在返回错误', () => {
    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', testGroup,
      '--relation', 'rel_999',
    ]);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('不存在'));
  });

  it('Group 不存在返回错误', () => {
    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', '项目根/不存在的Group',
      '--relation', 'rel_001',
    ]);

    assert.strictEqual(result.ok, false);
  });

  it('本地 KB 文件不存在返回错误', async () => {
    // 添加一个 Relation 到 cache 但没有对应的本地 KB
    const { readJson, writeJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');

    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<any>(cachePath)!;
    cache.groups[testGroup].hot_relations.push({
      id: 'rel_002',
      text: '无KB内容的Relation',
      score: 0,
      useCount: 0,
      lastUsedTime: null,
      keywords: [],
      isImported: false,
    });
    writeJson(cachePath, cache);

    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', testGroup,
      '--relation', 'rel_002',
    ]);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('未找到') || result.error.includes('不存在'));
  });
});

describe('get-module-info 批量模式（--relation 逗号分隔多条）', () => {
  // 批量测试自备第二条有 KB 内容的 Relation，避免与既有用例数据耦合
  before(async () => {
    const { readJson, writeJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath, getLocalKbDir } = await import('../src/lib/scope.js');

    const cachePath = getRelationsCachePath(scope);
    const cache = readJson<any>(cachePath)!;
    cache.groups[testGroup].hot_relations.push({
      id: 'rel_010',
      text: '静默策略说明',
      score: 1.0,
      useCount: 0,
      lastUsedTime: null,
      isImported: false,
    });
    writeJson(cachePath, cache);

    const localKbPath = getLocalKbDir(scope, testGroup);
    const kb = JSON.parse(fs.readFileSync(localKbPath, 'utf-8'));
    kb['静默策略说明'] = '# 静默策略\n\n告警静默窗口配置说明。';
    writeJson(localKbPath, kb);
  });

  it('批量查询多条全部成功', () => {
    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', testGroup,
      '--relation', 'rel_001,静默策略说明',
    ]);

    assert.strictEqual(result.ok, true, `stdout=${JSON.stringify(result)}`);
    assert.strictEqual(result.succeeded, 2);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.results.length, 2);
    assert.ok(result.results[0].content.includes('AlertController'));
    assert.ok(result.results[1].content.includes('静默策略'));
  });

  it('部分失败不影响其他条目', () => {
    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', testGroup,
      '--relation', 'rel_001,不存在的关系,rel_002',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.succeeded, 1);
    assert.strictEqual(result.failed, 2);
    assert.strictEqual(result.results[0].ok, true);
    assert.strictEqual(result.results[1].ok, false);
    assert.ok(result.results[1].error.includes('不存在'));
    assert.strictEqual(result.results[2].ok, false);
  });

  it('重复 relation 去重（只查询一次）', () => {
    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', testGroup,
      '--relation', '静默策略说明,静默策略说明',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.results.length, 1);
    assert.strictEqual(result.succeeded, 1);
  });

  it('超过 10 条 fail-loud 报错（不静默截断）', () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `不存在-${i}`).join(',');
    const result = runGetModuleInfoJson([
      '--scope', scope,
      '--group', testGroup,
      '--relation', eleven,
    ]);

    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('上限'));
  });
});
