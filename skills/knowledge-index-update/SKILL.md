# 知识库更新 SKILL

> 增量更新外部知识库的变更内容。基于 diff 检测的 3 步增量流程，高效处理新增、修改、删除操作。

## 触发场景

- 外部知识库发生变更（新增、修改、删除文件）
- 用户要求"更新知识库"、"增量导入"、"同步变更"
- 定期同步外部文档站的最新内容

## 前置条件

1. **已完成首次构建**：必须先使用 `knowledge-index-build` 完成首次全量导入
2. **外部知识库目录存在**：确保外部知识库目录可访问
3. **Git 仓库**：增量更新依赖 `git diff` 检测变更，外部知识库需在 Git 仓库中

## 执行流程

### 3 步增量更新流程

```
外部知识库变更
     │
     ▼
[Step 1] scan-kb diff 检测变更
     │
     ▼
[Step 2] AI 生成增量 ai-results.json
     │
     ▼
[Step 3] scan-kb import --mode incremental
     │
     ▼
知识索引更新完成
```

---

### Step 1: 检测变更

**命令**：
```bash
ki scan-kb diff --scope <scope>
```

**参数**：

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识 | 是 |

**输出示例**：
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

**输出字段说明**：

| 字段 | 说明 |
|------|------|
| `baseCommit` | 上次导入时的 git commit |
| `headCommit` | 当前 git commit |
| `sourceDir` | 外部知识库目录 |
| `rootName` | 根节点名称 |
| `added` | 新增文件列表 |
| `modified` | 修改文件列表（含 `memoryId`） |
| `deleted` | 删除文件列表（含 `memoryId`） |
| `stats` | 变更统计 |

**特殊情况**：
- 如果 `group-index.source` 块不存在，返回 `status: 'first_import'` 提示
- `modified`/`deleted` 条目会尝试从 `relations-cache` 关联 `memoryId`

---

### Step 2: AI 生成增量 `ai-results.json`

**任务**：根据 diff 结果，为每个变更文件生成结构化条目。

**处理规则**：

1. **新增文件（added）**：
   - 读取文件内容，生成摘要和关键词
   - 设置 `action: "add"`
   - 不需要 `memoryId`

2. **修改文件（modified）**：
   - 读取最新内容，生成更新后的摘要和关键词
   - 设置 `action: "modify"`
   - 必须包含 `memoryId`（从 diff 结果获取）

3. **删除文件（deleted）**：
   - 设置 `action: "delete"`
   - 必须包含 `memoryId`（从 diff 结果获取）
   - 不需要摘要和关键词

**增量 `ai-results.json` 格式**：

```json
{
  "meta": {
    "sourceDir": ".qoder/repowiki/zh/content",
    "rootName": "QoderWiki"
  },
  "entries": [
    {
      "path": "新增文件.md",
      "groupPath": "QoderWiki/新增分组",
      "relation": "新增文件",
      "summary": "新增文件的摘要...",
      "keywords": ["新增", "文件"],
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

**字段说明**：

| 字段 | 必填 | 说明 |
|------|------|------|
| `meta.sourceDir` | 是 | 外部知识库目录 |
| `meta.rootName` | 是 | 根节点名称 |
| `entries[].path` | 是 | 文件相对路径 |
| `entries[].groupPath` | 否 | Group 路径（缺失时推导） |
| `entries[].relation` | 否 | Relation 文本（缺失时推导） |
| `entries[].summary` | 否 | 3~5 句摘要 |
| `entries[].keywords` | 否 | 自然语言关键词数组 |
| `entries[].action` | 是 | 操作语义：`add` / `modify` / `delete` |
| `entries[].memoryId` | 条件 | `modify`/`delete` 时必填 |

**校验规则**：

1. `action` 字段必填
2. `action='delete'` 必须携带 `memoryId`
3. `action='modify'` 必须携带 `memoryId`

---

### Step 3: 执行增量导入

**命令**：
```bash
ki scan-kb import \
  --scope <scope> \
  --mode incremental \
  --results ai-results-incremental.json
```

**参数**：

| 参数 | 说明 | 必填 |
|------|------|------|
| `--scope` | 项目隔离标识 | 是 |
| `--mode` | 导入模式：`incremental` | 是 |
| `--results` | 增量 `ai-results.json` 文件路径 | 是 |

**增量语义**：

| action | 执行操作 |
|--------|----------|
| `add` | 向量化 + 写入索引 |
| `modify` | `mem delete <oldId>` + 重新向量化（拿新 id）+ 替换索引 |
| `delete` | `mem delete <oldId>` + 移除索引 |

**输出示例**：
```json
{
  "ok": true,
  "action": "import",
  "scope": "my-project",
  "mode": "incremental",
  "stats": {
    "total": 3,
    "added": 1,
    "modified": 1,
    "deleted": 1,
    "errors": 0
  }
}
```

---

## 验证步骤

增量更新完成后，执行以下验证：

1. **变更统计**：检查 `stats` 字段，确认 added/modified/delete 数量符合预期

2. **新增条目验证**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <新增条目的group> \
     --relation <新增条目的relation>
   ```
   预期：输出新增的模块信息

3. **修改条目验证**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <修改条目的group> \
     --relation <修改条目的relation>
   ```
   预期：输出更新后的模块信息

4. **删除条目验证**：
   ```bash
   ki get-module-info \
     --scope <scope> \
     --group <删除条目的group> \
     --relation <删除条目的relation>
   ```
   预期：报错"本地 KB 中未找到"

5. **Relations 缓存验证**：
   ```bash
   ki query-group --scope <scope> --groups <group>
   ```
   预期：确认 Relation 列表已更新

---

## 错误处理

| 错误 | 原因 | 修复 |
|------|------|------|
| `group-index.source 不存在` | 未完成首次构建 | 先执行 `knowledge-index-build` |
| `memoryId 不存在` | diff 未找到对应 memoryId | 检查 `relations-cache.json` 或重新全量导入 |
| `mem delete 失败` | mem 命令问题 | 检查 mem 安装和配置 |
| `action='delete' 缺少 memoryId` | 增量文件格式错误 | 补充 memoryId 字段 |
| `action='modify' 缺少 memoryId` | 增量文件格式错误 | 补充 memoryId 字段 |

---

## 与其他 Skill 的关系

| Skill | 使用场景 | 依赖关系 |
|------|---------|----------|
| knowledge-index-build | 首次构建 | 必须先完成首次构建 |
| knowledge-index-verify | 验证更新结果 | 在更新完成后执行 |
| knowledge-index-query | 查询知识 | 更新完成后使用 |
| knowledge-index-manage | 管理索引结构 | 更新过程中自动维护 Group |

**knowledge-index-update 是增量更新的入口**，首次导入使用 knowledge-index-build。