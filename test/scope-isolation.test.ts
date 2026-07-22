/**
 * scope-isolation.test.ts - Batch 4 scope 物理隔离测试
 *
 * 验证：相同 Group/Relation 名称在不同 scope 下独立，跨 scope 不串读/串写/串删
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..', 'src');

function runJson(script: string, args: string[]): any {
  try {
    const out = execFileSync('npx', ['jiti', path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8', env: getTestEnv(),
    });
    return JSON.parse(out.trim());
  } catch (err: any) { try { return JSON.parse((err.stdout || '{}').trim()); } catch { return { ok: false }; } }
}

function getOut(script: string, args: string[]): string {
  try {
    return execFileSync('npx', ['jiti', path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8', env: getTestEnv(),
    });
  } catch (err: any) { return err.stdout || ''; }
}

const createdScopes: string[] = [];
const tempDirs: string[] = [];
let n = 0;
async function mkScope(p: string) { const s = `${p}-${Date.now()}-${++n}`; registerTestScope(s); createdScopes.push(s); const { initScope } = await import('../src/lib/store.js'); initScope(s); return s; }
function mkTmp(p: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`)); tempDirs.push(d); return d; }

function getKbDirSync(scope: string): string {
  const KI_RECORD = path.resolve(import.meta.dirname, '..');
  return path.join(KI_RECORD, 'kb', scope);
}

after(() => {
  for (const s of createdScopes) { const d = getKbDirSync(s); if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
  for (const d of tempDirs) { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
  cleanupTestConfig();
});

describe('scope 物理隔离', () => {
  it('相同 Group 名在不同 scope 下独立存储', async () => {
    const sA = await mkScope('iso-a');
    const sB = await mkScope('iso-b');

    runJson('manage-index.ts', ['--scope', sA, '--action', 'create', '--name', 'wiki']);
    runJson('manage-index.ts', ['--scope', sB, '--action', 'create', '--name', 'wiki']);

    // scope A: sync relation
    runJson('sync-relation.ts', ['--scope', sA, '--group', 'wiki/监控', '--relation', '告警-A', '--module-info', '# A\nA内容', '--keywords', 'A']);

    // scope B: 不应看到 scope A 的 relation
    const outB = getOut('query-group.ts', ['--scope', sB, '--groups', 'wiki/监控']);
    assert.ok(!outB.includes('告警-A'));

    // scope A: 应看到自己的
    const outA = getOut('query-group.ts', ['--scope', sA, '--groups', 'wiki/监控']);
    assert.ok(outA.includes('告警-A'));
  });

  it('相同 Relation 名在独立 scope 下不串读', async () => {
    const sA = await mkScope('iso-rel-a');
    const sB = await mkScope('iso-rel-b');

    runJson('manage-index.ts', ['--scope', sA, '--action', 'create', '--name', 'wiki']);
    runJson('manage-index.ts', ['--scope', sB, '--action', 'create', '--name', 'wiki']);

    runJson('sync-relation.ts', ['--scope', sA, '--group', 'wiki/config', '--relation', 'DB', '--module-info', '# DB A\nscope A 的数据库', '--keywords', 'DB,A']);
    runJson('sync-relation.ts', ['--scope', sB, '--group', 'wiki/config', '--relation', 'DB', '--module-info', '# DB B\nscope B 的数据库', '--keywords', 'DB,B']);

    // get-module-info from scope A
    const outA = getOut('get-module-info.ts', ['--scope', sA, '--group', 'wiki/config', '--relation', 'DB']);
    assert.ok(outA.includes('scope A 的数据库'));
    assert.ok(!outA.includes('scope B 的数据库'));

    // get-module-info from scope B
    const outB = getOut('get-module-info.ts', ['--scope', sB, '--group', 'wiki/config', '--relation', 'DB']);
    assert.ok(outB.includes('scope B 的数据库'));
    assert.ok(!outB.includes('scope A 的数据库'));
  });

  it('磁盘路径隔离', async () => {
    const { getKbDir } = await import('../src/lib/scope.js');
    const sA = await mkScope('iso-disk-a');
    const sB = await mkScope('iso-disk-b');

    runJson('manage-index.ts', ['--scope', sA, '--action', 'create', '--name', 'wiki']);
    runJson('manage-index.ts', ['--scope', sB, '--action', 'create', '--name', 'wiki']);

    const dirA = getKbDir(sA);
    const dirB = getKbDir(sB);
    assert.notStrictEqual(dirA, dirB);
    assert.ok(fs.existsSync(dirA));
    assert.ok(fs.existsSync(dirB));
  });

  it('删除操作互不影响', async () => {
    const { getGroupIndexPath } = await import('../src/lib/scope.js');
    const sA = await mkScope('iso-del-a');
    const sB = await mkScope('iso-del-b');

    runJson('manage-index.ts', ['--scope', sA, '--action', 'create', '--name', 'wiki']);
    runJson('manage-index.ts', ['--scope', sA, '--action', 'create', '--parent', 'wiki', '--name', 'to-delete']);
    runJson('manage-index.ts', ['--scope', sB, '--action', 'create', '--name', 'wiki']);
    runJson('manage-index.ts', ['--scope', sB, '--action', 'create', '--parent', 'wiki', '--name', 'to-delete']);

    // 删除 scope A 中的节点
    runJson('manage-index.ts', ['--scope', sA, '--action', 'delete', '--parent', 'wiki', '--name', 'to-delete']);

    // scope B 中仍应有 'to-delete'
    const { readJson } = await import('../src/lib/store.js');
    const idxB = readJson<any>(getGroupIndexPath(sB));
    assert.ok(idxB.groups.wiki['to-delete'] !== undefined);

    // scope A 中应已删除
    const idxA = readJson<any>(getGroupIndexPath(sA));
    assert.strictEqual(idxA.groups.wiki['to-delete'], undefined);
  });

  it('scan-kb 和 import-kb 在不同 scope 下隔离', async () => {
    const sA = await mkScope('iso-scan-a');
    const sB = await mkScope('iso-scan-b');
    const src = mkTmp('iso-src');

    fs.writeFileSync(path.join(src, 'doc.md'), '# doc\ncontent');

    // scope A scan
    const resultsFile = path.join(src, 'results.json');
    const prepA = runJson('scan-kb.ts', ['scan', '--scope', sA, '--source', src, '--root-name', 'wiki']);
    fs.writeFileSync(resultsFile, JSON.stringify({
      entries: [{ path: 'doc.md', summary: 'content\n[路径] docs/doc.md', keywords: ['doc'], enriched: false }],
    }));
    runJson('scan-kb.ts', ['scan', '--scope', sA, '--source', src, '--root-name', 'wiki', '--results', resultsFile]);

    // scope B: should have no scan-index
    const { readJson } = await import('../src/lib/store.js');
    const { getScanIndexPath } = await import('../src/lib/scope.js');
    assert.strictEqual(readJson(getScanIndexPath(sB)), null);

    // scope A should have it
    const siA = readJson<any>(getScanIndexPath(sA));
    assert.ok(siA !== null);
    assert.strictEqual(siA.entries.length, 1);
  });
});
