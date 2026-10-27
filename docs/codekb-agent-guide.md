# codekb-agent-guide 代码知识库检索行为规则

> 面向使用 kisearch 的 AI Agent：每个阶段敲什么命令、拿到什么输出、做什么判断。
> 配套的检索 Skill 见 [`skills/ki-search/SKILL.md`](../skills/ki-search/SKILL.md)（四步走口径一致）；命令语法见 [ki-command-guide.md](./ki-command-guide.md)；工具参数见 [mcp-tools.md](./mcp-tools.md)。

## 0. 速览

```text
对话涉及代码?
├─ 否 → 本规则不介入
└─ 是 → scope 已指定?
    ├─ 否 → 问用户
    └─ 是 → 查询类型?
        ├─ 定位级（找文件/函数/类/报错行）→ 直接用 SearchSymbol / grep / Read，不走 KB
        └─ 理解级（架构/流程/设计意图/排查思路/模块关系）
            → ki group list --mode full 拉全景 → 缓存

查询项目知识（四步走，理解级专用）
  ① 定位 Group → 从全景中锁定目标 Group
  ② 查热区     → ki group list --groups <G> --mode hot,emerging
  ③ 取原文     → ki get-module-info
  ④ 语义兜底   → ki_search → 仍无 → 问用户

产生项目代码知识 → 只写 KB
  1~2 条 → ki_sync_relation 逐条写
  ≥3 条  → ki_bulk_sync_relation 批量写（每批 ≤5 条）
  ❌ 用户喜好 / 项目记忆 / 临时信息 → 不写 KB
```

## 1. Scope 约定

- 代码知识库用 `${scope}`；记忆类内容通常用 `${scope}-memory`。
- `scopeMode: default` 下首次使用自动创建；`strict` 下必须已在 `config.scopes` 注册。
- `${scope}` 仍是字面量时，不得执行任何 `ki` 命令。

## 2. 相关性判定

**正例（触发）**：问模块职责、接口约定、架构决策、跨文件调用关系、历史坑与排查路径。

**反例（不触发）**：问某个具体符号在哪、单文件语法、通用语言问题、与项目无关的知识。

**边界模糊**：先按定位级 grep 一次；结果指向多文件/需要解释设计意图时，再升级为理解级走 KB。

**查询类型**：

| 类型 | 典型问题 | 手段 |
|---|---|---|
| 定位级 | 「`buildKiMcpServer` 在哪定义？」 | grep / SearchSymbol / Read |
| 理解级 | 「MCP 启动链路是怎样的？」 | KB 四步走 |

## 3. 对话开始：拉全景

```bash
ki group list --scope ${scope} --mode full
```

拿到 Group 树与分区标签后缓存，后续步骤不再重复拉取（除非写入或切 scope）。`full` 模式每区最多渲染 50 条，超出会提示未展示数量。

## 4. 查询项目知识：四步走

### 第①步：定位 Group

从全景中按模块名锁定 Group。路径不确定时，`--groups` 会自动向量兜底并在输出中带 `💡 近似匹配`。

### 第②步：查热区

```bash
ki group list --scope ${scope} --groups "目标Group" --mode hot,emerging
```

若第①步已明确 Relation 名称，可跳过本步直接取原文。

### 第③步：取原文

```bash
ki get-module-info --scope ${scope} --group "目标Group" --relation "Relation名称"
```

批量读取：`--relation` 逗号分隔多个（≤10 条且须同 Group），或 MCP 工具传 `relations` 数组——返回逐条 `results`，部分失败不影响其他。

> 超长 `--module-info`（>1000 字符）在写入时会收到警告，建议拆分或改用 `ki import` 自动切分。

### 第④步：语义兜底与回问用户

#### 4.1 `ki_search` 语义检索

**仅当索引中找不到目标 Relation 时**才执行：

| 参数 | 值 | 说明 |
|---|---|---|
| `query` | 用户问题核心词 | 必填 |
| `scope` | `${scope}` | 精确指定 scope |
| `limit` | `3` | 总返回条数上限 |
| `mode` | `hybrid`（默认）/ `fulltext` | `--no-vector` 写入的内容只有全文索引，需用 `fulltext` |

返回每条结果带 `group` / `relation` / `tag` / `score` / `content`；需要整篇原文时加 `include_original`（CLI 为 `--original`）。

**命中后**：

1. 优先用结果的 `group` + `relation` 走第③步取原文，回答里标注来源；
2. 只有确有必要沉淀时，才用 `ki_sync_relation` 写入本地 KB（避免把检索噪声写回库）；
3. 无法解析 Group / Relation 时，直接基于返回内容回答，不强行回写。

#### 4.2 回问用户

索引与语义检索都未命中 → 暂停：

> 我在知识库中没有找到相关信息。请提供模块名称 / 文件路径 / 功能描述，我会扫描代码并沉淀到知识库。

## 5. 写入项目代码知识

**本规则只管写 KB。是否写记忆由 Agent 自行决定。**

**写入后刷新**：每次写入完成后重新执行 `ki group list --scope ${scope} --mode full` 更新缓存。

### 允许写入的白名单（8 类）

模块/组件职责与行为、API 接口与调用约定、架构决策与设计约束、项目内通用约定、已知 bug 模式与排查路径、重构策略与迁移路径、依赖关系与版本约束、测试策略。

### 禁止写入的黑名单（6 类）

用户喜好、项目记忆/会话进度、用户个人信息、一次性诊断结论、临时偏好、会话内短期上下文。

### 单条 vs 批量

| 条数 | 方式 |
|---|---|
| 1~2 条 | `ki_sync_relation` 逐条写 |
| ≥3 条 | `ki_bulk_sync_relation` 分批写（每批 ≤5 条） |

> 分批理由：一次传大量 items 组织成本高、易出错；分批后服务端仍是批量 embed + 批量写入，总耗时几乎不变，且单批失败只重试该批。

### 5.1 单条写入

```bash
ki sync-relation \
  --scope ${scope} \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容"
```

输出示例：`{ "ok": true, "relation": "...", "vectorStored": true }`

- 只写 relations-cache + 本地 KB + 向量层，不写外部记忆系统。
- 超长内容会收到警告，建议拆分或改用 `ki import`。

### 5.2 批量写入

```json
{
  "scope": "${scope}",
  "items": [
    { "group": "完整Group路径", "relation": "条目1", "module_info": "Markdown", "tags": "api,auth" },
    { "group": "完整Group路径", "relation": "条目2", "module_info": "Markdown" }
  ]
}
```

- `tags` 可选：叠加在默认 `ki-search` 之上。
- `vector` 可选，默认 `true`；`false` 时只写 KB 与全文索引，`vectorStored` 为 false。
- 各条目 `group` 自动补全路径；单条异常不中断整批。

CLI 等价：`ki sync-relation --scope ${scope} --input /path/to/batch.json`

## 6. 创建 / 删除 Group

```bash
# 创建（父级必须已存在）
ki group create "父Group路径/新Group名" --scope ${scope}

# 删除（默认预览，加 --yes 才执行；会连带删除子 Group 与全部 Relation）
ki group delete "目标Group路径" --scope ${scope}
ki group delete "目标Group路径" --yes --scope ${scope}
```

> 删除不可恢复：wiki 源文件是物理删除，没有回收站。删前先 `ki backup` 或确认可重新导入。

## 7. 禁忌清单

| # | 红线 |
|---|---|
| 1 | `${scope}` 仍是字面量时执行任何 `ki` 命令 |
| 2 | 把用户喜好 / 项目记忆 / 临时上下文写入 KB（白名单之外一律不写） |
| 3 | 跨 scope 串数据 |
| 4 | 超长 `module_info` 不拆分直接写入（收到警告仍应拆分） |
| 5 | 用 `ki_store` / `ki_bulk_store` 替代 `ki_sync_relation` 持久化记忆（只写向量层会产生孤儿向量） |
| 6 | 在 shell/模板中让 `${scope}` 被展开（本规则内用反引号包裹） |

**写前自检三问**：scope 解析了吗？属于白名单吗？走对通道了吗？

## 8. 快速命令速查

```bash
ki group list --scope ${scope} --mode full                    # 全景
ki group list --scope ${scope} --groups "G" --mode hot,emerging  # 热区
ki get-module-info --scope ${scope} --group "G" --relation "R"   # 原文
ki search "关键词" -s ${scope}                                   # 语义兜底
ki sync-relation --scope ${scope} --input batch.json             # 批量写
```

## 9. 数据存储位置

默认数据目录为 `~/.ki/kb/<scope>/`（可用 `config.dataDir` 覆盖）：

```text
~/.ki/kb/<scope>/
├── group-index.json                 # Group 树 + source 块
├── .relations/
│   ├── manifest.json                # scope 级元数据 + revision
│   └── <groupPath>/cache.json       # Relation 缓存分片
└── <groupPath>/index.json           # 本地 KB 原文
```

向量数据在 `~/.ki/vector/collections/<scope>/`（每 scope 独立 Collection）。

## 10. 相关文档

- [query-kb.md](./query-kb.md) —— 查询的三条路径
- [ki-command-guide.md](./ki-command-guide.md) —— 命令语法
- [mcp-tools.md](./mcp-tools.md) —— MCP 工具参数
- [architecture.md](./architecture.md) —— 数据文件与链路
