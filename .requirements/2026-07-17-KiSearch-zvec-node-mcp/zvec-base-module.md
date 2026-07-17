---
id: REQ-20260717-002
feature: KiSearch 基座模块（zvec 引擎抽象层）功能与接口设计
status: 设计中
created: 2026-07-17
updated: 2026-07-17
version: 1
tags: [engine-layer, zvec, base-module, interface]
depends_on: [REQ-20260717-001]
author: AI
document_type: requirement+interface
---

# 基座模块设计：zvec 引擎抽象层（ZvecEngine）

> 本模块即 `requirement.md` 中 **REQ-01「封装 zvec 引擎层」** 的具体落地设计。它位于 KiSearch 上层（领域 / MCP / CLI）与 `@zvec/zvec` 原始绑定之间，是纯引擎抽象层。

## 0. 已确认的三项决策（用户拍板）

| 决策点 | 结论 |
|---|---|
| 模块边界 | **纯引擎抽象层，不含 MCP 协议**。MCP server 是 KiSearch 上层职责，调用本模块 |
| Embedding 归属 | **模块自动 embed**：喂 `{id,text,fields}` 即内部生成 dense 向量并建 FTS 索引；同时接受预计算向量 |
| 集合模型 | **单集合句柄**：一个 `ZvecEngine` 实例 = 一个已打开的集合；`ki-relation`/`ki-path`/`ki-search` 与 scope 用 metadata 过滤隔离，不建多集合 |

## 1. 根因与本质

- **表象**：KiSearch 换了 zvec 引擎，需要一层封装。
- **本质**：把 `@zvec/zvec` 原始 Rust 绑定 API 的复杂度，与 KiSearch 的领域语义**彻底解耦**。没有这层，上层直接调 `multiQuerySync` 之类底层 API，引擎升级即全崩。
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
| 集合生命周期、文档增删改查、向量检索、FTS 关键词检索、混合检索（FTS+向量+RRF）、标量/metadata 过滤、索引管理、embedding 提供方抽象 | `ki-relation`/`ki-path`/`ki-search` 三层标签**含义**、scope 隔离**策略**、知识抽取逻辑、MCP 工具定义、CLI 命令、底层检索 API 之上的业务编排 |

**铁律**：基座模块**不认识 `ki-relation`**。只认"任意字符串 tag / 任意标量字段"。KiSearch 把领域概念映射成通用 `tags`/`fields` 传下来 → 引擎可单测、可锁版本、与领域解耦。

## 3. 功能需求清单

| ID | 能力 | 对应 zvec-mcp 工具 | 说明 |
|---|---|---|---|
| B-01 | 集合创建即打开 | `create_and_open_collection` | 首次建库，定义 dense 维度/度量 + 标量字段 + 开启 FTS |
| B-02 | 集合打开（复用） | `open_collection` | 常驻服务启动 / 重启挂载 |
| B-03 | 集合信息 | `get_collection_info` | schema、doc 数、索引状态 |
| B-04 | 文档写入（upsert，幂等） | `embedding_write`+`upsert` | 喂 `{id,text,fields}` → 自动 embed + 建 FTS 索引；也接受预计算向量 |
| B-05 | 文档插入（防覆盖） | `insert_documents` | id 冲突报错 |
| B-06 | 文档局部更新 | `update_documents` | 只改部分字段 |
| B-07 | 文档删除 | `delete_documents` | 按 id |
| B-08 | 文档取回 | `fetch_documents` | 按 id 取原文/向量/字段 |
| B-09 | 向量检索 / 语义检索 | `vector_query` | 文本语义召回（内部转向量）或直接给预计算向量 |
| B-10 | **FTS 关键词检索** | ❌（Python zvec-mcp 没有） | **Node 原生 FTS**，代码符号精确召回——核心差异点 |
| B-11 | **混合检索（FTS+向量+RRF）** | ❌（Python zvec-mcp 缺 FTS） | **KiSearch 召回主路径**，FTS+向量+RRF 融合召回（Node 原生支持） |
| B-12 | 标量过滤 | 各检索的 `filter` | 按标量字段（如 tag / scope）做等值或范围过滤 |
| B-13 | 索引管理 | `create_index`/`drop_index`/`optimize` | HNSW/INVERT 建改、压实 |
| B-14 | Embedding 提供方抽象 | `generate_dense_embedding` | 可注入 OpenAI 兼容（SiliconFlow），可替换 |

> **B-10 / B-11 是 Python zvec-mcp 缺、但 Node `@zvec/zvec` 原生有、且 KiSearch 刚需的能力**——换 Node 引擎的根本收益，必须作为一等公民暴露。

## 4. 接口契约（仅参数与响应结构，不涉及内部实现）

> 本节只定义「调用方传入什么结构」与「拿到什么响应结构」。方法内部如何调用 `@zvec/zvec`、是否同步、如何生成向量、如何融合排序等，均不在本节范围。

### 4.1 引擎配置（create / open 的入参）

```
interface ZvecEngineConfig {
  dbPath: string;                       // 集合持久化目录
  collection: {
    name: string;                       // 集合名
    denseField: string;                 // 向量字段名（如 'dense'）
    dimension: number;                   // 向量维度，须与 embedding 模型一致
    metric: 'COSINE' | 'IP' | 'L2';      // 向量距离度量
    scalarFields: ScalarFieldDef[];      // 标量字段定义（tag/path/scope 等）
    ftsField?: string;                   // 用于全文检索的标量字段名；省略则不建 FTS
  };
  embedding: EmbeddingProvider;          // 可注入的 embedding 提供方（见 4.6）
}

interface ScalarFieldDef {
  name: string;                          // 字段名
  dataType: 'STRING' | 'BOOL' | 'INT32' | 'INT64' | 'FLOAT' | 'DOUBLE' | 'UINT32' | 'UINT64';
  indexed?: boolean;                     // 是否建倒排(INVERT)索引加速过滤
}
```

### 4.2 文档输入（写入类操作的入参）

```
interface DocInput {
  id: string;                            // 文档唯一 id
  text?: string;                         // 原文：内部转向量并写入 ftsField（若该字段已配置）
  vectors?: Record<string, number[]>;    // 预计算向量（与 text 二选一或并存）
  fields?: Record<string, ScalarValue>;  // 标量字段键值（tag/path/scope 等）
}
type ScalarValue = string | number | boolean;
```

### 4.3 检索请求（查询类操作的入参）

```
interface SemanticSearchReq {                   // 语义检索：文本 → 内部转向量 → 相似召回
  queryText: string;
  topk?: number;                         // 返回条数
  filter?: string;                       // 标量字段过滤表达式
}

interface VectorSearchReq {                   // 向量检索：直接给查询向量
  vector: number[];
  topk?: number;
  filter?: string;
}

interface FtsSearchReq {
  match: string;                         // 关键词串（如代码符号名）
  topk?: number;
  filter?: string;
}

interface HybridSearchReq {
  queryText?: string;                    // 语义侧文本
  vector?: number[];                     // 语义侧预计算向量
  fts: string;                           // 关键词侧串
  topk?: number;
  rerank?: {                             // 多路融合策略
    type: 'rrf' | 'weighted';
    weights?: Record<string, number>;    // weighted 模式各路权重
    rankConstant?: number;               // rrf 模式常数
  };
  filter?: string;
}
```

### 4.4 响应数据结构

```
interface Hit {
  id: string;                            // 命中文档 id
  score: number;                         // 相关性数值（方向见 4.5 说明，依赖 queryType）
  queryType: 'vector' | 'fts' | 'hybrid'; // 标识结果来源，用于正确解读 score 方向
  fields: Record<string, ScalarValue>;   // 命中文档的标量字段
}

interface WriteResult {
  ok: number;                                      // 成功写入条数
  failed: number;                                  // 失败条数
  errors?: { id: string; reason: string }[];       // 失败明细（可选）
}

interface CollectionInfo {
  name: string;
  dimension: number;
  metric: 'COSINE' | 'IP' | 'L2';
  docCount: number;                                // 文档总数
  scalarFields: ScalarFieldDef[];
  ftsField?: string;
}

interface Doc {
  id: string;
  vectors?: Record<string, number[]>;
  fields?: Record<string, ScalarValue>;
}
```

### 4.5 操作清单（方法 → 入参 → 响应）

| 操作 | 入参类型 | 响应类型 | 对应能力 |
|---|---|---|---|
| 创建集合 | `ZvecEngineConfig` | 引擎句柄 | B-01 |
| 打开集合 | `ZvecEngineConfig` (+ 只读?) | 引擎句柄 | B-02 |
| 集合信息 | — | `CollectionInfo` | B-03 |
| 销毁集合 | — | 空 | （不可恢复） |
| 写入(upsert) | `DocInput[]` | `WriteResult` | B-04 |
| 插入(防覆盖) | `DocInput[]` | `WriteResult` | B-05 |
| 局部更新 | `DocInput[]` | `WriteResult` | B-06 |
| 删除 | `string[]`(ids) | 空 | B-07 |
| 取回 | `string[]`(ids) | `Doc[]` | B-08 |
| 语义检索 | `SemanticSearchReq` | `Hit[]` | B-09（语义侧） |
| 向量检索 | `VectorSearchReq` | `Hit[]` | B-09（向量侧） |
| FTS 检索 | `FtsSearchReq` | `Hit[]` | B-10 |
| 混合检索 | `HybridSearchReq` | `Hit[]` | B-11 |

**`Hit.score` 语义（重要，调用方须按 `queryType` 解读，不可假设统一方向）**：
- `vector`：距离值，**越小越相似**（COSINE 度量下）。
- `fts`：相似度值，**越大越相关**（BM25 式）。
- `hybrid`：融合分，方向以具体融合策略为准。

### 4.6 Embedding 提供方（配置抽象，不关心内部）

```
interface EmbeddingProvider {
  dimension: number;                    // 输出向量维度
  embed(texts: string[]): number[][];  // 输入文本，输出向量
}
```

> `EmbeddingProvider` 仅作为配置项被注入；基座模块不内置任何具体模型逻辑，由调用方决定 SiliconFlow / OpenAI / 本地模型等。

## 5. 非功能约束

- **进程内、无独立服务**：被 KiSearch 常驻进程直接引入使用，不独立对外暴露协议（MCP/HTTP 是上层职责）。
- **Embedding 可注入**：默认 SiliconFlow，抽象成 `EmbeddingProvider` 接口（见 4.6），便于替换 / 单测。
- **错误清晰**：集合未打开、维度不匹配、embedding 缺失配置等明确报错（对应 NFR 可用性）。
- **score 方向随查询类型变化**：`Hit.score` 的"好坏方向"依赖 `queryType`，已在 4.5 明确，调用方须按类型解读，不可假设统一方向。

## 6. 与现有需求映射

- 本模块实现 `REQ-20260717-001` 的 **REQ-01**（引擎层封装）与 **REQ-04**（原生混合检索 FTS+向量）。
- 上层 KiSearch（MCP server / CLI）基于本模块实现 REQ-02、REQ-05(scope 隔离)、REQ-06(写入流水线) 等。
- 实测依据：zvec 基准（Recall@1 85%、查询 0.8ms）、Node 原生 FTS+混合检索已验证、Python zvec-mcp 缺 FTS（见 `reference/docs/zvec-mcp-server-tools.md`）。

## 7. 下一步

1. 写最小 Node demo 接通 `@zvec/zvec`，核对 `insert`/`query`/原生混合/metadata 过滤 API（验证 H-01）。
2. 基于本接口 `ZvecEngine` 落地实现（先 B-01/B-04/B-11 主链路）。
3. 进入 `design-craft`：KiSearch 上层（MCP server 常驻架构、db 文件共享策略、scope 隔离编排）。
