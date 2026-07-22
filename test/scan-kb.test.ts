/**
 * scan-kb.ts 测试
 *
 * 覆盖：全量扫描、AI 结果合并、git 增量扫描、非 git 退化、
 *       vectorize 待办列出、完成回写、删除文件清理
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

const SCRIPT_PATH = path.resolve(import.meta.dirname, '..', 'src', 'scan-kb.ts');

function runScan(args: string[]): any {
  try {
    const output = execFileSync('npx', ['jiti', SCRIPT_PATH, ...args], {
      encoding: 'utf-8',
      env: getTestEnv(),
    });
    return JSON.parse(output);
  } catch (err: any) {
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // ignore
      }
    }
    return { ok: false, error: err.message };
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=master', ...args], {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
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

describe('scan-kb scan 子命令', () => {
  it('非 git 目录执行全量扫描并生成 pending 文件', async () => {
    const scope = makeScope('scan-full');
    const sourceDir = makeTempDir('ki-scan-full');

    fs.mkdirSync(path.join(sourceDir, '监控', '告警中心'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '监控', '告警中心', '规则.md'), '# 规则文档');
    fs.writeFileSync(path.join(sourceDir, '部署.md'), '# 部署文档');
    fs.writeFileSync(path.join(sourceDir, 'ignore.txt'), 'not markdown');

    const result = runScan([
      'scan',
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'scan_files');
    assert.strictEqual(result.mode, 'full');
    assert.strictEqual(result.total_files, 2);
    assert.strictEqual(result.changes.added, 2);
    assert.ok(fs.existsSync(result.pending_file));

    const pending = JSON.parse(fs.readFileSync(result.pending_file, 'utf-8'));
    assert.strictEqual(pending.files.length, 2);
    assert.ok(pending.files.some((item: any) => item.path === '部署.md'));
    assert.ok(pending.files.some((item: any) => item.path === '监控/告警中心/规则.md'));
  });

  it('可合并 AI 结果写入 scan-index.json', async () => {
    const scope = makeScope('scan-merge');
    const sourceDir = makeTempDir('ki-scan-merge');
    const resultsFile = path.join(sourceDir, 'scan-results.json');

    fs.mkdirSync(path.join(sourceDir, '监控'), { recursive: true });
    fs.writeFileSync(path.join(sourceDir, '监控', '规则.md'), '# 规则文档');

    const prepare = runScan([
      'scan',
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(prepare.ok, true);

    fs.writeFileSync(resultsFile, JSON.stringify({
      entries: [
        {
          path: '监控/规则.md',
          summary: '规则文档摘要\n[路径] docs/监控/规则.md',
          keywords: ['规则', '监控'],
          enriched: false,
        },
      ],
    }, null, 2));

    const merged = runScan([
      'scan',
      '--scope', scope,
      '--source', sourceDir,
      '--root-name', 'wiki',
      '--results', resultsFile,
    ]);

    assert.strictEqual(merged.ok, true);
    assert.strictEqual(merged.action, 'merge_results');
    assert.strictEqual(merged.merged, 1);

    const { readJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');
    const scanIndex = readJson<any>(getScanIndexPath(scope))!;

    assert.strictEqual(scanIndex.entries.length, 1);
    assert.strictEqual(scanIndex.entries[0].path, '监控/规则.md');
    assert.strictEqual(scanIndex.entries[0].fullPath, 'wiki/监控/规则');
    assert.deepStrictEqual(scanIndex.entries[0].keywords, ['规则', '监控']);
    assert.strictEqual(scanIndex.entries[0].vectorized, false);
  });

  it('git 仓库存在 lastScannedCommit 时执行增量扫描', async () => {
    const scope = makeScope('scan-incremental');
    const repoDir = makeTempDir('ki-scan-git');

    git(repoDir, ['init']);
    fs.writeFileSync(path.join(repoDir, 'a.md'), '# a v1');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);
    const firstCommit = git(repoDir, ['rev-parse', 'HEAD']);

    const { initScope, writeJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');
    initScope(scope);
    writeJson(getScanIndexPath(scope), {
      version: 1,
      scope,
      rootName: 'wiki',
      sourceDir: repoDir,
      lastScannedCommit: firstCommit,
      scannedAt: new Date().toISOString(),
      entries: [
        {
          path: 'a.md',
          fullPath: 'wiki/a',
          summary: 'old summary',
          keywords: ['a'],
          enriched: false,
          vectorized: true,
          memoryId: 'mem_a',
        },
      ],
      stats: { total: 1, scanned: 1, enriched: 0, vectorized: 1 },
    });

    fs.writeFileSync(path.join(repoDir, 'a.md'), '# a v2');
    fs.writeFileSync(path.join(repoDir, 'b.md'), '# b');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'update']);

    const result = runScan([
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.mode, 'incremental');
    assert.strictEqual(result.changes.added, 1);
    assert.strictEqual(result.changes.modified, 1);

    const pending = JSON.parse(fs.readFileSync(result.pending_file, 'utf-8'));
    assert.ok(pending.files.some((item: any) => item.path === 'a.md' && item.changeType === 'M'));
    assert.ok(pending.files.some((item: any) => item.path === 'b.md' && item.changeType === 'A'));
  });

  it('删除文件会在 pending.deleted 中体现，合并后从 scan-index 清理', async () => {
    const scope = makeScope('scan-delete');
    const repoDir = makeTempDir('ki-scan-delete');
    const resultsFile = path.join(repoDir, 'scan-results.json');

    git(repoDir, ['init']);
    fs.writeFileSync(path.join(repoDir, 'keep.md'), '# keep');
    fs.writeFileSync(path.join(repoDir, 'remove.md'), '# remove');
    git(repoDir, ['add', '.']);
    git(repoDir, ['commit', '-m', 'init']);
    const firstCommit = git(repoDir, ['rev-parse', 'HEAD']);

    const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');
    initScope(scope);
    writeJson(getScanIndexPath(scope), {
      version: 1,
      scope,
      rootName: 'wiki',
      sourceDir: repoDir,
      lastScannedCommit: firstCommit,
      scannedAt: new Date().toISOString(),
      entries: [
        {
          path: 'keep.md',
          fullPath: 'wiki/keep',
          summary: 'keep',
          keywords: ['keep'],
          enriched: false,
          vectorized: true,
          memoryId: 'mem_keep',
        },
        {
          path: 'remove.md',
          fullPath: 'wiki/remove',
          summary: 'remove',
          keywords: ['remove'],
          enriched: false,
          vectorized: true,
          memoryId: 'mem_remove',
        },
      ],
      stats: { total: 2, scanned: 2, enriched: 0, vectorized: 2 },
    });

    fs.unlinkSync(path.join(repoDir, 'remove.md'));
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'delete remove']);

    const prepare = runScan([
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
    ]);
    assert.strictEqual(prepare.ok, true);

    const pending = JSON.parse(fs.readFileSync(prepare.pending_file, 'utf-8'));
    assert.strictEqual(pending.deleted.length, 1);
    assert.strictEqual(pending.deleted[0].path, 'remove.md');

    fs.writeFileSync(resultsFile, JSON.stringify({ entries: [] }, null, 2));
    const merged = runScan([
      'scan',
      '--scope', scope,
      '--source', repoDir,
      '--root-name', 'wiki',
      '--results', resultsFile,
    ]);

    assert.strictEqual(merged.ok, true);
    const scanIndex = readJson<any>(getScanIndexPath(scope))!;
    assert.strictEqual(scanIndex.entries.length, 1);
    assert.strictEqual(scanIndex.entries[0].path, 'keep.md');
  });
});

describe('scan-kb vectorize 子命令', () => {
  it('列出待向量化条目', async () => {
    const scope = makeScope('scan-vectorize-list');
    const { initScope, writeJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');

    initScope(scope);
    writeJson(getScanIndexPath(scope), {
      version: 1,
      scope,
      rootName: 'wiki',
      sourceDir: '/tmp/source',
      lastScannedCommit: null,
      scannedAt: new Date().toISOString(),
      entries: [
        {
          path: 'a.md',
          fullPath: 'wiki/a',
          summary: 'A 摘要\n[路径] docs/a.md',
          keywords: ['A'],
          enriched: false,
          vectorized: false,
          memoryId: null,
        },
        {
          path: 'b.md',
          fullPath: 'wiki/b',
          summary: 'B 摘要\n[路径] docs/b.md',
          keywords: ['B'],
          enriched: false,
          vectorized: true,
          memoryId: 'mem_b',
        },
      ],
      stats: { total: 2, scanned: 2, enriched: 0, vectorized: 1 },
    });

    const result = runScan(['vectorize', '--scope', scope]);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'list_pending');
    assert.strictEqual(result.pending, 1);
    assert.ok(result.entries[0].content.includes('[摘要] A 摘要'));
    assert.ok(result.entries[0].content.includes('[关键词] A'));
  });

  it('标记完成后写回 memoryId 和 vectorized 状态', async () => {
    const scope = makeScope('scan-vectorize-complete');
    const completeDir = makeTempDir('ki-vectorize-complete');
    const completeFile = path.join(completeDir, 'complete.json');

    const { initScope, writeJson, readJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');

    initScope(scope);
    writeJson(getScanIndexPath(scope), {
      version: 1,
      scope,
      rootName: 'wiki',
      sourceDir: '/tmp/source',
      lastScannedCommit: null,
      scannedAt: new Date().toISOString(),
      entries: [
        {
          path: 'a.md',
          fullPath: 'wiki/a',
          summary: 'A 摘要\n[路径] docs/a.md',
          keywords: ['A'],
          enriched: false,
          vectorized: false,
          memoryId: null,
        },
        {
          path: 'b.md',
          fullPath: 'wiki/b',
          summary: 'B 摘要\n[路径] docs/b.md',
          keywords: ['B'],
          enriched: false,
          vectorized: false,
          memoryId: 'mem_old_b',
        },
      ],
      stats: { total: 2, scanned: 2, enriched: 0, vectorized: 0 },
    });

    fs.writeFileSync(completeFile, JSON.stringify({
      entries: [
        { path: 'a.md', memoryId: 'mem_a' },
        { path: 'b.md', memoryId: 'mem_b_new' },
      ],
    }, null, 2));

    const result = runScan([
      'vectorize',
      '--scope', scope,
      '--complete', completeFile,
    ]);

    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.action, 'mark_complete');
    assert.strictEqual(result.vectorized, 1);
    assert.strictEqual(result.updated, 1);

    const scanIndex = readJson<any>(getScanIndexPath(scope))!;
    const aEntry = scanIndex.entries.find((item: any) => item.path === 'a.md');
    const bEntry = scanIndex.entries.find((item: any) => item.path === 'b.md');
    assert.strictEqual(aEntry.vectorized, true);
    assert.strictEqual(aEntry.memoryId, 'mem_a');
    assert.strictEqual(bEntry.memoryId, 'mem_b_new');
  });
});
