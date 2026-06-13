---
name: ki-foundation
description: ki 命令架构心智模型与命令参考。codekb-skill 和 memory-skill 的前置依赖。当 AI 需要使用 knowledge-indexer 时必须先加载本 skill。覆盖 ki 三层架构、内部数据结构、运行时链路、query-group/get-module-info/sync-relation/manage-index 命令语法、keywords 规则、常见错误与修复。
---

# ki 基础知识与命令参考

> 本文件是 `codekb-skill` 和 `memory-skill` 的**前置知识**。
> AI 需先理解 ki 的架构心智模型和命令语法，再阅读各 skill 的行为逻辑。

---

## 1. ki 是什么

`ki`（knowledge-index）是记忆系统之上的一层**本地知识目录与交付层**，补齐 AI Agent 在项目知识访问过程中的两个关键能力：

- **结构化导航**：把知识整理成 Group 树，便于 Agent 先缩小范围
- **原文交付**：把模块说明保存在本地 KB 中，便于 Agent 直接读取 Markdown 原文

它不替代 `memory-lancedb-mcp` / `memory-lancedb-pro`，而是与它们协作：

```mermaid
flowchart TB
    U[用户 / MCP Client / AI Agent]
    KI[knowledge-index<br/>Group 树 + Relations 缓存 + 本地 KB]
    MCP[memory-lancedb-mcp<br/>MCP 工具层]
    CORE[memory-lancedb-pro<br/>长期记忆与混合检索引擎]
    DATA[(LanceDB / 持久化记忆)]

    U --> KI
    U --> MCP
    KI --> MCP
    MCP --> CORE
    CORE --> DATA
```

### 分层职责

| 组件 | 主要职责 |
|------|----------|
| `knowledge-index` | Group 导航、热门 Relation 缓存、本地 Markdown 原文交付 |
| `memory-lancedb-mcp` | 对外暴露 `memory_store`、`memory_recall` 等 MCP 能力 |
| `memory-lancedb-pro` | 负责混合检索、向量存储、长期记忆治理 |

### 协作模式

- **本地快取 + 远端召回**：热门知识优先走本地 JSON；长尾知识走 `memory_recall`；命中后回写本地
- **原文与摘要分层存储**：本地 KB 保存完整 Markdown 原文；记忆系统保存摘要、标签、关键词
- **闭环**：查询时本地优先、记忆检索兜底；写入时双写到本地索引与记忆系统；演化时热点沉淀在本地，长尾保留在记忆系统

---

## 2. 内部数据结构

```mermaid
flowchart LR
    GI["group-index.json<br/>Group 树索引 + source 块"]
    RC["relations-cache.json<br/>Relation 缓存 / 关键词 / 分区<br/>（含 memoryId / sourcePath）"]
    KB["kb/{scope}/{group}/index.json<br/>本地 KB 原文"]

    GI --> RC
    RC --> KB
```

| 文件 | 角色 | 读写方 | 生命周期 |
|------|------|--------|---------|
| `group-index.json` | Group 树结构索引 + `source` 块 | 所有脚本读写 | 永久 |
| `relations-cache.json` | Relation 缓存（评分/淘汰/词云），含 `memoryId`/`sourcePath` | 所有脚本读写 | 永久，随使用动态更新 |
| `kb/{scope}/{group}/index.json` | 本地 KB 原文 | get-module-info 读，sync-relation/import 写 | 永久 |

---

## 3. 运行时主链路

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

---

## 4. 命令参考

### 4.1 查看可用 Scope

> **⚠️ scope 是所有 ki 操作的基础**。不同 scope 物理隔离，没有 scope 就无法进行任何查询或写入。
> **如果你不确定当前项目有哪些 scope 可用，必须立即执行此命令查看，禁止猜测或假设 scope 名称。**

```bash
ki manage-index --action list-scopes
```

- **不需要** `--scope` 参数
- 列出 `kb/` 下所有已初始化的 scope 及其根节点名称
- Agent 开始任何操作前，如果不确定有哪些 scope 可用，**应先执行此命令**

输出示例：
```json
{
  "ok": true,
  "scopes": [
    { "scope": "monitor", "rootNames": ["项目根", "BK-Monitor-Wiki"] },
    { "scope": "monitor-memory", "rootNames": ["项目根"] },
    { "scope": "user-profile", "rootNames": ["项目根"] }
  ],
  "total": 3
}
```

### 4.2 拉取全景索引

```bash
ki query-group --scope <scope> --mode full
```

- 获取 scope 下所有 Group 的索引树和热度信息
- 可选参数：`--hot-count <count>`（默认 5）、`--depth <depth>`（默认 4，full 模式生效）

### 4.3 查 Group 热区

```bash
ki query-group --scope <scope> --groups "目标Group路径" --mode hot,emerging
```

- 查看指定 Group 下的热门知识和新兴热区（近 48 小时内频繁使用的知识）

### 4.4 取原文

```bash
ki get-module-info --scope <scope> --group "目标Group路径" --relation "Relation名称"
```

- 获取指定 Relation 的完整 Markdown 原文
- **Agent 必须提炼后回答，不要全文转储**

### 4.5 单条写入

```bash
ki sync-relation \
  --scope <scope> \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容" \
  --keywords "关键词1,关键词2,关键词3"
```

- Relation 名称相同时自动覆盖原有内容
- **批量模式**：`ki sync-relation --scope <scope> --input /path/to/batch.json`

```json
[
  {
    "group": "目标Group路径",
    "relation": "Relation名称",
    "module-info": "Markdown内容",
    "keywords": "关键词1,关键词2"
  }
]
```

### 4.6 管理 Group

```bash
# 创建根节点（新 scope 首次使用时必须先创建）
ki manage-index --scope <scope> --action create-root --root-name "根节点名称"

# 创建子 Group
ki manage-index --scope <scope> --action create --parent "父Group路径" --name "新Group名"

# 删除 Group（含子数据）
ki manage-index --scope <scope> --action delete --parent "父Group路径" --name "目标Group名" --force
```

- `create-root`：新 scope 首次初始化时使用（需 `--root-name`）
- `create`：在已有 Group 下创建子节点（需 `--parent` + `--name`）
- `--force` 会删除 Group 以及所有子 Relation

---

## 5. Keywords 规则

所有 `ki sync-relation` 写入时必须遵守：

- 必须是**自然语言词汇**，禁止代码符号（类名、方法名、路径）
- 必须真实出现在 `module-info` 原文中
- 3~5 个为宜

---

## 6. 常见错误与修复

| 错误 | 原因 | 修复 |
|------|------|------|
| `scope not found` | scope 尚未创建 | 先用 `ki manage-index --action list-scopes` 确认已有 scope，再 `ki manage-index --action create-root --root-name "名称"` 创建根节点，或执行 `ki sync-relation` 写入任意一条数据自动创建 |
| Group 不存在 | 尚未创建该 Group | 执行 `ki manage-index --action create` 创建（若 scope 也无根节点，先 `create-root`） |
| `keywords` 被拒绝 | 包含代码符号或未出现在原文中 | 改用自然语言词，确认词在 module-info 中真实存在 |
| `${scope}` 仍是字面量 | 用户未指定 scope | 暂停，先问用户确认 scope |
| Relation 名称与预期不符 | 使用了错误的名称 | 用 `ki query-group --mode full` 确认实际名称 |
| 写入到错误的 scope | 混淆了 scope | 确认写入目标 scope 是否正确 |

---

## 7. 写入后刷新缓存

每次写入操作（`sync-relation` / `scan-kb import` / `manage-index create`）完成后，必须重新拉取全景：

```bash
ki query-group --scope <scope> --mode full
```

---

## 8. Scope 替换表

| 规则 | scope 值 |
|------|----------|
| codekb-skill | `${scope}` |
| memory-skill（项目记忆） | `${scope}-memory` |
| memory-skill（用户画像） | `user-profile` |

> 本文件仅定义架构心智模型和命令语法。各命令的使用时机、判断流程、禁忌清单等行为逻辑由各 skill 文件定义。
