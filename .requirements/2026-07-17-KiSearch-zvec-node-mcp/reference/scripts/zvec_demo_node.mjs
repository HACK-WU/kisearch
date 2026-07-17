#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * Zvec 引擎验证 Demo (Node / @zvec/zvec)
 * ==================================================
 * 对齐 Python 版 zvec-probe/zvec_demo.py，验证 alibaba/zvec 在本需求(REQ-20260717-001)
 * 中的可用性与接口形态：
 *   1. 进程内、零服务
 *   2. Node 友好（官方 @zvec/zvec 绑定，Rust 内核，与 Python 等价）
 *   3. 混合检索：稠密向量 + 全文 BM25(FTS) + 标量过滤(tag)
 *   4. 冷启动耗时（类比 ki search 一次性打开+首查）
 *   5. 持久化（关闭后重开仍可检索）
 *
 * 说明：
 *   - 为自包含、不依赖重模型与网络，稠密向量用「词哈希 bag-of-words + L2 归一化」
 *     （共享词 => 向量相近），仅用于验证 API 与融合流程；真实部署替换为 SiliconFlow embedding。
 *   - zvec 单 Query 中 fts 与 vector 互斥，因此混合检索 = 分别跑两路 + RRF 融合；
 *     同时额外验证 zvec v0.5.0 的原生 multiQuerySync(rerank:'rrf') 混合路径。
 *
 * 运行：node zvec_demo.mjs
 */
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import {
  ZVecCreateAndOpen,
  ZVecOpen,
  ZVecCollectionSchema,
  ZVecDataType,
  ZVecIndexType,
  ZVecMetricType,
} from "@zvec/zvec";

// ----------------------------------------------------------------------------
// 0. 轻量 embedding：词哈希 bag-of-words（仅用于 demo，非生产 embedding）
// ----------------------------------------------------------------------------
const DIM = 256;

function embed(text, dim = DIM) {
  const vec = new Array(dim).fill(0);
  const toks = (text || "").toLowerCase().match(/[a-z_][a-z0-9_]*/g) || [];
  for (const t of toks) {
    const h = Math.abs(hashStr(t)) % dim;
    vec[h] += 1.0;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

function hashStr(s) {
  // 简单字符串哈希（等价于 Python 内置 hash 的演示用途，仅保证同词同槽）
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

// ----------------------------------------------------------------------------
// 1. 模拟 KiSearch 数据（relation / search / path 三类，对应 ki-relation/ki-search/ki-path）
//    每条: [doc_id, tag, scope, content文本]
// ----------------------------------------------------------------------------
const SAMPLE = [
  ["r1", "ki-relation", "projA", "syncRelation data vectorize embedding when relation value changes"],
  ["r2", "ki-relation", "projA", "buildRelationContent groupPath keywords relation text"],
  ["r3", "ki-relation", "projB", "relation syncRelation pending vector write back setImmediate"],
  ["s1", "ki-search", "projA", "ki search full text BM25 hybrid retrieval code symbol"],
  ["s2", "ki-search", "projB", "semantic search over indexed modules and relations"],
  ["s3", "ki-search", "projA", "syncRelation vectorize sync relation data store memory"],
  ["p1", "ki-path", "projA", "groupPath module index relation keyword path hierarchy"],
  ["p2", "ki-path", "projB", "module group path keywords buildGroupPathContent"],
];

// Reciprocal Rank Fusion：融合多路召回
function rrf(lists, k = 60) {
  const scores = new Map();
  for (const lst of lists) {
    lst.forEach((docId, rank) => {
      scores.set(docId, (scores.get(docId) || 0) + 1.0 / (k + rank + 1));
    });
  }
  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

const now = () => Number(process.hrtime.bigint()) / 1e6; // ms

function main() {
  console.log("=".repeat(70));
  console.log("Zvec 引擎验证 Demo (Node / @zvec/zvec)");
  console.log("=".repeat(70));

  const dataDir = path.join(
    os.tmpdir(),
    `zvec_node_${process.pid}_${Date.now()}`
  );
  console.log(`[setup] collection path: ${dataDir}`);

  // ------------------------------------------------------------------
  // 2. 定义 Schema：稠密向量 + FTS 全文 + 标量过滤(tag/scope)
  // ------------------------------------------------------------------
  const schema = new ZVecCollectionSchema({
    name: "kisearch_probe",
    fields: [
      {
        name: "tag",
        dataType: ZVecDataType.STRING,
        nullable: false,
        indexParams: {
          indexType: ZVecIndexType.INVERT,
          enableRangeOptimization: false,
        },
      },
      { name: "scope", dataType: ZVecDataType.STRING, nullable: false },
      {
        name: "content",
        dataType: ZVecDataType.STRING,
        nullable: false,
        indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: "standard" },
      },
    ],
    vectors: [
      {
        name: "dense",
        dataType: ZVecDataType.VECTOR_FP32,
        dimension: DIM,
        indexParams: {
          indexType: ZVecIndexType.HNSW,
          metricType: ZVecMetricType.COSINE,
        },
      },
    ],
  });

  // ------------------------------------------------------------------
  // 3. 创建 + 插入 + optimize（计时：冷创建）
  // ------------------------------------------------------------------
  let t0 = now();
  const col = ZVecCreateAndOpen(dataDir, schema);
  const tCreate = now() - t0;

  t0 = now();
  const docs = SAMPLE.map(([did, tag, scope, content]) => ({
    id: did,
    vectors: { dense: embed(content) },
    fields: { tag, scope, content },
  }));
  const statuses = col.insertSync(docs);
  const tInsert = now() - t0;
  const insertOk = statuses.filter((s) => s.ok).length;

  t0 = now();
  col.optimizeSync();
  const tOptimize = now() - t0;

  console.log(`[perf] create_and_open     : ${tCreate.toFixed(1).padStart(8)} ms`);
  console.log(`[perf] insert ${docs.length} docs   : ${tInsert.toFixed(1).padStart(8)} ms (ok=${insertOk}/${docs.length})`);
  console.log(`[perf] optimize            : ${tOptimize.toFixed(1).padStart(8)} ms`);

  // ------------------------------------------------------------------
  // 4. 冷启动检索计时（类比 ki search 一次性打开 + 首查）
  // ------------------------------------------------------------------
  const queryText = "syncRelation vectorize";
  const qvec = embed(queryText);

  t0 = now();
  const vecRes = col.querySync({ fieldName: "dense", vector: qvec, topk: 10 });
  const tVec = now() - t0;
  const vecIds = vecRes.map((d) => d.id);

  t0 = now();
  const ftsRes = col.querySync({
    fieldName: "content",
    fts: { matchString: queryText },
    topk: 10,
  });
  const tFts = now() - t0;
  const ftsIds = ftsRes.map((d) => d.id);

  t0 = now();
  const fused = rrf([vecIds, ftsIds]);
  const tFuse = now() - t0;

  console.log("-".repeat(70));
  console.log(`[query] '${queryText}'`);
  console.log(`  vector topk : ${vecIds}  (${tVec.toFixed(1)} ms)`);
  console.log(`  fts    topk : ${ftsIds}  (${tFts.toFixed(1)} ms)`);
  console.log(`  RRF fused   : ${fused.map(([d]) => d)}  (fuse ${tFuse.toFixed(2)} ms)`);

  // ------------------------------------------------------------------
  // 4b. 原生混合检索：multiQuerySync + rerank:'rrf'（zvec v0.5.0 原生能力）
  // ------------------------------------------------------------------
  t0 = now();
  const nativeHybrid = col.multiQuerySync({
    queries: [
      { fieldName: "dense", vector: qvec },
      { fieldName: "content", fts: { matchString: queryText } },
    ],
    topk: 10,
    rerank: { type: "rrf", rankConstant: 60 },
  });
  const tNative = now() - t0;
  console.log(`  native hybrid (multiQuerySync rrf): ${nativeHybrid.map((d) => d.id)}  (${tNative.toFixed(2)} ms)`);

  // ------------------------------------------------------------------
  // 5. 标量过滤（tag 维度隔离，对应 KiSearch 的多作用域/多 tag）
  // ------------------------------------------------------------------
  const filtered = col.querySync({
    fieldName: "dense",
    vector: qvec,
    filter: "tag = 'ki-relation'",
    topk: 10,
  });
  console.log(`[filter] tag='ki-relation' -> ${filtered.map((d) => d.id)}`);

  // ------------------------------------------------------------------
  // 6. 持久化验证：关闭后重新打开，检索仍可用
  // ------------------------------------------------------------------
  col.closeSync();
  t0 = now();
  const col2 = ZVecOpen(dataDir);
  const tReopen = now() - t0;
  const reRes = col2.querySync({
    fieldName: "content",
    fts: { matchString: "syncRelation" },
    topk: 5,
  });
  console.log(`[persist] reopen : ${tReopen.toFixed(1).padStart(8)} ms`);
  console.log(`[persist] fts 'syncRelation' after reopen -> ${reRes.map((d) => d.id)}`);

  // ------------------------------------------------------------------
  // 7. 诊断：打印一次原始 result 结构
  // ------------------------------------------------------------------
  console.log("-".repeat(70));
  console.log("[diag] raw fts result (first item):");
  console.log("   ", JSON.stringify(reRes[0], null, 2)?.slice(0, 400));

  col2.closeSync();
  fs.rmSync(dataDir, { recursive: true, force: true });
  console.log("=".repeat(70));
  console.log("Demo 完成。");
  console.log("=".repeat(70));
}

try {
  main();
} catch (e) {
  console.error("✗ 运行失败:", e);
  process.exit(1);
}
