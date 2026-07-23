# 标签体系设计文档

## 概述

KiSearch 定义了三类核心标签（`ki-path`、`ki-relation`、`ki-search`），基于 zvec 引擎的 metadata 字段 `tags`，实现不同用途记忆数据的**物理隔离**。

三类标签的分工定位：

| 标签 | 定位 | 写入频率 | 用途 |
|------|------|----------|------|
| `ki-path` | 路径层级索引 | 每个 Group 一条 | group-resolve / query-group 路径模糊匹配 |
| `ki-relation` | Relation 关系索引 | 每个 Entry 一条 | get-module-info Relation 名称模糊匹配 |
| `ki-search` | 通用语义搜索 | 用户手动 / 批量导入 | ki search CLI / MCP 通用语义搜索 |

---

## 1. ki-path — 路径层级索引

### 1.1 内容格式

格式：**路径层级（空格分隔，含根节点）| 合并关键词**

示例：
```
BK-Monitor-Wiki 告警系统设计 告警处理服务 | 告警收敛,降噪,通知
```

构建方式：`buildGroupPathContent(groupPath, keywords)` → [path-vectorize.ts](../src/lib/path-vectorize.ts#L57-L65)

### 1.2 写入路径

| 写入方 | 调用链 | 说明 |
|--------|--------|------|
| `import.ts` | `bulkStorePaths(pathEntries)` → engine.insert `tags: 'ki-path'` | scan-kb 全量导入 |
| `incremental.ts` | `bulkStorePaths(pathEntries)` → engine.insert `tags: 'ki-path'` | scan-kb 增量导入 |

每个 Group 合并所有 Entry 的关键词后写入一条，不重复。

参考代码：[import.ts L518-L525](../src/lib/import.ts#L518-L525)、[incremental.ts L380-L386](../src/lib/incremental.ts#L380-L386)

### 1.3 查询消费

| 消费方 | 调用链 | 场景 |
|--------|--------|------|
| `group-resolve.ts` | `searchPath(userInput, 'ki-path', scope)` | 用户输入 Group 路径时模糊匹配（如 "告警系统" 匹配 "BK-Monitor-Wiki/告警系统设计"） |
| `query-group.ts` | `memSearch({ tags: 'ki-path' })` | 语义兜底：精确匹配失败后，通过语义向量查找相似路径 |
| `path-vectorize.ts` | `deletePathVector(text, 'ki-path', scope)` | 增量导入时删除旧路径向量（先搜索定位 memoryId 再删除） |

---

## 2. ki-relation — Relation 关系索引

### 2.1 内容格式

格式：**Relation 名称 | Group: 路径层级（空格分隔）| 关键词**

示例：
```
告警收敛服务 | Group: BK-Monitor-Wiki 告警系统设计 告警处理服务 | 收敛,去重
```

构建方式：`buildRelationContent(relationText, groupPath, keywords)` → [path-vectorize.ts](../src/lib/path-vectorize.ts#L74-L84)

### 2.2 写入路径

| 写入方 | 调用链 | 说明 |
|--------|--------|------|
| `import.ts` | `bulkStorePaths(pathEntries)` → engine.insert `tags: 'ki-relation'` | scan-kb 全量导入 |
| `incremental.ts` | `bulkStorePaths(pathEntries)` → engine.insert `tags: 'ki-relation'` | scan-kb 增量导入 |
| `sync-relation.ts` | `storeOnePath({ tag: 'ki-relation' })` | 单条 Relation 写入，失败不阻塞主流程 |

参考代码：[import.ts L510-L515](../src/lib/import.ts#L510-L515)、[sync-relation.ts L431-L434](../src/sync-relation.ts#L431-L434)

### 2.3 查询消费

| 消费方 | 调用链 | 场景 |
|--------|--------|------|
| `get-module-info.ts` | `searchPath(relation, 'ki-relation', scope)` | 用户查询 Relation 名称时模糊匹配 |
| `path-vectorize.ts` | `deletePathVector(text, 'ki-relation', scope)` | 增量导入时删除旧 Relation 向量 |

### 2.4 ki-path 与 ki-relation 的共同基础设施

`searchPath()` 是两者的统一向量搜索接口 → [path-search.ts](../src/lib/path-search.ts#L62-L67)：

```typescript
export function searchPath(query: string, tag: 'ki-path' | 'ki-relation', scope: string): PathSearchResult | null
```

底层调用 `engine.hybridSearch()` 或 `engine.ftsSearch()` 做向量语义匹配，通过 metadata filter `tags` 限定标签，阈值 0.75，搜索范围仅限 scope 内的对应标签数据。

两类的 **`extractPathFromContent()`** 解析逻辑不同 → [path-search.ts L133-L139](../src/lib/path-search.ts#L133-L139)：

| 标签 | 路径提取方式 |
|------|-------------|
| `ki-path` | 取 `\|` 前的空格分隔路径，还原为 `/` 分隔的 Group 路径 |
| `ki-relation` | 取第一个 `\|` 前的 Relation 名称部分（如 `告警收敛服务`） |

---

## 3. ki-search — 通用语义搜索

### 3.1 内容格式

自由文本，无固定格式约束。典型内容：

- scan-kb 导入的文档摘要 + 关键词 + 路径
- sync-relation 写入的 moduleInfo 模块说明
- 用户通过 `ki store` 手动写入的任意知识片段

### 3.2 写入路径

| 写入方 | 调用链 | 说明 |
|--------|--------|------|
| `batch-vectorize.ts` | `vectorizeOne` / `bulkVectorize` → engine.insert `tags: 'ki-search'` | scan-kb 导入的文档内容向量 |
| `sync-relation.ts` | `engine.upsert({ tags: 'ki-search' })` | 容错双写 moduleInfo |
| `store.ts` | `engine.insert({ tags: 'ki-search' })` | `ki store` CLI 手动写入 |
| `bulk-store.ts` | `engine.insert({ tags: 'ki-search' })` | `ki bulk_store` CLI 手动批量写入 |
| `mcp-tools/store.ts` | `engine.insert({ tags: 'ki-search' })` | MCP ki_store 工具 |

> 注意：写入时必须显式传 `tags: 'ki-search'`，确保 metadata 字段正确，避免标签污染。

### 3.3 查询消费

| 消费方 | 调用链 | 场景 |
|--------|--------|------|
| `search.ts` | `memSearch({ tags: 'ki-search' })` | `ki search` CLI 命令，默认搜 ki-search 标签 |
| `mcp-tools/search.ts` | `executeSearch({ tags: 'ki-search' })` | MCP ki-search 工具 |

---

## 4. 标签隔离设计

```
┌─────────────────────────────────────────────────────────────────┐
│                        mem scope (e.g. monitor)                  │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │  ki-path     │  │ ki-relation  │  │  ki-search               │  │
│  │              │  │              │  │                          │  │
│  │  路径层级索引  │  │  关系索引    │  │  通用语义搜索            │  │
│  │  (内部匹配)   │  │  (内部匹配)  │  │  (用户面向)              │  │
│  │              │  │              │  │                          │  │
│  │  消费:       │  │  消费:       │  │  消费:                   │  │
│  │  group-      │  │  get-module- │  │  ki search CLI           │  │
│  │  resolve     │  │  info        │  │  MCP ki-search           │  │
│  │  query-group │  │              │  │                          │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
│                                                                  │
│  写入源: import.ts / incremental.ts / sync-relation.ts           │
│          store.ts / bulk-store.ts                                │
└─────────────────────────────────────────────────────────────────┘
```

- `ki-path` 和 `ki-relation`：**内部基础设施**，服务于 group-resolve 和 get-module-info 的向量模糊匹配
- `ki-search`：**用户面向**的通用语义搜索，是 `ki search` 命令的默认数据源

---

## 5. 标签隔离实现

### 5.1 写入时隔离

zvec 引擎通过 metadata 字段 `tags` 实现写入时隔离：

```typescript
// ki-path 写入（path-vectorize）
await engine.insert({
  id: generatePathId(scope, groupPath),
  text: 'BK-Monitor-Wiki 告警系统设计 | 告警收敛,降噪',
  fields: { scope, tags: 'ki-path' },
});

// ki-search 写入（ki store）
await engine.insert({
  id: generateDocId(scope, text),
  text: '告警系统设计：包含告警处理、告警引擎、通知渠道三个核心模块',
  fields: { scope, tags: 'ki-search' },
});
```

标签存储在 metadata 字段 `tags` 中，通过 zvec 的标量索引实现高效过滤。

### 5.2 查询时隔离

zvec 引擎通过 metadata filter 实现查询时硬过滤：

```typescript
// 检索时通过 filter 限定标签
const hits = await engine.hybridSearch({
  queryText: '如何配置告警',
  topk: 5,
  filter: { field: 'tags', op: '==', value: 'ki-search' },
});
```

与旧 mem CLI 不同，zvec 的 metadata filter 是**硬过滤**，无需客户端 post-filter。

---

## 6. 标签修改影响面

| 场景 | 影响范围 |
|------|----------|
| 修改数据写入标签 | 仅影响**新写入**数据，历史数据标签不变 |
| 修改查询标签 | 影响**搜索召回范围**（改后搜不到历史数据） |
| 删除/弃用标签 | `group-resolve` / `get-module-info` 向量匹配功能失效 |

历史标签数据（如 scan-kb import 修复前写入的自动提取标签）需要通过 `engine.delete()` 逐个删除后重新导入。

---

## 7. 相关文件索引

| 文件 | 职责 |
|------|------|
| [path-vectorize.ts](../src/lib/path-vectorize.ts) | ki-path / ki-relation 写入核心（bulkStorePaths / storeOnePath） |
| [batch-vectorize.ts](../src/lib/batch-vectorize.ts) | ki-search 批量写入（scan-kb import 文档内容向量化） |
| [path-search.ts](../src/lib/path-search.ts) | searchPath 统一搜索接口（ki-path / ki-relation 查询） |
| [zvec-engine/engine.ts](../src/zvec-engine/engine.ts) | ZvecEngine 核心：insert/upsert/search/close 生命周期 |
| [sync-relation.ts](../src/sync-relation.ts) | ki-relation + ki-search 双写 |
| [import.ts](../src/lib/import.ts) | scan-kb 导入：bulkVectorize（ki-search）+ bulkStorePaths（ki-path/ki-relation） |
| [incremental.ts](../src/lib/incremental.ts) | scan-kb 增量：同上写入逻辑 |
| [search.ts](../src/search.ts) | ki search CLI（默认 tags: ki-search） |
| [store.ts](../src/store.ts) | ki store CLI（默认 tags: ki-search） |
| [query-group.ts](../src/query-group.ts) | 语义兜底（tags: ki-path） |
| [get-module-info.ts](../src/get-module-info.ts) | Relation 模糊匹配（tags: ki-relation） |
| [group-resolve.ts](../src/lib/group-resolve.ts) | Group 路径模糊匹配（tags: ki-path） |
