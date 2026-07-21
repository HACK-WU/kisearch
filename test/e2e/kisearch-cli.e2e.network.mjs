/**
 * kisearch-cli.e2e.network.mjs —— ki CLI 上层链路真实端到端验收（黑盒）
 *
 * 被测对象（"当前代码"）：ki store / bulk_store / search 三条 CLI
 *   → bin/ki.mjs → src/{store,bulk-store,search}.ts → src/lib/vector-client.ts
 *   → dist/zvec-engine（真实 SiliconFlow embedding + 真实 zvec worker）
 * 与已有的 zvec-engine-e2e.network.mjs 互补：后者直接打引擎，本文件走**真实 CLI 进程**，
 * 覆盖 Vector Adapter + 命令层的对外契约。
 *
 * requirement_ref：MIGRATION_STEP_C 前置（Step A：search/store/bulk_store 迁移 zvec）
 *   + requirement §4.4（写入部分失败不静默）。断言只对照对外契约（入参→CLI JSON 输出/副作用），
 *   不依赖代码内部实现。
 *
 * 覆盖旅程（共享 Context 串联；顺序敏感——先写后查）：
 *   setup            : 载入 .env.e2e → 临时 vectorDir + 临时 config.json（隔离，不污染 ~/.ki）
 *   E2E-1 store      : 单条写入 → ok + docId
 *   E2E-2 idempotent : 同 text+scope 再写 → docId 不变（幂等 upsert，S-03 generateDocId）
 *   E2E-3 seed       : 写入 scope A 其余文档 + scope B 私有文档 + ki-relation 标签文档
 *   E2E-4 bulk       : 批量写入 → total/succeeded/failed + 逐项 results（#U4 契约：部分成功可分辨）
 *   E2E-5 recall     : 语义检索召回自身（Recall）
 *   E2E-6 scope-iso  : scope A 查不到 scope B 私有内容；scope B 能查到（scope 隔离）
 *   E2E-7 tag-filter : 默认 tag 查不到 ki-relation 文档；指定 ki-relation 能查到（tag 过滤）
 *   E2E-8 thr-nan    : --threshold 非法值 → 仍返回结果（#U7 回归：不再静默丢光）
 *   E2E-9 thr-high   : --threshold 极大值 → 结果被过滤为空（阈值仍生效）
 *   teardown         : 删除临时 vectorDir + config
 *
 * 安全：源码零秘钥。所有凭证从 .env.e2e（回退 .env / 进程环境）读取；缺 apiKey 整套跳过。
 * 运行：
 *   cp .env.e2e.example .env.e2e  # 填入 SILICONFLOW_API_KEY
 *   node --test test/e2e/kisearch-cli.e2e.network.mjs
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
if (!RUN) console.warn('[E2E-CLI] 未检测到 apiKey，整套真实联网 CLI 用例已跳过（CI 安全）。');

/** SiliconFlow OpenAI 兼容端点为 <base>/v1/embeddings；裸 base 补 /v1，已含 /vN 则保留 */
function resolveBaseURL(raw) {
  if (!raw) return 'https://api.siliconflow.cn/v1';
  const t = raw.replace(/\/+$/, '');
  return /\/v\d+$/i.test(t) ? t : `${t}/v1`;
}

// ─── 共享 Context ───

const PID = process.pid;
const SCOPE_A = `e2e-cli-a-${PID}`;
const SCOPE_B = `e2e-cli-b-${PID}`;
const TAG_SEARCH = 'ki-search';
const TAG_RELATION = 'ki-relation';

const TEXT = {
  a1: '语义检索通过将查询编码为稠密向量，基于余弦相似度召回语义相近的文档，适合自然语言查询。',
  a2: 'Docker 部署时通过挂载数据卷把容器内的数据库文件持久化到宿主机，避免容器重建后数据丢失。',
  aRel: '关系映射：把源文件路径绑定到 memoryId，用于同步 Git 仓库与知识库条目的对应关系。',
  b: '仅属于项目B的私有内容：季度财务报表的结算流程与对账科目明细，不应被项目A检索到。',
};

const ctx = { tmpBase: null, configPath: null, docIdA1: null };

/** 调用 ki CLI：node bin/ki.mjs <args> --config <tmp>，解析 stdout 中的 JSON */
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
  // stdout 可能夹杂 worker/jiti 噪声：截取首个 '{' 到末个 '}' 之间的 JSON 主体
  const first = stdout.indexOf('{');
  const last = stdout.lastIndexOf('}');
  let json = null;
  if (first >= 0 && last > first) {
    try { json = JSON.parse(stdout.slice(first, last + 1)); } catch { /* 落到断言暴露 */ }
  }
  return { status: res.status, stdout, stderr: res.stderr ?? '', json };
}

function store(scope, text, tags = TAG_SEARCH) {
  return ki(['store', '--scope', scope, '--text', text, '--tags', tags]);
}
function search(scope, query, extra = []) {
  return ki(['search', '--scope', scope, '--query', query, ...extra]);
}

// ─── setup / teardown ───

before(() => {
  if (!RUN) return;
  ctx.tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `ki-cli-e2e-${PID}-`));
  const vectorDir = path.join(ctx.tmpBase, 'vector'); // 首次 store 时由引擎创建
  const config = {
    vectorDir,
    embedding: {
      provider: 'siliconflow',
      baseURL: resolveBaseURL(process.env.GITNEXUS_EMBEDDING_URL),
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
    },
  };
  ctx.configPath = path.join(ctx.tmpBase, 'config.json');
  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2));
  console.log(`  [setup] vectorDir=${vectorDir}\n  [setup] config=${ctx.configPath}`);
});

after(() => {
  if (ctx.tmpBase && fs.existsSync(ctx.tmpBase)) {
    fs.rmSync(ctx.tmpBase, { recursive: true, force: true });
    console.log(`  [teardown] 已清理临时目录 ${ctx.tmpBase}`);
  }
});

// ─── 旅程 ───

test('E2E-1 store: 单条写入 → ok + docId', { ...SKIP, timeout: 120_000 }, () => {
  const r = store(SCOPE_A, TEXT.a1);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}`);
  assert.ok(r.json, `stdout 应为可解析 JSON；实际=${r.stdout}`);
  assert.equal(r.json.ok, true, `store 应成功；实际=${JSON.stringify(r.json)}`);
  assert.ok(typeof r.json.docId === 'string' && r.json.docId.length === 32, `docId 应为 32 位；实际=${r.json.docId}`);
  ctx.docIdA1 = r.json.docId;
  console.log(`  ✓ store A1 → docId=${r.json.docId}`);
});

test('E2E-2 idempotent: 同 text+scope 再写 → docId 不变（幂等 upsert）', { ...SKIP, timeout: 120_000 }, () => {
  const r = store(SCOPE_A, TEXT.a1);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json.docId, ctx.docIdA1, `幂等：同 text+scope 应得同 docId；首次=${ctx.docIdA1} 再次=${r.json.docId}`);
  console.log(`  ✓ 幂等复写 docId 一致=${r.json.docId}`);
});

test('E2E-3 seed: 写入 A2 / scope B 私有 / ki-relation 标签文档', { ...SKIP, timeout: 120_000 }, () => {
  const rA2 = store(SCOPE_A, TEXT.a2);
  assert.equal(rA2.json?.ok, true, `A2 写入应成功；${JSON.stringify(rA2.json)}`);
  const rRel = store(SCOPE_A, TEXT.aRel, TAG_RELATION);
  assert.equal(rRel.json?.ok, true, `ki-relation 文档写入应成功；${JSON.stringify(rRel.json)}`);
  const rB = store(SCOPE_B, TEXT.b);
  assert.equal(rB.json?.ok, true, `scope B 文档写入应成功；${JSON.stringify(rB.json)}`);
  console.log('  ✓ seed 完成：A2 + A(ki-relation) + B(私有)');
});

test('E2E-4 bulk: 批量写入 → total/succeeded/failed + 逐项 results', { ...SKIP, timeout: 120_000 }, () => {
  const batch = [
    { text: '向量索引使用 HNSW 图结构实现近似最近邻搜索，兼顾召回率与查询延迟。', keywords: 'HNSW,向量索引', tags: TAG_SEARCH },
    { text: 'RRF 倒数排名融合把向量召回与全文召回两路结果按排名加权合并，提升整体相关性。', keywords: 'RRF,融合', tags: TAG_SEARCH },
    { text: 'jieba 分词让中文全文检索能对代码符号与术语做精确匹配召回。', tags: TAG_SEARCH },
  ];
  const batchFile = path.join(ctx.tmpBase, 'batch.json');
  fs.writeFileSync(batchFile, JSON.stringify(batch));
  const r = ki(['bulk_store', '--scope', SCOPE_A, '--input', batchFile]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}`);
  assert.equal(r.json?.ok, true, `bulk 应成功；${JSON.stringify(r.json)}`);
  assert.equal(r.json.total, 3, 'total=3');
  assert.equal(r.json.succeeded, 3, `succeeded=3（真实 embedding 全部成功）；实际=${r.json.succeeded}`);
  assert.equal(r.json.failed, 0, `failed=0；实际=${r.json.failed}`);
  assert.equal(r.json.results.length, 3, '逐项 results 应有 3 条');
  for (const item of r.json.results) {
    assert.equal(item.success, true, `逐项应成功：${JSON.stringify(item)}`);
    assert.ok(typeof item.memoryId === 'string' && item.memoryId.length === 32, `成功项应带 memoryId；${JSON.stringify(item)}`);
  }
  console.log(`  ✓ bulk total=${r.json.total} succeeded=${r.json.succeeded} failed=${r.json.failed}`);
});

test('E2E-5 recall: 语义检索召回自身（Recall）', { ...SKIP, timeout: 120_000 }, () => {
  const r = search(SCOPE_A, '如何用向量做语义相似度检索');
  assert.equal(r.json?.ok, true, `search 应成功；${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json.results) && r.json.results.length > 0, `应召回结果；实际=${JSON.stringify(r.json.results)}`);
  const ids = r.json.results.map((x) => x.memoryId);
  assert.ok(ids.includes(ctx.docIdA1), `语义查询应召回 A1（docId=${ctx.docIdA1}）；实际 ids=${ids.join(',')}`);
  console.log(`  ✓ recall 命中 A1；返回 ${r.json.results.length} 条`);
});

test('E2E-6 scope-iso: A 查不到 B 私有内容；B 能查到（scope 隔离）', { ...SKIP, timeout: 120_000 }, () => {
  const rA = search(SCOPE_A, '季度财务报表结算流程与对账科目');
  assert.equal(rA.json?.ok, true);
  const leaked = rA.json.results.some((x) => (x.content ?? '').includes('财务报表'));
  assert.equal(leaked, false, `scope A 不应召回 scope B 的私有内容；results=${JSON.stringify(rA.json.results.map((x) => x.memoryId))}`);

  const rB = search(SCOPE_B, '季度财务报表结算流程与对账科目');
  assert.equal(rB.json?.ok, true);
  const foundInB = rB.json.results.some((x) => (x.content ?? '').includes('财务报表'));
  assert.equal(foundInB, true, `scope B 应能召回自己的私有内容；results=${JSON.stringify(rB.json.results)}`);
  console.log('  ✓ scope 隔离：A 无泄漏，B 可召回');
});

test('E2E-7 tag-filter: 默认 tag 查不到 ki-relation；指定 ki-relation 能查到', { ...SKIP, timeout: 120_000 }, () => {
  const rDefault = search(SCOPE_A, '源文件路径绑定 memoryId 的关系映射', ['--tags', TAG_SEARCH]);
  assert.equal(rDefault.json?.ok, true);
  const leaked = rDefault.json.results.some((x) => (x.content ?? '').includes('关系映射'));
  assert.equal(leaked, false, `ki-search 标签下不应召回 ki-relation 文档；results=${JSON.stringify(rDefault.json.results.map((x) => x.memoryId))}`);

  const rRel = search(SCOPE_A, '源文件路径绑定 memoryId 的关系映射', ['--tags', TAG_RELATION]);
  assert.equal(rRel.json?.ok, true);
  const found = rRel.json.results.some((x) => (x.content ?? '').includes('关系映射'));
  assert.equal(found, true, `ki-relation 标签下应召回该文档；results=${JSON.stringify(rRel.json.results)}`);
  console.log('  ✓ tag 过滤：ki-search 不串 ki-relation，指定标签可召回');
});

test('E2E-8 thr-nan: --threshold 非法值 → 仍返回结果（#U7 回归）', { ...SKIP, timeout: 120_000 }, () => {
  const r = search(SCOPE_A, '如何用向量做语义相似度检索', ['--threshold', 'abc']);
  assert.equal(r.json?.ok, true, `非法 threshold 不应导致失败；${JSON.stringify(r.json)}`);
  assert.ok(
    Array.isArray(r.json.results) && r.json.results.length > 0,
    `#U7：非法 threshold 应视为不过滤而非静默丢光结果；实际 results=${JSON.stringify(r.json.results)}`,
  );
  console.log(`  ✓ #U7 回归：--threshold abc 仍返回 ${r.json.results.length} 条（未静默清空）`);
});

test('E2E-9 thr-high: --threshold 极大值 → 结果被过滤为空（阈值仍生效）', { ...SKIP, timeout: 120_000 }, () => {
  const r = search(SCOPE_A, '如何用向量做语义相似度检索', ['--threshold', '999']);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json.results.length, 0, `极大阈值应过滤掉全部命中；实际=${JSON.stringify(r.json.results)}`);
  console.log('  ✓ 阈值仍生效：threshold=999 → 0 条');
});
