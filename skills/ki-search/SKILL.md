---
name: ki-search
description: 代码知识库检索行为规则。当用户问题涉及代码知识、模块架构、API 接口、bug 排查、代码审查等场景时使用。覆盖四步走查询流程（优先 ki_search ${scope}-memory）、定位级/理解级判定、索引原位兜底、宏观兜底。${scope} 默认只读：仅当发现知识库与实际代码不符且获得用户明确授权后，才可修改。
---

# ki-search 代码知识库检索行为规则

> **前置条件**：AI 已了解 MCP 工具定义和架构心智模型。
> 本文件专注**行为决策逻辑**，不重复命令语法。

---

## 0. 速览

```
对话涉及代码?
  ├─ 否 → 不介入
  └─ 是 → scope 已知?
      ├─ 否 → 问用户
      └─ 是 → 查询类型?
          ├─ 定位级 → SearchSymbol/grep/Read，不走 KB
          └─ 理解级 → 四步走

四步走（理解级）:
  ① ki_search(scope: "${scope}-memory", limit: 4, threshold: 0.02)  → 优先语义检索
  ② 未命中 → ki_get_module_info 索引取原位信息
  ③ 仍未命中 → ki_search(scope: "${scope}", limit: 4, threshold: 0.02)  → 宏观兜底
  ④ 都未命中 → 回问用户

写入 KB（仅用户明确授权后）:
  1~2 条 → ki_sync_relation 逐条写
  ≥3 条  → ki_sync_relation --input 批量写（CLI）
```

---

## 1. Scope 约定

- `${scope}` 未指定时必须暂停问用户
- 不确定有哪些 scope？`ki_manage_index_list()` 查看
- **`${scope}` 仍是字面量时，禁止执行任何 ki MCP 工具调用**

---

## 2. 代码相关性判定

**触发**：文件路径、函数/类名、bug排查、重构、架构、代码审查、测试、性能优化

**不触发**：闲聊、产品方向讨论、会议纪要、纯文档写作

**查询类型**：

| 类型 | 特征 | 路径 |
|------|------|------|
| 定位级 | 目标明确，找位置 | SearchSymbol/grep/Read，**不走 KB** |
| 理解级 | 需要架构/流程/设计意图 | **走 KB 四步走** |

> 判断口诀：能用一个 `grep` 回答 → 定位级；需要读完文件才能回答 → 理解级

---

## 3. 对话开始：拉取全景

理解级查询时自动执行：`ki_query_group(scope: "${scope}-memory", mode: "full")`

- 首次查询后缓存有效，写入后需刷新
- scope 不存在或树为空时静默失败，记录"无已建索引"
- 全景用于步骤②的 Group/Relation 定位；**查询始终以 ki_search 语义检索优先**，不要按索引遍历

---

## 4. 查询项目知识：四步走

### ① 语义检索（优先）：ki_search ${scope}-memory

> **ki-search 已支持 `${scope}-memory`，优先使用语义检索，不直接按索引查找。**

```
ki_search(scope: "${scope}-memory", query: "核心词", limit: 4, threshold: 0.02, tags: "ki-search")
```

- 返回 `results[]`，每项含 `memoryId`、`content`、`score`
- 标签按意图指定：`ki-search`（通用）、`ki-path`（路径）、`ki-relation`（关系）
- **limit 固定 4**：取最相关的 4 条
- **threshold 固定 0.02**：过滤低相似度内容，确保返回的是相似度较高的结果
- 命中 → 基于 `content` 提炼回答；未命中 → ②

### ② 索引原位兜底：ki_get_module_info

语义检索未命中时，才回到索引定位取原文：

1. 从缓存全景（`${scope}-memory`）判断问题涉及哪个 Group
2. `ki_query_group(scope: "${scope}-memory", groups: "目标Group路径", mode: "hot,emerging")` → 查热区
3. `ki_get_module_info(scope, group, relation)` → **Agent 必须提炼后回答，不要全文转储。**

- 命中 → 回答；未命中 → 换 Group 重试一次，仍无 → ③

### ③ 宏观兜底：ki_search ${scope}

> **为什么不优先 `${scope}`？** 因为 `${scope}` 的文档比较宏观、内容更多，匹配精度不如 `${scope}-memory` 准确，因此只作为最后兜底。

```
ki_search(scope: "${scope}", query: "核心词", limit: 4, threshold: 0.02, tags: "ki-search")
```

- 命中 → 基于 `content` 提炼回答；未命中 → ④

### ④ 回问用户

> 知识库中没有找到相关信息。请提供模块名称/文件路径/功能描述。

> **不回写**：本地 KB 与向量数据是一致的，语义检索命中的内容即为 KB 中原位内容，无需 `ki_sync_relation` 回写。

---

## 5. 写入 KB（默认只读，需用户明确授权）

> **`${scope}` 默认只读**：正常检索不写入。当发现知识库与实际代码不符（如架构变更、接口过期、文档过时）需要修正时，必须先向用户说明差异并**获得明确授权**，才可执行下述写入。

### 白名单（8类）

模块职责、API接口、架构约束、项目通用约定、bug模式与排查、重构策略、依赖版本约束、测试策略

### 黑名单（6类）

用户喜好、项目记忆/进度、用户个人信息、一次性诊断、临时偏好、会话短期上下文

### 写入方式

| 条数 | 方式 |
|------|------|
| 1~2 | `ki_sync_relation(scope, group, relation, module_info)` |
| ≥3 | `ki_bulk_sync_relation(scope, items)` 批量写（MCP，一次 embed + 一次向量写入） |

写入后必须刷新全景缓存。

### 批量格式（ki_bulk_sync_relation）

```json
{
  "scope": "项目名",
  "items": [
    { "group": "Group路径", "relation": "名称", "module_info": "Markdown内容", "tags": "api,auth" }
  ]
}
```

- `tags` 可选，逗号分隔多个，叠加在默认 `ki-search` 之上
- `vector` 可选，默认 `true`；`false` 时仅写 KB 层（不产生 memoryId，不可被 `ki_search` 召回）
- `items` 单次最多 **50 条**（超出需分批调用）；同批出现重复 `(group, relation)` 时，后一条覆盖前一条，前一条不再独立写向量
- 返回值：`results[].vectorStored` 为该条向量是否写入（主内容 `ki-search` 成功即可召回）；顶层 `vectorStored` 仅在**所有条目全部写入成功**时为 `true`；`hints`（可选）含 Group 路径解析提示

### 批量写入策略（重要）

> `ki_bulk_sync_relation` 虽然支持一次传大量 `items`，但**组织大量文档数据本身耗时、占上下文、易出错**。推荐**分批调用**，每批 ≤5 条：
> - 3~5 条：一次调用
> - 6~10 条：分 2 批（每批 ≤5 条）
> - >10 条：每批 5 条，分批调用
>
> 每次调用是独立的批量写入（各自一次 embed + 一次向量写入），服务端总耗时几乎不变，但**组织成本更低、单批失败只重试该批**。

### Group 管理

- 创建：`ki_manage_index_create(scope, parent, name)`
- 删除：MCP 不支持，需 CLI `ki manage-index --action delete`

---

## 6. 禁忌清单

| # | 红线 |
|---|------|
| 🔴 1 | `${scope}` 仍是字面量时执行任何 ki MCP 调用 |
| 🔴 2 | `ki_search` 未指定正确的 `tags` |
| 🔴 3 | 超长 module-info 不拆分直接写入（收到警告仍应拆分） |
| 🔴 4 | 跨 scope 串数据 |
| 🔴 5 | 把用户喜好/项目记忆/临时上下文写入 KB |
| 🔴 6 | 用 `memory_store` 逐条塞入应走批量导入的内容 |
| 🔴 7 | shell/模板中让 `${scope}` 被展开 |
| 🔴 8 | 理解级查询跳过 ① 直接按索引遍历（必须优先 `ki_search(${scope}-memory)`） |
| 🔴 9 | `ki_search` 未按 `limit: 4, threshold: 0.02` 执行 |
| 🔴 10 | 优先查询 `${scope}` 而非 `${scope}-memory`（`${scope}` 仅作宏观兜底） |
| 🔴 11 | **未经用户明确授权修改 `${scope}` 知识库**（默认只读，仅知识库与实际代码不符且获授权后才可改） |

**写前自检**：scope 解析了吗？是项目代码知识吗？走对通道了吗？获用户授权了吗？

---

## 7. 数据存储位置

```
<ki安装路径>/kb/${scope}/
├── group-index.json / relations-cache.json
└── {Group}/index.json
```

`ki_search` 向量数据：`~/.local/share/memory-mcp/lancedb/`
