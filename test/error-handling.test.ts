/**
 * error-handling.test.ts - Batch 4 边界与异常测试
 * 系统覆盖 08-error-handling.md 异常矩阵
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig, JITI_CLI } from './test-config.js';

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..', 'src');

function runJson(script: string, args: string[]): any {
  try {
    const out = execFileSync(process.execPath, [JITI_CLI, path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8', env: getTestEnv(),
    });
    return JSON.parse(out.trim() || '{}');
  } catch (err: any) { try { return JSON.parse((err.stdout || '{}').trim()); } catch { return { ok: false }; } }
}

function createGroup(scope: string, groupPath: string): any {
  return runJson('group.ts', ['create', groupPath, '--scope', scope]);
}

function getOut(script: string, args: string[]): string {
  try {
    return execFileSync(process.execPath, [JITI_CLI, path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8', env: getTestEnv(),
    });
  } catch (err: any) { return err.stdout || ''; }
}

const createdScopes: string[] = [];
const tempDirs: string[] = [];
let n = 0;
async function mkScope(p: string) { const s = `${p}-${Date.now()}-${++n}`; registerTestScope(s); createdScopes.push(s); const { initScope } = await import('../src/lib/store.js'); initScope(s); return s; }
function mkTmp(p: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`)); tempDirs.push(d); return d; }

after(async () => {
  const { getKbDir } = await import('../src/lib/scope.js');
  for (const s of createdScopes) { const d = getKbDir(s); if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
  for (const d of tempDirs) { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
  cleanupTestConfig();
});

// ─── §2 通用参数校验 ───
describe('参数校验', () => {
  it('非法 scope 字符被拒绝', () => {
    const r = runJson('group.ts', ['list', '--scope', '../etc']);
    assert.strictEqual(r.ok, false);
  });
  it('scope 含特殊字符被拒绝', () => {
    const r = runJson('group.ts', ['list', '--scope', 'bad/scope']);
    assert.strictEqual(r.ok, false);
  });
});

// ─── §3 Group 树索引 ───
describe('Group 树索引异常', () => {
  it('查询不存在的 Group 不崩溃', async () => {
    const s = await mkScope('err-g');
    createGroup(s, 'wiki');
    const out = getOut('group.ts', ['list', '--scope', s, '--groups', 'wiki/nope']);
    assert.ok(out.includes('暂无 Relations'));
  });
  it('损坏的 group-index.json', async () => {
    const s = await mkScope('err-g');
    createGroup(s, 'wiki');
    const { getGroupIndexPath } = await import('../src/lib/scope.js');
    fs.writeFileSync(getGroupIndexPath(s), '{{{broken');
    const r = runJson('group.ts', ['list', '--scope', s]);
    assert.strictEqual(r.ok, false);
  });
  it('已存在 Group', async () => {
    const s = await mkScope('err-g');
    createGroup(s, 'wiki');
    const r = createGroup(s, 'wiki');
    assert.strictEqual(r.ok, false);
  });
  it('ki group delete 默认只预览（零写入），--yes 才执行', async () => {
    const s = await mkScope('err-g');
    createGroup(s, 'wiki');
    createGroup(s, 'wiki/父');
    createGroup(s, 'wiki/父/子');

    const preview = runJson('group.ts', ['delete', 'wiki/父', '--scope', s]);
    assert.strictEqual(preview.ok, true);
    assert.ok(String(preview.hint).includes('--yes'));
    const { getGroupIndexPath } = await import('../src/lib/scope.js');
    const before = JSON.parse(fs.readFileSync(getGroupIndexPath(s), 'utf-8'));
    assert.ok(before.groups.wiki['父'], '预览不得删除节点');

    const executed = runJson('group.ts', ['delete', 'wiki/父', '--yes', '--scope', s]);
    assert.strictEqual(executed.ok, true);
    const after = JSON.parse(fs.readFileSync(getGroupIndexPath(s), 'utf-8'));
    assert.strictEqual(after.groups.wiki?.['父'], undefined);
  });
});

// ─── §4 Relations 缓存 ───
describe('Relations 缓存异常', () => {
  it('sync-relation 空 module-info 被拒绝', async () => {
    const s = await mkScope('err-r');
    createGroup(s, 'wiki');
    const r = runJson('sync-relation.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'x', '--module-info', '']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('需要'));
  });
  it('单条模式缺少参数', async () => {
    const s = await mkScope('err-r');
    createGroup(s, 'wiki');
    const r = runJson('sync-relation.ts', ['--scope', s]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('需要'));
  });
});

// ─── §5 本地 KB 相关 ───
describe('本地 KB 异常', () => {
  it('get-module-info 本地 KB 缺失', async () => {
    const s = await mkScope('err-kb');
    createGroup(s, 'wiki');
    runJson('sync-relation.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'A', '--module-info', '# A\nA内容']);
    const { getLocalKbDir } = await import('../src/lib/scope.js');
    fs.rmSync(getLocalKbDir(s, 'wiki/t'));
    const r = runJson('get-module-info.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'A']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('KB'));
  });
  it('relations-cache 缺失', async () => {
    const s = await mkScope('err-kb');
    createGroup(s, 'wiki');
    const { getRelationsCachePath } = await import('../src/lib/scope.js');
    fs.rmSync(getRelationsCachePath(s));
    const r = runJson('get-module-info.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'A']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('relations-cache'));
  });
});

// ─── §12 展示参数校验 ───
describe('展示参数校验', () => {
  it('无效 mode', async () => {
    const s = await mkScope('err-display');
    createGroup(s, 'wiki');
    const r = runJson('group.ts', ['list', '--scope', s, '--mode', 'invalid']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('无效值'));
  });
  it('无效 mode 多值', async () => {
    const s = await mkScope('err-display');
    createGroup(s, 'wiki');
    const r = runJson('group.ts', ['list', '--scope', s, '--mode', 'hot,invalid']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('无效值'));
  });
});

// ─── §8 导入异常（幂等追加直导） ───
describe('导入异常', () => {
  it('ki import source 目录不存在', async () => {
    const s = await mkScope('err-imp');
    const r = runJson('import.ts', ['--scope', s, '--source', '/nonexistent/path', '--group', 'wiki']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('sourceDir 不存在或不是目录'));
  });
  it('ki import 不传 --group：顶层 .md 落 scope name（K2 决策）', async () => {
    const s = await mkScope('err-imp');
    const src = mkTmp('ki-err-root');
    fs.writeFileSync(path.join(src, 'a.md'), '# a');
    const r = runJson('import.ts', ['--scope', s, '--source', src, '--no-vector']);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.ok(r.groups.includes(s), `缺省 --group 顶层 .md 应落 scope name；实际=${JSON.stringify(r.groups)}`);
  });
  it('ki import 目录无 md 文件', async () => {
    const s = await mkScope('err-imp');
    const src = mkTmp('ki-err-nomd');
    fs.writeFileSync(path.join(src, 'a.txt'), 'not markdown');
    const r = runJson('import.ts', ['--scope', s, '--source', src, '--group', 'wiki']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('未发现 .md 文件'));
  });
});
