---
name: ki-foundation
description: ki 命令架构心智模型与命令参考。codekb-skill、memory-skill、snippet-memory、agents-md-init 的前置依赖。当 AI 需要使用 KiSearch 时必须先加载本 skill。覆盖 ki 三层架构、内部数据结构、运行时链路、query-group/get-module-info/sync-relation/manage-index 命令语法、keywords 规则、常见错误与修复。
---

# ki 基础知识与命令参考

> 本文件是 `codekb-skill` 和 `memory-skill` 的**前置知识**。

---

## 1. ki 是什么

`ki`（knowledge-index）是记忆系统之上的**本地知识目录与交付层**，补齐两个能力：

- **结构化导航**：Group 树缩小查询范围
- **原文交付**：本地 KB 直接读取 Markdown 原文

### 三层架构

| 层 | 组件 | 职责 |
|----|------|------|
| 目录层 | `knowledge-index` | Group 导航、Relation 缓存、本地 KB 原文交付 |
| 工具层 | `memory-lancedb-mcp` | 对外暴露 MCP 工具（`memory_store`、`memory_recall` 等） |
| 引擎层 | `memory-lancedb-pro` | 混合检索、向量存储、长期记忆治理 |

### 协作模式

- **本地快取 + 远端召回**：热门走本地 JSON；长尾走 `ki_search`，命中后回写
- **原文与摘要分层**：本地 KB 存完整 Markdown；记忆系统存摘要/标签/关键词
- **双写闭环**：写入时同时更新本地索引与记忆系统

---

## 2. 内部数据结构

| 文件 | 角色 | 生命周期 |
|------|------|---------|
| `group-index.json` | Group 树索引 + `source` 块 | 永久 |
| `relations-cache.json` | Relation 缓存（评分/淘汰/词云），含 `memoryId`/`sourcePath` | 永久，动态更新 |
| `kb/{scope}/{group}/index.json` | 本地 KB 原文 | 永久 |

> 所有 JSON 通过原子写入（tmp → rename）保证安全。

---

## 3. 运行时主链路

1. 用户问题 → `query-group` 读取 Group 树 / 热门 Relation
2. **本地命中** → `get-module-info` 读原文 → AI 回答
3. **未命中** → `ki_search` 向量检索 → 命中则 `sync-relation` 回写本地 → AI 回答
4. **仍未命中** → AI 补充线索 / 扫描代码 → 双写本地 + 记忆系统

---

## 4. MCP 工具参考

### 4.1 查看可用 Scope

```
tool: ki_manage_index_list
input: (无需参数)
```

> ⚠️ 不确定有哪些 scope 时，**必须先调用此工具**，禁止猜测 scope 名称。

### 4.2 拉取全景索引

```
tool: ki_query_group
input: { scope, mode: "hot|warm|cold|emerging|full"(默认hot), depth(默认4), hot_count(默认5) }
```

### 4.3 查 Group 热区

```
tool: ki_query_group
input: { scope, groups: "Group1,Group2(逗号分隔多组，支持模糊匹配)", mode: "hot,emerging" }
```

### 4.4 取原文

```
tool: ki_get_module_info
input: { scope, group: "Group路径(模糊匹配)", relation: "Relation名称(精确匹配)" }
```

- Agent 必须**提炼后回答**，不要全文转储

### 4.5 写入/更新知识

```
tool: ki_sync_relation
input: { scope, group: "Group路径(支持/层级)", relation: "名称", module_info: "Markdown内容", keywords: ["词1","词2"] }
```

- Relation 名称相同时自动覆盖
- `keywords` 必须是数组格式

**写入后必须刷新缓存**：

```
tool: ki_query_group
input: { scope, mode: "full" }
```

### 4.6 管理 Group

```
tool: ki_manage_index_create
input: { scope, name: "Group名称(不含/)", parent: "父Group路径(可选)" }
```

- scope 不存在时自动创建
- ⚠️ 无 delete 操作，Agent 只能创建和查询

### 4.7 语义检索

```
tool: ki_search
input: { scope, query: "查询文本", limit(默认10), tags: "ki-search|ki-path|ki-relation", threshold(0-1,可选) }
```

- 返回 `results[]`，每项含 `memoryId`、`content`、`score`
- **显式指定 `tags` 可显著提升准确率**（见下方标签表）

### 4.8 单条向量存储

```
tool: ki_store
input: { scope, text: "文本", tags: "ki-search(默认)" }
```

### 4.9 批量向量存储

```
tool: ki_bulk_store
input: { scope, input: "/path/to/batch-data.json" }
```

- JSON 数组格式：`[{ "text": "内容", "tags": "ki-search" }, ...]`
- 返回 `{ ok, total, succeeded, failed, results[] }`

---

## 5. 标签过滤策略

| 标签 | 用途 | 场景 |
|------|------|------|
| `ki-search` | 通用语义搜索（默认） | 自然语言查询 |
| `ki-path` | 路径级语义搜索 | 按文件名/目录定位模块 |
| `ki-relation` | 关系索引检索 | 按知识条目名称查 Group 归属 |

---

## 6. Keywords 规则

`ki_sync_relation` 写入时：

- 必须是**自然语言词汇**，禁止代码符号
- 必须真实出现在 `module_info` 原文中
- 3~5 个为宜

---

## 7. 常见错误与修复

| 错误 | 修复 |
|------|------|
| `scope not found` | 用 `ki_manage_index_list` 确认，或写入任意数据自动创建 |
| Group 不存在 | `ki_manage_index_create` 创建 |
| `keywords` 被拒绝 | 改用自然语言词，确认在原文中存在 |
| `${scope}` 字面量 | 暂停，问用户确认 scope |
| Relation 名称不符 | `ki_query_group(mode: "full")` 确认 |
| 写入到错误 scope | 确认目标 scope |
| 父节点路径不存在 | 系统自动补全；失败时列出可用节点 |
| 本地 KB 不存在 | sync-relation 重写 / scan-kb 重新导入 |

---

## 8. Scope 替换表

| 规则 | scope 值 |
|------|----------|
| codekb-skill | `${scope}` |
| memory-skill（项目记忆） | `${scope}-memory` |
| memory-skill（用户画像） | `user-profile` |
| snippet-memory（代码要点） | `${scope}-memory`（AI 的项目百科全书：不懂就查，有新发现就写入，维护好它持续提效） |
| agents-md-init（AGENTS.md 初始化） | 查询所有 scope + `${scope}-memory` + `user-profile` |
