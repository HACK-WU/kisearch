## `scan-kb` 使用说明

`scan-kb.ts` 是外部 Markdown 知识库导入的统一入口，提供两个子命令：

| 子命令 | 用途 | 状态 |
|--------|------|------|
| `import` | 统一导入（首次全量 / 增量直连） | **推荐** |
| `diff` | 增量变更检测 | S-05 |

> 批次 3（REQ-04）：`scan` / `vectorize` 子命令与 ai-results 输入契约已删除。
> 导入改为 `--source` **原文直导**（无 AI 依赖），增量由 **git diff 驱动**（`handleDiff` 复用）。

---

## `import` 子命令（推荐）

### 首次全量导入（原文直导）

```bash
ki scan-kb import \
  --scope my-project \
  --source /path/to/wiki \
  --root-name QoderWiki \
  [--chunk-size 1000] \
  [--chunk-overlap 150]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 是 | 项目隔离标识 |
| `--source` | 是 | Markdown 目录绝对路径（`--mode incremental` 可缺省，复用 source 块） |
| `--root-name` | 是（full） | 根 Group 名 |
| `--chunk-size` | 否 | 切分块大小（字符，默认 1000） |
| `--chunk-overlap` | 否 | 相邻 chunk 重叠（字符，默认 150） |

内部 5 阶段流水线：收集 .md → 切分 → 批量 zvec 向量化 → Group 树创建 → `relations-cache` 写入（含 `memoryId`/`sourcePath`）+ `group-index.source` 块记录（含 git HEAD commit 与切分参数）。

**自动切分**（REQ-01/02/03）：大文件递归字符切分，边界优先 `\n\n > \n > 。 > ； > 硬切`；relation 命名为 `文件名-N`（如 `deploy-01`）；sourcePath 为 `文件路径#N`（文件级 diff 前缀聚合键）。切分参数持久化到 source 块（H-18）。

### 增量直连（git diff 驱动，无 AI）

```bash
# 修改 source 目录中文件后，直接执行：
ki scan-kb import \
  --scope my-project \
  --source /path/to/wiki \
  --mode incremental
```

内部 4 阶段：校验 source 块 → deleted 清理（按文件关联全 chunk memoryId）→ add/modify 向量化（modified **先写新全 chunk 成功后再删旧**）→ 持久化 + 更新 source.commit。

增量语义：

- **add**（新增文件）：读原文 → 切分 → 向量化 + 写入索引
- **modify**（修改文件）：先写新全 chunk（成功后再删旧全 chunk，避免失败丢数据）→ 替换索引
- **delete**（删除文件）：删除全部 chunk 向量 + 清理 relations-cache / local KB / 路径向量

### 切分格式说明

- 固定长度切分（默认 1000 字符），overlap 150
- 段落边界优先：`\n\n` → `\n` → `。` → `；`
- 超大文件上限 2MB；单文件 chunk 上限 500
- content 为 index.json 原始文本，不拼接任何前缀（REQ-05：`[摘要]/[关键词]/[路径]` 前缀机制已删除）

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
    { "path": "核心概念/Scope 隔离机制.md", "memoryId": "dbc6f2a0-...", "memoryIds": ["...", "..."] }
  ],
  "deleted": [
    { "path": "已删除文件.md", "memoryId": "33b1b2bb-...", "memoryIds": ["...", "..."] }
  ],
  "stats": { "added": 1, "modified": 1, "deleted": 1, "total": 3 }
}
```

- 如果 `group-index.source` 块不存在，返回 `status: 'first_import'` 提示
- `modified`/`deleted` 条目从 `relations-cache` 关联文件级 `memoryIds`（按 sourcePath `#` 前缀聚合，H-17/D-2 方案②）
- 依赖 `git diff -z --name-status`（NUL 分隔，正确处理中文文件名）
- source.dir 内部会做 realpath 规范化（macOS `/var` → `/private/var` 软链场景，避免 pathspec 越界）

---

## 与其他文档的关系

- 错误与恢复建议：[`error-handling.md`](./error-handling.md)
- 完整工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
