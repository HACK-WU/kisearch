# zvec

> 阿里巴巴开源的嵌入式（进程内）向量数据库，Rust 内核。KiSearch 选定其替换 `memory-lancedb-pro`(lancedb) 作为向量引擎。

## 基本信息

| 字段 | 内容 |
|---|---|
| 类型 | SDK / 嵌入式向量数据库（进程内，无 server/daemon） |
| 官方文档 | https://zvec.org/en/docs/db/ （全量：`https://zvec.org/llms-full.txt`；API 参考：`https://zvec.org/api-reference/`） |
| Node SDK | `@zvec/zvec`（`npm install @zvec/zvec`）—— **本需求采用** |
| Python SDK | `zvec`（`pip install zvec`；无预编译 wheel 时需本地编译 C++17+CMake） |
| 用途 | 在 KiSearch 进程内提供稠密/稀疏向量检索 + 原生 FTS(BM25) + 标量过滤，并以常驻 MCP 服务对外暴露 |
| 版本要求 | 推荐 v0.5.0+（2026-06-12 起原生支持 FTS 与混合检索能力）；Node binding 用最新 `@zvec/zvec` |

## 核心能力

- **进程内、零服务**：安装即索引/查询，无外部基础设施。已在阿里内部生产验证。
- **稠密向量**：FP32/FP16 等，需指定维度；索引类型 FLAT / HNSW / HNSW-RaBitQ / IVF / DiskANN；度量 COSINE / L2 / IP。
- **稀疏向量**：`SPARSE_VECTOR_FP32`，键值对（维度索引→权重），无需固定维度，用于混合检索。
- **全文检索（FTS）**：原生 BM25 排序，支持自然语言 match、短语匹配、布尔运算符；内置 standard / whitespace / **jieba（中文分词）** 三种分词器。
- **标量过滤**：倒排索引（INVERT）支持类 SQL `WHERE` 条件（含范围优化、通配）。
- **动态 Schema**：可运行时增删标量字段/向量，无需重建集合。
- **CRUD**：insert / upsert / update / delete（按 id 或按 filter）/ fetch。

## 接口清单（Node SDK 为主，标注 Python 等价）

> 所有操作基于一个已 `create_and_open` / `open` 得到的 `collection` 对象。Node 提供同步（`XxxSync`）与异步（`await Xxx`）两套 API。

### 集合管理

| 能力 | Node SDK | Python SDK | 说明 |
|---|---|---|---|
| 创建并打开 | `ZVecCreateAndOpen(path, schema)` | `zvec.create_and_open(path, schema)` | 返回 collection；目录不存在则创建 |
| 打开已有 | `ZVecOpen(path, ...)` | `zvec.open(path, ...)` | 常驻服务 reopen ≈ 50ms（基准实测） |
| 查看信息 | `collection.schema` / `collection.stats` | 同 | 维度、文档数、索引状态 |
| 删除集合 | `ZVecDestroy(path)` | `zvec.destroy(path)` | — |
| 优化 | `collection.optimizeSync()` / `await collection.optimize()` | `collection.optimize()` | 大批量插入后调用获最佳检索性能 |
| Schema 演化 | Schema Evolution API | 同 | 运行时增删字段/向量 |

### Schema 定义（Node 示例）

```ts
import { ZVecCollectionSchema, ZVecDataType, ZVecIndexType, ZVecMetricType } from "@zvec/zvec";

const collectionSchema = new ZVecCollectionSchema({
  name: "example_collection",
  fields: [
    // 标量字段（倒排索引 → 过滤）
    { name: "publish_year", dataType: ZVecDataType.INT32, nullable: true,
      indexParams: { indexType: ZVecIndexType.INVERT, enableRangeOptimization: false } },
    // 全文检索字段（STRING + FtsIndexParam）
    { name: "content", dataType: ZVecDataType.STRING, nullable: false,
      indexParams: { indexType: ZVecIndexType.FTS, tokenizerName: "standard", filters: ["lowercase"] } }
  ],
  vectors: [
    // 稠密向量字段
    { name: "embedding", dataType: ZVecDataType.VECTOR_FP32, dimension: 768,
      indexParams: { indexType: ZVecIndexType.HNSW, metricType: ZVecMetricType.COSINE } }
  ]
});
```

- 向量索引类型：`FLAT`(暴力/100%召回) / `HNSW`(图, `efConstruction`) / `HNSW_RABITQ`(省内存, 仅 x86_64 AVX2+, `totalBits`/`numClusters`) / `IVF`(`nList`) / `DISKANN`(`maxDegree`/`listSize`/`pqChunkNum`)。
- 度量（`metricType`）：`COSINE` / `L2` / `IP` —— **务必与 embedding 训练时一致**。

### 数据操作

| 操作 | Node SDK | 说明 |
|---|---|---|
| 插入 | `collection.insertSync({ id, vectors:{embedding:[...]}, fields:{...} })` | 单条或数组批量；返回 `{ok:true}` 或状态数组 |
| 覆盖写 | `collection.upsertSync(...)` | id 已存在则覆盖；`insert` 遇重复 id 会失败 |
| 更新 | `collection.updateSync(...)` | 更新已存在文档的字段/向量 |
| 删除(按id) | `collection.deleteSync(id)` | — |
| 删除(按过滤) | `collection.deleteByFilterSync("publish_year > 2000")` | 类 SQL 条件删除 |
| 按id取回 | `collection.fetchSync("doc_1")` | — |

> ⚠️ 插入校验：未知字段、向量维度不匹配等错误用法会**直接抛异常且（批量时）整批不插入**；格式合法则逐条尝试，单条失败（如重复 id）不影响其余。**务必检查批量返回的每个状态。**

### 查询

```ts
// 单向量 + topk
let r = collection.querySync({ fieldName: "embedding", vector: Array(768).fill(0.3), topk: 10 });
// 向量 + 标量过滤
let r = collection.querySync({ fieldName: "embedding", vector: Array(768).fill(0.3),
  topk: 10, filter: "publish_year > 1936" });
```

| 参数 | 说明 |
|---|---|
| `fieldName` | 参与检索的向量/FTS 字段名 |
| `vector` / `fts` / `id` | 检索类型，**三者互斥**（见 §约束） |
| `topk` | 返回最相似文档数 |
| `filter` | 可选类 SQL 布尔表达式，限制结果子集 |
| `outputFields` | 结果中包含的标量字段；省略则返回全部 |

- 向量查询：`query` / `querySync`
- 原生混合查询：`multiQuerySync` / `multiVectorQuery`（**v0.5.0 起支持 vector+fts 多路合并**，见 §混合检索）

### 混合检索（vector + FTS 融合）

zvec v0.5.0 起 `multiQuerySync` 原生支持**多路子查询（向量 + FTS 任意组合）合并**，内置 RRF / 加权融合，**优先于手写 RRF**：

```ts
let r = collection.multiQuerySync({
  queries: [
    { fieldName: "embedding", vector: qVec },
    { fieldName: "content", fts: { matchString: "syncRelation vectorize" } },
  ],
  topk: 10,
  rerank: { type: "rrf", rankConstant: 60 },   // 或 { type: "weighted", weights: [0.5, 0.5] }
});
```

- 子查询 `ZVecSubQuery`：`{ fieldName, vector? , fts?, numCandidates?, params? }`，至少 2 条。
- `rerank`：`'rrf'`（默认 rankConstant=60）或 `'weighted'`（需 `weights` 与 `queries` 等长）。
- 返回 `ZVecDoc[]`（与单路 `querySync` 同结构）。
- 若需自定义融合逻辑（如加权不同、附带标量打分），仍可在应用层分别 `querySync` 两路后手动 RRF——本 PoC 的 Python 版本即走此路径，Node 侧 `zvec-probe-node/zvec_demo.mjs` 两种都验证过、结果一致。

### 索引管理

| 能力 | 工具/方法 |
|---|---|
| 创建索引 | `create_index` |
| 丢弃索引 | `drop_index` |
| 优化集合 | `optimize_collection` / `collection.optimizeSync()` |

## 认证与配置

- **无认证**：zvec 是进程内库，无 API Key / 网络鉴权。
- **Embedding 不在 zvec 内**：需应用自行调用 embedding 服务（KiSearch 沿用 SiliconFlow `Qwen/Qwen3-Embedding-8B`，4096 维）。
- **配置项（Schema 层）**：向量维度/度量/索引类型、FTS 分词器（`tokenizer_name`）/ 过滤（`filters`）/ `extra_params` JSON。
- **Jieba 字典（中文 FTS）**：可设 `extra_params='{"jieba_dict_dir":"/path"}'`，或用环境变量 `ZVEC_JIEBA_DICT_DIR`，或用 `zvec.init(jieba_dict_dir=...)`；Python SDK 自带默认字典。
- **存储**：集合落盘为本地目录（如 `./my_collection_data`），进程退出后持久化，重开即检索。

## 全文检索（FTS）详解

- FTS 字段必须是 `STRING` + `FtsIndexParam`（`indexType: FTS`）。**支持 FTS-only 集合**（无向量字段）。
- 两种查询模式（通过 `Query.fts`）：
  - `matchString`（自然语言，自动分词，默认 `OR` 组合）
  - `queryString`（高级：`+term` 必含 / `-term` 排除 / `"phrase"` 短语 / `AND` `OR` `NOT` / `(expr)` 分组）
- `query_string` 与 `match_string` 互斥；默认算子可经 `FtsQueryParam.default_operator="AND"` 切换。
- **分词器**：
  - `standard`（默认，UAX#29 词边界，类 ES；CJK 拆单字）
  - `whitespace`（仅按空白切分，保留标点）
  - `jieba`（中文分词，支持中英混排，KiSearch 中文语料场景推荐）
- 过滤链（`filters`）：`lowercase` / `ascii_folding` / `stemmer`（Snowball，默认 english，可 `stemmer_lang`）。

## 约束与注意

- ⚠️ **FTS 与向量在同一单路 `Query` 路由内互斥**：单条 `querySync` 不能同时设 `fts` 与 `vector`/`id`。**但 v0.5.0 起可用 `multiQuerySync` 原生合并多路子查询（vector+fts）+ RRF/加权融合**（推荐）；若需自定义融合，仍可在应用层分别 `querySync` 两路后手动 RRF。
- ⚠️ FTS 字段**不支持** alter column（schema 演化）。
- ⚠️ 前导否定不支持（`NOT term` / 单独 `-term` 需至少一个正项）。
- 度量类型须与 embedding 训练一致，否则相似度语义错误。
- 大批量插入后建议 `optimize()` 以获得最佳性能（基准 100 篇建库 8.3s）。

## MCP Server（官方）

- 官方 `zvec-mcp-server`（GitHub: `zvec-ai/zvec-mcp-server`）基于 **Python + uvx** 分发，暴露 **17 个 MCP 工具**（集合管理 / 文档 CRUD / 向量查询 / 索引管理 / AI Embedding）。
- 配置经环境变量注入 embedding：`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_EMBEDDING_MODEL`（默认 `text-embedding-3-small`）。
- ⚠️ **本需求（KiSearch）为 Node 常驻 MCP 服务，不直接采用该 Python MCP server**，而是用 `@zvec/zvec` Node SDK 自建 MCP server（对外暴露 `store`/`search`/`list`/`stats` 等工具）。官方 MCP 工具列表可作接口设计参考：
  - 集合：`create_and_open_collection` / `open_collection` / `get_collection_info` / `destroy_collection`
  - 文档：`insert_documents` / `upsert_documents` / `update_documents` / `delete_documents` / `fetch_documents`
  - 向量：`vector_query` / `multi_vector_query`
  - 索引：`create_index` / `drop_index` / `optimize_collection`
  - Embedding：`generate_dense_embedding` / `embedding_write` / `embedding_search`

## 备选方案

- `memory-lancedb-pro`(lancedb)：现役引擎，基准实测 Recall@1 仅 12.5%、查询 4s、有锁文件卡死风险 → 已被 zvec 取代（见 `../reference/benchmark-zvec-vs-mem.md`）。
- 其他向量库（Milvus/Weaviate/Qdrant 等）：均为独立 server 形态，违反"进程内、零服务"诉求，引入运维与网络延迟，不适用于 KiSearch 一次性/常驻 CLI 场景。

## 风险与注意事项

| 项 | 说明 |
|---|---|
| 稳定性 | zvec 已在阿里生产验证；Node binding 为官方维护，但版本演进需锁版本 |
| 中文 FTS | `standard` 分词器对 CJK 拆单字，中文检索需 `jieba` 分词器才能词级匹配 |
| 混合检索 | v0.5.0 起原生支持 `multiQuerySync`（vector+fts 多路 + RRF/加权融合）；亦支持应用层手写 RRF（已两种都验证） |
| 写入校验 | 批量插入遇格式错误会整批回滚，需逐条检查返回状态 |
| 依赖 | 引擎为 Rust 编译产物，Node 包需匹配平台预编译 wheel；缺失时需本地编译 |

## 参考来源

- 官方文档总览：https://zvec.org/llms.txt
- Quickstart：https://zvec.org/mdx/en/docs/db/quickstart.md
- Schema：https://zvec.org/mdx/en/docs/db/collections/create/schema.md
- Insert：https://zvec.org/mdx/en/docs/db/data-operations/insert.md
- FTS：https://zvec.org/mdx/en/docs/db/data-operations/query/fts.md
- MCP Server：https://zvec.org/mdx/en/docs/ai/mcp.md
- 选型基准（内部）：`../reference/benchmark-zvec-vs-mem.md`
