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
  [--chunk-overlap 150] \
  [--no-vector]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 是 | 项目隔离标识 |
| `--source` | 是 | Markdown 目录绝对路径（`--mode incremental` 可缺省，复用 source 块） |
| `--root-name` | 是（full） | 根 Group 名 |
| `--chunk-size` | 否 | 切分块大小（字符，默认 1000） |
| `--chunk-overlap` | 否 | 相邻 chunk 重叠（字符，默认 150） |
| `--no-vector` | 否 | 非向量化模式：仅写 KB 层，跳过向量写入（不产生 memoryId，无法被 `ki search` 召回；local KB 文件原文照写） |
| `--no-clean` | 否 | 关闭全部数据清洗（含外部 hooks，等价 config `clean.enabled:false`） |
| `--clean-rules` | 否 | 覆盖内置清洗规则开关：`bom,frontmatter,htmlComment,mermaid,codePath,codeBlock` |

**数据模型（方案 D，REQ-20260807-001）**：local KB 存**文件级原文**（一个文件一条，key=文件级 relation，basename 去扩展名）；relation-cache 文件级 relation 挂 **`memoryIds` 多值**（该文件全部 chunk 的向量 docId）；`sourcePath` 存文件路径（无 `#N`）。清洗只作用于**向量化输入**（local KB 保留原文，未被清洗）。

**清洗**（默认开启）：内置规则（BOM/frontmatter/mermaid/代码块先剥→路径/空行折叠）→ 外部 hooks（config `scopes.<scope>.clean.hooks`，stdin→stdout 管道，超时 10s，失败跳过）。hook 全部失败 → 文件跳过 + local KB 回滚（P-7）。

**格式与大小限制**（REQ-08）：格式白名单默认 `.md`（config `scopes.<scope>.import.extensions`，非白名单跳过 + 汇总提示）；单文件上限默认 **1MB**（config `scopes.<scope>.import.maxFileSize`，超限跳过）；chunk 超限兜底 500。

**中断防护**（REQ-01/02）：导入捕获 SIGINT/SIGTERM 写中断标记；`SIGKILL`（kill -9）不可捕获由 probe residue 兜底（双路径）。中断后任意向量命令给出恢复引导（`ki rebuild-vector` 或 `ki restore <scope> --from-snapshot --rebuild-vector`）；重建/成功导入后标记自动清除。并发导入拒绝（`import.lock`，残留自动清理）。

### 增量直连（git diff 驱动，无 AI）

```bash
# 修改 source 目录中文件后，直接执行：
ki scan-kb import \
  --scope my-project \
  --source /path/to/wiki \
  --mode incremental
```

内部 4 阶段：校验 source 块 → deleted 清理（按文件关联全 memoryId）→ add/modify 向量化（文件级 relation + memoryIds 多值，modified **先删旧后更新 memoryIds 字段**，P-2）→ 持久化 + 更新 source.commit。

增量语义：

- **add**（新增文件）：写 local KB 文件原文 → 清洗 → 切分 → 向量化 → 回填 memoryIds
- **modify**（修改文件）：写新向量 → 更新 local KB 原文 → 删旧向量（成功后再更新 memoryIds 字段，P-2 先删后更，删旧失败字段保持旧值）
- **delete**（删除文件）：删除全部 chunk 向量 + 清理 relations-cache / local KB / 路径向量

### 切分格式说明

- 固定长度切分（默认 1000 字符），overlap 150
- 段落边界优先：`\n\n` → `\n` → `。` → `；`
- 超大文件上限 1MB（config 可调）；单文件 chunk 上限 500
- 向量化 content 为**清洗后** chunk 文本；local KB 存**文件原文**（未清洗）

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
- `modified`/`deleted` 条目从 `relations-cache` 关联文件级 `memoryIds`（**方案 D 字段直读**：优先读文件级 relation 的 `memoryIds` 多值；旧数据回退 `#` 前缀聚合）
- 依赖 `git diff -z --name-status`（NUL 分隔，正确处理中文文件名）
- source.dir 内部会做 realpath 规范化（macOS `/var` → `/private/var` 软链场景，避免 pathspec 越界）

---

## 与其他文档的关系

- 错误与恢复建议：[`error-handling.md`](./error-handling.md)
- 完整工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
