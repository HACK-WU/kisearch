# codekb-agent-guide 代码知识库检索行为规则

> **面向 BK-Monitor 项目**。本规则直接告诉你每个阶段该敲什么命令、拿到什么输出、做什么判断。
> 不再需要去翻其他文档。

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
  1~2 条 → ki_sync_relation 逐条写
  ≥3 条  → ki_bulk_sync_relation 批量写（一次 embed + 一次向量写入，比多次逐条调用快 N 倍）
  ❌ 用户喜好/项目记忆/临时信息 → 不写 KB
```

---

## 1. Scope 约定

本文档硬编码 scope 初始值为字面量 `${scope}`（反引号包裹，防 shell 展开）。

- `${scope}` = **未指定**，必须暂停问用户
- 已指定（如 `monitor`）= 正常使用

**当 `${scope}` 仍是字面量时，禁止执行任何 ki 命令或 memory_* 操作。必须先问用户。**

询问模板：
> 我需要操作知识库，请指定本次使用的 scope。

---

## 2. 代码相关性判定

用于判断对话是否触发知识库检索流程。

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

通过 §2 判定“涉及代码”后，进一步区分查询类型，选择最高效的路径：

| 类型 | 特征 | 推荐路径 | 示例 |
|------|------|----------|------|
| **定位级** | 目标明确，只需找到位置 | SearchSymbol / grep / Read，**不走 KB** | “`AlertViewSet` 在哪”“这个接口的 URL 是什么”“这个报错在第几行” |
| **理解级** | 需要架构/流程/设计意图等上下文 | **走 KB 四步走流程** | “告警收敛是怎么实现的”“这个模块的架构是什么”“A 和 B 的依赖关系” |

**判断口诀**：能用一个 `grep` 回答的 → 定位级；需要读完一个文件才能回答的 → 理解级。

> 混合型问题（如“告警引擎核心在哪 + 它怎么工作的”）：定位部分用 SearchSymbol，理解部分走 KB。两者可并行。

---

## 3. 对话开始：拉取全景

**触发条件**：对话涉及代码且为“理解级”查询（见 §2 查询类型判定）。定位级查询不走 KB，无需拉取全景。

**缓存策略**：首次查询后，索引信息在当前会话中有效，后续对话无需重复拉取。仅在执行写入操作（sync-relation / scan-kb import）后需要刷新。

**第一个动作**：

```bash
ki query-group --scope ${scope} --mode full
```

**输出示例**：

```
=== 知识索引 [scope: my-project] ===

📁 完整索引树:
my-project/ (score: 25.2) [热]
├── API/ (score: 15.5) [热]
│   ├── 用户管理/ (score: 8.5) [热]
│   └── 文件操作/ (score: 4.8) [常温]
├── 前端/ (score: 6.2) [热]
└── 部署/ (score: 3.2) [常温]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

**拿到后**：记住主要 Group 名称，后续查询/写入时直接用。

**静默失败**：如果 scope 不存在或树为空，不报错，记录"无已建索引"后继续。

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

基于 §3 已缓存的全景索引，判断用户问题涉及哪个 Group。

- **若缓存中无明确匹配**，可重新执行 `ki query-group --scope ${scope} --mode full` 确认或扩大范围，并更新缓存。
- **若定位到多个候选 Group**，优先选择得分最高的；不确定时可依次排查。

**快捷路径（跳过第②步）**：如果全景索引中已经能看到与用户问题直接匹配的 Relation 名称（如用户问“告警收敛”，全景中有“告警收敛机制”），可跳过第②步，直接进入第③步 `get-module-info`。判断标准：Relation 名称与用户问题关键词高度吻合，无需通过热区排序来筛选。

### 第②步：查热门 + 新兴热区

对目标 Group 执行：

```bash
ki query-group --scope ${scope} --groups "目标Group路径" --mode hot,emerging
```

**输出示例**：

```
=== my-project/API ===

🔥 热门知识 (Top 3):
├── 用户登录接口 (score: 8.5) [热]
├── 数据查询接口 (score: 6.2) [热]
└── 文件上传接口 (score: 4.8) [常温]
```

**为什么要查看新兴热区**：新兴热区是近期 48 小时内频繁使用的知识，它们可能还没有积累足够分数进入热区，但往往是最贴近当前工作上下文的内容。优先查看可以快速命中最近在用的知识。

**操作**：
- 从热门知识中选择最匹配的 relation
- **命中** → 进入第③步取原文
- **未命中** → 先检查 Group 是否定位正确（可换 Group 重试一次），确认无误后进入第④步

### 第③步：取原文

```bash
ki get-module-info --scope ${scope} --group "目标Group路径" --relation "Relation名称"
```

返回完整 Markdown 原文。**Agent 必须提炼后回答**，不要全文转储。

### 第④步：语义兜底与回问用户

#### 4.1 MCP memory_recall 语义搜索

**仅当索引中找不到目标 Relation 时**才执行此步：

| 参数 | 值 | 说明 |
|------|-----|------|
| query | `"<用户问题核心词>"` | **必须用 `query` 参数，禁止用 `text`** |
| limit | `3` | |
| scope | `"${scope}"` | 直接指定 scope 过滤，**禁止用 `tags`**（实测不生效） |

**返回结构**：
```json
{
  "content": [{ "type": "text", "text": "Found 2 memories:\n\n1. [...]" }],
  "details": {
    "count": 2,
    "memories": [
      {
        "id": "18d95893-...",
        "text": "[摘要] ...\n[关键词] ...\n[路径] ...",
        "category": "kb-import:${scope}",
        "scope": "${scope}",
        "score": 0.6043
      }
    ]
  }
}
```

**关键字段**：
- `details.memories[].id` = **memoryId**（后续 del 必需）
- `details.memories[].text` = 内容文本（直导后为原文 / chunk）
- `details.memories[].score` = 相关性分数

**⚠️ 常见错误与修复**：
| 错误 | 原因 | 修复 |
|------|------|------|
| `Cannot read properties of undefined (reading 'match')` | 用了 `text` 参数 | 改为 `query` 参数 |

#### 4.1.1 命中后：回写本地索引

`memory_recall` 命中后，`details.memories[].text` 为内容文本（直导后为原文 / chunk）。Agent 回写时：

1. **定位**：根据命中结果的 `group`/`relation` 字段（或内容上下文）确定 Group 与 Relation 名称；无法解析则跳过回写，直接基于内容回答。
2. **回写本地**：执行 `ki sync-relation` 将内容沉淀到本地索引，提升后续查询效率。
3. **提炼回答**：基于内容回答用户问题。

```bash
ki sync-relation \
  --scope ${scope} \
  --group "目标Group" \
  --relation "目标Relation" \
  --module-info "内容文本"
```

> **内容来源说明**：`--module-info` 使用 `memory_recall` 返回的内容文本，不额外调用 `get-module-info` 取原文。
>
> 这样做的目的是：热门知识从记忆系统逐步沉淀到本地索引，后续同类查询可直接命中本地热区，无需再走语义搜索。

#### 4.2 回问用户

索引 + `memory_recall` 都未命中 → 暂停：

> 我在知识库中没有找到相关信息。请提供模块名称/文件路径/功能描述，我会扫描代码并沉淀到知识库。

---

## 5. 写入项目代码知识到 KB

### 核心原则

**本规则只管写 KB。不管写 memory。AI 是否写 memory 自行决定。**

**写入后刷新**：每次写入完成（sync-relation 或 scan-kb import）后，必须重新执行 `ki query-group --scope ${scope} --mode full` 更新本地索引缓存。

### 允许写入的白名单（8 类项目代码知识）

✅ 模块/组件的职责与行为、API 接口与调用约定、架构决策与设计约束、项目内通用约定、已知 bug 模式与排查路径、重构策略与迁移路径、依赖关系与版本约束、测试策略

### 禁止写入的黑名单（6 类）

❌ 用户喜好、项目记忆/会话进度、用户个人信息、一次性诊断结论、临时偏好、会话内短期上下文

### 写入方式：单条 vs 批量

| 条数 | 方式 |
|------|------|
| 1~2 条 | `ki_sync_relation(scope, group, relation, module_info)` 逐条写 |
| ≥3 条 | `ki_bulk_sync_relation(scope, items)` 批量写（一次 embed + 一次向量写入） |

> CLI 等价：`ki sync-relation -s <scope> -i batch.json`（默认向量化；`--no-vector` 非向量化）

### 5.1 单条写入（sync-relation）

```bash
ki sync-relation \
  --scope ${scope} \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容"
```

**真实输出示例**：
```json
{
  "ok": true,
  "relation": "agent-rule-体验测试条目",
  "evicted": null,
  "vectorStored": true
}
```

**注意事项**：
- 超长 `--module-info`（>1000 字符）会收到警告，建议拆分多条或改用 `scan-kb import --source` 自动切分导入
- **`sync-relation` 只写 relations-cache + local KB，不写 memory**

### 5.2 批量写入（ki_bulk_sync_relation）

当单次写入 ≥3 条时，调用 MCP 工具 `ki_bulk_sync_relation`（一次 embedding + 一次向量写入，比多次逐条调用快 N 倍）：

```json
{
  "scope": "${scope}",
  "items": [
    {
      "group": "完整Group路径",
      "relation": "Relation名称",
      "module_info": "Markdown 内容",
      "tags": "api,auth"
    },
    {
      "group": "完整Group路径",
      "relation": "另一条Relation",
      "module_info": "Markdown 内容"
    }
  ]
}
```

- `tags` 可选：文档内容自定义标签（逗号分隔，叠加在默认 `ki-search` 之上）
- `vector` 可选，默认 `true`；`false` 时仅写 KB 层（无 memoryId，不可被 `ki_search` 召回）
- 各条目 `group` 自动补全路径；单条异常不中断整个批量

**CLI 等价**（如需）：

```bash
ki sync-relation --scope ${scope} --input /path/to/batch.json
```

**输出示例**：

```json
{
  "ok": true,
  "scope": "my-project",
  "total": 2,
  "succeeded": 2,
  "failed": 0,
  "skipped": 0,
  "results": [
    { "group": "完整Group路径", "relation": "条目1", "evicted": null, "contentTags": ["ki-search", "api", "auth"], "vectorStored": true, "wikiSynced": true },
    { "group": "完整Group路径", "relation": "条目2", "evicted": null, "contentTags": ["ki-search"], "vectorStored": true, "wikiSynced": true }
  ],
  "vectorStored": true
}
```

---

## 6. 创建/删除 Group

### 创建 Group

```bash
ki manage-index --scope ${scope} --action create --parent "父Group路径" --name "新Group名"
```

输出示例：`{ "ok": true, "path": "父Group路径/新Group名" }`

### 删除 Group（含子数据）

```bash
ki manage-index --scope ${scope} --action delete --parent "父Group路径" --name "目标Group名" --force
```

输出示例：`{ "ok": true, "path": "父Group路径/目标Group名" }`

**`--force` 会删除 Group 以及所有子 Relation。**

---

## 7. 禁忌清单（8 条红线）

| # | 红线 |
|---|------|
| 🔴 1 | `${scope}` 仍是字面量时，执行任何 ki 命令或 memory_* 操作 |
| 🔴 2 | `memory_recall` 使用 `text` 参数（必须用 `query`） |
| 🔴 3 | 把用户喜好 / 项目记忆 / 临时上下文写入 KB |
| 🔴 4 | 超长 module-info 不拆分直接写入（收到警告仍应拆分） |
| 🔴 5 | 跨 scope 串数据 |
| 🔴 6 | 把用户喜好 / 项目记忆 / 临时上下文写入 KB |
| 🔴 7 | 用 `memory_store` 逐条塞入本应走 `scan-kb import` 的批量内容 |
| 🔴 8 | 在 shell/模板中让 `${scope}` 被展开（本规则内反引号包裹） |

**写前自检三问**：scope 解析了吗？是项目代码知识吗？走对通道了吗？

---

## 8. 测试阶段反馈

`knowledge-index` 正处于测试验证阶段。使用过程中遇到以下情况时，请进行反馈报告：

### 需要反馈的场景

| 类型 | 示例 |
|------|------|
| **非使用错误的异常** | 命令执行崩溃、返回格式异常、数据不一致 |
| **可优化点** | 检索结果排序不合理、热区分数计算偏差、流程步骤冗余 |
| **文档/规则问题** | 描述与实际行为不符、遗漏边界场景、术语歧义 |
| **其他错误** | 权限问题、并发冲突、性能瓶颈 |

### 反馈方式

向项目维护者报告时，尽量提供：
- 复现步骤（具体命令 + 参数）
- 实际输出 vs 期望输出
- scope 名称、Group 路径等上下文

> 测试阶段的反馈直接影响正式版质量，鼓励及时上报遇到的任何异常。

---

## 9. 快速命令速查

> **公共命令语法见 [ki-command-guide](ki-command-guide.md)**。本节仅列出代码知识库特有的命令。

### 9.1 批量写入 KB

```bash
ki sync-relation --scope ${scope} --input /path/to/batch.json
```

详见 §5.2 批量写入流程。

### 9.2 MCP memory_recall 语义兜底

**仅当索引中找不到目标 Relation 时**使用：

| 参数 | 值 | 注意事项 |
|------|-----|----------|
| query | 用户问题 | **必须用 `query`，禁止 `text`** |
| limit | 3 | |
| scope | `${scope}` | 直接指定 scope 过滤，**禁止用 `tags`**（实测不生效） |

详见 §4.1 语义兜底流程。

---

## 10. 数据存储位置

ki 工具的数据存储在 npm 全局安装目录内（非项目仓库目录）：

```
<ki安装路径>/kb/${scope}/
├── group-index.json       # Group 树索引
├── relations-cache.json   # Relations 缓存（含 memoryIds/sourcePath）
└── {Group}/               # 本地 KB 原文（按 Group 分目录）
    └── index.json
```

当前环境实际路径：`/root/.npm/node_modules/lib/node_modules/kisearch/kb/monitor/`

`memory_recall` 查询的向量数据存储在 `~/.local/share/memory-mcp/lancedb/`。

---

> 本规则覆盖 REQ-01~05、REQ-07、REQ-08。不替代现有 SKILL，仅作 Agent 入口调度层。
