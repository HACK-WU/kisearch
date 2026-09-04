## 架构说明

`knowledge-index`（kisearch）是一个**本地知识索引与向量检索系统**，基于 zvec 向量引擎，提供完整的知识管理能力。

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
    RC["relations-cache.json<br/>Relation 缓存 / 分区<br/>（含 memoryIds / sourcePath）"]
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
| `group-index.json` | Group 树结构索引 + `source` 块（`dir` + 切分参数） | 所有脚本读写 | 永久，随 Group 增删改 |
| `relations-cache.json` | Relation 缓存（评分/分区，存储不设上限），含 `memoryIds`/`sourcePath` | 所有脚本读写 | 永久，随 Relation 使用动态更新 |
| `kb/{scope}/{group}/index.json` | 本地 KB 原文 | get-module-info 读，sync-relation/import 写 | 永久，随知识沉淀积累 |
| `scan-index.json` | [旧流程] 外部知识库扫描状态账本 | scan-kb import 读写 | 永久，增量扫描依赖 `lastScannedCommit` |
| `scan-pending.json` | [旧流程] 扫描断点 | scan-kb 写，AI 读 | 临时，merge 后可删除 |

> **分区上限语义**：`partition_config.maxHotCount`（默认 `10`）仅是 `query-group` 展示侧 hot 分区的截断上限（`scoring.ts` `partitionByScore`，新兴席位优先保留），**不是存储上限**——Relation 全量持久于 `hot_relations`，无逐出机制（历史上的"容量 10 条静默逐出"已于 2026-09-01 移除）。warm/cold 同理仅为展示分区（上限 50 / 不截断）。
>
> **分区守恒不变量（2026-09-04 修复）**：展示侧截断只改变条目所属分区，不会让条目消失——热区溢出回流常温/冷区、常温溢出回流冷区，`hot + warm + cold` 恒等于全量（唯一例外：显式配置 `maxColdCount` 时的冷区末端截断）。修复前规模 ≥ 34 时被截断条目会在**所有 mode 下都查不到**（且被兜底标记为 `[冷]` 却筛不到）。`warmPercent` 以热区之外的候选池为基准；Group 聚合分取组内 Relation 评分的**均值**（非求和，避免规模压倒活跃度）。
>
> **已清理的字段/函数**：`GroupData.max_hot_count`（只写不读的死字段，2026-09-01 存储上限 bug 残留）、`partition_config.decayStep` 与 `scoring.ts` 的 `boundaryDecay`/`hybridPartition`（生产零调用死代码；且 boundaryDecay 修改的 score 会被下次 `calculateScore` 重算覆盖，与派生评分模型不兼容）均已删除；存量 cache 中残留的同名键不被读取，无需迁移。

### `group-index.json` 的 `source` 块

记录外部知识库来源信息，用于 Wiki 写回定位源目录：

```json
{
  "version": 1,
  "scope": "qoder-wiki",
  "groups": { "wiki": { ... } },
  "source": {
    "dir": "/abs/path/to/source"
  },
  "updatedAt": "2026-05-28T05:17:22.360Z"
}
```

- `dir`：外部知识库目录绝对路径（`scan-kb import` 自动记录，Wiki 写回据此定位源文件）
- `chunkSize` / `chunkOverlap`：切分参数持久化（缺失时回退默认值）
- ~~`rootName` / `commit`~~：已彻底移除（rootName 概念废弃、incremental 废弃后不再保留，无向后兼容读取）

### `relations-cache.json` 的 `memoryIds` / `sourcePath`

关联字段写入 `hot_relations` 每条 relation（方案 D：`scan-kb import` 为**文件级 relation**，挂该文件全部 chunk 的 memoryIds 多值）：

```json
{
  "id": "rel_003",
  "text": "Scope 隔离机制",
  "score": 0,
  "useCount": 0,
  "lastUsedTime": null,
  "isImported": true,
  "memoryIds": ["dbc6f2a0-d62b-47cb-835a-371942fdc08a", "9f3ab1c4-e2d5-48a0-b7c6-0a1b2c3d4e5f"],
  "sourcePath": "核心概念/Scope 隔离机制.md"
}
```

- `memoryIds`：向量数据库中该文件全部 chunk 的 ID 列表（方案 D 多值）；`ki search` 命中任一 memoryId → 反查到同一文件级 relation → 返回文件原文（`--original`/`include_original` 开启时）。旧数据兼容单值 `memoryId` 字段
- `sourcePath`：相对 `source.dir` 的 posix 路径，用于幂等判定（同 sourcePath 重导覆盖、不同 sourcePath 同名跳过）

### `index.json` 的 key 因写入来源不同而异

| 写入脚本 | key 来源 | 示例 |
|---------|---------|------|
| `scan-kb import` | 文件名去 `.md` 扩展名 | `"多项目隔离"` |
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
    EXT[外部 Markdown 知识库] --> IMP[scan-kb import --source<br/>原文直导 + 自动切分]
    IMP --> VEC[zvec 引擎向量化<br/>content = chunk 原文]
    IMP --> GI2[group-index.json<br/>Group 树 + source 块]
    IMP --> RC2[relations-cache.json<br/>含 memoryIds / sourcePath]
    IMP --> KB2[本地 KB 原文]
```

### 增量更新链路（幂等追加）

```mermaid
flowchart LR
    EXT2[外部知识库 文件变更/新增] --> IMP2[scan-kb import --group &lt;name&gt;<br/>幂等追加]
    IMP2 --> ADD[新文件: 切分 + 向量化 + 写索引]
    IMP2 --> MOD[同 sourcePath: 覆盖更新]
    IMP2 --> SKIP[同名不同 sourcePath: 跳过]
```

> 历史：`--mode incremental`（git diff 驱动）与 `diff` 子命令已废弃移除。增量更新由「幂等追加」语义承载，重复执行同命令即同步变更，不再依赖 git。

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
