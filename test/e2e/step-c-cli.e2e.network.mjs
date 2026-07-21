/**
 * step-c-cli.e2e.network.mjs —— Step C 迁移命令真实端到端验收（黑盒）
 *
 * 被测对象（"当前代码"）：ki sync-relation / query-group / get-module-info / manage-index 四条 CLI
 *   → bin/ki.mjs → src/{sync-relation,query-group,get-module-info,manage-index}.ts
 *   → src/lib/{vector-client,path-search,path-vectorize,group-resolve}.ts
 *   → dist/zvec-engine（真实 SiliconFlow embedding + 真实 zvec worker）
 * 与 kisearch-cli.e2e.network.mjs 互补：后者覆盖 store/bulk_store/search，本文件覆盖
 * Step C 迁移的关系回写 / 分组查询 / 原文读取 / 级联删除四条链路。
 *
 * requirement_ref：MIGRATION_STEP_C_MEM_TO_ZVEC（mem → zvec Vector Adapter）。
 *   断言只对照对外契约（入参 → CLI JSON/文本 输出与副作用），不依赖代码内部实现。
 *
 * 覆盖旅程（共享 Context 串联；顺序敏感）：
 *   setup            : 载入 .env.e2e → 临时 dataDir + vectorDir + config.json（隔离，不污染 ~/.ki）
 *                      + in-process initScope 初始化 scope A / B 的 group-index / relations-cache
 *   E2E-1 sync       : sync-relation 写入 A（cache + 本地 KB + 一次 vectorBulkStore 批量 2 条）→ ok + vectorPending:false
 *   E2E-2 query      : query-group A → 输出包含刚写入的 Group 路径
 *   E2E-3 module     : get-module-info A → 原文回读（本地 KB）
 *   E2E-4 recall     : search A（ki-search）→ 语义召回 sync 写入的模块信息（证明向量写入成功）
 *   E2E-5 scope-iso  : sync 写入 B 私有内容；A 查不到 B 私有；B 能查到（scope 隔离）
 *   E2E-6 cascade    : manage-index 删 Group A --force → cascade.memDeleted≥1；再 search A → 0 条（向量被清理）
 *   teardown         : 删除临时目录
 *
 * 安全：源码零秘钥。所有凭证从 .env.e2e（回退 .env / 进程环境）读取；缺 apiKey 整套跳过。
 * 运行：
 *   cp .env.e2e.example .env.e2e  # 填入 SILICONFLOW_API_KEY
 *   node --test test/e2e/step-c-cli.e2e.network.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
if (!RUN) console.warn('[E2E-StepC] 未检测到 apiKey，整套真实联网 CLI 用例已跳过（CI 安全）。');

/** SiliconFlow OpenAI 兼容端点为 <base>/v1/embeddings；裸 base 补 /v1，已含 /vN 则保留 */
function resolveBaseURL(raw) {
  if (!raw) return 'https://api.siliconflow.cn/v1';
  const t = raw.replace(/\/+$/, '');
  return /\/v\d+$/i.test(t) ? t : `${t}/v1`;
}

// ─── 共享 Context ───

const PID = process.pid;
const SCOPE_A = `e2e-stepc-a-${PID}`;
const SCOPE_B = `e2e-stepc-b-${PID}`;

const GROUP_A = '工具库/加密';
const REL_A = 'AES 加密工具';
const MODULE_A = [
  '# AES 加密工具',
  '',
  'AES 是一种对称加密算法，使用相同密钥进行加密和解密，常用于数据保护与传输安全。',
  '常见工作模式包括 CBC 与 GCM，其中 GCM 额外提供完整性校验。',
].join('\n');
const KEYWORDS_A = 'AES,加密';
// 用于语义召回的查询（与 MODULE_A 语义相近，但非逐字复制）
const QUERY_A = '对称加密算法如何保护数据安全';

const GROUP_B = '财务';
const REL_B = '季度对账流程';
const MODULE_B = '季度财务报表的结算流程与对账科目明细，涵盖应收应付的核销与差异调整。';
const KEYWORDS_B = '财务,对账';
const QUERY_B = '季度财务报表结算与对账科目明细';

const ctx = { tmpBase: null, dataDir: null, vectorDir: null, configPath: null };

/** 调用 ki CLI：node bin/ki.mjs <args> --config <tmp>；解析 stdout 中的 JSON（若有） */
function ki(args, timeout = 120_000) {
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

function syncRelation(scope, group, relation, moduleInfo, keywords) {
  return ki([
    'sync-relation',
    '--scope', scope,
    '--group', group,
    '--relation', relation,
    '--module-info', moduleInfo,
    '--keywords', keywords,
  ]);
}
function search(scope, query, extra = []) {
  return ki(['search', '--scope', scope, '--query', query, ...extra]);
}

/**
 * 纯 JS 复刻 scripts/lib/store.ts initScope：从 _template 拷贝 group-index / relations-cache
 * 到 dataDir/scope/ 并回填 scope 与 updatedAt（避免在 .mjs 中直接 import .ts）。
 */
function initScopeFiles(scope) {
  const scopeDir = path.join(ctx.dataDir, scope);
  fs.mkdirSync(scopeDir, { recursive: true });
  const templateDir = path.join(REPO_ROOT, '_template');
  for (const name of ['group-index.json', 'relations-cache.json']) {
    const tpl = path.join(templateDir, name);
    if (!fs.existsSync(tpl)) throw new Error(`模板缺失：${tpl}`);
    const data = JSON.parse(fs.readFileSync(tpl, 'utf-8'));
    data.scope = scope;
    data.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(scopeDir, name), JSON.stringify(data, null, 2), 'utf-8');
  }
}

// ─── setup / teardown ───

before(async () => {
  if (!RUN) return;
  ctx.tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `ki-stepc-e2e-${PID}-`));
  ctx.dataDir = path.join(ctx.tmpBase, 'kb');
  ctx.vectorDir = path.join(ctx.tmpBase, 'vector'); // 首次向量写入时由引擎创建
  const config = {
    dataDir: ctx.dataDir,
    vectorDir: ctx.vectorDir,
    embedding: {
      provider: 'siliconflow',
      baseURL: resolveBaseURL(process.env.GITNEXUS_EMBEDDING_URL),
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
    },
    scopes: { [SCOPE_A]: {}, [SCOPE_B]: {} },
  };
  ctx.configPath = path.join(ctx.tmpBase, 'config.json');
  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2));

  // 初始化 scope（纯文件操作，从 _template 拷贝，与 initScope 等价）
  initScopeFiles(SCOPE_A);
  initScopeFiles(SCOPE_B);
  console.log(`  [setup] dataDir=${ctx.dataDir}
  [setup] vectorDir=${ctx.vectorDir}
  [setup] config=${ctx.configPath}`);
});

after(() => {
  if (ctx.tmpBase && fs.existsSync(ctx.tmpBase)) {
    fs.rmSync(ctx.tmpBase, { recursive: true, force: true });
    console.log(`  [teardown] 已清理临时目录 ${ctx.tmpBase}`);
  }
});

// ─── 旅程 ───

test('E2E-1 sync: sync-relation 写入 A → ok + vectorPending:false（await 完成向量写入）', { ...SKIP, timeout: 120_000 }, () => {
  const r = syncRelation(SCOPE_A, GROUP_A, REL_A, MODULE_A, KEYWORDS_A);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}`);
  assert.ok(r.json, `stdout 应含可解析 JSON；实际=${r.stdout}`);
  assert.equal(r.json.ok, true, `sync 应成功；实际=${JSON.stringify(r.json)}`);
  assert.equal(r.json.vectorPending, false, `迁移后向量写入应 await 完成（vectorPending:false）；实际=${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json.keywords) && r.json.keywords.length > 0, `应有有效关键词；实际=${JSON.stringify(r.json.keywords)}`);
  console.log(`  ✓ sync A → keywords=${JSON.stringify(r.json.keywords)} vectorPending=${r.json.vectorPending}`);
});

test('E2E-2 query: query-group A（full 树）→ 输出包含刚写入的 Group', { ...SKIP, timeout: 120_000 }, () => {
  const r = ki(['query-group', '--scope', SCOPE_A, '--mode', 'full']);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('加密'), `query-group full 树应包含 Group "加密"；实际=${r.stdout}`);
  console.log('  ✓ query-group full 树含 Group "加密"');
});

test('E2E-3 module: get-module-info A → 回读本地 KB 原文', { ...SKIP, timeout: 120_000 }, () => {
  const r = ki(['get-module-info', '--scope', SCOPE_A, '--group', GROUP_A, '--relation', REL_A]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}`);
  assert.ok(r.stdout.includes('对称加密算法'), `get-module-info 应回读原文（含"对称加密算法"）；实际=${r.stdout}`);
  console.log('  ✓ get-module-info 回读原文成功');
});

test('E2E-4 recall: search A（ki-search）→ 语义召回 sync 写入的模块信息', { ...SKIP, timeout: 120_000 }, () => {
  const r = search(SCOPE_A, QUERY_A);
  assert.equal(r.json?.ok, true, `search 应成功；${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json.results) && r.json.results.length > 0, `应召回结果（证明 vectorBulkStore 已写 ki-search 条）；实际=${JSON.stringify(r.json.results)}`);
  const hit = r.json.results.some((x) => (x.content ?? '').includes('对称加密'));
  assert.ok(hit, `语义召回应命中 sync 写入的模块信息；实际=${JSON.stringify(r.json.results.map((x) => x.content?.slice(0, 30)))}`);
  console.log(`  ✓ recall 命中 sync 模块信息；返回 ${r.json.results.length} 条`);
});

test('E2E-5 scope-iso: A 查不到 B 私有内容；B 能查到（scope 隔离）', { ...SKIP, timeout: 120_000 }, () => {
  const rSync = syncRelation(SCOPE_B, GROUP_B, REL_B, MODULE_B, KEYWORDS_B);
  assert.equal(rSync.json?.ok, true, `B 写入应成功；${JSON.stringify(rSync.json)}`);

  const rA = search(SCOPE_A, QUERY_B);
  assert.equal(rA.json?.ok, true);
  const leaked = rA.json.results.some((x) => (x.content ?? '').includes('对账科目'));
  assert.equal(leaked, false, `scope A 不应召回 scope B 的私有内容；results=${JSON.stringify(rA.json.results.map((x) => x.memoryId))}`);

  const rB = search(SCOPE_B, QUERY_B);
  assert.equal(rB.json?.ok, true);
  const foundInB = rB.json.results.some((x) => (x.content ?? '').includes('对账科目'));
  assert.equal(foundInB, true, `scope B 应能召回自己的私有内容；results=${JSON.stringify(rB.json.results)}`);
  console.log('  ✓ scope 隔离：A 无泄漏，B 可召回');
});

test('E2E-6 cascade: manage-index 删 Group A --force → 向量被清理（cascade.memDeleted≥1 且 search 归零）', { ...SKIP, timeout: 120_000 }, () => {
  const rDel = ki(['manage-index', '--scope', SCOPE_A, '--action', 'delete', '--name', '加密', '--parent', '工具库', '--force']);
  assert.equal(rDel.status, 0, `退出码应为 0；stderr=${rDel.stderr}`);
  assert.equal(rDel.json?.ok, true, `删除应成功；${JSON.stringify(rDel.json)}`);
  assert.ok(rDel.json.cascade, `应返回 cascade 统计；${JSON.stringify(rDel.json)}`);
  assert.ok(rDel.json.cascade.memDeleted >= 1, `级联应删除≥1 条向量（sync 回写的 ki-search docId）；实际=${JSON.stringify(rDel.json.cascade)}`);

  const rAfter = search(SCOPE_A, QUERY_A);
  assert.equal(rAfter.json?.ok, true);
  const stillHit = rAfter.json.results.some((x) => (x.content ?? '').includes('对称加密'));
  assert.equal(stillHit, false, `删除 Group 后 ki-search 向量应被清理，不应再召回；results=${JSON.stringify(rAfter.json.results.map((x) => x.content?.slice(0, 30)))}`);
  console.log(`  ✓ 级联删除：memDeleted=${rDel.json.cascade.memDeleted}，删除后 search 不再命中`);
});
