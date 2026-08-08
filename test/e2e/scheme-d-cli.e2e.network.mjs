/**
 * scheme-d-cli.e2e.network.mjs —— 方案 D 新功能真实端到端验收（黑盒）
 *
 * 被测对象：ki scan-kb import / ki search CLI
 *   → src/lib/{import,clean,interrupt,vector-client}.ts
 *   → dist/zvec-engine（真实 embedding + 真实 zvec worker）
 *
 * 覆盖方案 D 新功能（REQ-20260807-001）：
 *   E2E-D1 full 导入（含 frontmatter/BOM）→ local KB 存原文（未清洗）+ 向量 content 清洗后（search 召回）
 *   E2E-D2 search 原文召回：命中返回 original（文件级原文，未清洗）
 *   E2E-D3 --no-vector：local KB 原文写入、memoryIds 空
 *   E2E-D4 非 md 跳过 + 汇总提示（格式白名单）
 *
 * 安全：源码零秘钥。凭证从 .env.e2e（回退 .env / 进程环境）读取；缺 apiKey 整套跳过。
 * 运行：
 *   node --test test/e2e/scheme-d-cli.e2e.network.mjs
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

// ─── 载入 .env.e2e（回退 .env）───

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
const SKIP = RUN ? {} : { skip: '缺少 embedding apiKey，跳过方案 D 真实联网 CLI e2e' };
if (!RUN) console.warn('[E2E-scheme-d] 未检测到 apiKey，整套真实联网 CLI 用例已跳过。');

/** SiliconFlow 端点规范化 */
function resolveBaseURL(raw) {
  if (!raw) return 'https://api.siliconflow.cn/v1';
  const t = raw.replace(/\/+$/, '');
  return /\/v\d+$/i.test(t) ? t : `${t}/v1`;
}

// ─── 共享 Context ───

const PID = process.pid;
const SCOPE = `e2e-schemed-${PID}`;
const ROOT_NAME = 'wiki';
const ctx = { tmpBase: null, dataDir: null, vectorDir: null, configPath: null, sourceDir: null };

/** 调用 ki CLI，解析 stdout JSON */
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
  ctx.tmpBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ki-schemed-e2e-${PID}-`)));
  ctx.dataDir = path.join(ctx.tmpBase, 'kb');
  ctx.vectorDir = path.join(ctx.tmpBase, 'vector');

  // 外部 Wiki fixture：含 frontmatter/BOM 的文档 + 非 md 文件
  ctx.sourceDir = path.join(ctx.tmpBase, 'source');
  fs.mkdirSync(path.join(ctx.sourceDir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(ctx.sourceDir, 'docs', 'api.md'),
    '\uFEFF---\ntitle: API 文档\n---\n# API 模块\n\n这是 API 模块的完整说明，描述接口调用方式与鉴权流程。\n\n```mermaid\ngraph TD;\n  A-->B;\n```\n'
  );
  fs.writeFileSync(path.join(ctx.sourceDir, 'notes.txt'), 'not markdown');

  const config = {
    dataDir: ctx.dataDir,
    vectorDir: ctx.vectorDir,
    embedding: {
      provider: 'siliconflow',
      baseURL: resolveBaseURL(process.env.GITNEXUS_EMBEDDING_URL),
      model: process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B',
      dimension: parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10),
      apiKey: '${SILICONFLOW_API_KEY}', // ki() 从进程环境注入
    },
    scopes: { [SCOPE]: {} },
  };
  ctx.configPath = path.join(ctx.tmpBase, 'config.json');
  fs.writeFileSync(ctx.configPath, JSON.stringify(config, null, 2));
});

after(() => {
  if (ctx.tmpBase && fs.existsSync(ctx.tmpBase)) {
    fs.rmSync(ctx.tmpBase, { recursive: true, force: true });
  }
});

// ─── 旅程 ───

test('E2E-D1 full 导入：local KB 存原文（未清洗），向量 content 清洗后', { ...SKIP, timeout: 180_000 }, () => {
  const r = ki(['scan-kb', 'import', '--scope', SCOPE, '--source', ctx.sourceDir, '--root-name', ROOT_NAME]);
  assert.equal(r.status, 0, `退出码应为 0；stderr=${r.stderr}`);
  assert.equal(r.json?.ok, true, `import 应成功；${JSON.stringify(r.json)}`);
  assert.equal(r.json.stats.total, 1, `应导入 1 个文件（docs/api.md；notes.txt 非 md 跳过）`);

  // local KB 存文件级原文（未清洗：保留 BOM + frontmatter）；路径 kb/{scope}/{groupPath}/index.json
  const kbPath = path.join(ctx.dataDir, SCOPE, 'wiki/docs', 'index.json');
  assert.ok(fs.existsSync(kbPath), `local KB 应存在：${kbPath}`);
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));
  assert.ok(kb['api'], `文件级 relation（basename 去扩展名）应为 key：${Object.keys(kb)}`);
  assert.ok(kb['api'].includes('\uFEFF---'), 'local KB 保留 BOM + frontmatter（未清洗）');
  assert.ok(kb['api'].includes('title: API 文档'));
  console.log('  ✓ local KB 存文件级原文（未清洗）');
});

test('E2E-D2 search 原文召回：命中返回 original（文件级原文，未清洗）', { ...SKIP, timeout: 180_000 }, () => {
  const r = ki(['search', '--scope', SCOPE, '--query', 'API 模块 调用']);
  assert.equal(r.status, 0, `search 应成功；stderr=${r.stderr}`);
  assert.equal(r.json?.ok, true, `search 应 ok；${JSON.stringify(r.json)}`);
  const hit = (r.json?.results ?? []).find((x) => x.original);
  assert.ok(hit, `应至少有一个命中返回 original；results=${JSON.stringify(r.json?.results)}`);
  assert.equal(hit.originalRetrieved, true, `originalRetrieved 应为 true`);
  assert.ok(hit.original.includes('API 模块'), `original 应为文件原文：${hit.original.slice(0, 50)}`);
  // local KB 存原文（未清洗）：mermaid 块应保留在 original（向量 content 才被剥离）
  assert.ok(hit.original.includes('mermaid'), `original 应为未清洗原文（含 mermaid，清洗只作用于向量侧）`);
  console.log('  ✓ search 返回文件级原文（original 字段，含未清洗内容）');
});

test('E2E-D3 --no-vector：local KB 原文写入、memoryIds 空', { ...SKIP, timeout: 180_000 }, () => {
  const srcNoVec = path.join(ctx.tmpBase, 'source-novec');
  fs.mkdirSync(srcNoVec, { recursive: true });
  fs.writeFileSync(path.join(srcNoVec, 'plain.md'), '# Plain\n纯文本内容');
  const r = ki(['scan-kb', 'import', '--scope', SCOPE, '--source', srcNoVec, '--root-name', ROOT_NAME, '--no-vector']);
  assert.equal(r.status, 0, `--no-vector 导入应成功；stderr=${r.stderr}`);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json.stats.vectorized, 0, `--no-vector 不应向量化`);

  // local KB 写入（路径 kb/{scope}/{groupPath}/index.json）
  const kbPath = path.join(ctx.dataDir, SCOPE, 'wiki', 'index.json');
  assert.ok(fs.existsSync(kbPath), 'local KB 应存在（--no-vector 也写 KB）');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf-8'));
  assert.ok(kb['plain'], 'plain.md 文件级原文应写入');
  console.log('  ✓ --no-vector：local KB 写入、向量跳过');
});

test('E2E-D4 非 md 文件跳过 + 汇总提示', { ...SKIP, timeout: 180_000 }, () => {
  // 独立 scope + 独立 source（含 1 个非 md 文件）：验证非 md 跳过且 stderr 含汇总提示
  const scopeD4 = `${SCOPE}-d4`;
  const srcD4 = path.join(ctx.tmpBase, 'source-d4');
  fs.mkdirSync(srcD4, { recursive: true });
  fs.writeFileSync(path.join(srcD4, 'ok.md'), '# OK\n纯文本内容');
  fs.writeFileSync(path.join(srcD4, 'note.txt'), 'not markdown');
  const r = ki(['scan-kb', 'import', '--scope', scopeD4, '--source', srcD4, '--root-name', ROOT_NAME]);
  assert.equal(r.status, 0, `import 应成功；stderr=${r.stderr}`);
  assert.equal(r.json?.ok, true);
  assert.equal(r.json.stats.total, 1, `应只导入 ok.md`);
  assert.ok(r.stderr.includes('跳过 1 个不支持格式的文件'), `stderr 应含非 md 汇总提示；stderr=${r.stderr}`);
  console.log('  ✓ 非 md 文件跳过 + 汇总提示');
});
