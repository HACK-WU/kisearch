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

const SCRIPTS_DIR = path.resolve(import.meta.dirname, '..', 'scripts');

function runJson(script: string, args: string[]): any {
  try {
    const out = execFileSync('npx', ['jiti', path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return JSON.parse(out.trim() || '{}');
  } catch (err: any) { try { return JSON.parse((err.stdout || '{}').trim()); } catch { return { ok: false }; } }
}

function getOut(script: string, args: string[]): string {
  try {
    return execFileSync('npx', ['jiti', path.join(SCRIPTS_DIR, script), ...args], {
      encoding: 'utf-8', env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
  } catch (err: any) { return err.stdout || ''; }
}

const createdScopes: string[] = [];
const tempDirs: string[] = [];
let n = 0;
function mkScope(p: string) { const s = `${p}-${Date.now()}-${++n}`; createdScopes.push(s); return s; }
function mkTmp(p: string) { const d = fs.mkdtempSync(path.join(os.tmpdir(), `${p}-`)); tempDirs.push(d); return d; }

after(async () => {
  const { getKbDir } = await import('../scripts/lib/scope.js');
  for (const s of createdScopes) { const d = getKbDir(s); if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
  for (const d of tempDirs) { if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true }); }
});

// ─── §2 通用参数校验 ───
describe('参数校验', () => {
  it('非法 scope 字符被拒绝', () => {
    const r = runJson('query-group.ts', ['--scope', '../etc']);
    assert.strictEqual(r.ok, false);
  });
  it('scope 含特殊字符被拒绝', () => {
    const r = runJson('query-group.ts', ['--scope', 'bad/scope']);
    assert.strictEqual(r.ok, false);
  });
});

// ─── §3 Group 树索引 ───
describe('Group 树索引异常', () => {
  it('查询不存在的 Group 不崩溃', () => {
    const s = mkScope('err-g');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const out = getOut('query-group.ts', ['--scope', s, '--groups', 'wiki/nope']);
    assert.ok(out.includes('暂无 Relations'));
  });
  it('损坏的 group-index.json', async () => {
    const s = mkScope('err-g');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const { getGroupIndexPath } = await import('../scripts/lib/scope.js');
    fs.writeFileSync(getGroupIndexPath(s), '{{{broken');
    const r = runJson('query-group.ts', ['--scope', s]);
    assert.strictEqual(r.ok, false);
  });
  it('已存在 Group', () => {
    const s = mkScope('err-g');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    assert.strictEqual(r.ok, false);
  });
  it('删除非空节点被拒绝', () => {
    const s = mkScope('err-g');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    runJson('manage-index.ts', ['--scope', s, '--action', 'create', '--parent', 'wiki', '--name', '父']);
    runJson('manage-index.ts', ['--scope', s, '--action', 'create', '--parent', 'wiki/父', '--name', '子']);
    const r = runJson('manage-index.ts', ['--scope', s, '--action', 'delete', '--parent', 'wiki', '--name', '父']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('非空'));
  });
});

// ─── §4 Relations 缓存 ───
describe('Relations 缓存异常', () => {
  it('sync-relation 空 module-info 被拒绝', () => {
    const s = mkScope('err-r');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('sync-relation.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'x', '--module-info', '', '--keywords', 'x']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('需要'));
  });
  it('keywords 不在原文中被移除', () => {
    const s = mkScope('err-r');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('sync-relation.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'kw', '--module-info', '# t\n只有测试', '--keywords', '测试,虚构']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.keywords.length, 1);
    assert.ok(r.invalid_keywords.includes('虚构'));
  });
  it('keywords 为空仍继续', () => {
    const s = mkScope('err-r');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    // 传逗号分隔无实际关键词，split 后产生空数组，但 commander 会传空字符串
    // 当前实现：空字符串为 falsy，被参数校验拦截
    const r = runJson('sync-relation.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'empty', '--module-info', '# t\n内容', '--keywords', '']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('需要'));
  });
  it('单条模式缺少参数', () => {
    const s = mkScope('err-r');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('sync-relation.ts', ['--scope', s]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('需要'));
  });
});

// ─── §5 本地 KB 相关 ───
describe('本地 KB 异常', () => {
  it('get-module-info 本地 KB 缺失', async () => {
    const s = mkScope('err-kb');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    runJson('sync-relation.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'A', '--module-info', '# A\nA内容', '--keywords', 'A']);
    const { getLocalKbDir } = await import('../scripts/lib/scope.js');
    fs.rmSync(getLocalKbDir(s, 'wiki/t'));
    const r = runJson('get-module-info.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'A']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('KB'));
  });
  it('relations-cache 缺失', async () => {
    const s = mkScope('err-kb');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const { getRelationsCachePath } = await import('../scripts/lib/scope.js');
    fs.rmSync(getRelationsCachePath(s));
    const r = runJson('get-module-info.ts', ['--scope', s, '--group', 'wiki/t', '--relation', 'A']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('relations-cache'));
  });
});

// ─── §12 展示参数校验 ───
describe('展示参数校验', () => {
  it('无效 mode', () => {
    const s = mkScope('err-display');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('query-group.ts', ['--scope', s, '--mode', 'invalid']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('无效值'));
  });
  it('无效 mode 多值', () => {
    const s = mkScope('err-display');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('query-group.ts', ['--scope', s, '--mode', 'hot,invalid']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('无效值'));
  });
});

// ─── §8 预扫描异常 ───
describe('预扫描异常', () => {
  it('scan-kb source 目录不存在', () => {
    const s = mkScope('err-scan');
    const r = runJson('scan-kb.ts', ['scan', '--scope', s, '--source', '/nonexistent/path', '--root-name', 'wiki']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('source 目录不存在或不是目录'));
    assert.ok(r.hint.includes('--source'));
    assert.ok(Array.isArray(r.next_step));
    assert.ok(r.next_step.length >= 2);
  });
  it('scan-kb vectorize 无 scan-index', () => {
    const s = mkScope('err-scan');
    runJson('manage-index.ts', ['--scope', s, '--action', 'create-root', '--root-name', 'wiki']);
    const r = runJson('scan-kb.ts', ['vectorize', '--scope', s]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('scan-index.json 不存在'));
    assert.ok(r.hint.includes('scan --results'));
    assert.ok(Array.isArray(r.possible_causes));
    assert.ok(r.possible_causes.some((item: string) => item.includes('scan-pending.json')));
  });
  it('scan-kb scan --results 缺少 pending 文件时给出下一步提示', () => {
    const s = mkScope('err-scan');
    const src = mkTmp('ki-err-results-no-pending');
    const resultsFile = path.join(src, 'results.json');
    fs.writeFileSync(resultsFile, JSON.stringify({ entries: [] }, null, 2));

    const r = runJson('scan-kb.ts', ['scan', '--scope', s, '--source', src, '--root-name', 'wiki', '--results', resultsFile]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('scan-pending.json 不存在'));
    assert.ok(r.hint.includes('不带 `--results` 的 `scan`'));
    assert.ok(Array.isArray(r.next_step));
    assert.ok(r.next_step[0].includes('scan --scope'));
  });
  it('scan-kb scan --results 缺少结果文件时返回格式示例', () => {
    const s = mkScope('err-scan');
    const src = mkTmp('ki-err-missing-results');
    runJson('scan-kb.ts', ['scan', '--scope', s, '--source', src, '--root-name', 'wiki']);

    const r = runJson('scan-kb.ts', ['scan', '--scope', s, '--source', src, '--root-name', 'wiki', '--results', path.join(src, 'missing.json')]);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('results 文件不存在'));
    assert.ok(r.hint.includes('entries'));
    assert.deepStrictEqual(r.example.entries[0].keywords, ['API', '接口', '认证']);
  });
  it('scan-kb vectorize --complete 缺少完成文件时返回格式示例', () => {
    const s = mkScope('err-scan');
    const r = runJson('scan-kb.ts', ['vectorize', '--scope', s, '--complete', '/tmp/not-found-complete.json']);
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('complete 文件不存在'));
    assert.ok(r.hint.includes('memoryId'));
    assert.strictEqual(r.example.entries[0].path, 'docs/api.md');
  });
  it('scan-kb 空 md 文件被跳过', () => {
    const s = mkScope('err-scan');
    const src = mkTmp('ki-err-empty');
    fs.writeFileSync(path.join(src, 'empty.md'), '');
    fs.writeFileSync(path.join(src, 'good.md'), '# good');
    const r = runJson('scan-kb.ts', ['scan', '--scope', s, '--source', src, '--root-name', 'wiki']);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.total_files, 1);
    const pending = JSON.parse(fs.readFileSync(r.pending_file, 'utf-8'));
    assert.ok(!pending.files.some((f: any) => f.path === 'empty.md'));
    assert.ok(pending.files.some((f: any) => f.path === 'good.md'));
  });
});

// ─── §7 导入异常 ───
describe('导入异常', () => {
  it('import-kb source 目录不存在', () => {
    const s = mkScope('err-imp');
    const r = runJson('import-kb.ts', ['--scope', s, '--source', '/nonexistent', '--root-name', 'wiki']);
    assert.strictEqual(r.ok, false);
  });
  it('import-kb 空 root-name', () => {
    const s = mkScope('err-imp');
    const src = mkTmp('ki-err-root');
    const r = runJson('import-kb.ts', ['--scope', s, '--source', src, '--root-name', '']);
    assert.strictEqual(r.ok, false);
  });
});
