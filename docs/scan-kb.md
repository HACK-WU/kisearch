## `scan-kb` 使用说明

`scan-kb.ts` 是外部 Markdown 知识库导入的统一入口，提供 `import` 子命令：

| 子命令 | 用途 | 状态 |
|--------|------|------|
| `import` | 外部 Wiki 导入（幂等追加） | **推荐** |

> 历史：`--mode incremental`（git diff 驱动）与 `diff` 子命令已废弃移除。增量更新由「幂等追加」语义天然承载——重复执行 `import` 即同步变更（同文件覆盖更新、新文件导入、同名文件跳过），不再依赖 git。

---

## `import` 子命令（推荐）

### 幂等追加导入

```bash
ki scan-kb import \
  --scope my-project \
  --source /path/to/wiki \
  --group wiki \
  [--chunk-size 1000] \
  [--chunk-overlap 150] \
  [--tags t1,t2] \
  [--no-vector]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `--scope` | 否 | 项目隔离标识（default 模式缺省；strict 模式必填） |
| `--source` | 是 | Markdown 目录绝对路径 |
| `--group` | 否 | 目标 Group 落点（不存在时自动新建，含父路径，支持多级如 `wiki/部署运维`）。缺省时：目录导入按顶层子目录名各建根节点，单文档导入用 scope name |
| `--chunk-size` | 否 | 切分块大小（字符，默认 1000） |
| `--chunk-overlap` | 否 | 相邻 chunk 重叠（字符，默认 150） |
| `--tags` | 否 | 文档级自定义标签（逗号分隔）：为导入文件附加标签，每个 tag 各写一条内容向量，可被 `ki search -t <tag>` 召回；`--no-vector` 时仅持久化到 `relation.tags`（后续 `restore --rebuild-vector` 可恢复） |
| `--no-vector` | 否 | 非向量化模式：仅写 KB 层，跳过向量写入（不产生 memoryId，无法被 `ki search` 召回；local KB 文件原文照写） |
| `--no-clean` | 否 | 关闭全部数据清洗（含外部 hooks，等价 config `clean.enabled:false`） |
| `--clean-rules` | 否 | 覆盖内置清洗规则开关：`bom,frontmatter,htmlComment,mermaid,codePath,codeBlock` |

### 幂等语义（重复执行 = 增量）

`import` 以 `(groupPath, relation名)` 为主键做幂等判定：

- **同 sourcePath 重导**（同一文件内容变更后重新导入）：覆盖更新（local KB + 向量重建）
- **同名但 sourcePath 不同**（不同文件同名）：跳过，不重复导入
- **新文件**：正常导入

因此：
- 首次导入用 `--group <name>` 建根
- 后续向同一 group 追加新文档，重复执行同命令即可
- 修改已有文档，重新导入即覆盖更新

### 数据模型（方案 D，REQ-20260807-001）

local KB 存**文件级原文**（一个文件一条，key=文件级 relation，basename 去扩展名）；relation-cache 文件级 relation 挂 **`memoryIds` 多值**（该文件全部 chunk 的向量 docId）；`sourcePath` 存文件路径（无 `#N`）。清洗只作用于**向量化输入**（local KB 保留原文，未被清洗）。

### 清洗

默认开启：内置规则（BOM/frontmatter/mermaid/代码块先剥→路径/空行折叠）→ 外部 hooks（config `scopes.<scope>.clean.hooks`，stdin→stdout 管道，超时 10s，失败跳过）。hook 全部失败 → 文件跳过 + local KB 回滚（P-7）。

### 格式与大小限制（REQ-08）

格式白名单默认 `.md`（config `scopes.<scope>.import.extensions`，非白名单跳过 + 汇总提示）；单文件上限默认 **1MB**（config `scopes.<scope>.import.maxFileSize`，超限跳过）；chunk 超限兜底 500。

### 中断防护（REQ-01/02）

导入捕获 SIGINT/SIGTERM 写中断标记；`SIGKILL`（kill -9）不可捕获由 probe residue 兜底（双路径）。中断后任意向量命令给出恢复引导（`ki restore <scope> --rebuild-vector` 或 `ki restore <scope> --from-snapshot --rebuild-vector`）；重建/成功导入后标记自动清除。并发导入拒绝（`import.lock`，残留自动清理）。

### 切分格式说明

- 固定长度切分（默认 1000 字符），overlap 150
- 段落边界优先：`\n\n` → `\n` → `。` → `；`
- 超大文件上限 1MB（config 可调）；单文件 chunk 上限 500
- 向量化 content 为**清洗后** chunk 文本；local KB 存**文件原文**（未清洗）

---

## 与其他文档的关系

- 错误与恢复建议：[`error-handling.md`](./error-handling.md)
- 完整工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
