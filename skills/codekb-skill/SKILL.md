---
name: codekb-skill
description: 代码知识库检索与写入行为规则。当用户问题涉及代码知识、模块架构、API 接口、bug 排查、代码审查等场景时使用。覆盖四步走查询流程、定位级/理解级判定、ki_search 语义兜底、写入 KB 白名单黑名单、批量导入规范。
---

# codekb-skill 代码知识库检索行为规则

> **前置条件**：AI 已了解 MCP 工具定义和架构心智模型（ki-foundation）。
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
          └─ 理解级 → 拉全景 → 四步走

四步走（理解级）:
  ① 定位 Group → ② 查热区 → ③ 取原文 → ④ 语义兜底(ki_search)

写入 KB:
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

理解级查询时自动执行：`ki_query_group(scope: "${scope}", mode: "full")`

- 首次查询后缓存有效，写入后需刷新
- scope 不存在或树为空时静默失败，记录"无已建索引"

---

## 4. 查询项目知识：四步走

### ① 定位目标 Group

从缓存全景中判断用户问题涉及哪个 Group。

- 无明确匹配 → 重新拉取全景确认
- 多个候选 → 优先得分最高的
- 全景中已明确 Relation 名称 → 跳过②直接③

### ② 查热门 + 新兴热区

`ki_query_group(scope: "${scope}", groups: "目标Group路径", mode: "hot,emerging")`

- 从热门中选择最匹配的 relation
- 命中 → ③；未命中 → 换 Group 重试一次，仍无则 → ④

### ③ 取原文

`ki_get_module_info(scope, group, relation)` → **Agent 必须提炼后回答，不要全文转储。**

### ④ 语义兜底与回问用户

**ki_search 语义兜底**（仅索引找不到时）：

```
ki_search(scope: "${scope}", query: "核心词", limit: 3, tags: "ki-search", threshold: 0.15)
```

- 返回 `results[]`，每项含 `memoryId`、`content`、`score`
- 标签按意图指定：`ki-search`（通用）、`ki-path`（路径）、`ki-relation`（关系）

**命中后回写本地**：
1. 取 `content` 作为 `module_info`
2. 依据命中结果的 `group`/`relation`/`sourcePath` 定位
3. 推断 Group（无法定位则写入 `"临时/语义兜底"` 或跳过）
4. `ki_sync_relation` 回写
5. 基于 content 提炼回答

**仍未命中** → 回问用户：

> 知识库中没有找到相关信息。请提供模块名称/文件路径/功能描述。

---

## 5. 写入 KB

### 白名单（8类）

模块职责、API接口、架构约束、项目通用约定、bug模式与排查、重构策略、依赖版本约束、测试策略

### 黑名单（6类）

用户喜好、项目记忆/进度、用户个人信息、一次性诊断、临时偏好、会话短期上下文

### 写入方式

| 条数 | 方式 |
|------|------|
| 1~2 | `ki_sync_relation(scope, group, relation, module_info)` |
| ≥3 | `ki_sync_relation --input` 批量写（CLI） |

写入后必须刷新全景缓存。

### 批量格式（sync-relation --input）

```json
{
  "items": [
    { "group": "Group路径", "relation": "名称", "module_info": "Markdown内容" }
  ]
}
```

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

**写前自检**：scope 解析了吗？是项目代码知识吗？走对通道了吗？

---

## 7. 数据存储位置

```
<ki安装路径>/kb/${scope}/
├── group-index.json / relations-cache.json
└── {Group}/index.json
```

`ki_search` 向量数据：`~/.local/share/memory-mcp/lancedb/`
