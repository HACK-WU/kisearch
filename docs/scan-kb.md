## `scan-kb` 使用说明

`scan-kb.ts` 是外部 Markdown 知识库导入的统一入口，提供三个子命令：

| 子命令 | 用途 | 状态 |
|--------|------|------|
| `import` | 统一导入（首次全量 / 增量） | **推荐** |
| `diff` | 增量变更检测 | S-05 |
| `scan` | 旧流程：预扫描 | 保留兼容 |
| `vectorize` | 旧流程：向量化状态管理 | **DEPRECATED** |

> **迁移提示**：`vectorize` 子命令已废弃，请使用 `import` 子命令。旧的 7 步流程（`scan` → `scan --results` → `vectorize` → `memory_store` → `vectorize --complete` → `import-kb`）可压缩为 2 步（首次）或 3 步（增量）。

---

## `import` 子命令（推荐）

### 首次全量导入

```bash
# 第 1 步：AI 生成 ai-results.json（见下方格式说明）

# 第 2 步：一条命令完成全部操作
ki scan-kb import \
  --scope my-project \
  --results ai-results.json
```

内部 5 阶段流水线：格式校验 → 批量 `mem store` 向量化 → Group 树创建 → `relations-cache` 写入（含 `memoryId`/`sourcePath`）→ `group-index.source` 块记录（含 git HEAD commit）。

### 增量导入

```bash
# 第 1 步：检测变更
ki scan-kb diff --scope my-project

# 第 2 步：AI 根据 diff 结果生成增量 ai-results.json（每条带 action 字段）

# 第 3 步：执行增量导入
ki scan-kb import \
  --scope my-project \
  --mode incremental \
  --results ai-results-incremental.json
```

增量语义：

- `action='add'`：新增 → 向量化 + 写入索引
- `action='modify'`：更新 → `mem delete <oldId>` + 重新向量化（拿新 id）+ 替换索引
- `action='delete'`：删除 → `mem delete <oldId>` + 移除索引

### `ai-results.json` 格式

```json
{
  "meta": {
    "sourceDir": ".qoder/repowiki/zh/content",
    "rootName": "QoderWiki"
  },
  "entries": [
    {
      "path": "核心概念/Scope 隔离机制.md",
      "groupPath": "QoderWiki/核心概念",
      "relation": "Scope 隔离机制",
      "summary": "Scope 隔离通过服务端 scope 注入、agentId 绕过与 wrapper 层 ACL 检查三段式实现。",
      "keywords": ["Scope", "隔离", "访问控制", "ACL", "agentId"],
      "action": "add"
    },
    {
      "path": "核心概念/Scope 隔离机制.md",
      "groupPath": "QoderWiki/核心概念",
      "relation": "Scope 隔离机制",
      "summary": "更新后的摘要...",
      "keywords": ["Scope", "隔离", "访问控制", "ACL", "agentId", "动态更新"],
      "memoryId": "dbc6f2a0-d62b-47cb-835a-371942fdc08a",
      "action": "modify"
    },
    {
      "path": "已删除的文件.md",
      "groupPath": "QoderWiki/某个分组",
      "relation": "已删除的条目",
      "memoryId": "33b1b2bb-68fd-4290-b5d2-9e8c062089b2",
      "action": "delete"
    }
  ]
}
```

#### 字段说明

| 字段 | 必填 | 说明 |
|------|------|------|
| `meta.sourceDir` | 是 | 外部知识库目录（相对项目根或绝对路径） |
| `meta.rootName` | 是 | 导入根节点名称，需与首次导入一致 |
| `entries[].path` | 是 | 相对 `meta.sourceDir` 的 posix 路径 |
| `entries[].groupPath` | 否 | Group 完整路径（含 rootName 前缀）；缺失时从 `path` 推导 |
| `entries[].relation` | 否 | Relation 文本；缺失时从文件名推导 |
| `entries[].summary` | 否 | 3~5 句摘要 |
| `entries[].keywords` | 否 | 自然语言关键词数组 |
| `entries[].action` | 否 | 操作语义：`add`（默认）/ `modify` / `delete` |
| `entries[].memoryId` | 条件 | `modify`/`delete` 时必填；首次导入由系统填充 |

#### 校验规则

1. `meta.sourceDir` 和 `meta.rootName` 必填
2. `groupPath` 首段必须等于 `rootName`
3. `action='delete'` 必须携带 `memoryId`
4. `action` 缺失时默认 `'add'`

---

## `diff` 子命令

检测自上次导入以来外部知识库的变更：

```bash
ki scan-kb diff --scope my-project
```

输出示例：

```json
{
  "ok": true,
  "action": "diff",
  "scope": "my-project",
  "baseCommit": "b945303...",
  "headCommit": "dbde3a8...",
  "sourceDir": "/path/to/source",
  "rootName": "QoderWiki",
  "added": [
    { "path": "新增文件.md", "absPath": "/path/to/source/新增文件.md" }
  ],
  "modified": [
    { "path": "核心概念/Scope 隔离机制.md", "absPath": "...", "memoryId": "dbc6f2a0-..." }
  ],
  "deleted": [
    { "path": "已删除文件.md", "memoryId": "33b1b2bb-..." }
  ],
  "stats": { "added": 1, "modified": 1, "deleted": 1, "total": 3 }
}
```

- 如果 `group-index.source` 块不存在，返回 `status: 'first_import'` 提示
- `modified`/`deleted` 条目会尝试从 `relations-cache` 关联 `memoryId`
- 依赖 `git diff -z --name-status`（NUL 分隔，正确处理中文文件名）

---

## `scan` 子命令（旧流程，保留兼容）

```bash
# 生成待处理文件列表
ki scan-kb scan \
  --scope <scope> --source <dir> --root-name <name>

# 合并 AI 摘要结果
ki scan-kb scan \
  --scope <scope> --source <dir> --root-name <name> \
  --results <ai-results.json>
```

产物文件同旧版：`scan-pending.json`（临时）→ `scan-index.json`（持久）。

## `vectorize` 子命令（DEPRECATED）

```bash
# 列出待向量化条目
ki scan-kb vectorize --scope <scope>

# 回写向量化完成结果
ki scan-kb vectorize \
  --scope <scope> --complete <vectorize-results.json>
```

> **废弃原因**：`import` 子命令内部已集成批量向量化（通过 `mem store` CLI 子进程 + `Memory ID:` stdout 解析），不再需要手动管理向量化状态。

---

## 与其他文档的关系

- 外部导入总览：[`import-kb.md`](./import-kb.md)
- 错误与恢复建议：[`error-handling.md`](./error-handling.md)
- 完整工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
