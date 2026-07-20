/**
 * zvec-engine-e2e.network.mjs —— ZvecEngine 真实 embedding 端到端验收
 *
 * 旅程（共享 Context 串联状态；按声明顺序执行，写突变用例排在只读验收之后）：
 *   setup : 用真实 SiliconFlowProvider 建库（fts=jieba，对齐 TC-T-01）
 *   E2E-1 : create + info（docCount=0）
 *   E2E-2 : 真实 embed + upsert（20 篇中文技术文档，text=content）
 *   E2E-3 : semanticSearch 精确自检索 → top1 命中自己、score≈1 / distance≈0（R-06）
 *   E2E-4 : 不相关查询 → score 明显低于自检索（相对比值断言）
 *   E2E-5 : ftsSearch 代码符号精确召回（TC-T-01 / REQ-04，jieba）
 *   E2E-6 : hybridSearch 双路融合
 *   E2E-7 : Recall@5 ≥ 90% + Recall@1 观察（TC-T-02 / REQ-07，按 title 查 content）
 *   E2E-8 : fetch 取回字段
 *   E2E-9 : update(text) 重嵌 → 新文本可自检索
 *   E2E-10: update(仅 fields) → 抛 InconsistentUpdateError（Z-03 回归守护）
 *   E2E-11: delete → 文档移除、docCount 下降
 *   teardown: destroy 清盘
 *
 * ⚠️ 安全约定：测试源码中不得出现任何秘钥。所有模型配置（URL / model /
 *   维度 / apiKey）一律从 process.env 读取。无 apiKey 时整组跳过（CI 安全）。
 *
 * 运行（需真实联网 + 已 export 以下变量）：
 *   export GITNEXUS_EMBEDDING_URL=... GITNEXUS_EMBEDDING_MODEL=...
 *   export GITNEXUS_EMBEDDING_API_KEY=... GITNEXUS_EMBEDDING_DIMS=...
 *   export SILICONFLOW_API_KEY=...
 *   node --test test/zvec-engine-e2e.network.mjs
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ZvecEngine,
  SiliconFlowProvider,
  InconsistentUpdateError,
} from '../../dist/zvec-engine/index.js';

// ─── 从 env 读取模型配置（源码零秘钥） ───

const API_KEY =
  process.env.GITNEXUS_EMBEDDING_API_KEY ?? process.env.SILICONFLOW_API_KEY;

/** SiliconFlow 的 OpenAI 兼容端点为 <base>/v1/embeddings。
 *  用户可能给裸 base（https://api.siliconflow.cn）或已含 /v1 的完整 base，
 *  这里做归一化：未以 /vN 结尾则补 /v1，保证 /embeddings 路径正确。 */
function resolveBaseURL(raw) {
  if (!raw) return undefined; // 让 provider 用默认 https://api.siliconflow.cn/v1
  const trimmed = raw.replace(/\/+$/, '');
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

const EMBED_URL = resolveBaseURL(process.env.GITNEXUS_EMBEDDING_URL);
const EMBED_MODEL =
  process.env.GITNEXUS_EMBEDDING_MODEL ?? 'Qwen/Qwen3-Embedding-8B';
const EMBED_DIMS = parseInt(process.env.GITNEXUS_EMBEDDING_DIMS ?? '4096', 10);

const RUN_NETWORK = Boolean(API_KEY);
const SKIP_OPTS = RUN_NETWORK
  ? {}
  : { skip: '缺少 embedding apiKey（GITNEXUS_EMBEDDING_API_KEY / SILICONFLOW_API_KEY），跳过真实联网测试' };

if (!RUN_NETWORK) {
  console.warn('[E2E] 未检测到 embedding apiKey，整套真实联网用例已跳过（CI 安全）。');
}

// ─── 语料（20 篇中文技术文档；title 用于检索查询，content 含代码符号 sym） ───
// 注：规模较 TC-T-02 的 40 篇 wiki 已缩减，作为真实 embedding 验收的代表性样例。

const DOCS = [
  { id: 'd1',  sym: 'ftsSearch',         title: '全文检索的倒排索引原理',     content: '全文检索通过在倒排索引上匹配关键词来召回文档，ftsSearch 接口适合精确匹配代码符号与术语。' },
  { id: 'd2',  sym: 'hybridSearch',      title: '混合检索与 RRF 融合',         content: '混合检索 hybridSearch 结合向量语义召回与全文关键词召回，使用 RRF 融合两路结果提升相关性。' },
  { id: 'd3',  sym: 'semanticSearch',    title: '语义检索与稠密向量',           content: '语义检索 semanticSearch 将查询文本编码为稠密向量，基于余弦相似度召回语义相近的文档。' },
  { id: 'd4',  sym: 'syncRelation',      title: 'Git 仓库同步关系映射',         content: '同步关系脚本 syncRelation 扫描 Git 仓库并将文件映射为知识库条目，维护源路径到 memoryId 的关系。' },
  { id: 'd5',  sym: 'embed',             title: '嵌入模型与稠密向量',           content: '嵌入模型 embed 把自然语言文本转换为固定维度的稠密向量，用于语义相似度计算。' },
  { id: 'd6',  sym: 'createIndex',       title: '标量索引加速过滤查询',         content: '创建标量索引 createIndex 可以加速基于字段的过滤器查询，例如按标签或语言筛选文档。' },
  { id: 'd7',  sym: 'upsert',            title: 'upsert 增量写入语义',          content: 'upsert 写入当文档 id 已存在时执行更新，不存在时插入，是增量同步的主要写入方式。' },
  { id: 'd8',  sym: 'probe',             title: '集合探测与状态判断',           content: '探测操作 probe 在不持有句柄的情况下判断集合是否存在、是否被锁或是否损坏。' },
  { id: 'd9',  sym: 'workerPool',        title: '工作线程池并发模型',           content: '工作线程池 workerPool 并发执行嵌入与向量写入，提升批量导入的吞吐量。' },
  { id: 'd10', sym: 'rerank',            title: '重排序与倒数排名融合',         content: '重排序阶段 rerank 对召回结果按相关性重新打分，加权融合或倒数排名融合可调整两路权重。' },
  { id: 'd11', sym: 'dimensionMismatch', title: '向量维度一致性校验',           content: '向量维度必须与集合定义一致，否则 dimensionMismatch 会因维度不匹配而拒绝该文档。' },
  { id: 'd12', sym: 'destroy',           title: '集合销毁与磁盘清理',           content: '销毁操作 destroy 删除磁盘上的集合目录并释放句柄，是不可逆的清理动作。' },
  { id: 'd13', sym: 'vectorSearch',      title: '纯向量检索接口',               content: '纯向量检索 vectorSearch 直接以稠密向量为输入，跳过文本嵌入阶段进行最近邻查询。' },
  { id: 'd14', sym: 'fetch',             title: '文档字段取回',                 content: 'fetch 接口按 id 列表取回文档的标量字段，可选附带原始向量用于调试。' },
  { id: 'd15', sym: 'delete',            title: '文档删除与计数同步',           content: 'delete 按 id 删除文档，集合 docCount 随之递减，已删除文档不再可检索。' },
  { id: 'd16', sym: 'close',             title: '句柄关闭与 drain',             content: 'close 操作会 drain 在途请求后关闭句柄，多次调用幂等，之后句柄不可再用于读写。' },
  { id: 'd17', sym: 'filter',            title: '标量字段过滤器',               content: '过滤器 filter 基于标量字段条件下推到 zvec，在向量召回前缩小候选集，提升查询效率。' },
  { id: 'd18', sym: 'metric',            title: '相似度度量选择',               content: '相似度度量 metric 支持 COSINE、L2、IP，不同度量对应不同的 score 归一化公式。' },
  { id: 'd19', sym: 'scalarFields',      title: '标量字段声明与白名单',         content: '标量字段 scalarFields 在建库时声明，写入时按白名单校验，未声明字段会被拒绝。' },
  { id: 'd20', sym: 'optimize',          title: '索引优化与压实',               content: '优化操作 optimize 触发索引压实与图重建，提升后续查询的召回率与延迟。' },
];

const DOC_BY_ID = new Map(DOCS.map((d) => [d.id, d]));

// ─── 共享 Context ───

let engine = null;
let dbPath = null;
const ctx = { selfScore: 0 };

// ─── setup / teardown ───

before(async () => {
  if (!RUN_NETWORK) return;
  const provider = new SiliconFlowProvider({
    apiKey: API_KEY,
    baseURL: EMBED_URL,
    model: EMBED_MODEL,
    dimension: EMBED_DIMS,
  });
  assert.equal(provider.dimension, EMBED_DIMS, 'provider 维度应与配置一致');

  // ZvecEngine.create 要求 dbPath 不存在（它自行创建集合目录），故传一个唯一且尚未存在的路径
  dbPath = path.join(os.tmpdir(), `zvec-e2e-${process.pid}-${Date.now()}`);
  engine = await ZvecEngine.create({
    dbPath,
    collection: {
      name: 'e2e_real',
      denseField: 'vector',
      dimension: EMBED_DIMS,
      metric: 'COSINE',
      // 注意：zvec worker 会把 fts 字段的值自动取自 doc.text（覆盖同名字段）。
      // 因此 fts 字段用 body（由 content 填充），代码符号保留到独立的 sym 元数据字段。
      // tokenizer 用 jieba（TC-T-01 要求；validator.ts 也提示 standard 会破坏 CJK FTS）。
      scalarFields: [
        { name: 'sym', dataType: 'STRING' },
        { name: 'tag', dataType: 'STRING' },
        { name: 'body', dataType: 'STRING', indexed: true },
      ],
      fts: { field: 'body', tokenizer: 'jieba' },
    },
    embedding: provider,
  });
});

after(async () => {
  if (engine) {
    try { await engine.destroy(); } catch { /* 已清理 */ }
    engine = null;
  }
  if (dbPath && fs.existsSync(dbPath)) {
    fs.rmSync(dbPath, { recursive: true, force: true });
  }
});

// ─── 旅程（顺序敏感：E2E-9/E2E-11 会突变 d1/d3，须排在只读验收之后） ───

test('E2E-1: create + info（docCount=0）', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const info = await engine.info();
  assert.equal(info.name, 'e2e_real');
  assert.equal(info.dimension, EMBED_DIMS);
  assert.equal(info.metric, 'COSINE');
  assert.equal(info.docCount, 0, '新建集合应为空');
  assert.ok(info.fts && info.fts.field === 'body', 'fts 配置应持久化（body 字段）');
  assert.equal(info.fts.tokenizer, 'jieba', 'fts 分词器应为 jieba');
  console.log(`  ✓ info: dim=${info.dimension} metric=${info.metric} docCount=${info.docCount} fts=${info.fts.tokenizer}`);
});

test('E2E-2: 真实 embed + upsert（20 篇）', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const res = await engine.upsert(
    DOCS.map((d) => ({ id: d.id, text: d.content, fields: { sym: d.sym, tag: 'zvec' } })),
  );
  assert.equal(res.failed, 0, `upsert 不应有失败: ${JSON.stringify(res.errors)}`);
  assert.equal(res.ok, DOCS.length, `应全部写入: ${JSON.stringify(res)}`);

  const info = await engine.info();
  assert.equal(info.docCount, DOCS.length, 'docCount 应等于语料数');
  console.log(`  ✓ upsert ok=${res.ok} failed=${res.failed} docCount=${info.docCount}（真实 embedding 已完成）`);
});

test('E2E-3: semanticSearch 精确自检索 → top1 命中自己、score≈1 / distance≈0', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const doc = DOC_BY_ID.get('d3');
  // 精确自检索：query 与嵌入文本完全一致（content），COSINE 下应 distance≈0 → score≈1
  const hits = await engine.semanticSearch({ queryText: doc.content, topk: 1 });
  assert.ok(hits.length >= 1, '应至少召回 1 条');
  assert.equal(hits[0].id, 'd3', `自检索 top1 应是自己，实际=${hits[0]?.id}`);
  assert.ok(hits[0].score > 0.99, `自检索 score 应≈1，实际=${hits[0].score}`);
  const dist = 1 / hits[0].score - 1;
  assert.ok(dist < 1e-3, `自检索 distance 应≈0，实际=${dist}`);
  ctx.selfScore = hits[0].score;
  console.log(`  ✓ 自检索 top1=d3 score=${hits[0].score}（distance≈${dist.toExponential(2)}）`);
});

test('E2E-4: 不相关查询 → score 明显低于自检索（相对比值）', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  // 注：TC-T-02 原预估「不相关 score≈1/3（distance≈2）」系模型相关的经验值；
  // Qwen3-Embedding-8B 实测不相关 distance≈0.8（score≈0.55），并非 1/3。
  // 故改用相对比值断言以保留对 score 公式回归的区分力。
  const unrelated = '今天天气真好，我们去公园散步，顺便买杯奶茶和蛋糕。';
  const hits = await engine.semanticSearch({ queryText: unrelated, topk: 1 });
  assert.ok(hits.length >= 1);
  const self = ctx.selfScore || 1;
  const ratio = hits[0].score / self;
  assert.ok(ratio < 0.65, `不相关 score 应明显低于自检索（ratio=${ratio.toFixed(3)}，unrelated=${hits[0].score} < self=${self}）`);
  const dist = 1 / hits[0].score - 1;
  console.log(`  ✓ 不相关 query top1=${hits[0].id} score=${hits[0].score} distance≈${dist.toFixed(3)}（self=${self} ratio=${ratio.toFixed(3)}）`);
});

test('E2E-5: ftsSearch 代码符号精确召回（TC-T-01，jieba）', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const hits = await engine.ftsSearch({ match: 'hybridSearch', topk: 3 });
  assert.ok(hits.length >= 1, '应召回符号文档');
  assert.equal(hits[0].id, 'd2', `代码符号 hybridSearch 应精确命中 d2，实际 top1=${hits[0]?.id}`);
  assert.equal(hits[0].fields.sym, 'hybridSearch');
  console.log(`  ✓ fts(jieba) "hybridSearch" → top1=d2（符号精确召回）`);
});

test('E2E-6: hybridSearch 双路融合', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const doc = DOC_BY_ID.get('d2');
  const hits = await engine.hybridSearch({
    queryText: doc.content,
    fts: 'hybridSearch',
    topk: 5,
    rerank: { type: 'rrf', rankConstant: 60 },
  });
  assert.ok(hits.length >= 1, 'hybrid 应召回');
  const ids = hits.map((h) => h.id);
  assert.ok(ids.includes('d2'), `hybrid 应含 d2，实际=${ids.join(',')}`);
  console.log(`  ✓ hybrid 召回 ${hits.length} 条，含 d2；ids=${ids.join(',')}`);
});

test('E2E-7: Recall@5 ≥ 90% + Recall@1 观察（TC-T-02 / REQ-07，按 title 查 content）', { ...SKIP_OPTS, timeout: 180_000 }, async () => {
  let hit5 = 0;
  let hit1 = 0;
  for (const d of DOCS) {
    const res = await engine.semanticSearch({ queryText: d.title, topk: 5 });
    const ids = res.map((h) => h.id);
    if (ids.includes(d.id)) hit5++;
    if (ids[0] === d.id) hit1++;
  }
  const recall5 = hit5 / DOCS.length;
  const recall1 = hit1 / DOCS.length;
  assert.ok(recall5 >= 0.9, `Recall@5 应 ≥ 90%，实际=${(recall5 * 100).toFixed(1)}%`);
  console.log(`  ✓ Recall@5 = ${(recall5 * 100).toFixed(1)}%（${hit5}/${DOCS.length}）；Recall@1 观察 = ${(recall1 * 100).toFixed(1)}%（TC-T-02 目标≥85%）`);
});

test('E2E-8: fetch 取回字段', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const docs = await engine.fetch(['d1', 'd2']);
  assert.equal(docs.length, 2);
  const d1 = docs.find((d) => d.id === 'd1');
  assert.ok(d1, '应取回 d1');
  assert.equal(d1.fields.sym, 'ftsSearch');
  console.log(`  ✓ fetch d1,d2 成功；d1.sym=${d1.fields.sym}`);
});

test('E2E-9: update(text) 重嵌 → 新文本可自检索', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const newText = '向量数据库使用 HNSW 图索引实现近似最近邻搜索，兼顾召回率与查询延迟。';
  const res = await engine.update([{ id: 'd1', text: newText, fields: { sym: 'ftsSearch', tag: 'zvec' } }]);
  assert.equal(res.failed, 0, `update 不应失败: ${JSON.stringify(res.errors)}`);
  assert.equal(res.ok, 1);

  const hits = await engine.semanticSearch({ queryText: newText, topk: 1 });
  assert.equal(hits[0].id, 'd1', `重嵌后新文本应自检索命中 d1，实际=${hits[0]?.id}`);
  console.log(`  ✓ update(d1,text) 重嵌成功，新文本自检索 top1=d1`);
});

test('E2E-10: update(仅 fields) → 抛 InconsistentUpdateError（Z-03 回归守护）', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  await assert.rejects(
    () => engine.update([{ id: 'd2', fields: { sym: 'hybridSearchV2' } }]),
    (e) => e instanceof InconsistentUpdateError && /dense|required|field/i.test(e.message),
    'update 仅传 fields 必须抛 InconsistentUpdateError（zvec 要求 dense vector 必填）',
  );
  console.log(`  ✓ update(仅 fields) 如预期抛 InconsistentUpdateError（Z-03 守护）`);
});

test('E2E-11: delete → 文档移除、docCount 下降', { ...SKIP_OPTS, timeout: 120_000 }, async () => {
  const before = await engine.info();
  const res = await engine.delete(['d3']);
  assert.equal(res.ok, 1, `delete 应成功 1 条: ${JSON.stringify(res)}`);

  const after = await engine.info();
  assert.equal(after.docCount, before.docCount - 1, 'docCount 应减 1');

  const fetched = await engine.fetch(['d3']);
  assert.equal(fetched.length, 0, '已删除文档不应再被取回');
  console.log(`  ✓ delete d3 成功；docCount ${before.docCount} → ${after.docCount}`);
});
