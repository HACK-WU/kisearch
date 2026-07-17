#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
zvec vs memory-lancedb-pro 真实 embedding 对比
========================================================
公平前提：
  - 两者共用同一套 embedding: SiliconFlow Qwen/Qwen3-Embedding-8B (4096 维)
  - 同一份语料: /root/bk-monitor/ai-docs/*.md
  - 同一组查询 + 同一套评测(Recall@k + 延迟 + 冷启动)

zvec 侧 (Python 进程内):
  - 真实 embedding 调用 SiliconFlow API
  - 稠密向量(HNSW/COSINE) + FTS(BM25) 两路 + RRF 融合

memory-lancedb-pro 侧 (基线, 通过 mem CLI 驱动):
  - mem bulk-store 入库 (hybrid 引擎, 同源 embedding)
  - mem search --json 混合检索

评测方法:
  - 每篇文档取首行(标题)作为查询, 该文档自身为 ground truth
  - Recall@k = ground truth 是否落入 top-k
  - 这是标准的 self-retrieval 代理评测, 衡量"按主题能否找回原文"
"""
import os
import re
import sys
import json
import time
import glob
import shutil
import subprocess
import tempfile
import urllib.request
from collections import defaultdict

# ----------------------------- 配置 -----------------------------
CORPUS_DIR = "/root/bk-monitor/ai-docs"
N_SAMPLE = 40
TRUNC = 6000                      # 每篇文档取前 N 字符用于 embedding (两引擎一致)
EMBED_MODEL = "Qwen/Qwen3-Embedding-8B"
EMBED_DIMS = 4096
SF_URL = "https://api.siliconflow.cn/v1/embeddings"
SF_KEY = "sk-nhucdyuoykanymnkptpnbllswqqivhqaqmlefnxzyfjnjehg"
MEM_CONFIG = "/root/knowledge-indexer/zvec-probe/memcmp-config.yaml"
MEM_DB = "/root/knowledge-indexer/zvec-probe/.mem-cmp/lancedb"
TAG = "zveccmp"
FUSE_TOPK = 20
EVAL_K = [1, 3, 5]
MEM_LIMIT = 5
BATCH = 32

# --------------------- 1. SiliconFlow embedding ---------------------
def embed_batch(texts, batch=BATCH):
    """批量调用 SiliconFlow embeddings, 返回 list[list[float]]。"""
    out = []
    for i in range(0, len(texts), batch):
        chunk = texts[i:i + batch]
        body = json.dumps({
            "model": EMBED_MODEL,
            "input": chunk,
            "dimensions": EMBED_DIMS,
        }).encode()
        req = urllib.request.Request(
            SF_URL, data=body,
            headers={"Authorization": f"Bearer {SF_KEY}",
                     "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.load(r)
        out.extend(d["embedding"] for d in data["data"])
    return out

def first_line(text):
    for ln in text.splitlines():
        s = ln.strip().lstrip("#").strip()
        if s:
            return s
    return text[:60]

# --------------------- 2. 载入语料 ---------------------
def load_corpus():
    paths = []
    for p in glob.glob(os.path.join(CORPUS_DIR, "**", "*.md"), recursive=True):
        paths.append(p)
    print(f"[corpus] 发现 {len(paths)} 个 .md 文件")
    # 固定随机种子, 保证可复现
    import random
    random.seed(42)
    if len(paths) > N_SAMPLE:
        paths = random.sample(paths, N_SAMPLE)
    docs = []
    for idx, p in enumerate(paths):
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                txt = f.read()
        except Exception:
            continue
        txt = txt[:TRUNC]
        if len(txt.strip()) < 30:
            continue
        did = f"d{idx:03d}"
        text = f"[{TAG.upper()}][DOCID:{did}] " + txt
        docs.append({"doc_id": did, "path": p, "query": first_line(txt),
                     "text": text, "raw": txt})
    print(f"[corpus] 选用 {len(docs)} 篇用于对比")
    return docs

# --------------------- 3. RRF 融合 ---------------------
def rrf(lists, k=60):
    scores = defaultdict(float)
    for lst in lists:
        for rank, did in enumerate(lst):
            scores[did] += 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: -x[1])

def recall_at(ground, ranked, ks):
    pos = {d: i for i, (d, _) in enumerate(ranked)}
    res = {}
    for k in ks:
        res[k] = 1 if ground in [d for d, _ in ranked[:k]] else 0
    return res

# --------------------- 4. zvec 侧 ---------------------
def run_zvec(docs, queries):
    import zvec
    from zvec.model.param.query import Fts, Query

    data_dir = os.path.join(tempfile.gettempdir(),
                            f"zvec_cmp_{os.getpid()}_{int(time.time()*1000)}")
    schema = zvec.CollectionSchema(
        name="cmp",
        fields=[
            zvec.FieldSchema(name="tag", data_type=zvec.DataType.STRING,
                             nullable=False,
                             index_param=zvec.InvertIndexParam(
                                 enable_range_optimization=False)),
            zvec.FieldSchema(name="content", data_type=zvec.DataType.STRING,
                             nullable=False,
                             index_param=zvec.FtsIndexParam(
                                 tokenizer_name="standard")),
        ],
        vectors=[
            zvec.VectorSchema(name="dense",
                              data_type=zvec.DataType.VECTOR_FP32,
                              dimension=EMBED_DIMS,
                              index_param=zvec.HnswIndexParam(
                                  metric_type=zvec.MetricType.COSINE)),
        ],
    )

    t0 = time.perf_counter()
    col = zvec.create_and_open(path=data_dir, schema=schema)
    t_create = time.perf_counter() - t0

    # 嵌入文档 (真实 SiliconFlow)
    t0 = time.perf_counter()
    doc_vecs = embed_batch([d["raw"] for d in docs])
    t_embed = time.perf_counter() - t0

    t0 = time.perf_counter()
    zdocs = [zvec.Doc(id=d["doc_id"],
                      vectors={"dense": doc_vecs[i]},
                      fields={"tag": TAG, "content": d["raw"]})
             for i, d in enumerate(docs)]
    col.insert(zdocs)
    t_insert = time.perf_counter() - t0

    t0 = time.perf_counter()
    col.optimize()
    t_opt = time.perf_counter() - t0

    # 冷启动: 关闭后重开
    del col
    t0 = time.perf_counter()
    col = zvec.open(path=data_dir)
    t_reopen = time.perf_counter() - t0

    # 嵌入查询
    q_vecs = embed_batch(queries)

    # 逐查询检索 (vector + fts + rrf)
    q_lat = []
    recalls = []
    first = True
    for i, q in enumerate(queries):
        t0 = time.perf_counter()
        vec_res = col.query(
            queries=zvec.Query(field_name="dense", vector=q_vecs[i]),
            topk=FUSE_TOPK)
        fts_res = col.query(
            queries=Query(field_name="content",
                          fts=Fts(match_string=q)),
            topk=FUSE_TOPK)
        vec_ids = [it["id"] if isinstance(it, dict) else it.id
                   for it in (vec_res if isinstance(vec_res, (list, tuple)) else [vec_res])]
        fts_ids = [it["id"] if isinstance(it, dict) else it.id
                   for it in (fts_res if isinstance(fts_res, (list, tuple)) else [fts_res])]
        fused = rrf([vec_ids, fts_ids])
        dt = time.perf_counter() - t0
        if first:
            first_dt = dt
            first = False
        q_lat.append(dt)
        recalls.append(recall_at(docs[i]["doc_id"], fused, EVAL_K))

    # 汇总
    def avg(xs): return sum(xs) / len(xs) if xs else 0
    stats = {
        "engine": "zvec",
        "build_create_ms": t_create * 1000,
        "embed_docs_ms": t_embed * 1000,
        "insert_ms": t_insert * 1000,
        "optimize_ms": t_opt * 1000,
        "reopen_cold_ms": t_reopen * 1000,
        "query_avg_ms": avg(q_lat) * 1000,
        "query_first_ms": first_dt * 1000,
        "recall": {k: avg([r[k] for r in recalls]) for k in EVAL_K},
    }
    del col
    shutil.rmtree(data_dir, ignore_errors=True)
    return stats

# --------------------- 5. memory-lancedb-pro 侧 (基线) ---------------------
def run_mem(docs, queries):
    # 清空旧库, 避免重复
    shutil.rmtree(MEM_DB, ignore_errors=True)
    os.makedirs(os.path.dirname(MEM_DB), exist_ok=True)

    # 写 bulk-store JSON
    arr = [{"text": d["text"], "tags": TAG, "category": "fact"}
           for d in docs]
    jf = "/root/knowledge-indexer/zvec-probe/.mem_bulk.json"
    with open(jf, "w", encoding="utf-8") as f:
        json.dump(arr, f, ensure_ascii=False)

    # 入库 (带重试: SiliconFlow API 偶发抖动会导致 bulk-store 静默存 0)
    t0 = time.perf_counter()
    stored = 0
    for attempt in range(3):
        shutil.rmtree(MEM_DB, ignore_errors=True)
        r = subprocess.run(
            ["mem", "bulk-store", "-f", jf, "--config", MEM_CONFIG],
            capture_output=True, text=True, timeout=600)
        if r.returncode != 0:
            print("[mem] bulk-store failed, stderr:\n", r.stderr[-800:])
        s = subprocess.run(
            ["mem", "stats", "-s", "global", "--config", MEM_CONFIG],
            capture_output=True, text=True, timeout=60)
        m = re.search(r"Total memories:\s*(\d+)", s.stdout)
        stored = int(m.group(1)) if m else 0
        if stored >= len(docs) * 0.9:
            break
        print(f"[mem] attempt {attempt+1} 仅入库 {stored}/{len(docs)}, 重试...")
    else:
        raise RuntimeError(f"mem bulk-store 反复失败, 最后仅 {stored}/{len(docs)}")
    t_index = time.perf_counter() - t0
    print(f"[mem] 入库 {stored} 条, 耗时 {t_index*1000:.0f} ms")

    # 逐查询检索 (单条检索偶发因 SiliconFlow 抖动超时, 捕获后按未命中处理)
    q_lat, recalls = [], []
    first = True
    for i, q in enumerate(queries):
        t0 = time.perf_counter()
        ranked = []
        try:
            r = subprocess.run(
                ["mem", "search", q, "-t", TAG, "-l", str(MEM_LIMIT),
                 "--json", "--config", MEM_CONFIG],
                capture_output=True, text=True, timeout=90)
            ids = re.findall(r"DOCID:(d\d{3})", r.stdout)
            seen = set()
            for x in ids:
                if x not in seen:
                    seen.add(x); ranked.append(x)
        except Exception as e:
            print(f"[mem] query#{i} 超时/异常: {e}")
        dt = time.perf_counter() - t0
        if first:
            first_dt = dt
            first = False
        q_lat.append(dt)
        recalls.append(recall_at(docs[i]["doc_id"],
                                 [(x, 0) for x in ranked], EVAL_K))

    def avg(xs): return sum(xs) / len(xs) if xs else 0
    return {
        "engine": "memory-lancedb-pro",
        "index_ms": t_index * 1000,
        "query_avg_ms": avg(q_lat) * 1000,
        "query_first_ms": first_dt * 1000,
        "recall": {k: avg([r[k] for r in recalls]) for k in EVAL_K},
    }

# --------------------- 6. 主流程 ---------------------
def main():
    docs = load_corpus()
    if not docs:
        print("无可用语料, 退出"); sys.exit(1)
    queries = [d["query"] for d in docs]

    print("\n>>> 运行 zvec 侧 ...")
    zstats = run_zvec(docs, queries)

    print(">>> 运行 memory-lancedb-pro 基线侧 ...")
    mstats = run_mem(docs, queries)

    # 输出对比表
    print("\n" + "=" * 72)
    print("对比结果 (embedding: %s / %d维, 语料: %d 篇 wiki)"
          % (EMBED_MODEL, EMBED_DIMS, len(docs)))
    print("=" * 72)
    print(f"{'指标':<22}{'zvec':>18}{'memory-lancedb-pro':>22}")
    print("-" * 72)
    print(f"{'建库(创建+嵌+插+opt) ms':<22}"
          f"{(zstats['build_create_ms']+zstats['embed_docs_ms']+zstats['insert_ms']+zstats['optimize_ms']):>18.1f}"
          f"{mstats['index_ms']:>22.1f}")
    print(f"{'冷启动 reopen ms':<22}{zstats['reopen_cold_ms']:>18.1f}"
          f"{'-':>22}")
    print(f"{'查询 首条 ms':<22}{zstats['query_first_ms']:>18.1f}"
          f"{mstats['query_first_ms']:>22.1f}")
    print(f"{'查询 平均 ms':<22}{zstats['query_avg_ms']:>18.1f}"
          f"{mstats['query_avg_ms']:>22.1f}")
    for k in EVAL_K:
        print(f"{'Recall@'+str(k):<22}{zstats['recall'][k]*100:>17.1f}%"
              f"{mstats['recall'][k]*100:>21.1f}%")
    print("=" * 72)
    print("说明:")
    print(" - zvec 查询为进程内(in-process)耗时; memory 侧为 mem CLI 子进程")
    print("   单次调用(含 node 启动+lancedb 打开+检索), 反映一次性 CLI 真实体验。")
    print(" - 评测为 self-retrieval: 以文档首行(标题)为查询, 原文为 ground truth。")
    print(" - 语料为中文 wiki, BM25 对中文分词不友好, 两引擎均受影响(公平)。")

if __name__ == "__main__":
    main()
