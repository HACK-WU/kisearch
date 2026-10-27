# 向量引擎实现原理（基于 zvec 引擎）

> 说明 kisearch 的向量层：为什么用进程内 zvec 引擎、核心模块、写入与检索链路。

## 1. 架构定位：kisearch 自有向量引擎

kisearch 现在**拥有自己的向量引擎**（基于 `@zvec/zvec` 的 Rust 内核），不再依赖外部 `mem` CLI。核心变化：

- **从 spawn 到进程内**：向量引擎以 Node 原生模块形式存在，无 shell 调用开销
- **从冷启动到常驻**：MCP server 模式下引擎常驻，查询延迟从 ~4s 降至 <5ms
- **从全局安装到 npm 依赖**：`@zvec/zvec` 作为 npm 依赖，版本可锁，无需全局 `mem`

```
┌─────────────────────────────────────────────────────┐
│  kisearch 脚本（store / search / sync-relation …）        │
│  本地索引（Group 树 + relations-cache + local KB）         │
└───────────────┬─────────────────────────────────────┘
                │  直接 API 调用（无 shell）
                ▼
┌─────────────────────────────────────────────────────┐
│  ZvecEngine（src/zvec-engine/engine.ts）                  │
│  - 常驻进程内，无冷启动                                    │
│  - 原生混合检索（dense + FTS）                              │
│  - metadata 过滤（tag/scope/group）                    │
│  - Embedding 集成（SiliconFlow Qwen3-Embedding-8B）       │
└───────────────┬─────────────────────────────────────┘
                │  @zvec/zvec Node 绑定
                ▼
┌─────────────────────────────────────────────────────┐
│  zvec Rust 内核（嵌入式向量数据库）                         │
│  - 无文件锁，无 lancedb 卡死问题                            │
│  - Recall@5 ≥ 90%（实测 95%）                           │
└─────────────────────────────────────────────────────┘
```

## 2. 核心模块：`src/zvec-engine/`

zvec 引擎层位于 `src/zvec-engine/`，提供完整的向量数据库能力：

| 文件 | 职责 |
|------|------|
| `engine.ts` | ZvecEngine 门面类：create/open/upsert/insert/search/close 生命周期 |
| `types.ts` | 公共类型定义（DocInput/Hit/WriteResult/Filter 等） |
| `proxy.ts` | Worker 线程代理，管理 zvec Rust 实例的 spawn/通信 |
| `worker.ts` | Worker 线程：实际调用 @zvec/zvec API |
| `embedding/` | EmbeddingProvider 接口及 SiliconFlowProvider 实现 |
| `search/` | 检索路由（router.ts）和结果归一化（normalize.ts） |
| `filter/` | Filter 编译器（将 Filter DSL 转 SQL WHERE） |
| `schema/` | Schema 验证器和持久化 |
| `errors.ts` | 结构化错误类型（CollectionCorruptedException 等） |

## 3. ZvecEngine API

### 3.1 生命周期

```typescript
// 创建新集合（首次写入时；dbPath = <vectorDir>/collections/<scope>）
const engine = await ZvecEngine.create({
  dbPath: '/path/to/vector/collections/my-scope',
  collection: {
    name: 'kisearch',
    denseField: 'dense',
    dimension: 4096,                 // 与 config.embedding.dimension 一致
    metric: 'COSINE',
    scalarFields: [
      { name: 'tag', dataType: 'STRING', indexed: true },
      { name: 'scope', dataType: 'STRING', indexed: true },
      { name: 'group', dataType: 'STRING', indexed: true },
      { name: 'content', dataType: 'STRING' },   // FTS 字段
    ],
    fts: { field: 'content', tokenizer: 'jieba' },  // 中文分词
  },
  embedding: new SiliconFlowProvider(...),
});

// 打开已有集合（查询时）
const engine = await ZvecEngine.open({
  dbPath: '/path/to/vector/collections/my-scope',
  collectionName: 'kisearch',
  embedding: new SiliconFlowProvider(...),
});

// 探测状态（不持锁）
const probeResult = await ZvecEngine.probe('/path/to/vector.db');
// → { exists: true, locked: false, healthy: true }

// 关闭
await engine.close();
```

### 3.2 写入

```typescript
// 单条/批量写入
const result = await engine.insert([
  {
    id: generateDocId(text, 'project', 'ki-search'),   // sha256(text+scope+tag) 前 32 位
    text: '项目简介内容...',
    fields: {
      tag: 'ki-search',
      scope: 'project',
      group: '项目/简介',
    },
  },
]);
// → { ok: 1, failed: 0 }

// upsert（存在则更新）
await engine.upsert([...]);

// 删除
await engine.delete(['scope:project/relation:README']);
```

**自动 Embedding**：传入 `text` 时，引擎自动调用 EmbeddingProvider 转为向量，无需手动 embed。

### 3.3 检索

```typescript
// 语义搜索（dense vector）
const hits = await engine.semanticSearch({
  queryText: '如何配置告警',
  topk: 5,
  filter: { field: 'scope', op: '==', value: 'monitor' },
});

// 全文检索（FTS/BM25）
const hits = await engine.ftsSearch({
  match: 'deployGateway',
  topk: 5,
});

// 混合检索（dense + FTS，推荐）
const hits = await engine.hybridSearch({
  queryText: '如何配置告警',    // 语义侧
  fts: '告警 配置',             // 关键词侧
  topk: 5,
  filter: { field: 'tag', op: '==', value: 'ki-search' },
  rerank: { type: 'rrf' },      // RRF 融合
});

// 结果格式
// → [{ id: '...', score: 0.85, queryType: 'hybrid', fields: {...}, text: '...' }]
```

**Score 归一化**：
- vector 路（COSINE）：`1/(1+distance)`，值域 [1/3, 1]
- fts 路：BM25 原值
- hybrid 路：RRF 融合分

### 3.4 Metadata 过滤

支持 SQL 风格的 filter DSL：

```typescript
// 单条件
{ field: 'scope', op: '==', value: 'monitor' }

// 组合条件
{
  and: [
    { field: 'scope', op: '==', value: 'monitor' },
    { field: 'tag', op: '==', value: 'ki-search' },
  ]
}

// 嵌套
{
  or: [
    { field: 'tag', op: '==', value: 'ki-path' },
    { not: { field: 'scope', op: '==', value: 'test' } },
  ]
}
```

## 4. 与上层脚本的集成

### 4.1 store / search / bulk-store

`src/store.ts`、`src/search.ts`、`src/bulk-store.ts` 现在直接调用 `ZvecEngine` API（进程内，无 shell 调用）：

```typescript
// src/store.ts 简化逻辑
const engine = await getOrCreateEngine(config);
const result = await engine.insert([{
  id: generateDocId(text, scope, 'ki-search'),
  text: text,
  fields: { tag: 'ki-search', scope },
}]);
return { memoryId: result.id };
```

### 4.2 sync-relation 的双写

`src/sync-relation.ts` 仍然保持双写模式：

1. **同步阶段**：写本地索引（`relations-cache` + `local KB`）
2. **异步阶段**（`setImmediate`）：调用 `engine.upsert()` 写入两个向量
   - ki-relation：路径文本向量化（供语义兜底定位）
   - ki-search：module-info 原文向量化

**优势**：向量写入失败不影响已完成的本地索引主流程，保持容错性。

### 4.3 路径语义兜底

`src/lib/path-search.ts` 的 `searchPath()` 现在调用 `engine.ftsSearch()` 或 `engine.hybridSearch()`，不再直接 spawn mem：

- 标签固定为 `ki-path` 或 `ki-relation`
- 用 metadata filter 限定 tag
- 匹配阈值 `DEFAULT_THRESHOLD = 0.75`
- 任何异常**静默降级返回 null**

## 5. 标签体系（三层隔离）

zvec 引擎通过 metadata 字段 `tag` 实现向量空间隔离，语义与原 `mem --tags` 一致：

| 标签 | 用途 | 写入位置 |
|------|------|----------|
| `ki-search` | 通用知识语义搜索（模块原文） | `store` / `bulk-store` / `sync-relation` |
| `ki-path` | Group 路径定位 | `path-vectorize.ts` |
| `ki-relation` | Relation 名称 / 归属查询 | `path-vectorize.ts` / `sync-relation` |

**实现**：通过 `filter: { field: 'tag', op: '==', value: 'ki-search' }` 实现硬过滤，不再依赖客户端 post-filter。

## 6. Scope 与配置

- 每个 scope 使用独立 Collection（`vectorDir/collections/<scope>`），且所有向量都带 `scope` metadata，双重隔离
- 配置：`~/.ki/config.yaml` 的 `embedding` 段（模型 / 维度 / 超时）与可选的 `scopes.<scope>` 段
- `scopeMode: default`（默认）下无需注册 scope；`strict` 下需先在 `scopes` 中登记
- `@zvec/zvec` 是 npm 依赖，版本锁定在 `package.json`

## 7. 选型参考：与旧 mem CLI 的对比（历史数据）

> 数据采集于迁移期，仅作选型参考；当前行为以 zvec 实现为准。

| 指标 | zvec 引擎（当前） | mem CLI（旧） |
|------|------------------|--------------|
| 建库（创建+嵌+插+opt） | **8.3 s** | 24.5 s |
| 冷启动 reopen | **49.9 ms** | —（CLI 每次冷起） |
| 查询首条 | **3.6 ms** | 4.25 s |
| 查询平均 | **0.8 ms** | 4.08 s |
| Recall@1 | **85.0%** | 12.5% |
| Recall@3 | **92.5%** | 65.0% |
| Recall@5 | **95.0%** | 82.5% |

→ zvec 在延迟（~5000×）与召回质量（@1 约 7×）上全面胜出。

## 8. 小结

kisearch 的文本向量化与向量检索现在基于**进程内 zvec 引擎**，彻底消除了对外部 `mem` CLI 的依赖：

- **向量化** = `engine.insert()` / `engine.upsert()`（text + metadata → tag/scope/group）
- **检索** = `engine.hybridSearch()`（自然语言 query → 带 score 的 Hit[]）
- **本地索引** = Group 树 + `relations-cache` + `local KB`，与向量库解耦，可独立恢复
- **异步双写** = `sync-relation` 先落本地索引，再用 `setImmediate` + `engine.upsert()` 后台向量化

设计上严格遵循"引擎内嵌、常驻复用"原则：所有向量能力、召回算法、scope 治理都在 zvec 引擎层，kisearch 只做编排与交付。
