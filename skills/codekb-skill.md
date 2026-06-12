# codekb-skill 代码知识库检索行为规则

> **前置条件**：AI 已阅读 `ki-foundation.md`，了解 ki 命令语法和架构心智模型。
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
              → ki query-group --mode full 拉全景 → 缓存

查询项目知识（四步走，理解级专用）:
  ① 定位 Group  → 从缓存全景中锁定目标 Group
  ② 查热区      → ki query-group --groups <G> --mode hot,emerging
                  （若①已明确 Relation → 可跳过，直接③）
  ③ 取原文      → 命中 → ki get-module-info → 提炼回答
  ④ 语义兜底    → ②/③ 未命中 → memory_recall → 仍无 → 问用户

产生了项目代码知识 → 【只写 KB】
  1~2 条 → ki sync-relation 逐条写
  ≥3 条  → 组织 ai-results.json → ki scan-kb import --mode incremental
  ❌ 用户喜好/项目记忆/临时信息 → 不写 KB
```

---

## 1. Scope 约定

- scope 初始值为字面量 `${scope}`（反引号包裹，防 shell 展开）
- `${scope}` = **未指定**，必须暂停问用户
- 已指定（如 `monitor`）= 正常使用

**当 `${scope}` 仍是字面量时，禁止执行任何 ki 命令或 memory_* 操作。必须先问用户。**

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

**第一个动作**：`ki query-group --scope ${scope} --mode full`

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
    B -- 否 --> C[重新确认/扩大范围<br/>ki query-group --mode full]
    C --> B
    B -- 是 --> P{全景中已明确<br/>Relation名称?}
    P -- 是 --> F[取原文<br/>ki get-module-info]
    P -- 否 --> D[查该Group热区<br/>ki query-group --groups G<br/>--mode hot,emerging]
    D --> E{命中relation?}
    E -- 是 --> F
    F --> G[提炼回答]
    G --> H
    E -- 否 --> I[语义兜底<br/>mcp memory_recall]
    I --> J{命中记忆?}
    J -- 是 --> K[提取摘要去掉路径段<br/>→ sync-relation 回写本地]
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

对目标 Group 执行 `ki query-group --scope ${scope} --groups "目标Group路径" --mode hot,emerging`

**为什么要查看新兴热区**：新兴热区是近期 48 小时内频繁使用的知识，往往是最贴近当前工作上下文的内容。

**操作**：
- 从热门知识中选择最匹配的 relation
- 记下关键词词云（第④步备用）
- **命中** → 进入第③步
- **未命中** → 先检查 Group 是否定位正确（可换 Group 重试一次），确认无误后进入第④步

### 第③步：取原文

执行 `ki get-module-info`，返回完整 Markdown 原文。**Agent 必须提炼后回答，不要全文转储。**

### 第④步：语义兜底与回问用户

#### 4.1 MCP memory_recall 语义搜索

**仅当索引中找不到目标 Relation 时**才执行此步：

| 参数 | 值 | 说明 |
|------|-----|------|
| query | `"<用户问题核心词> <关键词词云摘取>"` | **必须用 `query` 参数，禁止用 `text`** |
| limit | `3` | |
| scope | `"${scope}"` | 直接指定 scope 过滤，**禁止用 `tags`**（实测不生效） |

**关键字段**：
- `details.memories[].id` = **memoryId**（后续 del 必需）
- `details.memories[].text` = 三段式文本 `[摘要]\n[关键词]\n[路径]`
- `details.memories[].score` = 相关性分数

⚠️ 常见错误：用了 `text` 参数 → 报 `Cannot read properties of undefined`，改为 `query` 即可。

#### 4.1.1 命中后：回写本地索引

`memory_recall` 命中后，`details.memories[].text` 是三段式文本。Agent 必须：

1. **提取摘要**：取 `[摘要]` 部分作为 `--module-info`（**去掉 `[路径]` 段**，路径是 KB 内部索引信息）
2. **提取关键词**：取 `[关键词]` 部分作为 `--keywords`
3. **解析路径用于定位**：从 `[路径]` 段提取 Group 路径和 Relation 名称（如 `BK-Monitor-Wiki/告警系统设计/告警引擎核心` → group=`BK-Monitor-Wiki/告警系统设计`，relation=`告警引擎核心`）。若路径为空或无法解析，跳过回写，直接基于摘要回答
4. **回写本地**：执行 `ki sync-relation` 将摘要沉淀到本地索引
5. **提炼回答**：基于摘要内容回答用户问题

> `--module-info` 使用 `memory_recall` 返回的**摘要文本**，不额外调用 `get-module-info` 取原文。

#### 4.2 回问用户

索引 + `memory_recall` 都未命中 → 暂停：

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
| 1~2 条 | `ki sync-relation` 逐条写 |
| ≥3 条 | 组织 `ai-results.json` → `ki scan-kb import --mode incremental` |

**注意**：`sync-relation` 只写 relations-cache + local KB，**不写 memory**。AI 是否写 memory 自行决定。

### 创建/删除 Group

当需要新增或移除代码知识分类时：

- **创建 Group**：`ki manage-index --action create --parent "父Group路径" --name "新Group名"`
- **删除 Group**：`ki manage-index --action delete --parent "父Group路径" --name "目标Group名" --force`

⚠️ `--force` 会删除 Group 以及**所有子 Relation**，操作前确认。

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

执行：`ki scan-kb import --scope ${scope} --mode incremental --results /path/to/ai-results.json`

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
| 🔴 1 | `${scope}` 仍是字面量时，执行任何 ki 命令或 memory_* 操作 |
| 🔴 2 | `memory_recall` 使用 `text` 参数（必须用 `query`） |
| 🔴 3 | 把代码符号（类名/方法名/路径）作为 `keywords` |
| 🔴 4 | `keywords` 中出现未在 `module-info` 原文中出现的词 |
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

`memory_recall` 查询的向量数据存储在 `~/.local/share/memory-mcp/lancedb/`。

---

> 本规则覆盖 REQ-01~05、REQ-07、REQ-08。与 `memory-skill` 互补，各管各的 scope，互不重叠。
