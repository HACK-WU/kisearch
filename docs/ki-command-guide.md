# ki 命令参考

> 本文件是 Agent 规则（[codekb-agent-guide](./codekb-agent-guide.md)）的公共命令参考。
> 规则文件通过引用本文件获取命令语法，自身专注行为逻辑。

---

## 公共命令

以下命令的 `<scope>` 为占位符，使用时替换为实际 scope 值：

| 用途 | scope 值 |
|------|----------|
| 代码知识库 | `${scope}` |
| 记忆类内容 | `${scope}-memory` |

> 用户画像已迁移至 AGENTS.md"用户画像"章节直接存储，不再使用 `user-profile` scope（见 `agents-md-init` skill）。

### 1. 拉取全景索引

```bash
ki group list --scope <scope> --mode full
```

**用途**：获取 scope 下所有 Group 的索引树和热度信息。

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

---

### 2. 查 Group 热区

```bash
ki group list --scope <scope> --groups "目标Group路径" --mode hot,emerging
```

**用途**：查看指定 Group 下的热门知识和新兴热区（近 48 小时内频繁使用的知识）。

> 💡 Group 路径支持向量语义兜底：输入部分名称（如 `"部署运维"`）可自动模糊匹配到完整路径（如 `"部署与运维"`），输出带 `💡 近似匹配` 前缀。

**可选参数**：

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--hot-count <count>` | 5 | 热门展示个数 |
| `--depth <depth>` | 4 | 索引层级深度（`--mode full` 时生效） |

**输出示例**：

```
=== my-project/API ===

热门索引 (Top 3):
├── 用户登录接口 (score: 8.5) [热]
├── 数据查询接口 (score: 6.2) [热]
└── 文件上传接口 (score: 4.8) [常温]
```

---

### 3. 取原文

```bash
ki get-module-info --scope <scope> --group "目标Group路径" --relation "Relation名称"
```

**用途**：获取指定 Relation 的完整 Markdown 原文。支持 Relation 名称的向量语义兜底：精确名称未命中时自动尝试模糊匹配。

**注意**：Agent 必须提炼后回答，不要全文转储。

---

### 4. 单条写入

```bash
ki sync-relation \
  --scope <scope> \
  --group "目标Group路径" \
  --relation "Relation名称" \
  --module-info "Markdown内容"
```

**用途**：向指定 Group 写入一条知识条目。

**真实输出示例**：

```json
{
  "ok": true,
  "relation": "agent-rule-体验测试条目",
  "evicted": null,
  "vectorStored": true
}
```

**`sync-relation` 同名覆盖**：Relation 名称相同时，自动覆盖原有内容。

**批量模式**：当需一次性写入多条 Relation 时，使用 `--input` 指定 JSON 文件。**批量模式默认向量化**（一次 embedding + 一次向量批量写入，比多次逐条调用快 N 倍）；`--no-vector` 关闭向量化：

```bash
ki sync-relation --scope <scope> --input /path/to/batch.json
```

`batch.json` 格式（`tags` 可选，自定义标签逗号分隔）：

```json
{
  "items": [
    {
      "group": "目标Group路径",
      "relation": "Relation名称",
      "module_info": "Markdown内容",
      "tags": "api,auth"
    }
  ]
}
```

> 等价 MCP 工具：`ki_bulk_sync_relation(scope, items)`（AI Agent 场景推荐，无需经 CLI）

---

### 5. 管理 Group

```bash
# 列出所有 scope（不需要 --scope 参数）
ki scope list --json

# 创建顶层 Group（位置参数即完整路径）
ki group create "Group名称" --scope <scope>

# 创建子 Group
ki group create "父Group路径/新Group名" --scope <scope>

# 删除 Group（含子数据）
ki group delete "父Group路径/目标Group名" --yes --scope <scope>
```

**`ki scope list` 输出示例**：

```json
{
  "ok": true,
  "scopeMode": "default",
  "vectorAvailable": true,
  "count": 2,
  "scopes": [
    { "scope": "my-project", "kb": true, "vector": true, "registered": true,
      "wikiCount": 12, "ftsOnlyDocCount": 0, "ftsDocCount": 12,
      "topGroups": ["我的项目"], "topGroupsStale": false },
    { "scope": "qoder-wiki", "kb": true, "vector": false, "registered": false,
      "wikiCount": 30, "ftsOnlyDocCount": 0, "ftsDocCount": 0,
      "topGroups": ["QoderWiki"], "topGroupsStale": false }
  ]
}
```

**Group 操作输出示例**：

```json
{ "ok": true, "scope": "my-project", "path": "父Group路径/新Group名", "createdScope": false }
```

**删除默认只预览，追加 `--yes` 才执行；不触碰 `source.dir` / wiki 源目录。**

**`create` 的位置参数就是完整路径**：
- 顶层：`ki group create "API" --scope <scope>`
- 子节点：`ki group create "API/用户" --scope <scope>`（父路径必须已存在）

**`ki scope list`**：列出 KB、向量层与配置中出现的全部 scope，并标注所在层与注册状态；不需要 `--scope` 参数

---

## 超长 module-info 提示

`sync-relation` 对超长 `--module-info`（>1000 字符）输出警告（建议拆分多条写入或改用 `ki import --source` 自动切分），但仍正常写入单条。

---

## 常见错误与修复

| 错误 | 原因 | 修复 |
|------|------|------|
| `scope not found` | scope 尚未创建 | 先用 `ki scope list` 确认已有 scope，再执行 `ki group create "名称" --scope <scope>` 创建顶层 Group，或执行 `ki sync-relation` 写入任意一条数据自动创建 |
| Group 不存在 | 尚未创建该 Group | 执行 `ki group create "名称" --scope <scope>` 创建 |
| Group 路径不精确 | 路径拼写、别名或简称 | CLI 已内置向量语义兜底，自动模糊匹配并输出 `💡 近似匹配`。若仍失败，用 `ki group list --mode full` 确认路径 |
| `--module-info 内容不能为空` | 未传或空内容 | 补充 `--module-info "<markdown>"` |
| `${scope}` 仍是字面量 | 用户未指定 scope | 暂停，先问用户确认 scope |
| Relation 名称与预期不符 | 使用了错误的名称 | 用 `ki group list --mode full` 确认实际名称 |
| 写入到错误的 scope | 混淆了 scope | 确认写入目标 scope 是否正确 |

---

## 写入后刷新缓存

每次写入操作（`sync-relation` / `ki import` / `ki group create`）完成后，必须重新拉取全景：

```bash
ki group list --scope <scope> --mode full
```

> 本文件仅定义命令语法和通用规则。各命令的使用时机、判断流程、禁忌清单等行为逻辑由 [codekb-agent-guide.md](./codekb-agent-guide.md) 定义。
