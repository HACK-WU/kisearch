## 架构说明

`knowledge-index`（KiSearch）是一个**本地知识索引与向量检索系统**，基于 zvec 向量引擎，提供完整的知识管理能力。

核心能力：

- **结构化导航**：把知识整理成 Group 树，便于 Agent 先缩小范围
- **原文交付**：把模块说明保存在本地 KB 中，便于 Agent 直接读取 Markdown 原文回答问题
- **向量检索**：基于 zvec 引擎的混合检索（dense + FTS），毫秒级响应

## 整体架构

```mermaid
flowchart TB
    U[用户 / MCP Client / AI Agent]
    KI[knowledge-index<br/>Group 树 + Relations 缓存 + 本地 KB]
    MCP[ki MCP Server<br/>常驻服务]
    ZVEC[ZvecEngine<br/>@zvec/zvec Rust 内核]
    DATA[(zvec DB 文件<br/>持久化向量)]

    U --> KI
    U --> MCP
    KI --> ZVEC
    MCP --> ZVEC
    ZVEC --> DATA
```

## 分层职责

| 组件 | 主要职责 |
|------|------|
| `knowledge-index` | Group 导航、热门 Relation 缓存、本地 Markdown 原文交付、CLI 命令 |
| `ki MCP Server` | 常驻 MCP 服务，暴露 store/search/list/stats 等工具 |
| `ZvecEngine` | 进程内向量引擎：insert/upsert/hybridSearch，Embedding 集成 |

## knowledge-index 内部结构

```mermaid
flowchart LR
    GI["group-index.json<br/>Group 树索引 + source 块"]
    RC["relations-cache.json<br/>Relation 缓存 / 关键词 / 分区<br/>（含 memoryId / sourcePath）"]
    KB["kb/<scope>/<group>/index.json<br/>本地 KB 原文"]
    SI["scan-index.json<br/>[旧流程] 外部知识库扫描状态账本"]
    SP["scan-pending.json<br/>[旧流程] 扫描断点（临时）"]

    GI --> RC
    RC --> KB
    SI --> RC
    SP --> SI
```

### 核心文件

| 文件 | 角色 | 读写方 | 生命周期 |
|------|------|--------|---------|
| `group-index.json` | Group 树结构索引 + `source` 块（`dir`/`rootName`/`commit`） | 所有脚本读写 | 永久，随 Group 增删改 |
| `relations-cache.json` | Relation 缓存（评分/淘汰/词云），含 `memoryId`/`sourcePath` | 所有脚本读写 | 永久，随 Relation 使用动态更新 |
| `kb/{scope}/{group}/index.json` | 本地 KB 原文 | get-module-info 读，sync-relation/import 写 | 永久，随知识沉淀积累 |
| `scan-index.json` | [旧流程] 外部知识库扫描状态账本 | scan-kb / import-kb 读写 | 永久，增量扫描依赖 `lastScannedCommit` |
| `scan-pending.json` | [旧流程] 扫描断点 | scan-kb 写，AI 读 | 临时，merge 后可删除 |

### `group-index.json` 的 `source` 块

S-01 新增字段，记录外部知识库来源信息，用于增量 diff：

```json
{
  "version": 1,
  "scope": "qoder-wiki",
  "groups": { "QoderWiki": { ... } },
  "source": {
    "dir": "/abs/path/to/source",
    "rootName": "QoderWiki",
    "commit": "b945303942b62176ace2bd58f294f5c78e5c2438"
  },
  "updatedAt": "2026-05-28T05:17:22.360Z"
}
```

- `dir`：外部知识库目录绝对路径
- `rootName`：导入时的顶层 Group 名称（与 `meta.rootName` 一致，作为 Group 树的第一层节点）
- `commit`：导入时的 git HEAD commit，`scan-kb diff` 以此为基准检测变更

### `relations-cache.json` 的 `memoryId` / `sourcePath`

S-04 新增的关联字段，写入 `hot_relations` 每条 relation 中：

```json
{
  "id": "rel_003",
  "text": "Scope 隔离机制",
  "score": 0,
  "useCount": 0,
  "lastUsedTime": null,
  "isImported": true,
  "memoryId": "dbc6f2a0-d62b-47cb-835a-371942fdc08a",
  "sourcePath": "核心概念/Scope 隔离机制.md"
}
```

- `memoryId`：向量数据库中对应记录的 ID，用于 `modify`（delete+create）和 `delete` 操作
- `sourcePath`：相对 `source.dir` 的 posix 路径，用于 `scan-kb diff` 关联变更文件

### `index.json` 的 key 因写入来源不同而异

| 写入脚本 | key 来源 | 示例 |
|---------|---------|------|
| `import-kb.ts` / `scan-kb import` | 文件名去 `.md` 扩展名 | `"多项目隔离"` |
| `sync-relation.ts` | `--relation` 参数原文 | `"标签系统"` |

## 运行时主链路

```mermaid
flowchart TD
    Q[用户问题] --> G[query-group<br/>读取 Group 树 / 热门 Relation / 关键词]
    G --> H{本地热门 Relation 是否命中?}
    H -- 是 --> M[get-module-info<br/>读取本地 KB 原文]
    M --> A[AI 直接回答]

    H -- 否 --> R[memory_recall<br/>到父项目记忆系统做语义检索]
    R --> F{是否命中记忆?}
    F -- 是 --> S[sync-relation<br/>回写本地 Relation + KB]
    S --> A

    F -- 否 --> P[AI 暂停并补充线索 / 扫描代码 / 生成模块说明]
    P --> D[sync-relation + memory_store<br/>双写本地索引与记忆系统]
    D --> A
```

## 外部知识库导入链路（S-04 统一流程）

```mermaid
flowchart LR
    EXT[外部 Markdown 知识库] --> AI[AI 生成 ai-results.json<br/>meta + entries]
    AI --> IMP[scan-kb import<br/>5 阶段流水线]
    IMP --> VEC[zvec 引擎向量化]
    IMP --> GI2[group-index.json<br/>Group 树 + source 块]
    IMP --> RC2[relations-cache.json<br/>含 memoryId / sourcePath]
    IMP --> KB2[本地 KB 原文]
```

### 增量更新链路（S-05 + S-06）

```mermaid
flowchart LR
    DIFF[scan-kb diff] --> AI2[AI 生成增量 ai-results.json<br/>含 action 字段]
    AI2 --> INCR[scan-kb import --mode incremental]
    INCR --> ADD[add: 向量化 + 写索引]
    INCR --> MOD[modify: mem delete + 重新向量化 + 替换索引]
    INCR --> DEL[delete: mem delete + 移除索引]
```

## 与父项目记忆系统的配合

### 协作 1：本地快取 + 远端召回

- 热门知识优先走本地 JSON
- 长尾知识走 `memory_recall`
- 命中后回写本地，逐步把长尾知识沉淀为可导航的热点知识

### 协作 2：原文与摘要分层存储

- 本地 KB 更适合保存**完整 Markdown 原文**
- 记忆系统更适合保存**摘要、标签、关键词、长期记忆条目**

### 协作 3：共同形成闭环

- **查询时**：本地命中优先，记忆检索兜底
- **写入时**：新知识双写到本地索引与记忆系统
- **演化时**：热点沉淀在本地，长尾保留在记忆系统
