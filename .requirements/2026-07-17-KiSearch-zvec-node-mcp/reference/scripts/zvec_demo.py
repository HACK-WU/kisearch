#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Zvec 引擎验证 Demo (Python)
==================================================
模拟 KiSearch 的向量化场景，验证 alibaba/zvec 是否满足诉求：
  1. 轻量、进程内、无服务
  2. Node/Python 友好（本 demo 用 Python SDK，等价验证引擎能力）
  3. 混合检索：稠密向量 + 全文 BM25(FTS) + 标量过滤(tag)
  4. 冷启动耗时（类比 `ki search` 一次性 CLI 的打开+首查延迟）
  5. 持久化（关闭后重开仍可检索）
  6. 对“代码符号/函数名”的精确召回质量（KiSearch 刚需）

注意：
  - zvec 单 Query 中 fts 与 vector 互斥，因此混合检索 = 分别跑两路 + RRF 融合
    （与 memory-lancedb-pro 的融合层思路一致，只是引擎换成了 zvec）。
  - 为保持 demo 自包含、不依赖重模型，稠密向量用「词哈希 bag-of-words + L2 归一化」
    生成（共享词 => 向量相近），仅用于验证 API 与融合流程；真实部署可替换为
    sentence-transformers / OpenAI embedding。
  - FTS(BM25) 才是代码符号精确匹配的主力，vector 作为语义补充。

安装：
  pip install zvec            # 官方 PyPI 包（quickstart 推荐）
  # 若失败（无预编译 wheel / 需本地编译 C++17+CMake）：
  #   git clone --recurse-submodules https://github.com/alibaba/zvec.git
  #   cd zvec && pip install .
"""

import os
import re
import math
import time
import shutil
import tempfile
import traceback
from collections import defaultdict


# ----------------------------------------------------------------------------
# 0. 轻量 embedding：词哈希 bag-of-words（仅用于 demo，非生产 embedding）
# ----------------------------------------------------------------------------
DIM = 256  # 向量维度（demo 用低维，足够验证流程）


def embed(text: str, dim: int = DIM) -> list[float]:
    """将文本转为固定维度稠密向量（共享词 => 余弦相近）。"""
    vec = [0.0] * dim
    toks = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", (text or "").lower())
    for t in toks:
        h = hash(t) % dim
        vec[h] += 1.0
    norm = math.sqrt(sum(v * v for v in vec))
    if norm > 0:
        vec = [v / norm for v in vec]
    return vec


# ----------------------------------------------------------------------------
# 1. 模拟 KiSearch 数据（relation / search / path 三类，对应 ki-relation/ki-search/ki-path）
# ----------------------------------------------------------------------------
# 每条: (doc_id, tag, scope, content文本)
SAMPLE = [
    ("r1", "ki-relation", "projA",
     "syncRelation data vectorize embedding when relation value changes"),
    ("r2", "ki-relation", "projA",
     "buildRelationContent groupPath keywords relation text"),
    ("r3", "ki-relation", "projB",
     "relation syncRelation pending vector write back setImmediate"),
    ("s1", "ki-search", "projA",
     "ki search full text BM25 hybrid retrieval code symbol"),
    ("s2", "ki-search", "projB",
     "semantic search over indexed modules and relations"),
    ("s3", "ki-search", "projA",
     "syncRelation vectorize sync relation data store memory"),
    ("p1", "ki-path", "projA",
     "groupPath module index relation keyword path hierarchy"),
    ("p2", "ki-path", "projB",
     "module group path keywords buildGroupPathContent"),
]


def get_ids(result):
    """鲁棒地解析 zvec query 返回的 id 列表（兼容对象/字典两种形态）。"""
    ids = []
    items = result if isinstance(result, (list, tuple)) else [result]
    for it in items:
        i = None
        if hasattr(it, "id"):
            i = it.id
        elif isinstance(it, dict) and "id" in it:
            i = it["id"]
        elif hasattr(it, "__getitem__"):
            try:
                i = it["id"]
            except Exception:
                i = None
        if i is not None:
            ids.append(i)
    return ids


def rrf(lists, k: int = 60):
    """Reciprocal Rank Fusion：融合多路召回。"""
    scores = defaultdict(float)
    for lst in lists:
        for rank, doc_id in enumerate(lst):
            scores[doc_id] += 1.0 / (k + rank + 1)
    return sorted(scores.items(), key=lambda x: -x[1])


def main():
    import zvec  # 放在函数内，便于给出友好的未安装提示

    print("=" * 70)
    print("Zvec 引擎验证 Demo")
    print("=" * 70)

    # 使用临时目录存放 collection，避免污染工作区
    # 注意：zvec.create_and_open 要求 path 不存在（由它自己创建），
    # 因此只生成路径名，不要预先用 mkdtemp 创建目录。
    data_dir = os.path.join(
        tempfile.gettempdir(),
        f"zvec_probe_{os.getpid()}_{int(time.time()*1000)}",
    )
    print(f"[setup] collection path: {data_dir}")

    # ------------------------------------------------------------------
    # 2. 定义 Schema：稠密向量 + FTS 全文 + 标量过滤(tag/scope)
    # ------------------------------------------------------------------
    schema = zvec.CollectionSchema(
        name="kisearch_probe",
        fields=[
            zvec.FieldSchema(
                name="tag",
                data_type=zvec.DataType.STRING,
                nullable=False,
                index_param=zvec.InvertIndexParam(enable_range_optimization=False),
            ),
            zvec.FieldSchema(
                name="scope",
                data_type=zvec.DataType.STRING,
                nullable=False,
            ),
            zvec.FieldSchema(
                name="content",
                data_type=zvec.DataType.STRING,
                nullable=False,
                index_param=zvec.FtsIndexParam(tokenizer_name="standard"),
            ),
        ],
        vectors=[
            zvec.VectorSchema(
                name="dense",
                data_type=zvec.DataType.VECTOR_FP32,
                dimension=DIM,
                index_param=zvec.HnswIndexParam(metric_type=zvec.MetricType.COSINE),
            ),
        ],
    )

    # ------------------------------------------------------------------
    # 3. 创建 + 插入 + optimize（计时：冷创建）
    # ------------------------------------------------------------------
    t0 = time.perf_counter()
    col = zvec.create_and_open(path=data_dir, schema=schema)
    t_create = time.perf_counter() - t0

    t0 = time.perf_counter()
    docs = [
        zvec.Doc(
            id=did,
            vectors={"dense": embed(content)},
            fields={"tag": tag, "scope": scope, "content": content},
        )
        for (did, tag, scope, content) in SAMPLE
    ]
    col.insert(docs)
    t_insert = time.perf_counter() - t0

    t0 = time.perf_counter()
    col.optimize()
    t_optimize = time.perf_counter() - t0

    print(f"[perf] create_and_open : {t_create*1000:8.1f} ms")
    print(f"[perf] insert {len(docs)} docs : {t_insert*1000:8.1f} ms")
    print(f"[perf] optimize         : {t_optimize*1000:8.1f} ms")

    # ------------------------------------------------------------------
    # 4. 冷启动检索计时（类比 ki search 一次性打开 + 首查）
    # ------------------------------------------------------------------
    query_text = "syncRelation vectorize"
    qvec = embed(query_text)

    t0 = time.perf_counter()
    # 4a. 稠密向量检索
    vec_res = col.query(
        queries=zvec.Query(field_name="dense", vector=qvec),
        topk=10,
    )
    t_vec = time.perf_counter() - t0
    vec_ids = get_ids(vec_res)

    t0 = time.perf_counter()
    # 4b. 全文 BM25 检索（代码符号精确匹配主力）
    from zvec.model.param.query import Fts, Query
    fts_res = col.query(
        queries=Query(field_name="content", fts=Fts(match_string=query_text)),
        topk=10,
    )
    t_fts = time.perf_counter() - t0
    fts_ids = get_ids(fts_res)

    # 4c. RRF 混合融合
    t0 = time.perf_counter()
    fused = rrf([vec_ids, fts_ids])
    t_fuse = time.perf_counter() - t0

    print("-" * 70)
    print(f"[query] '{query_text}'")
    print(f"  vector topk : {vec_ids}  ({t_vec*1000:.1f} ms)")
    print(f"  fts    topk : {fts_ids}  ({t_fts*1000:.1f} ms)")
    print(f"  RRF fused   : {[d for d, _ in fused]}  (fuse {t_fuse*1000:.2f} ms)")
    print("-" * 70)

    # ------------------------------------------------------------------
    # 5. 标量过滤（tag 维度隔离，对应 KiSearch 的多作用域/多 tag）
    # ------------------------------------------------------------------
    filtered = col.query(
        queries=zvec.Query(field_name="dense", vector=qvec),
        filter="tag = 'ki-relation'",
        topk=10,
    )
    print(f"[filter] tag='ki-relation' -> {get_ids(filtered)}")

    # ------------------------------------------------------------------
    # 6. 持久化验证：关闭后重新打开，检索仍可用
    # ------------------------------------------------------------------
    del col
    t0 = time.perf_counter()
    col2 = zvec.open(path=data_dir)
    reopen = time.perf_counter() - t0
    re_res = col2.query(
        queries=Query(field_name="content", fts=Fts(match_string="syncRelation")),
        topk=5,
    )
    print(f"[persist] reopen : {reopen*1000:8.1f} ms")
    print(f"[persist] fts 'syncRelation' after reopen -> {get_ids(re_res)}")

    # ------------------------------------------------------------------
    # 7. 诊断：打印一次原始 result 结构（确认字段名，便于后续适配）
    # ------------------------------------------------------------------
    print("-" * 70)
    print("[diag] raw fts result (first item repr):")
    try:
        sample_item = re_res[0] if isinstance(re_res, (list, tuple)) and re_res else re_res
        print("   ", repr(sample_item)[:300])
    except Exception as e:
        print("   diag skipped:", e)

    shutil.rmtree(data_dir, ignore_errors=True)
    print("=" * 70)
    print("Demo 完成。")
    print("=" * 70)


if __name__ == "__main__":
    try:
        main()
    except ImportError as e:
        print("✗ 未安装 zvec。请先执行: pip install zvec")
        print("  （若 PyPI 无预编译 wheel，需源码编译: "
              "git clone --recurse-submodules https://github.com/alibaba/zvec.git && cd zvec && pip install .）")
        print("  原始错误:", e)
    except Exception as e:
        traceback.print_exc()
