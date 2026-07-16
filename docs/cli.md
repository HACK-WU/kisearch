# CLI 参考

所有脚本都通过 `ki` 命令执行（已通过 `npm link` 创建全局链接）。

**配置优先级**：
1. `--config <path>` 命令行参数
2. 当前工作目录 `.ki/config.json`
3. `$HOME/.ki/config.json`
4. 内置默认值（`dataDir` = `$HOME/.ki-data`）

**首次使用**：运行 `ki config init` 生成配置文件模板。

**注意**：环境变量 `KI_DATA_DIR` 已不再支持，仅使用配置文件机制。

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
  "evicted": null,
  "wikiSynced": true,
  "wikiFile": "/path/to/wiki-content/API/用户登录接口.md"
}
```

**Wiki 写回**：sync-relation 写入 KB 后，会自动尝试将内容同步写回外部 Wiki 文件（Markdown 格式）。Wiki 目录发现优先级：

1. `group-index.json` 的 `source` 块（由 `scan-kb import` 自动记录）
2. `config.json` 中 scope 级 `wikiSync.sourceDir` 兜底配置

如果 `wikiSynced` 为 `false`，输出中会包含 `wikiReason` 说明原因（如未配置 Wiki 目录、relation 含非法路径字符等）。Wiki 写回失败不阻塞主流程，仅记录警告。

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

## `mcp`

启动 MCP (Model Context Protocol) Server，通过 stdio 传输向 AI Agent 暴露知识索引能力。

```bash
ki mcp
```

无需任何参数，启动后通过 JSON-RPC 协议与 AI Agent 通信。

### 暴露的 MCP 工具

| 工具名 | 类型 | 功能 | 对应 CLI 命令 |
|--------|------|------|--------------|
| `ki_query_group` | 读 | 查询 Group 树 + Relations + 词云 | `query-group` |
| `ki_get_module_info` | 读 | 读取本地 KB Markdown 内容 | `get-module-info` |
| `ki_manage_index_list` | 读 | 列出所有 scope | `manage-index --action list-scopes` |
| `ki_manage_index_create` | 写 | 创建 Group 节点 | `manage-index --action create` |
| `ki_sync_relation` | 写 | 写入 Relation + 关键词 | `sync-relation` |

> **零破坏性约束**：MCP 工具集不含 delete/force 操作。Agent 只能创建和查询，无法删除任何数据。

### MCP 客户端配置

在 MCP 客户端配置文件（如 `~/.qoder/shared_client/mcp.json`）中添加：

```json
{
  "mcpServers": {
    "ki": {
      "command": "ki",
      "args": ["mcp"]
    }
  }
}
```

### 工具参数说明

#### `ki_query_group`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 是 | — | 项目隔离标识 |
| `groups` | string | 否 | — | 逗号分隔的 Group 路径（支持模糊匹配） |
| `hot_count` | number | 否 | 5 | 热门展示个数 |
| `depth` | number | 否 | 4 | 索引层级深度（1-10） |
| `mode` | string | 否 | `hot` | 展示分区：hot/warm/cold/emerging/full |

#### `ki_get_module_info`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | string | 是 | 项目隔离标识 |
| `group` | string | 是 | Group 路径（支持模糊匹配） |
| `relation` | string | 是 | Relation 名称 |

#### `ki_sync_relation`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | string | 是 | 项目隔离标识 |
| `group` | string | 是 | Group 路径（支持 / 层级嵌套） |
| `relation` | string | 是 | Relation 名称 |
| `module_info` | string | 是 | 本地 KB Markdown 内容 |
| `keywords` | string[] | 是 | 关键词列表 |

#### `ki_manage_index_create`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | string | 是 | 项目隔离标识 |
| `name` | string | 是 | 新节点名称（不能包含 /） |
| `parent` | string | 否 | 父节点路径（省略则挂在根层） |

#### `ki_manage_index_list`

无参数，返回所有 scope 及顶层 Group。

---

## `config`

配置管理命令，用于生成和管理 ki 配置文件。

### `init` 子命令

生成配置文件模板到 `~/.ki/config.json`。

```bash
ki config init [--dir <path>] [--force]
```

| 参数 | 说明 |
|------|------|
| `--dir <path>` | 目标目录，默认 `$HOME` |
| `--force` | 强制覆盖已有的配置文件 |

**示例：生成配置文件**

```bash
ki config init
```

输出：
```json
{
  "ok": true,
  "action": "config_init",
  "configPath": "/Users/me/.ki/config.json",
  "existed": false,
  "message": "配置文件已生成：/Users/me/.ki/config.json\n请根据实际需要修改 dataDir / backupDir / scopes 字段。"
}
```

**配置文件结构**：

```json
{
  "dataDir": "$HOME/.ki-data",
  "backupDir": "$HOME/.ki-backup",
  "scopes": {
    "my-project": {
      "kbDir": "/data/special-kb/my-project",
      "sourceDir": ".qoder/repowiki/zh/content",
      "rootName": "QoderWiki",
      "wikiSync": {
        "enabled": true,
        "sourceDir": "/path/to/wiki-content"
      }
    }
  }
}
```

**字段说明**：

| 字段 | 层级 | 说明 |
|------|------|------|
| `dataDir` | 顶级 | 全局默认数据存储目录，各 scope 数据默认放在 `dataDir/{scope}/` 下 |
| `backupDir` | 顶级 | 备份快照存储目录 |
| `scopes.<scope>.kbDir` | scope | 覆盖该 scope 的 KB 数据存储路径，优先级高于 `dataDir/{scope}` |
| `scopes.<scope>.sourceDir` | scope | 外部知识库源目录（由 `scan-kb import` 自动记录） |
| `scopes.<scope>.rootName` | scope | 导入根节点名称（由 `scan-kb import` 自动记录） |
| `scopes.<scope>.wikiSync.enabled` | scope | 是否启用 Wiki 写回（默认 `true`） |
| `scopes.<scope>.wikiSync.sourceDir` | scope | Wiki 写回目标目录 |

**配置优先级**：
1. `--config <path>` 命令行参数
2. `$HOME/.ki/config.json`
3. 内置默认值

**路径展开规则**：
- `$HOME` → `process.env.HOME`
- `~` → 同 `$HOME`
- 相对路径 → 相对于配置文件所在目录

---

## `backup`

备份 scope 目录快照。

```bash
ki backup <scope>               # 备份 scope 目录快照
ki backup <scope> --list        # 列出已有备份
```

| 参数 | 说明 |
|------|------|
| `<scope>` | 项目隔离标识（必填） |
| `--list` | 列出已有备份而非执行备份 |

**示例：备份 scope**

```bash
ki backup my-project
```

输出：
```json
{
  "ok": true,
  "action": "backup",
  "scope": "my-project",
  "snapshot": "snapshot.20260616-223000.tar.gz",
  "snapshotPath": "/Users/me/.ki-backup/my-project/snapshots/snapshot.20260616-223000.tar.gz",
  "message": "scope 快照已保存：/Users/me/.ki-backup/my-project/snapshots/snapshot.20260616-223000.tar.gz"
}
```

**示例：列出备份**

```bash
ki backup my-project --list
```

输出：
```json
{
  "ok": true,
  "action": "backup_list",
  "scope": "my-project",
  "snapshots": [
    "snapshot.20260616-223000.tar.gz",
    "snapshot.20260616-210000.tar.gz"
  ],
  "aiResults": [
    "ai-results.20260616-223000.full.json",
    "ai-results.20260616-210000.incremental.json"
  ]
}
```

**备份存储位置**：
- 快照：`{backupDir}/{scope}/snapshots/snapshot.{timestamp}.tar.gz`
- ai-results：`{backupDir}/{scope}/ai-results/ai-results.{timestamp}.{mode}.json`

---

## `restore`

从快照或 ai-results 还原 scope 数据。

```bash
ki restore <scope>                           # 列出可用备份
ki restore <scope> --from-snapshot [--timestamp <ts>] [--yes]
ki restore <scope> --from-results  [--dir <ai-results-dir>]
```

| 参数 | 说明 |
|------|------|
| `<scope>` | 项目隔离标识（必填） |
| `--from-snapshot` | 从 tar.gz 快照覆盖还原（破坏性操作，需 `--yes` 确认） |
| `--from-results` | 按 timestamp 顺序重放 ai-results 备份文件 |
| `--timestamp <ts>` | 指定快照 timestamp（可选，默认使用最新） |
| `--dir <dir>` | 指定 ai-results 目录（可选，默认使用备份目录） |
| `--yes` | 跳过交互确认 |

**示例：列出可用备份**

```bash
ki restore my-project
```

输出：
```json
{
  "ok": true,
  "action": "restore_list",
  "scope": "my-project",
  "available": {
    "snapshots": ["snapshot.20260616-223000.tar.gz"],
    "aiResults": ["ai-results.20260616-223000.full.json"]
  },
  "hint": "使用 --from-snapshot 或 --from-results 选择还原模式"
}
```

**示例：从快照还原**

```bash
ki restore my-project --from-snapshot --yes
```

输出：
```json
{
  "ok": true,
  "action": "restore_snapshot",
  "scope": "my-project",
  "snapshot": "snapshot.20260616-223000.tar.gz",
  "restoredAt": "2026-06-16T22:30:00.000Z"
}
```

**示例：从 ai-results 重放**

```bash
ki restore my-project --from-results
```

输出：
```json
{
  "ok": true,
  "action": "restore_results",
  "scope": "my-project",
  "replayed": [
    { "file": "ai-results.20260616-223000.full.json", "mode": "full", "status": "ok" },
    { "file": "ai-results.20260616-230000.incremental.json", "mode": "incremental", "status": "ok" }
  ],
  "stats": { "total": 2, "success": 2, "failed": 0 }
}
```

**重放要求**：
- 首个文件必须是 `full` 模式的全量备份
- 后续文件按 timestamp 顺序依次重放
- 任一文件重放失败会停止后续重放

**安全机制**：
- 还原前自动创建当前状态快照（安全网）
- 快照还原失败时自动从安全网恢复
- 破坏性操作需 `--yes` 确认

---

## `export`

将 KB scope 中的结构化数据反向导出为 Markdown 文件目录。

```bash
ki export <scope> --output <dir> [--root-name <name>]
```

| 参数 | 说明 |
|------|------|
| `<scope>` | 项目隔离标识（必填） |
| `--output <dir>` | 输出目录（必填） |
| `--root-name <name>` | 指定根节点名称（可选，默认导出所有） |

**示例：导出 scope 为 Markdown**

```bash
ki export my-project --output ./wiki-output
```

输出：
```json
{
  "ok": true,
  "action": "export",
  "scope": "my-project",
  "outputDir": "/path/to/wiki-output",
  "stats": {
    "total": 15,
    "exported": 12,
    "empty": 3
  },
  "skipped": []
}
```

**导出格式**：

每个 Relation 导出为一个 Markdown 文件，包含 YAML frontmatter：

```markdown
---
groupPath: 项目/API
relation: 用户登录接口
keywords: [登录, 认证, token]
exportedAt: 2026-06-16T22:30:00.000Z
---

## 登录流程

用户输入账号密码后进入认证流程，服务端校验成功后返回 token。
```

**目录结构**：
```
wiki-output/
├── 项目/
│   ├── API/
│   │   ├── 用户登录接口.md
│   │   └── 数据查询接口.md
│   └── 前端/
│       └── 状态管理.md
└── ...
```

**特性**：
- 仅使用 scope 本地数据（group-index.json + relations-cache.json + local KB index.json）
- 不依赖 mem CLI
- 自动处理 YAML 特殊字符

---

## `setup`

从 GitHub 下载 Skills / Rules 到目标项目目录。支持多目录批量安装，支持按名称筛选。

```bash
ki setup --skills [-n <names>] [-t <path>... | --file <path>]
ki setup --rules  [-n <names>] [-t <path>... | --file <path>]
```

| 参数 | 说明 |
|------|------|
| `--skills` | 安装 AI Agent Skills（`skills/`） |
| `--rules` | 安装加载引导规则（`rules/`） |
| `-n, --names <names>` | 指定要安装的 skill/rule 名称（逗号分隔，不指定则安装全部） |
| `-t, --target <path...>` | 指定目标目录（可多次使用，与 `--file` 互斥） |
| `--file <path>` | 指定目标目录配置文件（每行一个路径，与 `-t` 互斥） |

> **约束**：`--skills` 和 `--rules` 不能同时使用；`-t` 和 `--file` 不能同时使用。

### 目标目录解析优先级

1. `-t <path>` 命令行参数（最高优先级）
2. `--file <path>` 指定的配置文件
3. `~/.ki-targets` 默认配置文件（如存在）

配置文件格式：每行一个绝对路径，空行和 `#` 开头的注释行忽略。

**示例：单目录安装**

```bash
ki setup --skills -t ~/projects/my-app
```

输出：
```
🚀 ki setup --skills
   目标来源: 命令行参数 (-t × 1)
   目标数量: 1

[1/1] 🧠 安装 Skills → /Users/me/projects/my-app
  [OK] ki-foundation/SKILL.md
  [OK] codekb-skill/SKILL.md
  [OK] memory-skill/SKILL.md

✅ 完成: 3/3 个文件安装成功
```

**示例：按名称安装指定 skill**

```bash
ki setup --skills -n codekb-skill,memory-skill -t ~/projects/my-app
```

输出：
```
🚀 ki setup --skills [codekb-skill, memory-skill]
   目标来源: 命令行参数 (-t × 1)
   目标数量: 1
   名称过滤: codekb-skill, memory-skill

[1/1] 🧠 安装 Skills → /Users/me/projects/my-app
  [OK] codekb-skill/SKILL.md
  [OK] memory-skill/SKILL.md
  跳过: 1 个未匹配的 skill

✅ 完成: 2/2 个文件安装成功
```

**示例：按名称安装指定 rule**

```bash
ki setup --rules -n ai-codekb-memory.md -t ~/projects/my-app
```

**示例：多目录安装**

```bash
ki setup --rules -t ~/projects/app-frontend -t ~/projects/app-backend
```

**示例：使用配置文件**

```bash
cat ~/.ki-targets
# /Users/me/projects/app-frontend
# /Users/me/projects/app-backend
# /Users/me/projects/admin-panel

ki setup --skills
```

**示例：指定配置文件**

```bash
ki setup --skills --file ~/my-targets.txt
```

---

## 常用工作流

### 本地知识沉淀

1. `manage-index` 创建 Group
2. `sync-relation` 写入模块说明
3. `query-group` 检查导航与热点
4. `get-module-info` 验证原文可读性

### AI Agent 通过 MCP 使用

1. 配置 `mcp.json`（见上方 MCP 客户端配置）
2. 重启 AI Agent 客户端
3. Agent 自动调用 `ki_query_group` / `ki_get_module_info` 查询知识
4. Agent 需要沉淀知识时调用 `ki_sync_relation` / `ki_manage_index_create`

### 外部知识库导入（推荐新流程）

1. AI 生成 `ai-results.json`
2. `scan-kb import --scope <s> --results <f>`

### 增量更新

1. `scan-kb diff --scope <s>`
2. AI 生成增量 `ai-results.json`
3. `scan-kb import --scope <s> --mode incremental --results <f>`

---

## 相关文档

- [架构与协作关系](./architecture.md) - 了解 KiSearch 与向量数据库的分层关系
- [scan-kb 子命令详解](./scan-kb.md) - 含 `import`、`diff` 的详细说明和 `ai-results.json` 格式
- [外部导入与 mapping 示例](./import-kb.md) - mapping 配置文件的详细说明
- [异常处理与恢复建议](./error-handling.md) - 常见错误和解决方案
- [典型工作流](./workflows.md) - 完整的使用场景和最佳实践
- [备份与恢复](./backup-restore.md) - 数据备份和恢复策略