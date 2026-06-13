# CLI 参考

所有脚本都通过 `ki` 命令执行（已通过 `npm link` 创建全局链接）。

---

## `scan-kb`（统一入口）

外部知识库扫描与导入的统一入口，支持 `import`、`diff`、`scan` 三个子命令。

### `import` 子命令（推荐）

统一导入外部知识库，首次全量或增量更新。

```bash
ki scan-kb import \
  --scope <scope> \
  --results <ai-results.json> \
  [--mode full|incremental] \
  [--source-dir <dir>] \
  [--root-name <name>] \
  [--mapping <jsonFile>]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 是 | 项目隔离标识 |
| `--results` | 是 | `ai-results.json` 路径 |
| `--mode` | 否 | `full`（默认）或 `incremental` |
| `--source-dir` | 否 | 覆盖 `meta.sourceDir` |
| `--root-name` | 否 | 覆盖 `meta.rootName` |
| `--mapping` | 否 | mapping 文件（配置模式） |

**示例：首次全量导入**

```bash
ki scan-kb import --scope my-project --results ai-results.json
```

输出：
```json
{
  "ok": true,
  "action": "import",
  "scope": "my-project",
  "total_entries": 15,
  "vectorized": 15,
  "groups_created": 5,
  "relations_cached": 15,
  "local_kb_written": 15,
  "source_recorded": true
}
```

**示例：增量更新**

```bash
# 1. 检测变更
ki scan-kb diff --scope my-project

# 2. AI 生成增量 ai-results.json（每条带 action: add|modify|delete）

# 3. 执行增量导入
ki scan-kb import --scope my-project --mode incremental --results ai-results.json
```

输出：
```json
{
  "ok": true,
  "action": "incremental",
  "scope": "my-project",
  "added": 3,
  "modified": 2,
  "deleted": 1,
  "total_processed": 6
}
```

### `diff` 子命令

检测自上次导入以来的变更。

```bash
ki scan-kb diff \
  --scope <scope> \
  [--output <file>]
```

**示例：查看变更**

```bash
ki scan-kb diff --scope my-project
```

输出：
```json
{
  "ok": true,
  "action": "diff",
  "scope": "my-project",
  "last_commit": "abc123",
  "current_commit": "def456",
  "changes": {
    "added": ["docs/new-feature.md"],
    "modified": ["docs/api.md"],
    "deleted": ["docs/old-feature.md"]
  },
  "total_changes": 3
}
```

### `scan` 子命令（旧流程，保留兼容）

```bash
ki scan-kb scan \
  --scope <scope> --source <dir> --root-name <name> \
  [--results <ai-results.json>]
```

---

## `manage-index`

管理 Group 树索引节点，以及查询已初始化的 scope 列表。

### 列出所有 scope

```bash
ki manage-index --action list-scopes
```

**示例：**

```bash
ki manage-index --action list-scopes
```

输出：
```json
{
  "ok": true,
  "scopes": [
    { "scope": "my-project", "topGroups": ["API", "设计文档"] },
    { "scope": "qoder-wiki", "topGroups": ["QoderWiki"] }
  ],
  "total": 2
}
```

> `list-scopes` 不需要 `--scope` 参数。

### 创建顶层 Group

```bash
ki manage-index \
  --scope <scope> --action create --name <name>
```

> 不指定 `--parent` 即创建顶层 Group。

**示例：**

```bash
ki manage-index --scope my-project --action create --name "API"
```

输出：
```json
{
  "ok": true,
  "path": "我的项目"
}
```

### 创建子节点

```bash
ki manage-index \
  --scope <scope> --action create --parent <path> --name <name>
```

**示例：**

```bash
ki manage-index --scope my-project --action create --parent "我的项目" --name "API"
```

输出：
```json
{
  "ok": true,
  "path": "我的项目/API"
}
```

### 删除节点

```bash
ki manage-index \
  --scope <scope> --action delete --parent <path> --name <name> [--force]
```

**示例：删除空节点**

```bash
ki manage-index --scope my-project --action delete --parent "我的项目" --name "API"
```

输出：
```json
{
  "ok": true,
  "path": "我的项目/API"
}
```

**示例：强制删除非空节点**

```bash
ki manage-index --scope my-project --action delete --parent "我的项目" --name "API" --force
```

输出：
```json
{
  "ok": true,
  "path": "我的项目/API"
}
```

---

## `query-group`

查询 Group 树、Relation 分区和关键词词云。

```bash
ki query-group --scope <scope> [--groups <g1,g2>] [--mode <mode>] [--hot-count <count>] [--depth <depth>]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--scope` | 项目隔离标识 | 必填 |
| `--groups` | 逗号分隔的 Group 路径 | - |
| `--mode` | 展示分区：`hot` / `warm` / `cold` / `emerging` / `full`（支持逗号分隔） | `hot` |
| `--hot-count` | 热门展示个数 | `5` |
| `--depth` | 索引层级深度 | `4` |

**mode 说明**：
- `hot`：热门索引（高频使用）
- `warm`：常温索引
- `cold`：冷区索引（低频使用）
- `emerging`：新兴热区（近期活跃）
- `full`：完整索引树

**💡 向量语义兜底**：当 `--groups` 指定的 Group 路径在索引树中不存在时，自动通过向量搜索进行模糊匹配。例如输入部分名称 `"部署运维"` 可匹配到 `"部署与运维"`，`"通知渠道"` 可匹配到 `"告警系统设计/通知渠道管理"`。命中后输出带 `💡 近似匹配` 前缀的提示。

**示例：模糊 Group 路径匹配**

```bash
ki query-group --scope monitor --groups "部署运维"
```

输出：
```
💡 近似匹配："部署运维" → "BK-Monitor-Wiki/部署与运维"（score: 0.89）

=== BK-Monitor-Wiki/部署与运维 ===

🔥 热门知识 (Top 5):
├── Kubernetes集群管理 (score: 0) [📥]
└── 容器化部署 (score: 0) [📥]
```

**示例：查看热门索引**

```bash
ki query-group --scope my-project
```

输出：
```
=== 知识索引 [scope: my-project] ===

🔥 热门索引 (Top 5):
├── 项目/API (score: 8.5) [热]
├── 项目/前端/状态管理 (score: 6.2) [热]
├── 项目/后端/数据库 (score: 4.8) [常温]
├── 项目/部署/CI-CD (score: 3.2) [常温]
└── 项目/文档/README (score: 1.5) [冷]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

**示例：查看特定 Group 的 Relations**

```bash
ki query-group --scope my-project --groups "项目/API"
```

输出：
```
=== 项目/API ===

🔥 热门知识 (Top 5):
├── 用户登录接口 (score: 8.5) [热]
├── 数据查询接口 (score: 6.2) [热]
├── 文件上传接口 (score: 4.8) [常温]
├── 权限验证接口 (score: 3.2) [常温]
└── 日志记录接口 (score: 1.5) [冷]

🏷️ 关键词词云:
└── 登录, 认证, token, 查询, 上传, 权限, 日志
```

**示例：查看多个分区**

```bash
ki query-group --scope my-project --mode hot,warm
```

输出：
```
=== 知识索引 [scope: my-project] ===

🔥 热门索引 (Top 5):
├── 项目/API (score: 8.5) [热]
├── 项目/前端/状态管理 (score: 6.2) [热]
├── 项目/后端/数据库 (score: 4.8) [常温]
├── 项目/部署/CI-CD (score: 3.2) [常温]
└── 项目/文档/README (score: 1.5) [冷]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

**示例：查看完整索引树**

```bash
ki query-group --scope my-project --mode full
```

输出：
```
=== 知识索引 [scope: my-project] ===

📁 完整索引树:
我的项目/ (score: 25.2) [热]
├── API/ (score: 15.5) [热]
│   ├── 用户管理/ (score: 8.5) [热]
│   ├── 数据查询/ (score: 6.2) [热]
│   └── 文件操作/ (score: 4.8) [常温]
├── 前端/ (score: 6.2) [热]
│   ├── 状态管理/ (score: 6.2) [热]
│   └── 组件库/ (score: 3.2) [常温]
└── 部署/ (score: 3.2) [常温]
    ├── CI-CD/ (score: 3.2) [常温]
    └── 监控/ (score: 1.5) [冷]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

---

## `get-module-info`

按 Group + Relation 读取本地 KB 中的 Markdown 原文。支持 Relation 名称的向量语义兜底：精确名称未命中时自动尝试模糊匹配。

```bash
ki get-module-info \
  --scope <scope> --group <group> --relation <relation>
```

**示例：读取模块原文**

```bash
ki get-module-info --scope my-project --group "项目/API" --relation "用户登录接口"
```

输出：
```markdown
## 登录流程

用户输入账号密码后进入认证流程，服务端校验成功后返回 token。

### 接口参数

- `username`: 用户名（必填）
- `password`: 密码（必填）

### 返回结果

```json
{
  "code": 200,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```
```

---

## `sync-relation`

把 Relation 和模块说明写入本地索引。支持单条模式和批量模式。

### 单条模式

```bash
ki sync-relation \
  --scope <scope> --group <group> \
  --relation <text> --module-info <markdown> --keywords <k1,k2>
```

**示例：写入单条知识**

```bash
ki sync-relation \
  --scope my-project \
  --group "项目/API" \
  --relation "用户登录接口" \
  --module-info "## 登录流程\n用户输入账号密码后进入认证流程，服务端校验成功后返回 token。" \
  --keywords "登录,认证,token"
```

输出：
```json
{
  "ok": true,
  "relation": "用户登录接口",
  "keywords": ["登录", "认证", "token"],
  "invalid_keywords": [],
  "evicted": null
}
```

### 批量模式

```bash
ki sync-relation \
  --scope <scope> --input <jsonFile>
```

**示例：批量写入**

```bash
ki sync-relation --scope my-project --input batch-input.json
```

`batch-input.json` 格式：
```json
{
  "items": [
    {
      "group": "项目/API",
      "relation": "用户登录接口",
      "module_info": "## 登录流程\n用户输入账号密码后进入认证流程...",
      "keywords": ["登录", "认证", "token"]
    },
    {
      "group": "项目/API",
      "relation": "数据查询接口",
      "module_info": "## 查询流程\n支持分页查询和条件筛选...",
      "keywords": ["查询", "分页", "筛选"]
    }
  ]
}
```

输出：
```json
{
  "ok": true,
  "results": [
    {
      "relation": "用户登录接口",
      "keywords": ["登录", "认证", "token"],
      "invalid_keywords": [],
      "evicted": null
    },
    {
      "relation": "数据查询接口",
      "keywords": ["查询", "分页", "筛选"],
      "invalid_keywords": [],
      "evicted": null
    }
  ],
  "total": 2,
  "failed": 0
}
```

### 关键词约束

- 关键词必须是自然语言词汇
- 关键词必须真实出现在 `module-info` 原文中
- 未出现在原文中的关键词会被判为无效

---

## 常用工作流

### 本地知识沉淀

1. `manage-index` 创建 Group
2. `sync-relation` 写入模块说明
3. `query-group` 检查导航与热点
4. `get-module-info` 验证原文可读性

### 外部知识库导入（推荐新流程）

1. AI 生成 `ai-results.json`
2. `scan-kb import --scope <s> --results <f>`

### 增量更新

1. `scan-kb diff --scope <s>`
2. AI 生成增量 `ai-results.json`
3. `scan-kb import --scope <s> --mode incremental --results <f>`

---

## 相关文档

- [架构与协作关系](./architecture.md) - 了解 knowledge-indexer 与向量数据库的分层关系
- [scan-kb 子命令详解](./scan-kb.md) - 含 `import`、`diff` 的详细说明和 `ai-results.json` 格式
- [外部导入与 mapping 示例](./import-kb.md) - mapping 配置文件的详细说明
- [异常处理与恢复建议](./error-handling.md) - 常见错误和解决方案
- [典型工作流](./workflows.md) - 完整的使用场景和最佳实践
- [备份与恢复](./backup-restore.md) - 数据备份和恢复策略