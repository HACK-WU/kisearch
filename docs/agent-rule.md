# AI 使用知识库服务 · 行为规则

> **面向 BK-Monitor 项目**。本规则直接告诉你每个阶段该敲什么命令、拿到什么输出、做什么判断。
> 不再需要去翻其他文档。

---

## 0. 速览：什么时候做什么

```
对话开始 → 【判断是否代码相关】
  ├─ 不相关 → 本规则不介入
  └─ 相关   → 检查 scope → 必要时问用户 → ki query-group 拉索引全景

需要查项目知识 → 【查询三步走】
  ① ki query-group --mode hot 看热门 → 命中？ki get-module-info 取原文
  ② 没命中 → MCP memory_recall(query=..., tags=...) 语义搜
  ③ 都没命中 → 问用户

产生了项目代码知识 → 【只写 KB】
  1~2 条 → ki sync-relation 逐条写
  ≥3 条 → 组织 ai-results.json → ki scan-kb import --mode incremental
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

## 2. 对话开始：拉知识库全景

**触发条件**：对话涉及代码（见 §7 判定标准）。

**第一个动作**：

```bash
ki query-group --scope ${scope} --mode full
```

**输出示例**（含完整索引树）：

```
=== 知识索引 [scope: monitor] ===

🔥 热门索引 (Top 5):
├── BK-Monitor-Wiki/监控数据管理 (score: 0) [📥]
├── BK-Monitor-Wiki/部署与运维 (score: 0) [📥]
├── BK-Monitor-Wiki/测试策略 (score: 0) [📥]
├── BK-Monitor-Wiki/核心模块架构 (score: 0) [📥]
└── BK-Monitor-Wiki/核心模块架构/告警后端模块 (score: 0) [📥]

📁 完整索引树:
BK-Monitor-Wiki/
├── 安全考虑
├── 故障排查
├── 告警系统设计
│   ├── 告警处理服务
│   ├── 告警引擎核心
│   └── 通知渠道管理
├── 核心模块架构
│   ├── 告警后端模块
│   ├── APM监控模块
│   └── 元数据管理模块
├── APM全栈监控
├── API接口文档
│   └── RESTful API接口
└── 数据库设计

📊 统计信息:
- 总索引数: 26
- 热区索引: 8 (新兴热: 3, 历史热: 5)
- 常温区索引: 13
- 冷区索引: 5
```

**拿到后**：记住主要 Group 名称，后续查询/写入时直接用。

**静默失败**：如果 scope 不存在或树为空，不报错，记录"无已建索引"后继续。

---

## 3. 查询项目知识：三步走

### 第①步：热门 Relation 命中

```bash
ki query-group --scope ${scope} --groups "BK-Monitor-Wiki/告警系统设计/告警引擎核心" --mode hot
```

**真实输出示例**：

```
=== BK-Monitor-Wiki/告警系统设计/告警引擎核心 ===

🔥 热门知识 (Top 3):
├── 告警上下文管理 (score: 0) [📥]
├── 告警处理引擎 (score: 0) [📥]
└── 告警引擎核心 (score: 0) [📥]

🏷️ 关键词词云:
└── 告警系统设计, 告警引擎核心, 告警上下文管理, 告警处理引擎, 存储系统, ...
```

**操作**：
- 从 `🔥 热门知识` 中选择最匹配的 relation
- 记下 `🏷️ 关键词词云`（第②步备用）

**命中后取原文**：

```bash
ki get-module-info --scope ${scope} --group "BK-Monitor-Wiki/告警系统设计/告警引擎核心" --relation "告警处理引擎"
```

返回完整 Markdown（含 mermaid 图、cite 引用链接、章节）。**Agent 必须提炼后回答**，不要全文转储。

### 第②步：MCP memory_recall 语义搜索

热门未命中 → 用 MCP 工具的 **`memory_recall`**：

| 参数 | 值 | 说明 |
|------|-----|------|
| query | `"<用户问题核心词> <关键词词云摘取>"` | **必须用 `query` 参数，禁止用 `text`** |
| limit | `3` | |
| tags | `"knowledge-index,${scope}"` | 逗号分隔，"knowledge-index" 前缀固定 |

当 **MCP 工具** 自动将参数填入时，格式为：
```json
{ "query": "告警处理引擎 接入模块 事件处理", "limit": 3, "tags": "knowledge-index,monitor" }
```

**返回的真实结构**：
```json
{
  "content": [{ "type": "text", "text": "Found 2 memories:\n\n1. [...]" }],
  "details": {
    "count": 2,
    "memories": [
      {
        "id": "18d95893-...",
        "text": "[摘要] ...\n[关键词] ...\n[路径] ...",
        "category": "kb-import:monitor",
        "scope": "monitor",
        "score": 0.6043
      }
    ]
  }
}
```

**关键字段**：
- `details.memories[].id` = **memoryId**（后续 del 必需）
- `details.memories[].text` = 三段式文本 `[摘要]\n[关键词]\n[路径]`
- `details.memories[].score` = 相关性分数

**⚠️ 常见错误与修复**：
| 错误 | 原因 | 修复 |
|------|------|------|
| `Cannot read properties of undefined (reading 'match')` | 用了 `text` 参数 | 改为 `query` 参数 |

### 第③步：回问用户

KB + memory 都未命中 → 暂停：

> 我在知识库中没有找到相关信息。请提供模块名称/文件路径/功能描述，我会扫描代码并沉淀到知识库。

---

## 4. 写入项目代码知识到 KB

### 核心原则

**本规则只管写 KB。不管写 memory。AI 是否写 memory 自行决定。**

### 允许写入的白名单（8 类项目代码知识）

✅ 模块/组件的职责与行为、API 接口与调用约定、架构决策与设计约束、项目内通用约定、已知 bug 模式与排查路径、重构策略与迁移路径、依赖关系与版本约束、测试策略

### 禁止写入的黑名单（6 类）

❌ 用户喜好、项目记忆/会话进度、用户个人信息、一次性诊断结论、临时偏好、会话内短期上下文

### 写入方式：单条 vs 批量

| 条数 | 命令 |
|------|------|
| 1~2 条 | `ki sync-relation` 逐条写 |
| ≥3 条 | 组织 `ai-results.json` → `ki scan-kb import --mode incremental` |

### 4.1 单条写入（sync-relation）

```bash
ki sync-relation \
  --scope ${scope} \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容" \
  --keywords "关键词1,关键词2,关键词3"
```

**真实输出示例**：
```json
{
  "ok": true,
  "relation": "agent-rule-体验测试条目",
  "keywords": ["测试", "agent-rule", "体验"],
  "invalid_keywords": [],
  "evicted": null
}
```

**注意事项**：
- `keywords` 必须是自然语言词汇，禁止代码符号（类名、方法名、路径）
- `keywords` 必须真实出现在 `module-info` 原文中
- **`sync-relation` 只写 relations-cache + local KB，不写 memory**

### 4.2 批量写入（ai-results.json + scan-kb import）

当单次写入 ≥3 条时，组织如下 JSON：

```json
{
  "meta": {
    "sourceDir": "/root/bk-monitor/bk-monitor-wiki/wiki",
    "rootName": "BK-Monitor-Wiki"
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

**执行命令**：

```bash
ki scan-kb import --scope ${scope} --mode incremental --results /path/to/ai-results.json
```

**真实输出示例**：

```
[Phase 1/4] 校验增量导入前置条件 ...
  ✓ 校验通过

[Phase 2/4] 删除过时条目（0 条）...
  ✓ 删除完成：0 条

[Phase 3/4] 预处理 modify + 批量向量化（add=3, modify=0）...
  ✓ 向量化完成：add=3, modify=0, errors=0

[Phase 4/4] 持久化 + 更新 source ...

增量导入完成：total=3  added=3  modified=0  deleted=0  errors=0
{
  "ok": true,
  "stats": { "total": 3, "added": 3, "modified": 0, "deleted": 0, "errors": 0 }
}
```

**支持的操作（action 字段）**：

| action | 用途 | 必要额外字段 |
|--------|------|-------------|
| `add` | 新增 | summary, keywords |
| `modify` | 修改已有 | summary, keywords, memoryId |
| `delete` | 删除 | **memoryId** |

**⚠️ `delete` 操作必须携带 `memoryId`**，否则报错：
`"entries[0] action=delete 必须携带 memoryId"`

---

## 5. 创建/删除 Group

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

## 7. 代码相关性判定

用于 §2 判断对话是否触发主动拉 Group。

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

---

## 8. 快速命令速查

```bash
# 拉全景
ki query-group --scope ${scope} --mode full

# 看某 Group 热门 + 关键词
ki query-group --scope ${scope} --groups "路径" --mode hot

# 取原文
ki get-module-info --scope ${scope} --group "路径" --relation "名称"

# 单条写入 KB
ki sync-relation --scope ${scope} --group "路径" --relation "名称" --module-info "内容" --keywords "k1,k2"

# 批量写入 KB
ki scan-kb import --scope ${scope} --mode incremental --results /path/to/ai-results.json

# 创建 Group
ki manage-index --scope ${scope} --action create --parent "父" --name "子"

# 删除 Group
ki manage-index --scope ${scope} --action delete --parent "父" --name "子" --force
```

**MCP memory_recall 参数速查**：

| 参数 | 值 | 注意事项 |
|------|-----|----------|
| query | 用户问题 + 关键词词云提取 | **必须用 `query`，禁止 `text`** |
| limit | 3 | |
| tags | `knowledge-index,${scope}` | 前缀 `knowledge-index` 固定 |

---

## 9. 数据存储位置

```
knowledge-indexer/kb/${scope}/
├── group-index.json       # Group 树索引
├── relations-cache.json   # Relations 缓存（含 memoryId）
└── {Group}/index.json     # 本地 KB 原文
```

`memory_recall` 查询的向量数据存储在 `~/.local/share/memory-mcp/lancedb/`。

---

> 本规则覆盖 REQ-01~05、REQ-07、REQ-08。不替代现有 SKILL，仅作 Agent 入口调度层。
