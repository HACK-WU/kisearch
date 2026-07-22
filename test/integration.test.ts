/**
 * integration.test.ts - Batch 4 端到端集成测试
 *
 * 覆盖：
 *   快速路径: manage-index → sync-relation → query-group → get-module-info
 *   检索回退路径: 查询不存在的 Group/Relation
 *   知识缺失路径: 本地 KB 缺失
 *   导入路径: scan-kb → import-kb
 *   A/M/D 全链路: scan → incremental scan → vectorize
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
      '--keywords', '告警,规则',
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.relation, '告警规则');
    assert.strictEqual(result.keywords.length, 2);
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
        { group: 'wiki/监控', relation: '规则A', module_info: '# 规则A\n内容A', keywords: ['规则', 'A'] },
        { group: 'wiki/监控', relation: '规则B', module_info: '# 规则B\n内容B', keywords: ['规则', 'B'] },
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
        { group: 'wiki/监控', relation: '查询规则', module_info: '# 查询\n内容', keywords: ['查询'] },
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
      '--keywords', '模块,详细',
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
      '--keywords', '存在',
    ]);

    const result = runScriptJson('get-module-info.ts', [
      '--scope', scope,
      '--group', 'wiki/监控',
      '--relation', '不存在的关系',
    ]);
    assert.strictEqual(result.ok, false);
    assert.ok(result.error.includes('不存在'));
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
      '--keywords', '数据库,连接',
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

// ─── 导入路径: scan-kb → import-kb ───

describe('导入路径', () => {
  it('scan-kb → import-kb 完整导入链路', async () => {
    const scope = await makeScopeInit('integration-import');
    const sourceDir = makeTempDir('ki-int-source');

    fs.mkdirSync(path.join(sourceDir, '监控'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '监控', '告警.md'), '# 告警模块\n告警配置说明');
    fs.writeFileSync(path.join(sourceDir, '部署.md'), '# 部署文档\n部署流程说明');

    // scan
    const resultsFile = path.join(sourceDir, 'scan-results.json');
    const scanPrep = runScriptJson('scan-kb.ts', [
      'scan',
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(scanPrep.ok, true);

    // fake AI results
    const pendingData = JSON.parse(fs.readFileSync(scanPrep.pending_file, 'utf-8'));
    fs.writeFileSync(resultsFile, JSON.stringify({
      entries: pendingData.files.map((f: any) => ({
        path: f.path,
        summary: f.path === '部署.md'
          ? '部署流程说明文档\n[路径] docs/部署.md'
          : '告警配置说明\n[路径] docs/监控/告警.md',
        keywords: f.path === '部署.md' ? ['部署', '流程'] : ['告警', '监控'],
        enriched: false,
      })),
    }, null, 2));

    const scanMerged = runScriptJson('scan-kb.ts', [
      'scan',
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
      '--results', resultsFile,
    ]);
    assert.strictEqual(scanMerged.ok, true);
    assert.strictEqual(scanMerged.merged, 2);

    // import-kb convention mode
    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'wiki',
    ]);

    const { getScanIndexPath } = await import('../src/lib/scope.js');
    const scanIndexPath = getScanIndexPath(scope);

    const importResult = runScriptJson('import-kb.ts', [
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki_imported',
      '--scan-index', scanIndexPath,
    ]);
    assert.strictEqual(importResult.ok, true);
    assert.strictEqual(importResult.relations_imported, 2);
    // resultsFile (scan-results.json) 也在 sourceDir 中，walkFiles 计入后被跳过
  });

  it('import-kb 映射模式导入', async () => {
    const scope = await makeScopeInit('integration-mapping');
    const sourceDir = makeTempDir('ki-int-mapping');
    const mappingFile = path.join(sourceDir, 'mapping.json');

    fs.writeFileSync(path.join(sourceDir, 'doc.md'), '# 文档\n文档内容');
    fs.writeFileSync(path.join(sourceDir, 'api.md'), '# API\nAPI说明');

    fs.writeFileSync(mappingFile, JSON.stringify({
      root_name: 'external_wiki',
      groups: [
        { path: '参考资料', sources: [
          { file: 'doc.md', relation: '参考文档' },
          { file: 'api.md', relation: 'API文档', code_refs: ['src/api.ts'] },
        ]},
      ],
    }, null, 2));

    runScriptJson('manage-index.ts', [
      '--scope', scope, '--action', 'create', '--name', 'external_wiki',
    ]);

    const result = runScriptJson('import-kb.ts', [
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'external_wiki',
      '--mapping', mappingFile,
    ]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.relations_imported, 2);
  });
});

// ─── A/M/D 全链路 ───

describe('A/M/D 全链路', () => {
  it('add → modify → delete 完整增量扫描链路', async () => {
    const scope = await makeScopeInit('integration-amd');
    const repoDir = makeTempDir('ki-int-amd');
    const resultsFile = path.join(repoDir, 'scan-results.json');

    git(repoDir, ['init']);
    fs.writeFileSync(path.join(repoDir, 'keep.md'), '# keep');
    fs.writeFileSync(path.join(repoDir, 'change.md'), '# change v1');
    fs.writeFileSync(path.join(repoDir, 'remove.md'), '# remove');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);

    // Initial scan to build baseline
    fs.writeFileSync(resultsFile, JSON.stringify({
      entries: [
        {
          path: 'keep.md',
          summary: 'keep\n[路径] docs/keep.md',
          keywords: ['keep'],
          enriched: false,
        },
        {
          path: 'change.md',
          summary: 'change v1\n[路径] docs/change.md',
          keywords: ['change'],
          enriched: false,
        },
        {
          path: 'remove.md',
          summary: 'remove\n[路径] docs/remove.md',
          keywords: ['remove'],
          enriched: false,
        },
      ],
    }, null, 2));

    // Initial scan: first prepare baseline by running scan without results
    const scanPrep = runScriptJson('scan-kb.ts', [
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(scanPrep.ok, true);

    // Now merge AI results into baseline
    const scan1 = runScriptJson('scan-kb.ts', [
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
      '--results', resultsFile,
    ]);
    assert.strictEqual(scan1.ok, true);
    assert.strictEqual(scan1.merged, 3);

    // Now modify: add new file, modify change.md, remove remove.md
    fs.writeFileSync(path.join(repoDir, 'new.md'), '# new');
    fs.writeFileSync(path.join(repoDir, 'change.md'), '# change v2');
    fs.unlinkSync(path.join(repoDir, 'remove.md'));
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'changes']);

    // Incremental scan - prepare
    const scan2 = runScriptJson('scan-kb.ts', [
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(scan2.ok, true);
    assert.strictEqual(scan2.mode, 'incremental');
    // Should detect A=1 (new.md), M=1 (change.md), D=1 (remove.md)
    assert.strictEqual(scan2.changes.added, 1);
    assert.strictEqual(scan2.changes.modified, 1);
    assert.strictEqual(scan2.changes.deleted, 1);

    const pending = JSON.parse(fs.readFileSync(scan2.pending_file, 'utf-8'));
    assert.ok(pending.files.some((f: any) => f.path === 'new.md' && f.changeType === 'A'));
    assert.ok(pending.files.some((f: any) => f.path === 'change.md' && f.changeType === 'M'));
    assert.ok(pending.deleted.some((f: any) => f.path === 'remove.md'));

    // Merge with AI results for the new/changed files
    fs.writeFileSync(resultsFile, JSON.stringify({
      entries: [
        {
          path: 'new.md',
          summary: 'new\n[路径] docs/new.md',
          keywords: ['new'],
          enriched: false,
        },
        {
          path: 'change.md',
          summary: 'change v2\n[路径] docs/change.md',
          keywords: ['change', 'v2'],
          enriched: false,
        },
      ],
    }, null, 2));

    const scan3 = runScriptJson('scan-kb.ts', [
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
      '--results', resultsFile,
    ]);
    assert.strictEqual(scan3.ok, true);
    assert.strictEqual(scan3.action, 'merge_results');
    // merged 为 results.entries.length，确认至少合并了变更文件
    assert.ok(scan3.merged >= 2);

    // Verify scan-index.json state
    const { readJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');
    const scanIndex = readJson<any>(getScanIndexPath(scope))!;
    assert.strictEqual(scanIndex.entries.length, 3); // keep + change + new (change updated, remove deleted)
    assert.ok(scanIndex.entries.some((e: any) => e.path === 'keep.md'));
    assert.ok(scanIndex.entries.some((e: any) => e.path === 'new.md'));
    assert.ok(!scanIndex.entries.some((e: any) => e.path === 'remove.md'));
  });
});
