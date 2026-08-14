/**
 * scan-kb-cli.e2e.network.mjs —— scan-kb import 管线真实端到端验收（黑盒）
 *
 * 被测对象（"当前代码"）：ki scan-kb import CLI
 *   → bin/ki.mjs → src/scan-kb.ts
 *   → src/lib/{import,batch-vectorize,path-vectorize,vector-client}.ts
 *   → dist/zvec-engine（真实 SiliconFlow embedding + 真实 zvec worker）
 *
 * 批次 3（REQ-04）：ai-results 输入契约已删除，改为 --source 原文直导。
 * 后续迭代：废弃 --mode incremental 与 diff 子命令（git diff 驱动），
 * 统一为「--group 幂等追加」语义（重复执行 = 增量）。
 *
 * 覆盖旅程（共享 Context 串联；顺序敏感）：
 *   setup       : 载入 .env.e2e → 临时 dataDir + vectorDir + config.json（隔离，不污染 ~/.ki）
 *                 + 一个源目录 fixture 作为外部知识库 sourceDir
 *   E2E-1 full  : import --source 直导 → ok + total=2 + source.rootName
 *   E2E-2 recall: search → 语义召回全量向量化写入的模块（证明真实 zvec 写入）
 *   E2E-3 append: 新增文档 + 同文件修改后重新 import → 幂等追加（新文件导入、旧文件覆盖）
 *   E2E-4 verify: 幂等追加后，新增文档可召回
 *   teardown    : 删除临时目录
 *
 * 安全：源码零秘钥。凭证从 .env.e2e（回退 .env / 进程环境）读取；缺 apiKey 整套跳过。
 * 运行：
 *   cp .env.e2e.example .env.e2e  # 填入 SILICONFLOW_API_KEY
 *   node --test test/e2e/scan-kb-cli.e2e.network.mjs
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
const GROUP = 'wiki';

const ctx = { tmpBase: null, dataDir: null, vectorDir: null, configPath: null, sourceDir: null };

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

// ─── setup / teardown ───

before(() => {
  if (!RUN) return;
  ctx.tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ki-scankb-e2e-${PID}-`)));
  ctx.dataDir = path.join(ctx.tmpBase, 'kb');
  ctx.vectorDir = path.join(ctx.tmpBase, 'vector'); // 首次向量写入时由引擎创建

  // 外部知识库 sourceDir fixture
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

test('E2E-1 full: import --source 直导 → ok + total=2 + source.rootName', { ...SKIP, timeout: 180_000 }, () => {
  const r = ki(['scan-kb', 'import', '--scope', SCOPE, '--source', ctx.sourceDir, '--group', GROUP]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.equal(r.json?.ok, true, `import 应成功；实际=${JSON.stringify(r.json)}`);
  assert.equal(r.json.stats.total, 2, `应导入 2 个 chunk（a.md + sub/b.md 各 1）；实际=${JSON.stringify(r.json.stats)}`);
  assert.equal(r.json.stats.errors, 0, `不应有错误；errors=${JSON.stringify(r.json.errors)}`);
  assert.equal(r.json.source.rootName, GROUP, `source.rootName 应为 ${GROUP}；实际=${r.json.source?.rootName}`);
  console.log(`  ✓ 直导：chunks=${r.json.stats.total} group=${r.json.source.rootName}`);
});

test('E2E-2 recall: search → 语义召回全量向量化写入的模块（证明真实 zvec 写入）', { ...SKIP, timeout: 180_000 }, () => {
  const r = ki(['search', '--scope', SCOPE, '--query', '对称加密算法如何保护数据安全']);
  assert.equal(r.json?.ok, true, `search 应成功；${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json.results) && r.json.results.length > 0, `应召回结果；实际=${JSON.stringify(r.json.results)}`);
  const hit = r.json.results.some((x) => (x.content ?? '').includes('对称加密'));
  assert.ok(hit, `语义召回应命中直导写入的 ki-search 向量；实际=${JSON.stringify(r.json.results.map((x) => x.content?.slice(0, 40)))}`);
  console.log(`  ✓ recall 命中全量向量；返回 ${r.json.results.length} 条`);
});

test('E2E-3 append: 新增文档 + 修改后重新 import → 幂等追加', { ...SKIP, timeout: 180_000 }, () => {
  // 新增 c.md，修改 a.md
  fs.writeFileSync(path.join(ctx.sourceDir, 'c.md'), '# RSA 非对称加密\n\nRSA 使用公钥加密、私钥解密，常用于密钥交换与数字签名。');
  fs.writeFileSync(path.join(ctx.sourceDir, 'a.md'), '# AES 加密工具 v2\n\nAES-GCM 模式在对称加密基础上额外提供完整性校验。');

  const r = ki(['scan-kb', 'import', '--scope', SCOPE, '--source', ctx.sourceDir, '--group', GROUP]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}\nstdout=${r.stdout}`);
  assert.equal(r.json?.ok, true, `幂等追加应成功；${JSON.stringify(r.json)}`);
  assert.equal(r.json.stats.errors, 0, `不应有错误；errors=${JSON.stringify(r.json.errors)}`);
  // 3 个文件（a 覆盖 + sub/b 幂等 + c 新增）各 1 chunk
  assert.equal(r.json.stats.total, 3, `total 应为 3；实际=${JSON.stringify(r.json.stats)}`);
  console.log(`  ✓ 幂等追加：chunks=${r.json.stats.total}（新增 c.md + 覆盖 a.md + 幂等 sub/b.md）`);
});

test('E2E-4 verify: 幂等追加后，新增文档可召回', { ...SKIP, timeout: 180_000 }, () => {
  // 新增的 RSA 应可被召回（证明追加写入成功）
  const rAdd = ki(['search', '--scope', SCOPE, '--query', '公钥加密私钥解密用于密钥交换']);
  assert.equal(rAdd.json?.ok, true);
  const rsaHit = (rAdd.json.results ?? []).some((x) => (x.content ?? '').includes('非对称') || (x.content ?? '').includes('RSA'));
  assert.ok(rsaHit, `追加的 RSA 向量应可召回；results=${JSON.stringify((rAdd.json.results ?? []).map((x) => x.content?.slice(0, 30)))}`);
  console.log('  ✓ verify：追加文档可召回');
});
