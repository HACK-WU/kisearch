---
name: codekb-skill
description: 代码知识库检索与写入行为规则。当用户问题涉及代码知识、模块架构、API 接口、bug 排查、代码审查等场景时使用。覆盖四步走查询流程、定位级/理解级判定、ki_search 语义兜底、写入 KB 白名单黑名单、批量导入规范。
---

# codekb-skill 代码知识库检索行为规则

> **前置条件**：AI 已了解 MCP 工具定义（ki_query_group、ki_get_module_info、ki_sync_relation、ki_manage_index_create 等）和架构心智模型。
> 本文件专注**行为决策逻辑**，不再重复命令语法。

---

## 0. 速览：什么时候做什么

```
对话涉及代码?
  ├─ 否 → 本规则不介入
  └─ 是 → scope 已指定?
      ├─ 否 → 问用户
      └─ 是 → 查询类型?
          ├─ 定位级（找文件/函数/类/报错行）
          │   → 直接用 SearchSymbol / grep / Read，不走 KB
          └─ 理解级（架构/流程/设计意图/排查思路/模块关系）
              → ki_query_group(scope: "${scope}", mode: "full") 拉全景 → 缓存

查询项目知识（四步走，理解级专用）:
  ① 定位 Group  → 从缓存全景中锁定目标 Group
  ② 查热区      → ki_query_group(scope: "${scope}", groups: "<G>", mode: "hot,emerging")
                  （若①已明确 Relation → 可跳过，直接③）
  ③ 取原文      → 命中 → ki_get_module_info(scope: "${scope}", group: "G", relation: "R") → 提炼回答
  ④ 语义兜底    → ②/③ 未命中 → ki_search(tags: "ki-search", threshold: 0.15) → 仍无 → 问用户

产生了项目代码知识 → 【只写 KB】
  1~2 条 → ki_sync_relation(scope, group, relation, module_info, keywords) 逐条写
  ≥3 条  → 组织 ai-results.json → ki scan-kb import（CLI 专用命令，MCP 不暴露）
  ❌ 用户喜好/项目记忆/临时信息 → 不写 KB
```

---

## 1. Scope 约定

- scope 初始值为字面量 `${scope}`（反引号包裹，防 shell 展开）
- `${scope}` = **未指定**，必须暂停问用户
- 已指定（如 `monitor`）= 正常使用
- 不确定有哪些 scope？执行 `ki_manage_index_list()` 查看

**当 `${scope}` 仍是字面量时，禁止执行任何 ki MCP 工具调用或 memory_* 操作。必须先问用户。**

询问模板：
> 我需要操作知识库，请指定本次使用的 scope。

---

## 2. 代码相关性判定

### 正例（触发）

- 提到具体文件路径、函数名/类名/变量名
- 询问 bug 排查/报错信息
- 涉及重构/迁移/依赖/版本/部署/CI
- 涉及架构/设计模式/代码审查/测试
- 涉及性能优化/数据库 schema

### 反例（不触发）

- 纯闲聊/问候
- 产品方向讨论（无代码指向）
- 会议纪要/团队沟通
- 纯文档写作（不涉及代码引用）

### 边界模糊

不确定时：

> 这个问题可能涉及项目代码，我需要先加载知识库索引吗？

### 查询类型判定（定位级 vs 理解级）

| 类型 | 特征 | 推荐路径 | 示例 |
|------|------|----------|------|
| **定位级** | 目标明确，只需找到位置 | SearchSymbol / grep / Read，**不走 KB** | "`AlertViewSet` 在哪""这个报错在第几行" |
| **理解级** | 需要架构/流程/设计意图等上下文 | **走 KB 四步走流程** | "告警收敛是怎么实现的""A 和 B 的依赖关系" |

**判断口诀**：能用一个 `grep` 回答的 → 定位级；需要读完一个文件才能回答的 → 理解级。

> 混合型问题（如"告警引擎核心在哪 + 它怎么工作的"）：定位部分用 SearchSymbol，理解部分走 KB。两者可并行。

---

## 3. 对话开始：拉取全景

**触发条件**：对话涉及代码且为"理解级"查询。定位级查询不走 KB，无需拉取。

**缓存策略**：首次查询后，索引信息在当前会话中有效，后续无需重复拉取。仅在执行写入操作后需要刷新。

**第一个动作**：`ki_query_group(scope: "${scope}", mode: "full")`

**拿到后**：记住主要 Group 名称，后续查询/写入时直接用。

**静默失败**：scope 不存在或树为空时不报错，记录"无已建索引"后继续。

---

## 4. 查询项目知识：四步走

```mermaid
flowchart TD
    A([用户提问]) --> Z{查询类型?}
    Z -- 定位级 --> Z1[SearchSymbol / grep<br/>直接定位]
    Z1 --> H([结束])
    Z -- 理解级 --> B{能否从已缓存的<br/>全景索引定位Group?}
    B -- 否 --> C[重新确认/扩大范围<br/>ki_query_group full]
    C --> B
    B -- 是 --> P{全景中已明确<br/>Relation名称?}
    P -- 是 --> F[取原文<br/>ki_get_module_info]
    P -- 否 --> D[查该Group热区<br/>ki_query_group hot,emerging]
    D --> E{命中relation?}
    E -- 是 --> F
    F --> G[提炼回答]
    G --> H
    E -- 否 --> I[语义兜底<br/>ki_search<br/>tags: ki-search]
    I --> J{命中?}
    J -- 是 --> K[提取内容<br/>→ ki_sync_relation 回写本地]
    K --> G
    J -- 否 --> L[回问用户<br/>补充线索]
    L --> H
```

### 第①步：定位目标 Group

基于已缓存的全景索引，判断用户问题涉及哪个 Group。

- **若缓存中无明确匹配**：重新拉取全景确认或扩大范围，并更新缓存
- **若定位到多个候选 Group**：优先选择得分最高的；不确定时可依次排查
- **快捷路径（跳过②）**：全景索引中已能看到与用户问题直接匹配的 Relation 名称，可跳过②直接③

### 第②步：查热门 + 新兴热区

对目标 Group 执行 `ki_query_group(scope: "${scope}", groups: "目标Group路径", mode: "hot,emerging")`

**为什么要查看新兴热区**：新兴热区是近期 48 小时内频繁使用的知识，往往是最贴近当前工作上下文的内容。

**操作**：
- 从热门知识中选择最匹配的 relation
- 记下关键词词云（第④步备用）
- **命中** → 进入第③步
- **未命中** → 先检查 Group 是否定位正确（可换 Group 重试一次），确认无误后进入第④步

### 第③步：取原文

执行 `ki_get_module_info(scope, group, relation)`，返回完整 Markdown 原文。**Agent 必须提炼后回答，不要全文转储。**

### 第④步：语义兜底与回问用户

#### 4.1 ki_search 语义兜底

**仅当索引中找不到目标 Relation 时**才执行此步。使用 ki MCP 向量搜索代替直接调 memory MCP：

| 参数 | 值 | 说明 |
|------|-----|------|
| query | `"<用户问题核心词> <关键词词云摘取>"` | 自然语言查询 |
| scope | `"${scope}"` | 项目隔离标识 |
| limit | `3` | 返回条数 |
| tags | `"ki-search"` | **强烈建议显式指定**，缩小检索域避免跨类型串扰 |
| threshold | `0.15` | 相似度阈值（0-1），不传则不过滤 |

**关键字段**：
- `results[].memoryId` = 向量记忆 ID
- `results[].content` = 记忆文本内容
- `results[].score` = 相似度分数

**⚠️ 标签选择**：根据查询意图指定 `tags` 可显著提升准确率。代码知识相关查询使用 `ki-search`。详见 [DESIGN.md 标签过滤策略](../../.requirements/2026-06-14-ki-vector-integration/design/DESIGN.md#标签过滤策略)。

#### 4.1.1 命中后：回写本地索引

`ki_search` 命中后，`results[].content` 返回记忆文本。Agent 必须：

1. **提取内容**：取 `content` 文本作为 `module_info`（去掉 `【标签:xxx】` 等前缀标记）
2. **提取关键词**：从 `content` 中提取核心概念词作为 `keywords`（3~5 个自然语言词，必须真实出现在 `module_info` 中）
3. **定位 Group**：根据 `content` 中可能出现的路径信息（如 `Group: BK-Monitor-Wiki/告警系统设计`）推断归属 Group。若无法定位，回写到 `"临时/语义兜底"` Group 或跳过回写
4. **回写本地**：执行 `ki_sync_relation(scope, group, relation, module_info, keywords)` 将摘要沉淀到本地索引
5. **提炼回答**：基于 `content` 内容回答用户问题

> `module_info` 使用 `ki_search` 返回的**内容文本**，不额外调用 `ki_get_module_info` 取原文。

#### 4.2 回问用户

索引 + `ki_search` 都未命中 → 暂停：

> 我在知识库中没有找到相关信息。请提供模块名称/文件路径/功能描述，我会扫描代码并沉淀到知识库。

---

## 5. 写入项目代码知识到 KB

### 核心原则

**本规则只管写 KB。不管写 memory。AI 是否写 memory 自行决定。**

**写入后刷新**：每次写入完成后，必须重新拉取全景更新缓存。

### 允许写入的白名单（8 类项目代码知识）

✅ 模块/组件的职责与行为、API 接口与调用约定、架构决策与设计约束、项目内通用约定、已知 bug 模式与排查路径、重构策略与迁移路径、依赖关系与版本约束、测试策略

### 禁止写入的黑名单（6 类）

❌ 用户喜好、项目记忆/会话进度、用户个人信息、一次性诊断结论、临时偏好、会话内短期上下文

### 写入方式：单条 vs 批量

| 条数 | 命令 |
|------|------|
| 1~2 条 | `ki_sync_relation(scope, group, relation, module_info, keywords)` 逐条写 |
| ≥3 条 | 组织 `ai-results.json` → `ki scan-kb import`（CLI 专用命令，MCP 不暴露） |

**注意**：`ki_sync_relation` 只写 relations-cache + local KB，**不写 memory**。AI 是否写 memory 自行决定。

### 创建/删除 Group

当需要新增或移除代码知识分类时：

- **创建 Group**：`ki_manage_index_create(scope: "${scope}", parent: "父Group路径", name: "新Group名")`
- **删除 Group**：MCP 不支持 delete 操作，需通过 CLI 执行 `ki manage-index --action delete`

### 批量写入（ai-results.json 格式）

```json
{
  "meta": {
    "sourceDir": "/path/to/source",
    "rootName": "ProjectWiki"
  },
  "entries": [
    {
      "path": "相对于sourceDir的文件路径",
      "groupPath": "完整Group路径",
      "relation": "Relation名称",
      "summary": "一句话摘要",
      "keywords": ["关键词1", "关键词2"],
      "action": "add"
    }
  ]
}
```

执行：`ki scan-kb import`（CLI 专用命令，MCP 不暴露）

**支持的操作（action 字段）**：

| action | 用途 | 必要额外字段 |
|--------|------|-------------|
| `add` | 新增 | summary, keywords |
| `modify` | 修改已有 | summary, keywords, memoryId |
| `delete` | 删除 | **memoryId** |

⚠️ `delete` 操作必须携带 `memoryId`，否则报错。

---

## 6. 禁忌清单（8 条红线）

| # | 红线 |
|---|------|
| 🔴 1 | `${scope}` 仍是字面量时，执行任何 ki MCP 工具调用或 memory_* 操作 |
| 🔴 2 | `ki_search` 未根据查询意图指定正确的 `tags`：查模块使用 `ki-search`，查路径使用 `ki-path`，查关系使用 `ki-relation` |
| 🔴 3 | 把代码符号（类名/方法名/路径）作为 `keywords` |
| 🔴 4 | `keywords` 中出现未在 `module_info` 原文中出现的词 |
| 🔴 5 | 跨 scope 串数据 |
| 🔴 6 | 把用户喜好 / 项目记忆 / 临时上下文写入 KB |
| 🔴 7 | 用 `memory_store` 逐条塞入本应走 `scan-kb import` 的批量内容 |
| 🔴 8 | 在 shell/模板中让 `${scope}` 被展开（本规则内反引号包裹） |

**写前自检三问**：scope 解析了吗？是项目代码知识吗？走对通道了吗？

---

## 7. 测试阶段反馈

遇到以下情况时请反馈：

| 类型 | 示例 |
|------|------|
| **非使用错误的异常** | 命令执行崩溃、返回格式异常、数据不一致 |
| **可优化点** | 检索结果排序不合理、热区分数计算偏差、流程步骤冗余 |
| **文档/规则问题** | 描述与实际行为不符、遗漏边界场景、术语歧义 |
| **其他错误** | 权限问题、并发冲突、性能瓶颈 |

反馈时提供：复现步骤、实际 vs 期望输出、scope/Group 上下文。

---

## 8. 数据存储位置

ki 工具的数据存储在 npm 全局安装目录内（非项目仓库目录）：

```
<ki安装路径>/kb/${scope}/
├── group-index.json       # Group 树索引
├── relations-cache.json   # Relations 缓存（含 memoryId）
├── backup/                # 自动备份
└── {Group}/               # 本地 KB 原文（按 Group 分目录）
    └── index.json
```

`ki_search` 查询的向量数据存储在 `~/.local/share/memory-mcp/lancedb/`。

---

> 本规则覆盖 REQ-01~05、REQ-07、REQ-08。与 `memory-skill` 互补，各管各的 scope，互不重叠。
