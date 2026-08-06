/**
 * incremental-direct.test.ts —— 增量直连专项测试（git diff 驱动）
 *
 * 回归保护：批次 3 审查发现的 P0 bug——modified 删旧逻辑若按 sourcePath 前缀
 * 匹配，会把新写入的 chunk 也误删（relations-cache 变空）。修复后：
 *   - 删旧基于 oldIds（旧 memoryId）∩ okIds（新 id）的差集（staleIds）
 *   - chunk 数不变：新 chunk 更新 memoryId 保留
 *   - chunk 数减少：多余旧 chunk 删除
 *
 * 这些用例用 mock 向量层（不依赖真实 embedding），聚焦 cache 层语义。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { registerTestScope, getTestEnv, cleanupTestConfig } from './test-config.js';

// ─── 工具 ───

// 本测试验证 modified 删旧缓存语义（chunk 数不变/减少），依赖真实向量化成功
//（okIds 非空才触发删旧）。无 embedding key 时整组跳过（与 e2e 网络测试一致），
// 避免向量化失败走 else 分支导致断言失真。
const EMB_KEY = process.env.SILICONFLOW_API_KEY || process.env.GITNEXUS_EMBEDDING_API_KEY;
const SKIP = EMB_KEY ? {} : { skip: '缺少 embedding apiKey（SILICONFLOW_API_KEY / GITNEXUS_EMBEDDING_API_KEY），跳过增量直连缓存语义测试' };

function makeRepo(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ki-inc-test-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['add', '.'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  return dir;
}

function commitChange(repoDir: string, msg: string): void {
  execFileSync('git', ['add', '-A'], { cwd: repoDir });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: repoDir, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
}

/** 构造一个 chunk 必然 >1 的大文件内容 */
function bigContent(prefix: string, repeat = 200): string {
  const sentence = `${prefix}：这是用于切分的测试内容。句子A。句子B。句子C。句子D。句子E。`;
  return '# 大文件\n\n' + sentence.repeat(repeat);
}

/** 构造短内容（必然 1 chunk） */
function shortContent(prefix: string): string {
  return `# ${prefix} v2\n\n短内容`;
}

function getCache(scope: string): any {
  const { getRelationsCachePath } = require('../src/lib/scope.js');
  const p = getRelationsCachePath(scope);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function getTexts(scope: string): string[] {
  const cache = getCache(scope);
  return Object.values(cache.groups).flatMap((g: any) => g.hot_relations.map((r: any) => r.text));
}

// 用一个固定 scope 前缀，每个用例独立 scope
const scope = `inc-direct-${Date.now()}`;
let repoDir: string;

describe('incremental-direct 增量直连', () => {
  before(async () => {
    registerTestScope(scope);
    const { ensureScopeDir } = await import('../src/lib/store.js');
    ensureScopeDir(scope);
  });

  after(() => {
    cleanupTestConfig();
    if (repoDir && fs.existsSync(repoDir)) fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('chunk 数不变：modified 后新 chunk 更新 memoryId 且保留', SKIP, async () => {
    repoDir = makeRepo({ 'a.md': bigContent('v1') });
    const full = runImport(scope, repoDir, 'wiki');
    assert.strictEqual(full.ok, true, `full 导入应成功: ${JSON.stringify(full)}`);
    const beforeCount = getTexts(scope).length;
    assert.ok(beforeCount >= 2, `v1 大文件应切出 ≥2 chunk，实际 ${beforeCount}`);

    // modified：内容更新但长度相当（chunk 数不变）
    fs.writeFileSync(path.join(repoDir, 'a.md'), bigContent('v2'));
    commitChange(repoDir, 'v2');

    const inc = runImport(scope, repoDir, 'wiki', 'incremental');
    assert.strictEqual(inc.ok, true, `incremental 应成功: ${JSON.stringify(inc)}`);
    assert.strictEqual(inc.stats.modified, 1);
    assert.strictEqual(inc.stats.errors, 0);

    // 回归断言：修改后 relations-cache 不应为空（P0：误删新 chunk）
    const afterTexts = getTexts(scope);
    assert.ok(afterTexts.length >= 2, `modified 后 chunk 数不应减少到 <2，实际 ${JSON.stringify(afterTexts)}`);
    assert.ok(afterTexts.some((t) => t.startsWith('a-')), `应有 a-N chunk，实际 ${JSON.stringify(afterTexts)}`);
  });

  it('chunk 数减少：多余旧 chunk 被删、新 chunk 保留', SKIP, async () => {
    const scope2 = `inc-direct-${Date.now()}-b`;
    registerTestScope(scope2);
    const { ensureScopeDir } = await import('../src/lib/store.js');
    ensureScopeDir(scope2);
    const repo = makeRepo({ 'a.md': bigContent('v1') });

    try {
      const full = runImport(scope2, repo, 'wiki');
      assert.ok(full.ok);
      const beforeTexts = getTexts(scope2);
      assert.ok(beforeTexts.length >= 2);

      // modified：缩成短内容（必然 1 chunk）
      fs.writeFileSync(path.join(repo, 'a.md'), shortContent('a'));
      commitChange(repo, 'v2');

      const inc = runImport(scope2, repo, 'wiki', 'incremental');
      assert.strictEqual(inc.ok, true);
      assert.strictEqual(inc.stats.modified, 1);
      assert.strictEqual(inc.stats.errors, 0);

      const afterTexts = getTexts(scope2);
      // 只剩 1 个 chunk（a-01），且旧 a-02 等已删
      assert.strictEqual(afterTexts.length, 1, `缩短后应只剩 1 chunk，实际 ${JSON.stringify(afterTexts)}`);
      assert.ok(afterTexts[0].startsWith('a-01'), `应保留 a-01，实际 ${JSON.stringify(afterTexts)}`);
    } finally {
      if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('add/delete 文件级处理正确', SKIP, async () => {
    const scope3 = `inc-direct-${Date.now()}-c`;
    registerTestScope(scope3);
    const { ensureScopeDir } = await import('../src/lib/store.js');
    ensureScopeDir(scope3);
    const repo = makeRepo({
      'keep.md': '# keep\n内容',
      'gone.md': '# gone\n内容',
    });

    try {
      const full = runImport(scope3, repo, 'wiki');
      assert.ok(full.ok);
      assert.ok(getTexts(scope3).some((t) => t === 'keep-01'));
      assert.ok(getTexts(scope3).some((t) => t === 'gone-01'));

      // add new.md + delete gone.md
      fs.writeFileSync(path.join(repo, 'new.md'), '# new\n内容');
      fs.unlinkSync(path.join(repo, 'gone.md'));
      commitChange(repo, 'v2');

      const inc = runImport(scope3, repo, 'wiki', 'incremental');
      assert.strictEqual(inc.ok, true);
      assert.strictEqual(inc.stats.added, 1);
      assert.strictEqual(inc.stats.deleted, 1);
      assert.strictEqual(inc.stats.errors, 0);

      const texts = getTexts(scope3);
      assert.ok(texts.some((t) => t === 'keep-01'), 'keep.md 应保留');
      assert.ok(texts.some((t) => t === 'new-01'), 'new.md 应新增');
      assert.ok(!texts.some((t) => t === 'gone-01'), 'gone.md 应删除');
    } finally {
      if (fs.existsSync(repo)) fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});

// ─── 辅助：运行 import ───

function runImport(scope: string, sourceDir: string, rootName: string, mode = 'full'): any {
  const args = [
    'jiti', 'src/scan-kb.ts', 'import',
    '--scope', scope,
    '--source', sourceDir,
    '--root-name', rootName,
    ...(mode === 'incremental' ? ['--mode', 'incremental'] : []),
  ];
  const stdout = execFileSync('npx', args, {
    cwd: path.resolve(import.meta.dirname, '..'),
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
    env: getTestEnv(),
  });
  return JSON.parse(stdout);
}
