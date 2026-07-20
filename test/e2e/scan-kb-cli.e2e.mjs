// scan-kb CLI 端到端：full → diff → incremental（用 mock-mem 隔离向量化）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const MOCK_MEM = path.join(__dirname, '..', 'fixtures', 'mock-mem.mjs');

// 创建临时目录，将 mock-mem.mjs 复制为 mem 命令
const MOCK_BIN_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mock-mem-bin-'));
fs.copyFileSync(MOCK_MEM, path.join(MOCK_BIN_DIR, 'mem'));
fs.chmodSync(path.join(MOCK_BIN_DIR, 'mem'), 0o755);

// 保存原始 PATH 并在测试前添加 mock 目录
const ORIGINAL_PATH = process.env.PATH;
process.env.PATH = `${MOCK_BIN_DIR}:${ORIGINAL_PATH}`;

// 2) 真实仓库 fixture
const GIT_ENV = ' -c user.email=t@t -c user.name=t -c commit.gpgsign=false ';
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-kb-'));
  fs.writeFileSync(path.join(dir, 'a.md'), '# A v1');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.md'), '# B v1');
  execSync('git init -q', { cwd: dir });
  execSync(`git${GIT_ENV}add . && git${GIT_ENV}commit -q -m init`, { cwd: dir, shell: '/bin/bash' });
  return dir;
}

import { getKbDir } from '../../scripts/lib/scope.ts';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCAN_KB = path.join(PROJECT_ROOT, 'knowledge-index', 'scripts', 'scan-kb.ts');
const TEST_SCOPE = 'cli-e2e-' + Date.now();

function cleanup() {
  const dir = getKbDir(TEST_SCOPE);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function runCli(args, opts = {}) {
  return execSync(`npx jiti ${SCAN_KB} ${args}`, {
    cwd: PROJECT_ROOT,
    encoding: 'utf-8',
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function parseLastJson(stdout) {
  // 取末尾 JSON 块（jiti 可能有 warning 前缀）
  const trimmed = stdout.trim();
  // 找最后一个 '{' 起始位置（最外层）
  const firstBrace = trimmed.indexOf('{');
  return JSON.parse(trimmed.slice(firstBrace));
}

test('CLI E2E: import full → diff (no change) → incremental', () => {
  cleanup();
  const sourceDir = makeRepo();

  // ── Step 1: 首次 import ──
  const fullAi = path.join(os.tmpdir(), `full-${Date.now()}.json`);
  fs.writeFileSync(fullAi, JSON.stringify({
    meta: { sourceDir, rootName: 'wiki' },
    entries: [
      { path: 'a.md', groupPath: 'wiki', summary: 'A v1', keywords: ['a'] },
      { path: 'sub/b.md', groupPath: 'wiki/sub', summary: 'B v1', keywords: ['b'] },
    ],
  }));
  const fullOut = runCli(`import --scope ${TEST_SCOPE} --results ${fullAi}`);
  const full = parseLastJson(fullOut);
  assert.equal(full.ok, true);
  assert.equal(full.mode, 'full');
  assert.equal(full.stats.vectorized, 2);
  assert.match(full.source.commit, /^[0-9a-f]{40}$/);

  // ── Step 2: diff（无变更）──
  const diffOut = runCli(`diff --scope ${TEST_SCOPE}`);
  const diff = parseLastJson(diffOut);
  assert.equal(diff.ok, true);
  assert.equal(diff.action, 'diff');
  assert.equal(diff.stats.total, 0);

  // ── Step 3: 改文件 + commit ──
  fs.writeFileSync(path.join(sourceDir, 'a.md'), '# A v2');
  fs.writeFileSync(path.join(sourceDir, 'c.md'), '# C 新文件');
  fs.unlinkSync(path.join(sourceDir, 'sub', 'b.md'));
  execSync(`git${GIT_ENV}add -A && git${GIT_ENV}commit -q -m v2`, { cwd: sourceDir, shell: '/bin/bash' });

  // ── Step 4: diff（应有变更，且 modify/delete 关联到 memoryId）──
  const diff2Out = runCli(`diff --scope ${TEST_SCOPE}`);
  const diff2 = parseLastJson(diff2Out);
  assert.equal(diff2.stats.added, 1);
  assert.equal(diff2.stats.modified, 1);
  assert.equal(diff2.stats.deleted, 1);
  assert.match(diff2.modified[0].memoryId, /^[0-9a-f]{16}$/, 'modified 应关联 memoryId');
  assert.match(diff2.deleted[0].memoryId, /^[0-9a-f]{16}$/, 'deleted 应关联 memoryId');

  // ── Step 5: 用 diff 输出构造增量 ai-results 并 import --mode incremental ──
  const incAi = path.join(os.tmpdir(), `inc-${Date.now()}.json`);
  fs.writeFileSync(incAi, JSON.stringify({
    meta: { sourceDir, rootName: 'wiki' },
    entries: [
      { path: 'c.md', groupPath: 'wiki', summary: 'C', keywords: ['c'], action: 'add' },
      { path: 'a.md', groupPath: 'wiki', summary: 'A v2', keywords: ['a', 'v2'], memoryId: diff2.modified[0].memoryId, action: 'modify' },
      { path: 'sub/b.md', groupPath: 'wiki/sub', summary: '', keywords: [], memoryId: diff2.deleted[0].memoryId, action: 'delete' },
    ],
  }));
  const incOut = runCli(`import --scope ${TEST_SCOPE} --mode incremental --results ${incAi}`);
  const inc = parseLastJson(incOut);
  assert.equal(inc.mode, 'incremental');
  assert.equal(inc.stats.added, 1);
  assert.equal(inc.stats.modified, 1);
  assert.equal(inc.stats.deleted, 1);
  assert.equal(inc.stats.errors, 0, JSON.stringify(inc.errors));
  assert.notEqual(inc.previousCommit, inc.newCommit);

  // ── Step 6: 第二次 diff 应再次回到 0 变更 ──
  const diff3Out = runCli(`diff --scope ${TEST_SCOPE}`);
  const diff3 = parseLastJson(diff3Out);
  assert.equal(diff3.stats.total, 0);

  cleanup();
  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.unlinkSync(fullAi);
  fs.unlinkSync(incAi);
});

test('CLI E2E: 首次未导入时 diff 提示 first_import', () => {
  cleanup();
  const out = runCli(`diff --scope ${TEST_SCOPE}`);
  const result = parseLastJson(out);
  assert.equal(result.ok, true);
  assert.equal(result.status, 'first_import');
  assert.match(result.hint, /scan-kb import/);
  cleanup();
});
