# zvec-mcp-server 工具参考文档

> 来源：`zvec-ai/zvec-mcp-server` (GitHub, v0.3.0, Apache-2.0)
> 源码结构：`src/zvec_mcp/{server.py, schemas.py, types.py, utils.py}`
> 用途：**仅作为后续开发 KiSearch Node MCP server 时的接口/能力参考**，非需求实现本身。
> 运行时：Python + `uvx` 分发（与 KiSearch 的 Node 前提不符，见末尾差距分析）。
> 配置（本环境实测）：`OPENAI_BASE_URL=https://api.siliconflow.cn/v1`，`OPENAI_EMBEDDING_MODEL=Qwen/Qwen3-Embedding-8B`。

---

## 工具总览（17 个）

| 分组 | 工具 | 一句话作用 |
|---|---|---|
| Collection | `create_and_open_collection` | 建库即打开（首次必须） |
| Collection | `open_collection` | 打开已有库（重启/挂载） |
| Collection | `get_collection_info` | 查看 schema/统计 |
| Collection | `destroy_collection` | 永久删除（不可逆） |
| Document | `insert_documents` | 仅插入（id 冲突则失败） |
| Document | `upsert_documents` | 插入或更新（幂等，最常用） |
| Document | `update_documents` | 仅更新指定字段（须已存在） |
| Document | `delete_documents` | 按 id 删除 |
| Document | `fetch_documents` | 按 id 取回 |
| Vector | `vector_query` | 单路向量检索 |
| Vector | `multi_vector_query` | 多路向量融合重排（dense+sparse） |
| Index | `create_index` | 补建索引 |
| Index | `drop_index` | 删索引 |
| Index | `optimize_collection` | 压实优化 |
| AI | `generate_dense_embedding` | 文本→向量（试算/预生成） |
| AI | `embedding_write` | 文本自动向量化并写入 |
| AI | `embedding_search` | 自然语言端到端语义检索 |

---

## 核心概念导航（先看这个）

> 读工具详情前，先建立三个层级 + 两种字段的心智模型，否则容易把 `create_index` 和 `create_and_open_collection` 当成平级概念。

### 1. 三层结构：集合 → 字段 → 索引

```
Collection（集合，顶层容器）
 ├─ 文档们（id + vectors + fields）
 ├─ 字段 schema
 │   ├─ 向量字段 dense（dimension=1024, metric=COSINE）
 │   │     └─ 索引：HNSW  ←─ create_index 作用的对象
 │   └─ 标量字段 tag
 │         └─ 索引：INVERT  ←─ create_index 作用的对象
```

- **Collection** ≈ 一张数据库表（含表结构），管"存什么"。由 `create_and_open_collection` / `open_collection` 管理。
- **字段 schema** ≈ 表里的列定义，分向量字段和标量字段两种。
- **Index** ≈ 字段上的加速结构（向量字段建 HNSW/IVF/FLAT，标量字段建 INVERT），管"查得快不快"。由 `create_index` / `drop_index` / `optimize_collection` 管理。
- **关系**：索引**不是独立存在的**，必须依附在某个集合的某个字段上。`create_and_open_collection` 是一次性建库（同一会话不能重开，见实测坑 3），所以事后想加/换索引才需要独立的 `create_index`。

### 2. 两种字段：向量字段 vs 标量字段

| | 向量字段（vector field） | 标量字段（scalar field） |
|---|---|---|
| 存什么 | 一坨浮点数组成的向量（embedding），如 `dense:[0.12,-0.03,...]`（1024 维） | 单个普通值：文本/数字/布尔，如 `tag:"ki-relation"`、`path:"src/x.ts"` |
| 用来干嘛 | 做**相似度检索**（"哪条最像"） | 做**精确过滤** + **结果展示**（"在哪范围找""命中后展示什么"） |
| 索引类型 | HNSW / IVF / FLAT（加速向量检索） | INVERT 倒排索引（加速 `tag == "xxx"` 过滤） |
| 支持类型 | `VECTOR_FP32` 等 | `STRING` `BOOL` `INT32/64` `FLOAT/DOUBLE` `UINT32/64` |
| 类比 | 书的"内容语义指纹" | 书的"书名/作者/分类标签" |

一条文档的真实样子（向量字段负责"搜得准"，标量字段负责"筛得动、看得懂"）：
```json
{
  "id": "r1",
  "vectors": { "dense": [0.1, 0.2, ...] },                       // 向量字段：搜相似
  "fields":  { "tag": "ki-relation", "path": "src/sync/relation.ts" }  // 标量字段：过滤+展示
}
```

### 3. 四种索引的区别（向量索引三选一 + 标量倒排）

> 前三个（HNSW/FLAT/IVF）只用在**向量字段**上加速"相似度检索"；INVERT 只用在**标量字段**上加速"等值/范围过滤"。这是两类完全不同的索引。

**先分大类**
| 索引 | 用在哪 | 加速什么 | 类比 |
|---|---|---|---|
| HNSW / FLAT / IVF | 向量字段 | 向量相似度检索（"找最像的"） | 图书馆的"找相似书"导航 |
| INVERT | 标量字段 | 精确过滤（`tag == "xxx"`、`score > 0.8`） | 书的"分类标签抽屉" |

**向量索引三选一（权衡：查询速度 vs 内存 vs 精度）**
- **FLAT（暴力精确）**：不建结构，逐对算距离取 top-k。结果 100% 精确，但 O(N) 随数据量变慢。适用：文档少（几千内）或小库且零容忍精度损失。默认 `metric=IP`。
- **IVF（倒排文件·近似）**：把向量空间聚成 `nlist` 个簇（默认 128），查询只进最近的几个簇搜。比 FLAT 快很多，但是**近似**（最近向量若在未选中簇会漏）。适用：百万级大数据集且可接受少量损失。默认 `metric=IP, nlist=128`。
- **HNSW（分层可导航小世界·最常用）**：多层图结构，上层跳跃、下层精确定位。查询快、召回质量高（近似但效果好），但建索引与内存开销大。可调 `m`（默认 50）、`ef_construction`（默认 500）。适用：绝大多数中到大规模、低延迟场景。本库建库即用它（`m:16, ef_construction:200`）。

直觉取舍：`精度 FLAT > HNSW > IVF`；`速度 HNSW ≈ IVF >> FLAT`；`内存 HNSW > IVF > FLAT`。

**INVERT（标量倒排索引）**
- 原理：为每个标量值建"值 → 文档 id 列表"映射，查 `tag == "ki-relation"` 直接定位，不全表扫。
- 可开 `enable_range_optimization`（默认 false）额外加速数值范围查询（`score > 0.8`）。
- 只能建在**标量字段**上；HNSW/IVF/FLAT 只能建在**向量字段**上，二者互斥不可混用。

**它们如何共存**（一次混合查询的分工）：
```
集合 kib_test
 ├─ 向量字段 dense → HNSW   → 加速「相似度检索」
 └─ 标量字段 tag   → INVERT → 加速「filter 过滤」
```
`embedding_search(query, filter='tag=="ki-relation"')` 流程：① HNSW 在 dense 上快速召回 top-k 候选 → ② INVERT 用 tag 过滤掉不符的 → ③ 返回结果。两者互补，构成一次高效混合查询。

---

## 通用类型（types.py）

### DataTypeEnum（字段数据类型）
- 标量：`STRING` `BOOL` `INT32` `INT64` `FLOAT` `DOUBLE` `UINT32` `UINT64`
- 稠密向量：`VECTOR_FP16` `VECTOR_FP32` `VECTOR_FP64` `VECTOR_INT8`
- 稀疏向量：`SPARSE_VECTOR_FP32` `SPARSE_VECTOR_FP16`

### MetricTypeEnum（距离/相似度度量）
`COSINE`（余弦） `IP`（内积，server 默认） `L2`（欧氏）
> ⚠️ 实测：`COSINE` 下返回 `score` 是**距离**，越小越相似，不是相似度。

### IndexTypeEnum（向量索引）
`HNSW`（分层可导航小世界，最常用） `IVF`（倒排文件，大数据集） `FLAT`（暴力精确，小数据集）

### QuantizeTypeEnum（向量压缩，省内存）
`UNDEFINED`（默认，不压缩） `FP16` `INT8`

### ResponseFormat
`MARKDOWN`（默认，人类可读） `JSON`（便于程序解析）

### 文档通用结构 `DocumentInput`
```json
{
  "id": "string",
  "vectors": { "dense": [0.1, 0.2], "sparse": {"17": 0.5} },
  "fields":  { "tag": "ki-relation", "path": "src/x.ts" }
}
```
- `vectors`：字段名 → 稠密 `List[float]` 或 稀疏 `Dict[int,float]`
- `fields`：任意标量键值对（对应建库时声明的 scalar_fields）

---

## 一、Collection Management（集合生命周期）

### 1. `create_and_open_collection` —— 建库即打开（首次初始化必用）
**作用**：在磁盘 `path` 下创建一个新集合（含 schema：向量字段维度、标量字段、索引），并立即把它装入 MCP 会话缓存，使后续所有工具都能通过 `collection_name` 引用它。等价于"定义结构 + 物理落盘 + 注册到内存"三件事一次完成。

**关键参数**
| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `path` | str | ✅ | 集合落盘目录（如 `/data/kb_zvec`） |
| `collection_name` | str | ✅ | 会话内缓存键（后续工具凭它引用，**不必等于磁盘目录名**） |
| `vector_fields` | `VectorFieldInput[]` | ✅ | ≥1 个，含 `name`/`data_type`/`dimension`，可带 `index_param` |
| `scalar_fields` | `ScalarFieldInput[]` | ❌ | 标量字段，可带 `index_param: INVERT`（倒排，加速过滤） |

`VectorFieldInput`：`name:str`, `data_type:DataTypeEnum`, `dimension:int(≥1)`, `index_param?:HNSW|FLAT|IVF`
`ScalarFieldInput`：`name:str`, `data_type:DataTypeEnum`, `nullable:bool=false`, `index_param?:INVERT`

**使用场景**
- 知识库**第一次搭建**：定义好文档要存哪些向量字段（维度、度量）和标量字段（用于过滤的标签、路径）。
- 示例：`dense` 字段 1024 维 + HNSW/COSINE 索引；标量 `tag`（INVERT 索引，便于按"ki-relation/ki-search"过滤）、`path`（存源码路径）。

**典型调用**
```json
{
  "params": {
    "path": "/root/kb/mcp_live_kb",
    "collection_name": "kib_test",
    "vector_fields": [
      {"name":"dense","data_type":"VECTOR_FP32","dimension":1024,
       "index_param":{"type":"HNSW","metric_type":"COSINE","m":16,"ef_construction":200}}
    ],
    "scalar_fields": [
      {"name":"tag","data_type":"STRING","index_param":{"type":"INVERT"}},
      {"name":"path","data_type":"STRING"}
    ]
  }
}
```

**实测注意**
- ✅ 实测 1024 维 dense + tag(INVERT)/path 标量，2 索引建好。
- ⚠️ `dimension` 必须落在 embedding 模型支持区间（见「实测经验」坑 2）。

---

### 2. `open_collection` —— 打开已有库（重启/挂载复用）
**作用**：对于一个已经存在于磁盘的集合（通常是上次 `create_and_open_collection` 生成的），把它重新装入当前会话缓存，使其可被读写/查询。不创建新数据，只"挂载"。

**关键参数**
| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `path` | str | ✅ | — |
| `collection_name` | str | ✅ | — |
| `read_only` | bool | ❌ | `false` |

**使用场景**
- **MCP 服务重启后**：上次会话的缓存已丢失，必须重新 `open` 才能继续用。
- **只读查询端**：设 `read_only=true`，给只做检索的客户端用，避免误写。
- 注意：若你不确定库在不在，稳妥顺序是"先 `open_collection`，失败再 `create_and_open_collection`"。

**实测注意**
- ❌ 实测：同一会话内已 `create` 过该库，`open_collection(read_only=true)` 报 `Can't lock read-only collection: .../LOCK`。原因：会话内已持有该库的可写句柄与 LOCK 文件，二次打开冲突。**要验证持久化得另起一个 MCP 进程**。

---

### 3. `get_collection_info` —— 查看 schema 与统计
**作用**：返回集合的路径、向量字段（名/类型/维度/索引）、标量字段、文档总数等元信息。只读，不改数据。

**关键参数**
| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `collection_name` | str | ✅ | — |
| `response_format` | markdown/json | ❌ | markdown |

**使用场景**
- 调试时确认"维度/索引是否按预期生效"（如确认 dense 是 1024 维、tag 有 INVERT 索引）。
- 写入前后对比 `doc_count`，确认写入/删除是否落盘。
- 程序侧用 `response_format=json` 解析结构做自检。

**实测注意**
- ✅ 实测：建库后 `doc_count=6`；删除 r6 后变 `5`，证明落盘生效。

---

### 4. `destroy_collection` —— 永久删除集合（不可逆）
**作用**：调用 `collection.destroy()` 并从会话缓存移除，**物理删除磁盘上的集合目录**。操作不可恢复。

**关键参数**
| 参数 | 类型 | 必填 |
|---|---|---|
| `collection_name` | str | ✅ |

**使用场景**
- 测试库重建：清空后重新 `create_and_open_collection`。
- 迁移/换 schema：旧库作废时清理。
- ⚠️ 生产环境慎用，无回收站。

---

## 二、Document Operations（文档增删改查）

> 所有工具均依赖集合已在会话缓存中（先 `create`/`open`）。文档结构见上文 `DocumentInput`。

### 5. `insert_documents` —— 仅插入（严格防覆盖）
**作用**：批量插入新文档；若其中任意 `id` 已存在，则**整体失败**（不覆盖、不部分写入）。
**关键参数**：`collection_name`, `documents[]`（每个即 `DocumentInput`）。
**使用场景**
- 全量首次灌库且**保证 id 唯一**时，用它能立刻发现重复 id 的脏数据。
- 与 `fetch_documents` 配合：先查 id 是否存在，不存在才 `insert`，实现"严格不覆盖"语义。

### 6. `upsert_documents` —— 插入或更新（幂等，最常用）
**作用**：文档不存在则插入，已存在则**全量覆盖**（用新向量+新字段替换旧值）。天然幂等——重复调用结果一致。
**关键参数**：同 `insert_documents`。
**使用场景**
- **增量同步 / 重新索引**：扫描代码库重新写入时，重复执行不会报错，自动覆盖旧版本。
- 绝大多数"写文档"场景首推这个，比 `insert` 省心。

### 7. `update_documents` —— 仅更新指定字段（须已存在）
**作用**：对**已存在**的文档，只更新其 `vectors`/`fields` 中提供的部分字段，其余保持不变。文档不存在则失败。
**关键参数**：`collection_name`, `documents[]`（提供 id + 要改的字段）。
**使用场景**
- 局部修正：例如只更新某文档的 `tag` 标签或 `path`，不想重新算一整条 embedding。
- 补字段：建库时漏了某个标量字段，事后批量补。

### 8. `delete_documents` —— 按 id 删除
**作用**：根据 `document_ids: str[]` 从集合中删除文档（落盘）。
**关键参数**：`collection_name`, `document_ids`。
**使用场景**
- 文件被删除/重命名时，清理对应知识条目。
- 实测 ✅：删除 r6 后 `doc_count` 6→5，检索不再返回。

### 9. `fetch_documents` —— 按 id 取回
**作用**：根据 `document_ids: str[]` 取回完整文档（含向量与标量字段）。
**关键参数**：`collection_name`, `document_ids`, `response_format`（默认 markdown）。
**使用场景**
- 结果展开：向量检索返回 id 后，用 `fetch` 取原文/路径展示给用户。
- 调试：核对某条文档的向量或字段是否正确。
- 实测 ✅：返回含完整向量与字段。

---

## 三、Vector Search（向量检索）⚠️ 只有向量检索，无 FTS/BM25 关键词工具

### 10. `vector_query` —— 单路向量相似度检索
**作用**：用一条已知向量，在指定向量字段上做 top-k 相似度召回，可选标量过滤。返回 id + score。

**关键参数**
| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `field_name` | str | ✅ | — |
| `vector` | `List[float]` | ✅ | — |
| `topk` | int | ❌ | `10`（上限 1000） |
| `filter` | str | ❌ | `null`（如 `'tag == "ki-relation" AND score > 0.8'`） |
| `response_format` | markdown/json | ❌ | markdown |

**使用场景**
- 你已经有一段 query 的 embedding（比如先调 `generate_dense_embedding`，或自己算好），想直接做单字段相似召回。
- 配合 `filter` 做"在 ki-relation 标签下找最相似的 3 条"。
- 适用于只有稠密向量的简单语义检索，不需要稀疏/融合。

**注意**
- 通常你要先有向量：要么用 `generate_dense_embedding` 预生成，要么走端到端的 `embedding_search`。

---

### 11. `multi_vector_query` —— 多路向量融合重排（混合检索）
**作用**：对**≥2 条向量**（可来自不同字段，如一条稠密、一条稀疏）分别做召回，再用重排器（加权 / RRF）融合成最终 top-n 结果。这是 server 唯一称得上"混合"的能力。

**关键参数**
| 参数 | 类型 | 必填 | 默认 |
|---|---|---|---|
| `vectors` | `MultiVectorQuerySpec[]` | ✅ | **≥2 条** |
| `topk` | int | ❌ | `10`（每路候选） |
| `topn` | int | ❌ | `5`（重排后最终返回） |
| `reranker_type` | `weighted`\|`rrf` | ❌ | `weighted` |
| `weights` | `Dict[field,float]` | ❌ | `null`（如 `{"dense":1.2,"sparse":1.0}`） |
| `rank_constant` | int | ❌ | `60`（RRF 用） |
| `metric_type` | COSINE/IP/L2 | ❌ | `IP` |
| `filter` | str | ❌ | `null` |

`MultiVectorQuerySpec`：`{field_name:str, vector: List[float] | Dict[int,float]}`。
重排器：`WeightedReRanker(topn, metric, weights)` 或 `RrfReRanker(topn, rank_constant)`。

**使用场景**
- **稠密 + 稀疏双塔混合**：`dense` 用 embedding 语义向量，`sparse` 用 BM25/词项权重编码成 `Dict[int,float]`，两路融合提升召回质量（类似我们 Node demo 的 `multiQuerySync`，但此处 sparse 需你自己预编码）。
- 多字段语义融合：如代码注释向量 + 文档向量两路合并。

> **关键限制**：所谓"混合"是**向量空间内 dense + sparse 两路融合**，sparse 必须预先把关键词编码成 `Dict[int,float]` 喂入。**server 没有任何字符串关键词匹配 (FTS) 工具**——你不能直接传 `"syncRelation"` 这种字符串让它做精确符号匹配。代码符号精确召回必须用我们 Node 侧已验证的原生 `multiQuerySync({fts:{matchString}})`。

---

## 四、Index Management（索引维护）

### 12. `create_index` —— 补建索引
**作用**：建库时若某字段没带 `index_param`，事后用此工具补建索引（向量索引 HNSW/FLAT/IVF 或标量倒排 INVERT）。

**关键参数**
| 参数 | 类型 | 必填 |
|---|---|---|
| `collection_name` | str | ✅ |
| `field_name` | str | ✅ |
| `index_param` | HNSW/FLAT/IVF/INVERT（按 `type` 判别） | ✅ |

**索引参数默认值**
- HNSW：`metric=IP, m=50, ef_construction=500, quantize=UNDEFINED`
- IVF：`metric=IP, nlist=128`
- FLAT：`metric=IP`（精确暴力）
- INVERT：`enable_range_optimization=false`
- 量化：`UNDEFINED` / `FP16` / `INT8`

**使用场景**
- 建库时忘记给 `tag` 加 INVERT 索引，现在想加速 `tag == "xxx"` 过滤 → 补 `create_index({type:"INVERT"})`。
- 数据量变大，把 FLAT 换成 HNSW 提升查询速度（需先 `drop_index` 再建）。

### 13. `drop_index` —— 删除索引
**作用**：移除某字段上的索引（`collection.drop_index(field_name)`）。删除后该字段退化为无索引状态（查询变慢但可写）。
**关键参数**：`collection_name`, `field_name`。
**使用场景**
- 想更换索引类型（如 HNSW→IVF）：先 `drop_index` 再 `create_index`。
- 大批量写入前先 `drop` 索引加速写入，写完再重建。

### 14. `optimize_collection` —— 压实优化
**作用**：调用 `collection.optimize()`，合并/压实底层文件、整理索引，使后续查询更快、占用更紧凑。
**关键参数**：`collection_name`。
**使用场景**
- 大批量写入或建库完成后调用一次，像"整理碎片"。
- 周期性维护：知识库更新频繁时定期 `optimize`。

---

## 五、AI Embedding（自带 OpenAI 兼容 embedding）

> 这 3 个工具让 server **自己调用 embedding 模型**，你不必预先算向量。凭证读环境变量 `OPENAI_API_KEY` / `OPENAI_BASE_URL`（本环境指向 SiliconFlow）。

### 15. `generate_dense_embedding` —— 文本→向量（试算/预生成）
**作用**：把一段 `text` 经 embedding 模型转成向量返回，供你在调 `vector_query`/`multi_vector_query` 前手动持有向量，或单纯试算维度/效果。

**关键参数**
| 参数 | 默认 |
|---|---|
| `text` | ✅ |
| `api_key` / `base_url` | 不传用环境变量 |
| `model` | `text-embedding-3-small` |
| `dimension` | `1536` |

**使用场景**
- 先单独看 embedding 长啥样、维度对不对，再决定建库 `dimension`。
- 你需要自己持有 query 向量去做 `vector_query` 时，用它生成。

**实测注意**
- ⚠️ `dimension=8` → 400 报错（`code=20015 parameter invalid`）；`dimension=1024` → ✅。维度须在模型支持区间内。本环境模型 `Qwen/Qwen3-Embedding-8B` 用 1024 稳妥。

### 16. `embedding_write` —— 文本自动向量化并写入（最省事写入路径）
**作用**：你只喂 `{id, text, fields}`，server 内部自动 `embed(text)` → 组装 `zvec.Doc` → `upsert`。**维度从集合 schema 自动推断**，无需手动算向量。

**关键参数**：`collection_name`, `field_name`, `documents:[{id, text, fields}]`。
**使用场景**
- **KiSearch 扫描 kb → 写库**若走这条路，连 SiliconFlow 调用都不用自己写，喂文本即可。
- 绝大多数"把文本灌进向量库"的需求直接用它。
- 实测 ✅：6/6 写入成功，SiliconFlow 链路打通。

### 17. `embedding_search` —— 自然语言端到端语义检索（最省事查询路径）
**作用**：你直接丢一句人话 `query_text`，server 内部 `embed(query_text)` → `vector_query`，返回相似文档。
**关键参数**：`collection_name`, `field_name`, `query_text`, `topk=10`, `filter`, `response_format`。
**使用场景**
- 最快验证语义检索：不需要任何向量预处理，直接问自然语言。
- 实测 ✅：问"如何同步两个知识实体之间的关系" → 最相关 r1 排首（`score=0.16` 最小，见坑 1）。

---

## 与 KiSearch 需求的差距分析（关键）

| 需求点 | 官方 server | 说明 |
|---|---|---|
| 进程内 / Node | ❌ | Python/uvx，引入第二运行时 |
| 常驻 MCP 服务 | ✅ | 本身就是 MCP server |
| 语义混合检索（dense+sparse） | ✅ | `multi_vector_query` |
| **关键词/FTS 精确召回**（代码符号） | ❌ | **无 FTS 工具**，仅向量空间融合 |
| 领域模型（ki-relation/path/scope） | ❌ | 通用向量库，不懂 KiSearch 概念 |
| 自动 embedding 写入/查询 | ✅ | `embedding_write`/`embedding_search` 开箱即用 |
| SiliconFlow 接入 | ✅ | 配 `OPENAI_BASE_URL=https://api.siliconflow.cn/v1` 即可 |

**结论**：官方 server 是开箱即用的通用 zvec 检索 MCP；但缺 FTS 关键词召回、且为 Python 非 Node，与 KiSearch「Node 进程内 + BM25 代码符号召回 + 领域模型」三前提不兼容。
KiSearch Node 方案应**借用其 17 工具词表作接口蓝本**，并在 `multi_vector_query` 对应位置替换为已验证的原生 `multiQuerySync({fts:{matchString}, vector, rerank:{type:'rrf'}})`（真正的字符串 FTS + 向量融合）。

---

## 实测经验（2026-07-17 真机跑通，SiliconFlow `Qwen/Qwen3-Embedding-8B`）

> 通过真实 MCP 会话逐工具调用验证，记录与文档/直觉不符的**真实行为**。

### 测试流程与结果
| 步骤 | 工具 | 结果 |
|---|---|---|
| 1 | `create_and_open_collection` | ✅ 1024 维 dense + tag(INVERT)/path 标量，2 索引建好 |
| 2 | `embedding_write` | ✅ 6/6 写入（SiliconFlow 自动 embedding 链路打通） |
| 3 | `embedding_search` | ✅ 语义检索可用；最相关 r1 排首但 `score=0.16` **最小** |
| 4 | `get_collection_info` | ✅ doc_count=6，schema 正确 |
| 5 | `fetch_documents` | ✅ 按 id 返回完整向量+字段 |
| 6 | `generate_dense_embedding` | ⚠️ `dimension=8` → **400 报错**；`dimension=1024` → ✅ |
| 7 | `open_collection(read_only)` | ❌ `Can't lock read-only collection: .../LOCK` |
| 8 | `delete_documents` | ✅ 删除 r6 |
| 9 | `get_collection_info` / `embedding_search` | ✅ doc_count=5，r6 不再出现 → **删除已落盘** |

### 三个真实坑（必读）
1. **`score` 是距离不是相似度**：COSINE 度量下，返回 `score` 越小越相似（两次查询均验证：最相关项分值最低）。做重排/阈值判断时切勿当成"分数越高越好"。
2. **embedding 维度必须在模型支持区间内**：`Qwen/Qwen3-Embedding-8B` 经 SiliconFlow 时，`dimension=8` 触发 `400 code=20015 parameter invalid`；`dimension=1024` 正常。`embedding_write`/`embedding_search` 的维度取自集合 schema，故**建库 `dimension` 要选模型支持的值**（1024 稳妥）。
3. **同会话无法重开同一集合**：集合首次 `create_and_open` 后在服务端会话内缓存并持有 `LOCK` 文件；再次 `open_collection`（即便 `read_only=true`）报 LOCK 冲突。因此**无法在同一运行会话内"重开"验证持久化**——持久化靠落盘文件保障（已验证删除落盘 doc_count 6→5）。

### 结论补充
- SiliconFlow + `Qwen/Qwen3-Embedding-8B` 接入正常，env 配置（`OPENAI_BASE_URL=https://api.siliconflow.cn/v1`、`OPENAI_EMBEDDING_MODEL`）生效。
- 与文档一致：**无 FTS/BM25 关键词工具**；`multi_vector_query` 仅向量空间 dense+sparse 融合，不接收字符串关键词。
- 若需验证"重开持久化"，应**另起一个 MCP 会话**（进程重启）再 `open_collection`，而非在同一会话内二次打开。
