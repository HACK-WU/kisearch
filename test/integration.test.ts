/**
 * integration.test.ts - Batch 4 端到端集成测试
 *
 * 覆盖：
 *   快速路径: manage-index → sync-relation → query-group → get-module-info
 *   检索回退路径: 查询不存在的 Group/Relation
 *   知识缺失路径: 本地 KB 缺失
 *   导入路径: scan-kb import --source 直导（full / incremental，git diff 驱动）
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..', 'src');

function runScript(script: string, args: string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync('npx', ['jiti', path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8',
      env: getTestEnv()
    });
    return { stdout, status: 0 };
  } catch (err: any) {
    return { stdout: err.stdout || '', status: err.status || 1 };
  }
}

function runScriptJson(script: string, args: string[]): any {
  const { stdout, status } = runScript(script, args);
  try {
    return JSON.parse(stdout.trim() || '{}');
  } catch {
    return { ok: false, raw: stdout, status };
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test-int',
      GIT_AUTHOR_EMAIL: 'test-int@example.com',
      GIT_COMMITTER_NAME: 'test-int',
      GIT_COMMITTER_EMAIL: 'test-int@example.com',
    },
  }).trim();
}

const createdScopes: string[] = [];
const tempDirs: string[] = [];
let counter = 0;

function makeScope(prefix: string): string {
  const scope = `${prefix}-${Date.now()}-${++counter}`;
  registerTestScope(scope);
  createdScopes.push(scope);
  return scope;
}

async function makeScopeInit(prefix: string): Promise<string> {
  const scope = makeScope(prefix);
  const { initScope } = await import('../src/lib/store.js');
  initScope(scope);
  return scope;
}

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  for (const scope of createdScopes) {
    const kbDir = getKbDir(scope);
    if (fs.existsSync(kbDir)) {
      fs.rmSync(kbDir, { recursive: true, force: true });
    }
  }
  for (const dir of tempDirs) {
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
  cleanupTestConfig();
});

// ─── 快速路径: manage-index → sync-relation → query-group → get-module-info ───

describe('快速路径', () => {
  it('manage-index 创建 Group 树', async () => {
    const scope = await makeScopeInit('integration-fast');

    // create root
    const createRoot = runScriptJson('manage-index.ts', [
      '--scope', scope,
      '--action', 'create',
      '--name', 'wiki',
    ]);
    assert.strictEqual(createRoot.ok, true);
    assert.strictEqual(createRoot.path, 'wiki');

    // create child
    const createChild = runScriptJson('manage-index.ts', [
      '--scope', scope,
      '--action', 'create',
      '--parent', 'wiki',
      '--name', '监控',
    ]);
    assert.strictEqual(createChild.ok, true);
    assert.strictEqual(createChild.path, 'wiki/监控');

    // create deeper child
    const createDeeper = runScriptJson('manage-index.ts', [
      '--scope', scope,
      '--action', 'create',
      '--parent', 'wiki/监控',
      '--name', '告警中心',
    ]);
    assert.strictEqual(createDeeper.ok, true);
    assert.strictEqual(createDeeper.path, 'wiki/监控/告警中心');
  });

  it('sync-relation 单条回写', async () => {
    const scope = await makeScopeInit('integration-fast');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    const result = runScriptJson('sync-relation.ts', [
      '--scope', scope,
      '--group', 'wiki/监控',
      '--relation', '告警规则',
      '--module-info', '# 告警规则\n告警规则文档内容',
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.relation, '告警规则');
  });

  it('sync-relation 批量回写', async () => {
    const scope = await makeScopeInit('integration-fast');
    const inputDir = makeTempDir('ki-int-batch');
    const inputFile = path.join(inputDir, 'batch.json');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    fs.writeFileSync(inputFile, JSON.stringify({
      items: [
        { group: 'wiki/监控', relation: '规则A', module_info: '# 规则A\n内容A' },
        { group: 'wiki/监控', relation: '规则B', module_info: '# 规则B\n内容B' },
      ],
    }, null, 2));

    const result = runScriptJson('sync-relation.ts', [
      '--scope', scope,
      '--input', inputFile,
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.results.length, 2);
  });

  it('query-group 快速查询', async () => {
    const scope = await makeScopeInit('integration-fast');
    const inputDir = makeTempDir('ki-int-query');
    const inputFile = path.join(inputDir, 'batch.json');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    fs.writeFileSync(inputFile, JSON.stringify({
      items: [
        { group: 'wiki/监控', relation: '查询规则', module_info: '# 查询\n内容' },
      ],
    }, null, 2));

    runScriptJson('sync-relation.ts', ['--scope', scope, '--input', inputFile]);

    // query specific group
    const { stdout } = runScript('query-group.ts', [
      '--scope', scope,
      '--groups', 'wiki/监控',
      '--mode', 'hot',
    ]);
    assert.ok(stdout.includes('wiki/监控'));
    assert.ok(stdout.includes('查询规则'));
  });

  it('get-module-info 读取模块信息', async () => {
    const scope = await makeScopeInit('integration-fast');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    runScriptJson('sync-relation.ts', [
      '--scope', scope,
      '--group', 'wiki/监控',
      '--relation', '模块A',
      '--module-info', '# 模块A\n这是模块A的详细说明文档',
    ]);

    // get-module-info reads the markdown content
    const { stdout } = runScript('get-module-info.ts', [
      '--scope', scope,
      '--group', 'wiki/监控',
      '--relation', '模块A',
    ]);
    assert.ok(stdout.includes('这是模块A的详细说明文档'));
    assert.ok(stdout.includes('# 模块A'));
  });
});

// ─── 检索回退路径 ───

describe('检索回退路径', () => {
  it('查询不存在的 Group 返回空', async () => {
    const scope = await makeScopeInit('integration-fallback');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    const { stdout } = runScript('query-group.ts', [
      '--scope', scope,
      '--groups', 'wiki/不存在',
      '--mode', 'hot',
    ]);
    assert.ok(stdout.includes('暂无 Relations'));
  });

  it('get-module-info 查询不存在的 Relation 返回错误', async () => {
    const scope = await makeScopeInit('integration-fallback');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    runScriptJson('sync-relation.ts', [
      '--scope', scope,
      '--group', 'wiki/监控',
      '--relation', '存在的关系',
      '--module-info', '# 内容\n存在的关系内容',
    ]);

    const result = runScriptJson('get-module-info.ts', [
      '--scope', scope,
      '--group', 'wiki/监控',
      '--relation', '不存在的关系',
    ]);
    // get-module-info 成功时输出文本（非 JSON），失败时输出 JSON。
    // fuzzy 向量兜底（searchPath threshold=0 接受 top-1）：
    //   - 无 embedding key（离线）：searchPath 返回 null → 失败 + error 含"不存在"
    //   - 有 embedding key（在线）：近似命中已存在的"存在的关系" → 文本含"存在的关系内容"
    const raw = result.raw ?? result.content ?? '';
    if (result.ok) {
      assert.ok(String(raw).includes('存在的关系内容'), '在线 fuzzy 应近似命中已存在的 relation');
    } else if (raw) {
      assert.ok(String(raw).includes('存在的关系内容'), '文本输出（ok 分支）应含 fuzzy 命中内容');
    } else {
      assert.strictEqual(result.ok, false);
      assert.ok(String(result.error ?? '').includes('不存在'));
    }
  });
});

// ─── 知识缺失路径 ───

describe('知识缺失路径', () => {
  it('本地 KB 不存在时 get-module-info 报错', async () => {
    const scope = await makeScopeInit('integration-missing');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    runScriptJson('sync-relation.ts', [
      '--scope', scope,
      '--group', 'wiki/配置',
      '--relation', '数据库配置',
      '--module-info', '# 数据库配置\n数据库连接信息',
    ]);

    // 直接删除本地 KB
    const { getLocalKbDir } = await import('../src/lib/scope.js');
    const kbPath = getLocalKbDir(scope, 'wiki/配置');
    fs.rmSync(kbPath);

    const result = runScriptJson('get-module-info.ts', [
      '--scope', scope,
      '--group', 'wiki/配置',
      '--relation', '数据库配置',
    ]);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('不存在') || result.error.includes('not exist') || result.error.includes('KB'));
  });

  it('relations-cache 不存在时 get-module-info 报错', async () => {
    const scope = await makeScopeInit('integration-missing');

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    // 删除 relations-cache
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    const cachePath = getRelationsCachePath(scope);
    fs.rmSync(cachePath);

    const result = runScriptJson('get-module-info.ts', [
      '--scope', scope,
      '--group', 'wiki/配置',
      '--relation', '某个关系',
    ]);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('relations-cache.json 不存在'));
  });
});

// ─── 导入路径: scan-kb import --source 直导 ───

describe('导入路径', () => {
  it('scan-kb import --source 直导完整链路', async () => {
    const scope = await makeScopeInit('integration-import');
    const sourceDir = makeTempDir('ki-int-source');

    fs.mkdirSync(path.join(sourceDir, '监控'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '监控', '告警.md'), '# 告警模块\n告警配置说明');
    fs.writeFileSync(path.join(sourceDir, '部署.md'), '# 部署文档\n部署流程说明');

    // 全量直导（无 AI）：--source + --root-name
    const importResult = runScriptJson('scan-kb.ts', [
      'import',
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(importResult.ok, true);
    assert.strictEqual(importResult.mode, 'full');
    assert.strictEqual(importResult.stats.total, 2);
    assert.strictEqual(importResult.groups.length, 2);
    assert.ok(importResult.groups.includes('wiki'));
    assert.ok(importResult.groups.includes('wiki/监控'));

    // 验证 relations-cache 已写入（方案 D：文件级 relation + memoryIds 多值）
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const deployRel = cache.groups['wiki'].hot_relations.find((r: any) => r.text === '部署');
    assert.ok(deployRel, '部署.md 应按文件级 relation（basename 去扩展名）命名');
    assert.strictEqual(deployRel.sourcePath, '部署.md');
    assert.strictEqual(deployRel.isImported, true);
    // 向量化成功 → memoryIds 多值（单 chunk 文件 = 1 个 id）
    assert.ok(Array.isArray(deployRel.memoryIds) && deployRel.memoryIds.length >= 1, '文件级 relation 应挂 memoryIds 多值');
  });

  it('scan-kb import 增量直连（git diff 驱动）', async () => {
    const scope = await makeScopeInit('integration-inc');
    const repoDir = makeTempDir('ki-int-inc');

    git(repoDir, ['init']);
    fs.writeFileSync(path.join(repoDir, 'keep.md'), '# keep\n内容A');
    fs.writeFileSync(path.join(repoDir, 'change.md'), '# change v1\n内容B');
    fs.writeFileSync(path.join(repoDir, 'remove.md'), '# remove\n内容C');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    // 全量直导
    const full = runScriptJson('scan-kb.ts', [
      'import',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(full.ok, true);
    assert.strictEqual(full.stats.total, 3);

    // A/M/D：新增 new.md、修改 change.md、删除 remove.md
    fs.writeFileSync(path.join(repoDir, 'new.md'), '# new\n内容D');
    fs.writeFileSync(path.join(repoDir, 'change.md'), '# change v2\n内容E');
    fs.unlinkSync(path.join(repoDir, 'remove.md'));
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'changes']);

    // 增量直连
    const inc = runScriptJson('scan-kb.ts', [
      'import',
      '--scope', scope,
      '--source', repoDir,
      '--mode', 'incremental',
    ]);
    assert.strictEqual(inc.ok, true);
    assert.strictEqual(inc.mode, 'incremental');
    assert.strictEqual(inc.stats.added, 1); // new.md
    assert.strictEqual(inc.stats.modified, 1); // change.md
    assert.strictEqual(inc.stats.deleted, 1); // remove.md
    assert.strictEqual(inc.stats.errors, 0);

    // source.commit 已更新
    const { getSource } = await import('../src/lib/scope.js');
    const source = getSource(scope);
    assert.ok(source.commit.length === 40, '增量后 source.commit 应为新 HEAD');
    const head = git(repoDir, ['rev-parse', 'HEAD']);
    assert.strictEqual(source.commit, head);

    // relations-cache 内容断言（回归保护：modified 删旧不得误删新 chunk，P0 bug）
    const { readJson } = await import('../src/lib/store.js');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    const cache = readJson<any>(getRelationsCachePath(scope))!;
    const allRels = Object.values(cache.groups).flatMap((g: any) => g.hot_relations);
    const texts = allRels.map((r: any) => r.text);

    // keep.md 保留；new.md 新增；change.md 修改后仍在（文件级 relation + memoryIds 更新）
    assert.ok(texts.some((t: string) => t === 'keep'), 'keep.md 应保留');
    assert.ok(texts.some((t: string) => t === 'new'), 'new.md 应新增');
    assert.ok(texts.some((t: string) => t === 'change'), 'change.md 修改后文件级 relation 应存在（回归：不得被删旧误删）');
    // remove.md 删除
    assert.ok(!texts.some((t: string) => t === 'remove'), 'remove.md 应删除');
  });
});
