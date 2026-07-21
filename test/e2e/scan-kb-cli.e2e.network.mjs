/**
 * scan-kb-cli.e2e.network.mjs —— scan-kb import/diff 管线真实端到端验收（黑盒）
 *
 * 被测对象（"当前代码"）：ki scan-kb import / diff CLI
 *   → bin/ki.mjs → src/scan-kb.ts
 *   → src/lib/{import,incremental,diff,batch-vectorize,path-vectorize,vector-client}.ts
 *   → dist/zvec-engine（真实 SiliconFlow embedding + 真实 zvec worker）
 * 与 step-c-cli.e2e.network.mjs / kisearch-cli.e2e.network.mjs 互补：本文件覆盖
 * 外部知识库导入的"全量 import → diff → 增量 import（add/modify/delete）"闭环。
 *
 * requirement_ref：MIGRATION_P3_MEM_TO_ZVEC（向量化管线 mem → zvec Vector Adapter）。
 *   断言只对照对外契约（CLI 入参 → JSON 输出与副作用），不依赖内部实现。
 *   重点回归：全量 import 必须把真实 docId 持久化到 relations-cache，使后续
 *   diff → 增量 modify/delete 能关联旧向量（docId 是 zvec 删除向量的唯一钥匙）。
 *
 * 覆盖旅程（共享 Context 串联；顺序敏感）：
 *   setup       : 载入 .env.e2e → 临时 dataDir + vectorDir + config.json（隔离，不污染 ~/.ki）
 *                 + 一个 git 仓库 fixture 作为外部知识库 sourceDir
 *   E2E-1 full  : import full → ok + mode:full + stats.vectorized=2 + source.commit(40-hex)
 *   E2E-2 recall: search → 语义召回全量向量化写入的模块（证明真实 zvec 写入）
 *   E2E-3 diff0 : diff（无变更）→ stats.total=0
 *   E2E-4 diffN : 改 a.md + 增 c.md + 删 b.md + commit → diff → added/modified/deleted 各 1
 *                 且 modified/deleted 关联到 docId（32-hex）← 全量 import 持久化 docId 的回归点
 *   E2E-5 inc   : 用 diff 输出构造增量 ai-results → import --mode incremental
 *                 → mode:incremental + added=1 + modified=1 + deleted=1 + errors=0
 *   E2E-6 verify: 删除项的旧向量应被清理（search 不再召回）；再 diff → total=0
 *   teardown    : 删除临时目录
 *
 * 安全：源码零秘钥。凭证从 .env.e2e（回退 .env / 进程环境）读取；缺 apiKey 整套跳过。
 * 运行：
 *   cp .env.e2e.example .env.e2e  # 填入 SILICONFLOW_API_KEY
 *   node --test test/e2e/scan-kb-cli.e2e.network.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KI_BIN = path.join(REPO_ROOT, 'bin', 'ki.mjs');

// ─── 载入 .env.e2e（回退 .env）：仅补齐进程环境中尚未设置的键（shell export 优先） ───

function loadEnvFile() {
  const candidates = [path.join(REPO_ROOT, '.env.e2e'), path.join(REPO_ROOT, '.env')];
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) return;
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    const val = s.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvFile();

const API_KEY = process.env.GITNEXUS_EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY;
const RUN = Boolean(API_KEY);
const SKIP = RUN ? {} : { skip: '缺少 embedding apiKey（SILICONFLOW_API_KEY / GITNEXUS_EMBEDDING_API_KEY），跳过真实联网 CLI e2e' };
if (!RUN) console.warn('[E2E-scan-kb] 未检测到 apiKey，整套真实联网 CLI 用例已跳过（CI 安全）。');

/** SiliconFlow OpenAI 兼容端点为 <base>/v1/embeddings；裸 base 补 /v1，已含 /vN 则保留 */
function resolveBaseURL(raw) {
  if (!raw) return 'https://api.siliconflow.cn/v1';
  const t = raw.replace(/\/+$/, '');
  return /\/v\d+$/i.test(t) ? t : `${t}/v1`;
}

// ─── 共享 Context ───

const PID = process.pid;
const SCOPE = `e2e-scankb-${PID}`;
const ROOT_NAME = 'wiki';

const DOC_ID_RE = /^[0-9a-f]{32}$/; // vector-client: sha256(text+scope).slice(0,32)

const ctx = { tmpBase: null, dataDir: null, vectorDir: null, configPath: null, sourceDir: null };

// git fixture 工具（关闭 gpg 签名，固定身份，保证可复现）
const GIT_ENV = ' -c user.email=t@t -c user.name=t -c commit.gpgsign=false ';

/** 调用 ki CLI：node bin/ki.mjs <args> --config <tmp>；解析 stdout 中的 JSON（若有） */
function ki(args, timeout = 180_000) {
  const childEnv = { ...process.env };
  if (API_KEY && !childEnv.SILICONFLOW_API_KEY) childEnv.SILICONFLOW_API_KEY = API_KEY;
  const res = spawnSync('node', [KI_BIN, ...args, '--config', ctx.configPath], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: 'utf-8',
    timeout,
  });
  const stdout = res.stdout ?? '';
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  let json = null;
  if (first >= 0 && last > first) {
    try { json = JSON.parse(stdout.slice(first, last + 1)); } catch { /* 落到断言暴露 */ }
  }
  return { status: res.status, stdout, stderr: res.stderr ?? '', json };
}

function writeJsonFile(name, data) {
  const p = path.join(ctx.tmpBase, name);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  return p;
}

// ─── setup / teardown ───

before(() => {
  if (!RUN) return;
  // realpathSync 规范化：macOS os.tmpdir() 为 /var/folders/...（软链到 /private/var/...），
  // 而 git rev-parse --show-toplevel 返回真实路径；不规范化会导致 diff 的 path.relative 越界。
  ctx.tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ki-scankb-e2e-${PID}-`)));
  ctx.dataDir = path.join(ctx.tmpBase, 'kb');
  ctx.vectorDir = path.join(ctx.tmpBase, 'vector'); // 首次向量写入时由引擎创建

  // 外部知识库 git fixture
  ctx.sourceDir = path.join(ctx.tmpBase, 'source');
  fs.mkdirSync(path.join(ctx.sourceDir, 'sub'), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.sourceDir, 'a.md'),
    '# AES 加密工具\n\nAES 是一种对称加密算法，使用相同密钥进行加密和解密，常用于数据保护与传输安全。'
  );
  fs.writeFileSync(
    path.join(ctx.sourceDir, 'sub', 'b.md'),
    '# 季度对账流程\n\n季度财务报表的结算流程与对账科目明细，涵盖应收应付的核销与差异调整。'
  );
  execSync('git init -q', { cwd: ctx.sourceDir });
  execSync(`git${GIT_ENV}add . && git${GIT_ENV}commit -q -m init`, { cwd: ctx.sourceDir, shell: '/bin/bash' });

  const config = {
    dataDir: ctx.dataDir,
    vectorDir: ctx.vectorDir,
    embedding: {
      provider: 'siliconflow',
      baseURL: resolveBaseURL(process.env.GITNEXUS_EMBEDDING_URL),
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
    },
    scopes: { [SCOPE]: {} }, // 注册 scope，ensureScopeDir 会从 _template 自动初始化
  };
  ctx.configPath = path.join(ctx.tmpBase, 'config.json');
  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2));
  console.log(`  [setup] dataDir=${ctx.dataDir}
  [setup] sourceDir=${ctx.sourceDir}
  [setup] config=${ctx.configPath}`);
});

after(() => {
  if (ctx.tmpBase && fs.existsSync(ctx.tmpBase)) {
    fs.rmSync(ctx.tmpBase, { recursive: true, force: true });
    console.log(`  [teardown] 已清理临时目录 ${ctx.tmpBase}`);
  }
});

// ─── 旅程 ───

test('E2E-1 full: import full → ok + mode:full + vectorized=2 + source.commit(40-hex)', { ...SKIP, timeout: 180_000 }, () => {
  const full = writeJsonFile('full.json', {
    meta: { sourceDir: ctx.sourceDir, rootName: ROOT_NAME },
    entries: [
      { path: 'a.md', groupPath: `${ROOT_NAME}/工具库`, relation: 'AES 加密工具', summary: 'AES 对称加密算法用于数据保护与传输安全', keywords: ['AES', '加密'] },
      { path: 'sub/b.md', groupPath: `${ROOT_NAME}/财务`, relation: '季度对账流程', summary: '季度财务报表结算与对账科目明细', keywords: ['财务', '对账'] },
    ],
  });
  const r = ki(['scan-kb', 'import', '--scope', SCOPE, '--results', full]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.equal(r.json?.ok, true, `import 应成功；实际=${JSON.stringify(r.json)}`);
  assert.equal(r.json.mode, 'full', `应为全量模式；实际=${JSON.stringify(r.json)}`);
  assert.equal(r.json.stats.vectorized, 2, `应向量化 2 条；实际=${JSON.stringify(r.json.stats)}`);
  assert.match(r.json.source.commit, /^[0-9a-f]{40}$/, `source.commit 应为 git HEAD；实际=${r.json.source?.commit}`);
  console.log(`  ✓ full import：vectorized=${r.json.stats.vectorized} commit=${r.json.source.commit.slice(0, 8)}`);
});

test('E2E-2 recall: search → 语义召回全量向量化写入的模块（证明真实 zvec 写入）', { ...SKIP, timeout: 180_000 }, () => {
  const r = ki(['search', '--scope', SCOPE, '--query', '对称加密算法如何保护数据安全']);
  assert.equal(r.json?.ok, true, `search 应成功；${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json.results) && r.json.results.length > 0, `应召回结果；实际=${JSON.stringify(r.json.results)}`);
  const hit = r.json.results.some((x) => (x.content ?? '').includes('对称加密'));
  assert.ok(hit, `语义召回应命中全量写入的 ki-search 向量；实际=${JSON.stringify(r.json.results.map((x) => x.content?.slice(0, 40)))}`);
  console.log(`  ✓ recall 命中全量向量；返回 ${r.json.results.length} 条`);
});

test('E2E-3 diff0: diff（无变更）→ stats.total=0', { ...SKIP, timeout: 120_000 }, () => {
  const r = ki(['scan-kb', 'diff', '--scope', SCOPE]);
  assert.equal(r.json?.ok, true, `diff 应成功；${JSON.stringify(r.json)}`);
  assert.equal(r.json.action, 'diff');
  assert.equal(r.json.stats.total, 0, `无变更时 total 应为 0；实际=${JSON.stringify(r.json.stats)}`);
  console.log('  ✓ diff（无变更）total=0');
});

test('E2E-4 diffN: 改/增/删 + commit → diff 各 1，且 modified/deleted 关联 docId（回归点）', { ...SKIP, timeout: 120_000 }, () => {
  // 改 a.md、增 c.md、删 sub/b.md，然后 commit
  fs.writeFileSync(path.join(ctx.sourceDir, 'a.md'), '# AES 加密工具 v2\n\nAES-GCM 模式在对称加密基础上额外提供完整性校验。');
  fs.writeFileSync(path.join(ctx.sourceDir, 'c.md'), '# RSA 非对称加密\n\nRSA 使用公钥加密、私钥解密，常用于密钥交换与数字签名。');
  fs.unlinkSync(path.join(ctx.sourceDir, 'sub', 'b.md'));
  execSync(`git${GIT_ENV}add -A && git${GIT_ENV}commit -q -m v2`, { cwd: ctx.sourceDir, shell: '/bin/bash' });

  const r = ki(['scan-kb', 'diff', '--scope', SCOPE]);
  assert.equal(r.json?.ok, true, `diff 应成功；${JSON.stringify(r.json)}`);
  assert.equal(r.json.stats.added, 1, `added 应为 1；实际=${JSON.stringify(r.json.stats)}`);
  assert.equal(r.json.stats.modified, 1, `modified 应为 1；实际=${JSON.stringify(r.json.stats)}`);
  assert.equal(r.json.stats.deleted, 1, `deleted 应为 1；实际=${JSON.stringify(r.json.stats)}`);
  // 关键回归：全量 import 已持久化真实 docId，diff 应能为 modified/deleted 关联 docId
  assert.match(r.json.modified[0].memoryId ?? '', DOC_ID_RE, `modified 应关联 docId（全量 import 持久化回归）；实际=${JSON.stringify(r.json.modified)}`);
  assert.match(r.json.deleted[0].memoryId ?? '', DOC_ID_RE, `deleted 应关联 docId（全量 import 持久化回归）；实际=${JSON.stringify(r.json.deleted)}`);
  // 暂存到 ctx 供 E2E-5 构造增量
  ctx._diff = r.json;
  console.log(`  ✓ diff：+${r.json.stats.added}/~${r.json.stats.modified}/-${r.json.stats.deleted}；modified.docId=${r.json.modified[0].memoryId.slice(0, 12)}…`);
});

test('E2E-5 inc: 用 diff 输出构造增量 → import --mode incremental → add/modify/delete 各 1，errors=0', { ...SKIP, timeout: 180_000 }, () => {
  const diff = ctx._diff;
  assert.ok(diff, 'E2E-4 应已产出 diff 结果');
  const inc = writeJsonFile('inc.json', {
    meta: { sourceDir: ctx.sourceDir, rootName: ROOT_NAME },
    entries: [
      { path: 'c.md', groupPath: `${ROOT_NAME}/工具库`, relation: 'RSA 非对称加密', summary: 'RSA 非对称加密用于密钥交换与数字签名', keywords: ['RSA', '非对称加密'], action: 'add' },
      { path: 'a.md', groupPath: `${ROOT_NAME}/工具库`, relation: 'AES 加密工具', summary: 'AES-GCM 在对称加密上额外提供完整性校验', keywords: ['AES', 'GCM', '完整性'], memoryId: diff.modified[0].memoryId, action: 'modify' },
      { path: 'sub/b.md', groupPath: `${ROOT_NAME}/财务`, relation: '季度对账流程', summary: '', keywords: [], memoryId: diff.deleted[0].memoryId, action: 'delete' },
    ],
  });
  const r = ki(['scan-kb', 'import', '--scope', SCOPE, '--mode', 'incremental', '--results', inc]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.equal(r.json?.ok, true, `增量 import 应成功；${JSON.stringify(r.json)}`);
  assert.equal(r.json.mode, 'incremental');
  assert.equal(r.json.stats.added, 1, `added 应为 1；实际=${JSON.stringify(r.json.stats)}`);
  assert.equal(r.json.stats.modified, 1, `modified 应为 1；实际=${JSON.stringify(r.json.stats)}`);
  assert.equal(r.json.stats.deleted, 1, `deleted 应为 1；实际=${JSON.stringify(r.json.stats)}`);
  assert.equal(r.json.stats.errors, 0, `不应有错误；errors=${JSON.stringify(r.json.errors)}`);
  assert.notEqual(r.json.previousCommit, r.json.newCommit, 'source.commit 应推进到新 HEAD');
  console.log(`  ✓ incremental：+${r.json.stats.added}/~${r.json.stats.modified}/-${r.json.stats.deleted} errors=0`);
});

test('E2E-6 verify: 删除项旧向量被清理（search 不再召回）；再 diff → total=0', { ...SKIP, timeout: 180_000 }, () => {
  // 删除的 b.md（季度对账）不应再被召回
  const rDel = ki(['search', '--scope', SCOPE, '--query', '季度财务报表结算与对账科目明细']);
  assert.equal(rDel.json?.ok, true, `search 应成功；${JSON.stringify(rDel.json)}`);
  const stillHit = (rDel.json.results ?? []).some((x) => (x.content ?? '').includes('对账科目'));
  assert.equal(stillHit, false, `删除项旧向量应被清理，不应再召回；results=${JSON.stringify((rDel.json.results ?? []).map((x) => x.content?.slice(0, 30)))}`);

  // 新增的 RSA 应可被召回（证明增量 add 写入成功）
  const rAdd = ki(['search', '--scope', SCOPE, '--query', '公钥加密私钥解密用于密钥交换']);
  assert.equal(rAdd.json?.ok, true);
  const rsaHit = (rAdd.json.results ?? []).some((x) => (x.content ?? '').includes('非对称') || (x.content ?? '').includes('RSA'));
  assert.ok(rsaHit, `增量 add 的 RSA 向量应可召回；results=${JSON.stringify((rAdd.json.results ?? []).map((x) => x.content?.slice(0, 30)))}`);

  // 增量后 commit 已推进，diff 应回到 0 变更
  const rDiff = ki(['scan-kb', 'diff', '--scope', SCOPE]);
  assert.equal(rDiff.json?.ok, true);
  assert.equal(rDiff.json.stats.total, 0, `增量后 diff 应回到 total=0；实际=${JSON.stringify(rDiff.json.stats)}`);
  console.log('  ✓ verify：删除项已清理、RSA 可召回、diff 归零');
});
