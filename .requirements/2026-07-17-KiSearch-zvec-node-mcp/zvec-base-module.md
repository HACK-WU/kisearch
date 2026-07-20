---
id: REQ-20260717-002
feature: KiSearch 基座模块（zvec 引擎抽象层）功能与接口设计
status: 实现完成
created: 2026-07-17
updated: 2026-07-20
version: 6
tags: [engine-layer, zvec, base-module, interface]
depends_on: [REQ-20260717-001]
author: AI
document_type: requirement+interface
---

# 基座模块设计：zvec 引擎抽象层（ZvecEngine）

> 本模块即 `requirement.md` 中 **REQ-01「封装 zvec 引擎层」** 的具体落地设计。它位于 KiSearch 上层（领域 / MCP / CLI）与 `@zvec/zvec` 原始绑定之间，是纯引擎抽象层。
>
> **v6 修订（实现期契约修正回写）**：基于 `src/zvec-engine/` 真实 Node 实现（zvec 0.6.0）+ 14/14 冒烟测试通过，回写 6 项 v5 契约与 zvec 实测行为的偏差修正：① **probe 必须带超时**（zvec `ZVecOpen` 对持锁路径**阻塞等待**而非立即抛错；实测 1505ms 超时判定 locked 成功）② **`open` 主线程预检路径存在性**（zvec 对不存在路径同样阻塞而非抛错，提前 `existsSync` 失败）③ **probe 不传 `collectionName`**（zvec open 从磁盘元数据恢复集合名；`'__probe__'` 过不了集合名正则 `^[a-zA-Z][a-zA-Z0-9_]{2,}$`）④ **zvec `querySync`/`multiQuerySync` 拒绝显式 `undefined` 参数**（所有可选参数须条件展开 `...(x !== undefined ? {x} : {})`，不能显式传 `undefined`）⑤ **zvec `upsertSync`/`insertSync`/`updateSync` 要求 `vectors`/`fields` 至少为 `{}`**（不能是 `undefined`；`updateSync` 进一步要求 dense vector 必填——与 v5 §4.5 "仅传 fields 只改标量"规则冲突，实测证实该规则**在 zvec 0.6.0 下不可实现**，须回退到"update 必须提供 vector 或不更新 vector 字段"）⑥ **embed 失败的 doc 必须从 toWrite 中剔除**（否则 vector=undefined 会被 zvec 拒绝整批）。另确认：worker ESM 必须静态 `import`（不能 `require`）；zvec `insert` 重复 id 部分失败行为与 v4 实测一致；score=1/(1+d) 公式在 hash 向量下自检索 top1 score≈0.99 符合预期。
>
> **v5 修订（scenario-rehearsal 修复回写）**：据 `review/scenario-rehearsal.md` 推演发现 + `review/fix-plan.md` 方案，闭合 1 项 🔴 阻断与 5 项 🟡：① **写入侧 async 改为「单一 zvec worker（actor 模型）」架构**——整个 `ZvecEngine` 实例跑在 dedicated `worker_threads`，主线程持 proxy 经 `postMessage` 转发，worker 启动时 `ZVecOpen` 一次持有唯一写句柄（消解"同进程再 open 锁冲突"，因 read_only 也锁冲突故查询亦进 worker）；embedding 在 worker 内闭环避免 4096 维向量跨线程传输；`close()` = terminate worker + `closeSync()` 释放 LOCK。② 补静态 `ZvecEngine.probe(dbPath)` 供 CLI 在 open 前探测锁/损坏。③ §4.4 批级异常显式补 `InconsistentUpdateError`。④ embedding 失败粒度 = `batchSize` 小批，预计算 vector 的 doc 不受影响。⑤ `listIds` limit 默认 1000/上限 10000。⑥ db 明确为"可重建缓存"，重灌数据源 = 上层代码库重新抽取。⑦ `open` 补维度/metric 校验异常名。#7 score 公式与 #8 delete 不存在 id 留待真实 embedding / Node 实测补验。
>
> **v4 修订（最小 Node demo 验证回写）**：运行 `zvec-probe-node/verify_blocking.mjs` 实测闭合 §7 全部阻塞项，并据实证**修正 §5 一处不实假设**——zvec Node 绑定(0.5.0)的 Async API 仅覆盖 `query`/`multiQuery`/`optimize`/`deleteByFilter`，`create`/`open`/`insert`/`upsert`/`update`/`delete` 仅 Sync，故"批量写入走 Async"不可实现（改走 worker 线程）。其余结论：listIds 原生可行（证伪 v2-#2）、insert 部分失败可行（闭合 v2-#3）、jieba 无需 dictDir（闭合 v2-#4）、standard 中文 FTS 失效（闭环 H-03）、weighted 被 fts 碾压（证实 v2-#5）、close 释放 LOCK + 单进程单写句柄（闭环 H-02）；H-04 仅闭合 4096 维 API 通路，语义 Recall 须真实 embedding 补验。
>
> **v3 修订**：根据 `review/challenge-report-v2.md` 第三轮质疑审查，处理 17 项残留/新引入问题：限定 `metric` 为 COSINE（消解 IP 归一化地雷）、`open` 入参瘦身防 schema 漂移、补 `close()` 与锁/损坏类型化异常、补全 hybrid 退化矩阵与 update 联动规则、批级/文档级错误码分层、补 `includeVector`、版本锁定与 Async API 约束、统一 REQ-07 验收口径、扩充 Node demo 验证清单。
>
> **v2 修订**：根据 `review/challenge-report.md` 二次质疑审查，修正 5 项高风险（embedding 同步签名、维度决策、FTS 分词器、Hit 缺原文、score 方向）与 5 项中风险（db 共享、filter 注入、embedding 重试、fts 必填、vectors 多字段）问题。

## 0. 已确认的决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 模块边界 | **纯引擎抽象层，不含 MCP 协议**。MCP server 是 KiSearch 上层职责，调用本模块 |
| Embedding 归属 | **模块自动 embed**：喂 `{id,text,fields}` 即内部生成 dense 向量并建 FTS 索引；同时接受预计算向量 |
| 集合模型 | **单集合句柄**：一个 `ZvecEngine` 实例 = 一个已打开的集合；`ki-relation`/`ki-path`/`ki-search` 与 scope 用 metadata 过滤隔离，不建多集合 |
| Embedding 维度 | **4096 维**（与基准实测对齐，见 `requirement.md` §4.1 / `decision.md` §3.1 / `reference/scripts/compare.py` `EMBED_DIMS=4096`）。建库前须校验 `EmbeddingProvider.dimension === config.collection.dimension`，不一致抛 `DimensionMismatchError`。> 注：`reference/docs/zvec-mcp-server-tools.md` 同环境曾用 1024 维跑通 MCP server 实测，属历史 PoC；生产基座以基准 4096 为准，REQ-07 验收须在 4096 维下复现 **Recall@5≥90%（基准 95%）**；Recall@1≥85% 为附加观察指标。 |
| 度量选择 | **限定 `metric: 'COSINE'`**（与基准 / 两个 demo / Qwen3-Embedding 训练度量对齐，见 `reference/scripts/compare.py` L146 `MetricType.COSINE`）。IP/L2 的返回 score 语义**未经任何实测**，贸然暴露会触发归一化方向反转（见 §4.5），故暂不开放；后续如需扩展须先在 Node demo 实测 score 方向后补归一化规则。 |
| db 文件归属 | **由常驻 MCP server 单一持有 db 句柄**；CLI 写入走 MCP 协议或排队等待锁释放。基座模块提供 `tryOpen()` / `isLocked()` / `close()` 以支撑上层判断能否安全 open 与优雅释放（应对 zvec 文件锁语义，见 `reference/docs/zvec-mcp-server-tools.md` 实测坑 3 / 坑 7） |
| score 归一化 | **统一为"越大越相关"**（业界惯例）。COSINE 度量下 vector 路做 `score = 1/(1+distance)` 归一化（distance∈[0,2] → score∈[1/3,1]，方向已实测为"越小越相似"），fts 路保持 BM25 原值（越大越相关），hybrid 路用 RRF/加权融合分；`queryType` 仅作来源标识，**不再分叉 score 方向** |
| FTS 分词器 | **默认 `jieba`**（中文分词，KiSearch 中文语料场景，见 `dependencies/zvec.md` §FTS）。建库时必须显式指定 `tokenizer`，不允许默认 standard（CJK 拆单字会拖低 B-11 混合召回） |
| 写入并发模型 | **单一 zvec worker（actor 模型）**：`ZvecEngine` 实例运行在 dedicated `worker_threads`，主线程持 `ZvecEngineProxy`（所有方法 `async` 签名不变，经 `postMessage` 转发）；worker 启动时 `ZVecOpen` 一次持有唯一写句柄。原因：zvec 锁是文件级、进程内独占（`verify_blocking.mjs` H-02 实测同进程对已开集合再 `ZVecOpen` 报 `Can't lock read-write collection`，且 read_only 也冲突），主线程+worker 无法同时持柄；Node worker 间不共享对象（句柄无法 `postMessage`）。故把"句柄+操作"整体封装在单一 worker 内，主线程不阻塞事件循环，签名保持 async（消解 v4 "worker 线程包裹 Sync" 与锁语义的矛盾，见 §5） |

## 1. 根因与本质

- **表象**：KiSearch 换了 zvec 引擎，需要一层封装。
- **本质**：把 `@zvec/zvec` 原始 Rust 绑定 API 的复杂度，与 KiSearch 的领域语义**彻底解耦**，并**消解 zvec 已知陷阱**（score 方向、维度区间、文件锁、分词器选择），让上层无需懂 zvec 细节即可安全使用。没有这层，上层直接调 `multiQuerySync` 之类底层 API，引擎升级即全崩。
- **关键认知**：基座模块 ≠ MCP server。分层如下：

```
KiSearch 上层（领域：ki-relation/path/scope、抽取、MCP 协议、CLI）
        │ 调用
        ▼
ZvecEngine 基座模块（引擎层：集合/文档/向量/FTS/混合/索引/embedding）★本文件
        │ 封装
        ▼
@zvec/zvec（Rust 内核 Node 绑定，v0.5.0+ 原生 FTS+混合）
```

## 2. 职责边界（铁律）

| 基座模块 IN（引擎能力） | KiSearch OUT（领域语义） |
|---|---|
| 集合生命周期、文档增删改查、向量检索、FTS 关键词检索、混合检索（FTS+向量+RRF）、标量/metadata 过滤（**结构化 Filter**）、索引管理、embedding 提供方抽象、score 归一化、文件锁协调 | `ki-relation`/`ki-path`/`ki-search` 三层标签**含义**、scope 隔离**策略**、知识抽取逻辑、MCP 工具定义、CLI 命令、底层检索 API 之上的业务编排 |

**铁律**：基座模块**不认识 `ki-relation`**。只认"任意字符串 tag / 任意标量字段 / 结构化 Filter 表达式"。KiSearch 把领域概念映射成通用 `tags`/`fields` 传下来 → 引擎可单测、可锁版本、与领域解耦。

## 3. 功能需求清单

| ID | 能力 | 对应 zvec-mcp 工具 | 说明 |
|---|---|---|---|
| B-01 | 集合创建即打开 | `create_and_open_collection` | 首次建库，定义 dense 维度/度量/数据类型 + 标量字段 + 开启 FTS（含分词器） |
| B-02 | 集合打开（复用） | `open_collection` | 常驻服务启动 / 重启挂载；提供 `tryOpen` 避免锁冲突；`open` 失败抛类型化异常（锁/不存在/损坏） |
| B-03 | 集合信息 | `get_collection_info` | schema、doc 数、索引状态、fts 配置 |
| B-04 | 文档写入（upsert，幂等） | `embedding_write`+`upsert` | 喂 `{id,text,fields}` → 自动 embed（含重试/分批）+ 建 FTS 索引；也接受预计算向量 |
| B-05 | 文档插入（防覆盖） | `insert_documents` | id 冲突报错；部分失败语义以 Node 实测为准 |
| B-06 | 文档局部更新 | `update_documents` | 只改部分字段；text/vector 联动规则见 §4.5 |
| B-07 | 文档删除 | `delete_documents` | 按 id；不存在的 id 进 `errors[]`(NOT_FOUND) |
| B-08 | 文档取回 | `fetch_documents` | 按 id 取原文/向量/字段 |
| B-09 | 向量检索 / 语义检索 | `vector_query` | 文本语义召回（内部转向量）或直接给预计算向量 |
| B-10 | **FTS 关键词检索** | ❌（Python zvec-mcp 没有） | **Node 原生 FTS**，代码符号精确召回——核心差异点。分词器在建库时配置（默认 jieba） |
| B-11 | **混合检索（FTS+向量+RRF）** | ❌（Python zvec-mcp 缺 FTS） | **KiSearch 召回主路径**，FTS+向量+RRF 融合召回（Node 原生支持）。fts 关键词可选，缺失时退化为纯向量 |
| B-12 | 标量过滤（结构化 Filter） | 各检索的 `filter` | 按标量字段（如 tag / scope）做等值或范围过滤；提供结构化 Filter 类型，内部转 zvec 字符串语法并转义 |
| B-13 | 索引管理 | `create_index`/`drop_index`/`optimize` | HNSW/INVERT 建改、压实 |
| B-14 | Embedding 提供方抽象 | `generate_dense_embedding` | 可注入 OpenAI 兼容（SiliconFlow），可替换；含重试/分批/超时 |
| B-15 | 列出文档 id | —（zvec-mcp 无） | 按 filter 列出文档 id 列表，支撑 KiSearch `list` 工具与 sync-relation 回写检查 |
| B-16 | 健康检查、锁状态与关闭 | —（zvec-mcp 无） | `isHealthy()`/`isLocked()`/`isOpen()`/`close()`，支撑 REQ-09 常驻保活、优雅关闭与 db 损坏重建 |

> **B-10 / B-11 是 Python zvec-mcp 缺、但 Node `@zvec/zvec` 原生有、且 KiSearch 刚需的能力**——换 Node 引擎的根本收益，必须作为一等公民暴露。分词器默认 `jieba`（中文场景），代码符号场景可配 `standard`/`whitespace`。

## 4. 接口契约（仅参数与响应结构，不涉及内部实现）

> 本节定义「调用方传入什么结构」与「拿到什么响应结构」，以及方法签名。方法内部如何调用 `@zvec/zvec`、如何生成向量、如何融合排序、如何转义 filter 等，均不在本节范围。
>
> **所有写入/检索方法均为 `async`**（因 embedding 调用 SiliconFlow HTTP API 必须异步，见 §4.6）。

### 4.1 引擎配置（create / open 的入参）

```ts
interface ZvecEngineConfig {
  dbPath: string;                       // 集合持久化目录
  collection: {
    name: string;                       // 集合名
    denseField: string;                 // 向量字段名（如 'dense'）
    dimension: number;                  // 向量维度，必须 === embedding.dimension；KiSearch 固定 4096
    metric: 'COSINE';                   // 距离度量；KiSearch 固定 COSINE（见 §0 度量选择）。IP/L2 暂不开放
    denseDataType?: 'FP32' | 'FP16';    // 向量数据类型，默认 'FP32'；FP16 为半精度省内存（注：x86_64 AVX2+ 限制属于 HNSW-RaBitQ 索引，本模块未暴露，与 FP16 数据类型无关）
    scalarFields: ScalarFieldDef[];     // 标量字段定义（tag/path/scope 等）
    fts?: FtsConfig;                    // FTS 配置；省略则不建 FTS（B-10/B-11 不可用）
  };
  embedding: EmbeddingProvider;         // 可注入的 embedding 提供方（见 4.6）
}

interface ScalarFieldDef {
  name: string;                         // 字段名
  dataType: 'STRING' | 'BOOL' | 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'UINT32' | 'UINT64';
  indexed?: boolean;                    // 是否建倒排(INVERT)索引加速过滤；默认 false
}

interface FtsConfig {
  field: string;                        // 用于全文检索的标量字段名（如 'content'）
  tokenizer: 'standard' | 'whitespace' | 'jieba';  // 分词器；KiSearch 中文场景默认 'jieba'，代码符号场景可 'standard'
  filters?: ('lowercase' | 'ascii_folding' | 'stemmer')[];  // 过滤链，默认 ['lowercase']
  jiebaDictDir?: string;                // tokenizer='jieba' 时可选自定义词典目录；缺省用 SDK 默认字典
}
```

> **维度校验铁律**：`create` 时若 `config.collection.dimension !== config.embedding.dimension`，立即抛 `DimensionMismatchError`，不建库。> 注：`reference/docs/zvec-mcp-server-tools.md` 实测坑 2 记录 SiliconFlow `Qwen3-Embedding-8B` 在 `dimension=8` 时报 `400 code=20015`；KiSearch 用 4096 维（基准已验证）。
>
> **FTS 字段校验**：`create` 时若配置了 `fts`，校验 `fts.field ∈ collection.scalarFields 且对应 `dataType === 'STRING'`，不符抛 `InvalidSchemaError`（zvec 要求 FTS 字段为 STRING + FtsIndexParam，见 `dependencies/zvec.md` §FTS）。避免配置错误穿透到 zvec 层才报、信息不指向根因。
>
> **schema 持久化与 open**：zvec 集合 schema 随目录持久化，`open` 不需要也不应重传 schema（见 §4.5 `ZvecEngineOpenConfig`）；如需防御漂移，调用方可选传 `schemaAssert` 与持久化 schema 逐项比对，不符抛 `SchemaMismatchError`。

### 4.2 文档输入（写入类操作的入参）

```ts
interface DocInput {
  id: string;                           // 文档唯一 id
  text?: string;                        // 原文：内部转向量并写入 fts.field（若已配置 FTS）
  vector?: number[];                    // 预计算向量（与 text 二选一或并存）；长度须 === config.dimension
  fields?: Record<string, ScalarValue>; // 标量字段键值（tag/path/scope 等）
}
type ScalarValue = string | number | boolean;
```

> v1 曾用 `vectors?: Record<string, number[]>` 多字段，与配置层单 `denseField` 自相矛盾（质疑 #10）。v2 简化为单 `vector?: number[]`，与单 denseField 对齐。zvec 的稀疏向量（`SPARSE_VECTOR_FP32`）属进阶能力，基座模块暂不暴露。
>
> **text / vector 联动**：`upsert`/`insert` 时若配置了 FTS，**强烈建议传 `text`**（否则该文档对 ftsSearch / hybridSearch 的 fts 路不可见，且无任何告警）。`text` 与 `vector` 并存时以 `vector` 为准、`text` 仅写 FTS 索引；只传 `text` 时内部自动 embed。`update` 的联动规则更严，见 §4.5。

### 4.3 检索请求（查询类操作的入参）

```ts
// 结构化 Filter（基座模块内部转 zvec 类 SQL 字符串并转义，避免注入）
type Filter =
  | { field: string; op: '==' | '!=' | '>' | '<' | '>=' | '<='; value: ScalarValue }
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter };

interface SearchOptions {               // 所有检索 Req 的公共可选项
  topk?: number;                        // 返回条数；默认 10，上限 1000
  filter?: Filter;                      // 结构化标量过滤；省略则不过滤
  outputFields?: string[];              // 结果中包含的标量字段；省略则返回 fts.field + 所有标量字段
  includeVector?: boolean;              // 是否在 Hit 中返回命中文档的向量；默认 false（省带宽），true 时填充 Hit.vector
}

interface SemanticSearchReq extends SearchOptions {  // 语义检索：文本 → 内部转向量 → 相似召回
  queryText: string;
}

interface VectorSearchReq extends SearchOptions {    // 向量检索：直接给查询向量
  vector: number[];
}

interface FtsSearchReq extends SearchOptions {      // FTS 关键词检索
  match: string;                        // 关键词串（如代码符号名）；走 fts 字段的 BM25
}

interface HybridSearchReq extends SearchOptions {   // 混合检索：FTS + 向量 + RRF/加权融合
  queryText?: string;                   // 语义侧文本（与 vector 二选一）
  vector?: number[];                    // 语义侧预计算向量
  fts?: string;                         // 关键词侧串；可选
  rerank?: {                            // 多路融合策略
    type: 'rrf' | 'weighted';           // 默认 'rrf'（基于名次，对 score 尺度不敏感，推荐）
    weights?: Record<string, number>;   // weighted 模式各路权重
    rankConstant?: number;              // rrf 模式常数，默认 60
  };
}
```

> **退化矩阵（v3 补全）**：hybridSearch 按可用输入自动降级路由，`queryType` 反映实际走的路：
> - 有 `fts` 且有 `queryText`/`vector` → 原生 `multiQuerySync` 两路融合，`queryType='hybrid'`；
> - `fts` 缺失但有 `queryText`/`vector` → 退化为单路向量检索，`queryType='vector'`；
> - `queryText`/`vector` 均缺失只给 `fts` → 退化为单路 FTS 检索（走 `querySync` fts），`queryType='fts'`；
> - 三者皆缺 → 抛 `InvalidSearchError`。
>
> v1 的 `filter?: string`（裸字符串）改为结构化 `Filter` 类型（质疑 #7），避免上层手写 zvec DSL 与注入风险。若上层确需透传原始 zvec 过滤表达式，可在 `Filter` 联合类型加 `{ raw: string }` 逃生口，但需调用方自负转义责任。
> v1 的 `HybridSearchReq.fts` 必填改为可选（质疑 #9），支持纯语义场景退化为单路向量。
>
> **weighted 融合尺度提醒**：vector 路归一化分 ∈ (0,1]，fts 路 BM25 原值量级常达 1~30+，二者尺度不匹配。`weighted` 直接对原始分加权会被 fts 路数值主导，权重参数可能失效；zvec 原生 reranker 是否内部归一化**未文档化**。故默认且推荐 `rrf`；`weighted` 行为以 Node demo 实测为准（见 §7），未验证前不建议生产使用。

### 4.4 响应数据结构

```ts
interface Hit {
  id: string;                            // 命中文档 id
  score: number;                         // 归一化相关性分：越大越相关（见 4.5）
  queryType: 'vector' | 'fts' | 'hybrid'; // 结果来源标识（仅作来源说明，不改变 score 方向）
  fields: Record<string, ScalarValue>;   // 命中文档的标量字段（按 outputFields 返回）
  text?: string;                         // fts.field 原文（若配置了 FTS 且 outputFields 含之）
  vector?: number[];                     // 命中向量；仅当 SearchOptions.includeVector===true 时填充，默认不返回以省带宽
}

interface WriteResult {
  ok: number;                            // 成功写入条数
  failed: number;                        // 失败条数
  errors?: { id: string; code: WriteErrorCode; reason: string }[];  // 失败明细
}

type WriteErrorCode =
  | 'EMBEDDING_FAILED'        // embedding 提供方调用失败（网络/限流/超时）—— 文档级；失败粒度 = batchSize 小批（见 §4.6），小批重试耗尽后该批对应 doc 标此码；预计算 vector 的 DocInput（已给 vector）不依赖 embed，照常写入，不受 embed 失败影响
  | 'ID_CONFLICT'             // insert 模式下 id 已存在 —— 文档级
  | 'NOT_FOUND'               // update/delete 指定 id 不存在 —— 文档级
  | 'ZVEC_WRITE_ERROR'        // zvec 底层写入异常（文档级可恢复的）
  | 'UNKNOWN';                // 兜底

// 以下为「批级」错误：不进入 WriteResult.errors，而是让整个 upsert/insert/update 直接 reject：
//   - DIMENSION_MISMATCH     → 抛 DimensionMismatchError（向量维度与 config.dimension 不符）
//   - UNKNOWN_FIELD          → 抛 InvalidDocInputError（含未声明的标量字段；附字段名）
//   - SCHEMA_MISMATCH        → 抛 SchemaMismatchError（open 时 schemaAssert 与持久化不符）
//   - INCONSISTENT_UPDATE    → 抛 InconsistentUpdateError（update 只传 vector 不传 text 且集合配置了 FTS；避免向量更新而 FTS 索引停留旧原文、导致 ftsSearch/hybridSearch 漏召回且无告警，见 §4.5 update 联动规则）
// 依据：zvec 对未知字段/维度不匹配是「整批抛异常且整批不插入」（dependencies/zvec.md L78），
//       建模为文档级 errors[] 走不到该路径，故分层。

interface CollectionInfo {
  name: string;
  dimension: number;
  metric: 'COSINE';                       // 本模块仅创建/支持 COSINE（见 §0）；若 open 到非 COSINE 库抛 SchemaMismatchError
  denseDataType: 'FP32' | 'FP16';
  docCount: number;                      // 文档总数
  scalarFields: ScalarFieldDef[];
  fts?: FtsConfig;                       // FTS 配置（含分词器）
  locked?: boolean;                       // db 是否被其他进程持有锁
}

interface Doc {
  id: string;
  vector?: number[];
  fields?: Record<string, ScalarValue>;
  text?: string;                         // fts.field 原文
}
```

> v1 的 `Hit` 缺 `text`（质疑 #4）导致上层被迫二次 `fetch` 拿原文，破坏 <5ms 目标与"返回结构化结果"需求；v2 补 `text?`，并支持 `outputFields` 透传 zvec 原生能力。
> v1 的 `WriteResult.errors[].reason: string`（质疑 #8）无法区分 embedding 失败 vs 维度不匹配 vs id 冲突；v2 改为 `code: WriteErrorCode` 枚举 + `reason` 描述。v3 进一步分层（质疑 v2-#10）：批级用法错误（维度/未知字段/schema 漂移）直接抛类型化异常，文档级可恢复错误（embedding 失败/id 冲突/not found）才进 `errors[]`，与 zvec「整批回滚 vs 逐条尝试」的真实行为对齐。

### 4.5 方法签名与操作清单

```ts
// open 专用配置（schema 从持久化元数据读回，不重传；见 §4.1「schema 持久化与 open」）
interface ZvecEngineOpenConfig {
  dbPath: string;
  collectionName: string;
  embedding: EmbeddingProvider;        // 运行时 embed 用；其 dimension 须 === 持久化 schema 的 dimension
  readOnly?: boolean;                  // 默认 false
  schemaAssert?: {                     // 可选：与持久化 schema 逐项比对，不符抛 SchemaMismatchError
    dimension?: number;
    metric?: 'COSINE';
    scalarFields?: ScalarFieldDef[];
    fts?: FtsConfig;
  };
}

class ZvecEngine {
  // 集合生命周期
  static create(config: ZvecEngineConfig): Promise<ZvecEngine>;   // B-01：建库即打开，维度/FTS 字段校验
  static open(config: ZvecEngineOpenConfig): Promise<ZvecEngine>;  // B-02：打开已有库；失败抛 CollectionNotFoundError | CollectionLockedException | CollectionCorruptedException | SchemaMismatchError。**v6 修正**：主线程先 `existsSync(dbPath)` 预检——zvec `ZVecOpen` 对**不存在路径会阻塞**而非抛错，预检直接抛 `CollectionNotFoundError`。open 后内部读持久化 schema 校验：embedding.dimension !== 持久化 dimension → 抛 DimensionMismatchError；持久化 metric !== 'COSINE' → 抛 SchemaMismatchError；传 schemaAssert 则逐项比对，不符抛 SchemaMismatchError
  static tryOpen(config: ZvecEngineOpenConfig): Promise<ZvecEngine | null>;  // B-02：任意 open 失败返回 null（不抛）；需判别原因请 catch open() 的类型化异常
  static probe(dbPath: string, timeoutMs?: number): Promise<{ exists: boolean; locked: boolean; healthy: boolean; error?: 'NOT_FOUND' | 'LOCKED' | 'CORRUPTED' | 'UNKNOWN' }>;  // B-16 静态：无需句柄，CLI 在 open 前探测 db 状态以决策"走 MCP 还是排队"。**v6 修正**：必须带超时（默认 3000ms）——zvec `ZVecOpen` 对**持锁路径阻塞等待**而非立即抛错（实测 1505ms），`Promise.race` 超时即判定 `locked:true`。实现：调用方进程临时 worker 内尝试一次轻量 ZVecOpen（**不传 collectionName**，zvec 从磁盘元数据恢复），按错误类型映射（Can't lock → locked:true；目录不存在 → exists:false；损坏 → healthy:false；timeout → locked:true）；探测完立即 closeSync + terminate 释放，不影响常驻 server 持锁
  info(): Promise<CollectionInfo>;                                  // B-03
  close(): Promise<void>;                                           // 幂等；terminate worker + worker 内 closeSync() 释放句柄与 LOCK，close 后 isOpen()===false（支撑 REQ-09 优雅关闭）
  destroy(): Promise<void>;                                         // 不可恢复，删盘
  isHealthy(): boolean;                                             // B-16：句柄是否有效
  isLocked(): boolean;                                              // B-16：db 是否被持锁
  isOpen(): boolean;                                                 // B-16：句柄是否打开

  // 文档操作（均 async）
  upsert(docs: DocInput[]): Promise<WriteResult>;                   // B-04：幂等写入
  insert(docs: DocInput[]): Promise<WriteResult>;                  // B-05：防覆盖，id 冲突进 errors[](ID_CONFLICT)；部分失败语义以 Node 实测为准（见 §7）
  update(docs: DocInput[]): Promise<WriteResult>;                   // B-06：局部更新；联动规则见下注
  delete(ids: string[]): Promise<WriteResult>;                      // B-07：按 id；不存在的 id 进 errors[](NOT_FOUND)（v3 由 void 改为 WriteResult 以便汇总）
  fetch(ids: string[]): Promise<Doc[]>;                             // B-08：按 id 取回
  listIds(filter?: Filter, limit?: number): Promise<string[]>;     // B-15：按 filter 列出 id；底层纯 filter 扫描已实测可行（见 §7 v2-#2）。limit 默认 1000、上限 10000（listIds 是扫描场景，与检索 topk 上限 1000 区分）；超过上限抛 InvalidSearchError；调用方需分页应自行迭代

  // 检索（均 async，统一返回 Hit[]，score 越大越相关）
  semanticSearch(req: SemanticSearchReq): Promise<Hit[]>;           // B-09（语义侧）
  vectorSearch(req: VectorSearchReq): Promise<Hit[]>;               // B-09（向量侧）
  ftsSearch(req: FtsSearchReq): Promise<Hit[]>;                     // B-10
  hybridSearch(req: HybridSearchReq): Promise<Hit[]>;               // B-11：按退化矩阵自动路由（见 §4.3）

  // 索引管理
  createIndex(field: string, indexParam: object): Promise<void>;     // B-13：HNSW/INVERT
  dropIndex(field: string): Promise<void>;                          // B-13
  optimize(): Promise<void>;                                        // B-13：压实
}
```

> **`update` 联动规则（v3 补全，质疑 v2-#8；v6 修正第 1 条）**：
> - ~~仅传 `fields`：保留旧 vector 与旧 text，只更新标量字段~~ **v6 实测修正**：zvec 0.6.0 `updateSync` 要求 dense vector 必填（`Invalid doc[xx]: field[dense] is required but not provided`），"仅传 fields 不改 vector"在 zvec 0.6.0 下**不可实现**。改为：调用方若需"只改标量"，须先 `fetch` 拿原 vector 再随 update 一并传回；或在 engine 内部 fetch-then-update（v6 实现选择前者，由调用方负责）
> - 传 `text`：**必须内部重嵌并同步更新 FTS 索引**（vector 与 FTS 索引保持一致）；
> - 只传 `vector` 不传 `text`，且集合配置了 FTS：**抛 `InconsistentUpdateError`**，避免向量更新而 FTS 索引停留在旧原文、导致 ftsSearch/hybridSearch 漏召回且无告警；
> - `update` 不存在的 id → 该条进 `errors[]`（`NOT_FOUND`）。

| 方法 | 入参 | 响应 | 能力 |
|---|---|---|---|
| `ZvecEngine.create` | `ZvecEngineConfig` | `Promise<ZvecEngine>` | B-01 |
| `ZvecEngine.open` | `ZvecEngineOpenConfig` | `Promise<ZvecEngine>` | B-02（失败抛类型化异常） |
| `ZvecEngine.tryOpen` | `ZvecEngineOpenConfig` | `Promise<ZvecEngine \| null>` | B-02（锁安全，不抛） |
| `info` | — | `Promise<CollectionInfo>` | B-03 |
| `close` | — | `Promise<void>` | 释放句柄/LOCK（幂等） |
| `destroy` | — | `Promise<void>` | （不可恢复） |
| `isHealthy`/`isLocked`/`isOpen` | — | `boolean` | B-16 |
| `upsert` | `DocInput[]` | `Promise<WriteResult>` | B-04 |
| `insert` | `DocInput[]` | `Promise<WriteResult>` | B-05 |
| `update` | `DocInput[]` | `Promise<WriteResult>` | B-06 |
| `delete` | `string[]` | `Promise<WriteResult>` | B-07 |
| `fetch` | `string[]` | `Promise<Doc[]>` | B-08 |
| `listIds` | `Filter?`, `limit?` | `Promise<string[]>` | B-15 |
| `semanticSearch` | `SemanticSearchReq` | `Promise<Hit[]>` | B-09（语义侧） |
| `vectorSearch` | `VectorSearchReq` | `Promise<Hit[]>` | B-09（向量侧） |
| `ftsSearch` | `FtsSearchReq` | `Promise<Hit[]>` | B-10 |
| `hybridSearch` | `HybridSearchReq` | `Promise<Hit[]>` | B-11 |
| `createIndex`/`dropIndex`/`optimize` | 见签名 | `Promise<void>` | B-13 |

**`Hit.score` 语义（v2 归一化，调用方无需按 `queryType` 分支解读）**：
- **统一方向：越大越相关**。
- `vector` 路：COSINE 度量下内部由 distance 归一化为 `score = 1/(1+distance)`（distance∈[0,2] → score∈[1/3,1]，方向已实测为"越小越相似"，见 `zvec-mcp-server-tools.md` 坑 1）。**仅 COSINE 适用此公式**——IP/L2 的返回 score 语义未经实测，且 IP 是相似度（越大越相似），套用 `1/(1+x)` 会单调递减导致排序反转，故本模块限定 `metric:'COSINE'`（见 §0）。
- `fts` 路：BM25 相似度原值（越大越相关）。
- `hybrid` 路：RRF/加权融合分（越大越相关）。
- `queryType` 仅作结果来源说明，**不影响 score 解读方向**（消解 v1 的方向分叉陷阱，对应 `reference/docs/zvec-mcp-server-tools.md` 实测坑 1）。

> v1 让调用方按 `queryType` 判断 score 方向（质疑 #5），上层每次排序都要 switch-on-type，极易写反导致静默错误；v2 在引擎层统一归一化。

### 4.5.1 zvec 实测参数契约（v6 新增）

实现期 `src/zvec-engine/worker.ts` 与 zvec 0.6.0 对齐时发现：zvec 原生 API 对参数形态有严格约束，以下规则**强约束**本模块与 zvec 的交互边界：

| # | zvec API | 契约约束 | 本模块适配 |
|---|---|---|---|
| Z-01 | `querySync` / `multiQuerySync` / `deleteByFilter` | **拒绝显式 `undefined` 参数**（即使该参数可选）——报 `Expected a string for 'filter'` 等错 | 所有可选参数**条件展开**：`...(x !== undefined ? {x} : {})` |
| Z-02 | `upsertSync` / `insertSync` / `updateSync` | **`vectors` / `fields` 至少为 `{}`**——不能是 `undefined` | `toZvecDocInput` 始终返回 object，即使是空 `{}` |
| Z-03 | `updateSync` | **dense vector 必填**——`Invalid doc[xx]: field[dense] is required but not provided` | 见 §4.5 `update` 联动规则 v6 修正 |
| Z-04 | `ZVecOpen` 对不存在路径 / 持锁路径 | **阻塞等待**而非抛错 | engine.open 主线程 `existsSync` 预检；probe 加 `Promise.race` 超时（默认 3000ms） |
| Z-05 | `ZVecOpen` 恢复集合 | **不需要 `collectionName`**——zvec 从磁盘元数据读集合名 | probe 不传 collectionName；`'__probe__'` 过不了集合名正则 `^[a-zA-Z][a-zA-Z0-9_]{2,}$` |
| Z-06 | worker ESM | **必须静态 `import`**——不能 `require` | worker.ts 顶部 `import { buildCollectionSchema } from './schema/builder.js'` |

**嵌入失败文档剔除（v6 修正）**：`writeDocs` 编排时，`embedding.embed()` 失败的 doc 虽然已进 `WriteResult.errors[]`（`EMBEDDING_FAILED`），但**必须同时从待写列表中剔除**——否则 `vector=undefined` 会触发 zvec Z-02/Z-03 校验报错，导致整批失败（而不是部分失败）。实现：`embedFailedIds: Set<string>` 跳过。

### 4.6 Embedding 提供方（配置抽象，不关心内部）

```ts
interface EmbeddingProvider {
  dimension: number;                    // 输出向量维度；必须 === ZvecEngineConfig.collection.dimension
  embed(texts: string[], opts?: EmbedOptions): Promise<number[][]>;  // v2 改 async（质疑 #2）
}

interface EmbedOptions {
  retries?: number;                      // 失败重试次数，默认 3
  batchSize?: number;                    // 分批大小（避免 SiliconFlow 429），默认 64；**失败粒度 = 小批**：内部按 batchSize 分小批独立重试，小批重试耗尽仍失败 → 该小批对应 doc 标 EMBEDDING_FAILED（见 §4.4）；embed 接口不支持单条失败区分时以小批为最小失败单元（一批同成败）
  timeoutMs?: number;                    // 单批超时，默认 30000
  onProgress?: (done: number, total: number) => void;  // 进度回调
}
```

> `EmbeddingProvider` 仅作为配置项被注入；**基座模块不内置任何具体模型逻辑**（不与引擎耦合），由调用方决定 SiliconFlow / OpenAI / 本地模型等。另附一个**独立的** `SiliconFlowProvider` 参考实现（同包导出，非引擎耦合），默认配置 `Qwen/Qwen3-Embedding-8B` / 4096 维，KiSearch 上层默认注入它即可（对应 REQ-03）。
> v1 的 `embed(texts): number[][]` 同步签名（质疑 #2）在 Node 侧无法实现（SiliconFlow 是 HTTP API），强制同步会阻塞常驻服务并发；v2 改为 `Promise<number[][]>`，所有写入/检索方法签名同步改 async。
> v2 补 `EmbedOptions`（质疑 #8）内化 SiliconFlow 抖动痛点（`requirement.md` §4.4 评测踩坑已记录"整批静默存 0"），批量写入自动分批 + 指数退避重试。

## 5. 非功能约束

- **进程内、无独立服务**：被 KiSearch 常驻进程直接引入使用，不独立对外暴露协议（MCP/HTTP 是上层职责）。
- **全异步**：所有写入/检索方法返回 `Promise`（经 worker `postMessage` 天然 async，不阻塞主事件循环）。
- **不阻塞主事件循环（单一 zvec worker / actor 模型，v5 修正）**：zvec Node 绑定(0.5.0)的 **Async API 仅覆盖 `query`/`multiQuery`/`optimize`/`deleteByFilter`**；`ZVecCreateAndOpen`/`ZVecOpen`/`insertSync`/`upsertSync`/`updateSync`/`deleteSync` **只有 Sync 版本**。v4 的"worker 线程包裹 Sync 写入"方案与锁语义矛盾——worker 属同一进程，主线程若持句柄则 worker 再 `ZVecOpen` 报独占锁冲突（H-02 实测），且 Node worker 间不共享对象（句柄无法 `postMessage`）。**v5 方案：整个 `ZvecEngine` 实例运行在 dedicated `worker_threads`**：(a) worker 启动时 `ZVecOpen` 一次，持有唯一写句柄（无锁冲突）；(b) 主线程持 `ZvecEngineProxy`，所有方法签名保持 `async`，经 `postMessage` 转发到 worker，返回 Promise；(c) embedding（SiliconFlow HTTP）在 worker 内闭环，避免 4096 维向量跨线程传输；(d) 查询亦进 worker（read_only 也锁冲突，不能主线程另开句柄），查询 0.68ms + postMessage 往返 ~0.1ms ≪ 5ms 目标。**串行化代价**：单 worker 串行处理消息，大批量 insert（实测 41.8ms/200 条）期间查询短暂等待——缓解：worker 内批量写入分批 `insertSync`，每批间 `setImmediate` 让出处理积压查询（查询插队）；KiSearch 写入不频繁（扫描后批量灌库），可接受。`ZvecEngine` 实例生命周期 = worker 生命周期（非进程生命周期）。
- **Embedding 可注入**：抽象成 `EmbeddingProvider` 接口（见 4.6），含重试/分批/超时，便于替换 / 单测；附 `SiliconFlowProvider` 参考实现（Qwen3-Embedding-8B，4096 维）。
- **维度校验铁律**：建库前校验 `embedding.dimension === config.collection.dimension`，不符即抛 `DimensionMismatchError`。KiSearch 固定 4096 维（与基准对齐）。
- **度量限定**：`metric` 固定 `'COSINE'`（见 §0）；IP/L2 的 score 语义未实测，暂不开放。
- **score 归一化**：`Hit.score` 统一为"越大越相关"，基座模块内部完成 COSINE distance→score 归一化，调用方无需按 queryType 分支。
- **db 文件归属**：由常驻 MCP server 的 **zvec worker 单一持有写句柄**（见上"不阻塞主事件循环"）；CLI 写入走 MCP 协议或排队等锁。基座模块提供静态 `probe(dbPath)` 供 CLI 在 open 前探测锁/损坏、实例级 `tryOpen()`/`isLocked()`/`close()` 支撑锁协调与优雅释放。实测锁语义（`verify_blocking.mjs` H-02）：`closeSync()` 会真正释放 LOCK（close 后可 `ZVecOpen` 重开成功）；但**同一进程对已开集合再次 `ZVecOpen` 报独占锁冲突**（`Can't lock read-write collection: .../LOCK`），且 read_only 也冲突——故采用"单一 worker 唯一句柄"模型（v5），主线程不持柄。`ZvecEngine` 实例生命周期 = worker 生命周期；worker 崩溃可重 spawn 并重 `ZVecOpen`（db 落盘未损，重开即恢复）。
- **db 损坏识别与重建**：`open()` 失败抛类型化异常（`CollectionNotFoundError` / `CollectionLockedException` / `CollectionCorruptedException`）；损坏 vs 不存在的区分能力以 Node demo 实测为准。确认损坏后由上层触发 `destroy()` → `create()` → 全量重灌。**db 为可重建缓存，非权威数据源**——权威数据在 KiSearch 上层（代码库抽取结果 + 索引文件），重灌数据源 = 上层重新扫描代码库 → 重新抽取 → 全量 `upsert`；基座模块不自带备份，但提供 `destroy()` + `create()` 闭环支撑。
- **FTS 分词器强制配置**：建库时若开启 FTS 必须显式指定 `tokenizer`，默认 `jieba`（中文场景）；不允许默认 standard（CJK 拆单字会拖低 B-11 混合召回）。**✅ Node 侧实测（`verify_blocking.mjs` H-03）：jieba 无需 `jiebaDictDir` 即可初始化（绑定自带默认字典），中文查询正常；而 `standard` 对纯中文 FTS 查询返回空（如 `关系 同步→[]`），印证"禁 standard、默认 jieba"决策必要**。注意：`zvec-probe-node/zvec_demo.mjs` 基线 demo 误用 `standard`，其中文 FTS 路径实际从未生效，需后续改为 jieba。
- **FTS 字段校验**：`fts.field` 须 ∈ `scalarFields` 且 `STRING` 类型，不符抛 `InvalidSchemaError`（见 §4.1）。
- **filter 转义**：结构化 `Filter` 类型内部转 zvec 字符串语法并转义，避免注入。
- **错误分层清晰**：批级用法错误（维度/未知字段/schema 漂移/不一致更新）抛类型化异常；文档级可恢复错误（embedding 失败/id 冲突/not found）进 `WriteResult.errors[]` 用 `WriteErrorCode` 区分（对应 NFR 可用性）。
- **topk 边界**：默认 10，上限 1000（对齐 zvec-mcp-server-tools.md L290）。
- **引擎版本锁定**：`@zvec/zvec` 要求 **≥0.5.0**（原生 FTS/混合依赖此版本）且锁精确版本；安装/启动校验版本与平台预编译二进制可用性，缺失给出修复指引（对应 requirement.md 痛点 3"版本可锁"卖点）。
- **时延构成**：不含 embedding 的检索路（`vectorSearch`/`ftsSearch`/`listIds`）<5ms（基准 0.8ms 均值）；含 `queryText` 的 `semanticSearch`/`hybridSearch` 总时延 = embedding RTT（SiliconFlow HTTP，数百 ms）+ <5ms。"ki search 毫秒级"期望仅对预计算向量路成立。

## 6. 与现有需求映射

- 本模块实现 `REQ-20260717-001` 的 **REQ-01**（引擎层封装）与 **REQ-04**（原生混合检索 FTS+向量）。
- 上层 KiSearch（MCP server / CLI）基于本模块实现 REQ-02（含 `list` 工具，对应 B-15）、REQ-05(scope 隔离)、REQ-06(写入流水线)、REQ-09（常驻保活，对应 B-16）等。
- 实测依据：zvec 基准（Recall@1 85% / Recall@5 95%、查询 0.8ms，4096 维，COSINE）、**Node `verify_blocking.mjs` 已实测闭合**：原生 `multiQuerySync` 混合检索可用、jieba 无需 dictDir 即可初始化且中文 FTS 正常（standard 中文返回空）、4096 维 COSINE 建库+查询通路正常（create 61ms / insert200 41ms / optimize 114ms / query 0.68ms）、`listIds` 纯 filter 扫描可行、`insert` 重复 id 部分失败可行、close 释放 LOCK。Python zvec-mcp 缺 FTS（见 `reference/docs/zvec-mcp-server-tools.md`）。REQ-07 验收口径：Recall@5≥90%（基准 95%）、查询<5ms；Recall@1≥85% 为附加观察指标。
- 假设闭环状态（✅=已实测闭合 / ⚠=部分闭合需真实环境）：
  - **H-01**（zvec API 满足语义）：✅ `listIds` 纯 filter 扫描实测可行（`querySync({filter})` 返回 3 条），`insert` 重复 id 实测为"5 ok + 1 `ZVEC_ALREADY_EXISTS`（不回滚、不覆盖）"，与文档 `WriteResult.errors[] + ID_CONFLICT` 模型完全一致；API 能力完整暴露。
  - **H-02**（db 文件共享）：✅ `closeSync()` 释放 LOCK（close 后重开成功）；同进程重复 `ZVecOpen` 报独占锁 → 落实"单一进程单一写句柄"（见 §5）。
  - **H-03**（中文 FTS 有效性）：✅ jieba 无需 dictDir 可用，standard 中文 FTS 返回空 → "默认 jieba、禁 standard"决策闭环。
  - **H-04**（Node 性能一致）：⚠ 4096 维 API 通路与低时延(0.68ms)已实测；但**语义 Recall@5≥90% 需真实 SiliconFlow embedding + compare.py 语料**，本 Node probe 用退化 hash 向量（自检索 score 全 0、排名失真）无法闭合该指标，须在进入实现后补真实 embedding 基准。**score 归一化公式 `score=1/(1+distance)`（distance∈[0,2]）亦须在真实 embedding 下验证**：自检索 top1 score 应接近 1（distance≈0）、不相关文档 score 应接近 1/3（distance≈2），与 Recall@5 一并闭合。另：本绑定写入/创建/打开无 Async 版本，已由 v5 单一 worker 架构消解（见 §5）。
  - **H-05**（mem-client 语义可映射）：score 归一化后映射成本降低（设计层面成立，待实现验证）。

## 7. 最小 Node demo 验证报告（✅ 已完成）

> 验证脚本：`zvec-probe-node/verify_blocking.mjs`（配套 `probe_h04.mjs`）。全部阻塞项已实测闭合或标注局限性。

| 阻塞项 | 实测结论 | 证据 |
|---|---|---|
| **listIds 可行性**（v2-#2） | ✅ **原生可行**（担忧证伪） | `querySync({filter:"tag='ki-relation'}`) 返回 `[r1,r2,r3]`；官方类型注释亦声明 "Scalar-only filtering: provide only filter"。无需 fetch 全量/独立 id 索引替代方案 |
| **insert 重复 id 语义**（v2-#3） | ✅ **部分成功 + 不回滚**（与文档模型一致） | 5 新 + 1 重复：成功 5 条，失败 1 条 `code=ZVEC_ALREADY_EXISTS` / msg `doc_id[r1] already exists`；r1 内容未被覆盖 → `WriteResult.errors[] + ID_CONFLICT` 建模正确，回写契约确认 |
| **jieba 可用性**（v2-#4 / H-03a,b） | ✅ **无需 dictDir 即可初始化** | `ZVecCreateAndOpen` + `tokenizerName:"jieba"` 无 `jiebaDictDir` 成功，中文查询命中；绑定自带默认字典 |
| **jieba vs standard**（H-03c） | ✅ **standard 中文 FTS 失效** | jieba `关系 同步→[r1,s3,s2]`；standard `关系 同步→[]`（纯中文全空）→ "默认 jieba、禁 standard"决策必要；⚠ `zvec_demo.mjs` 基线误用 standard，其中文 FTS 路径实际未生效 |
| **weighted vs rrf**（v2-#5） | ✅ **weighted 被 fts 数值碾压**（担忧证实） | 同查询 weighted 前 3 = `[s3,r1,r3]` 与 ftsOnly `[s3,r1,r3]` **完全一致**，rrf = `[s3,r1,r3,r2,s1,...]` 更均衡 → 维持"默认 rrf、weighted 标实验性"决策 |
| **H-02 锁语义 + close** | ✅ **close 释放 LOCK / 单进程单写句柄** | `closeSync()` 后 `ZVecOpen` 重开成功（LOCK 释放）；同进程对已开集合再 `ZVecOpen` 报独占锁冲突 `Can't lock read-write collection: .../LOCK` → 落实"一集合一写句柄" |
| **H-04 4096 维通路** | ✅ API 正常 / ⚠ 语义召回未闭合 | create 61.5ms / insert200 41.8ms / optimize 113.8ms / query **0.68ms**；但退化 hash 向量致自检索 score 全 0、排名失真，**Recall@5≥90% 须真实 SiliconFlow embedding + compare.py 语料**，本 probe 无法闭合 |
| **Async API 现实**（修正 §5） | 🔴 **§5 原假设被证伪** | 本绑定(0.5.0) Async 仅 `query`/`multiQuery`/`optimize`/`deleteByFilter`；`create`/`open`/`insert`/`upsert`/`update`/`delete` 仅 Sync → "批量写入走 Async"不可实现，改走 worker 线程 |

**实现的额外 gotcha（实测踩坑）**：
- 集合名需过正则（最小长度 3，如 `lk`/`h` 被拒，`locktest`/`d4096` 通过）——实现时需对集合名加校验。
- `ZVecCreateAndOpen` 要求目标路径**不存在**（已存在的空目录也报错 `path exists`），调用前须清理或判空。
- 中文 FTS 必须用 jieba，否则 `ftsOnly` 等中文检索静默返回空（上线前务必用中文语料回归）。

**下一步**：
1. 基于 `ZvecEngine` 接口落地实现（先 B-01/B-04/B-11 主链路），写入用 worker 线程包裹 Sync 调用（见 §5 修正）。
2. 实现后用真实 SiliconFlow `Qwen3-Embedding-8B` + compare.py 语料补 H-04 语义 Recall@5≥90% 验收。
3. 进入 `design-craft`：KiSearch 上层（MCP server 常驻架构、db 文件共享策略、scope 隔离编排）。
