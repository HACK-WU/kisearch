## 备份与恢复

本文档说明 `KiSearch` 的数据备份和恢复策略。

### CLI 命令（推荐）

ki 提供内置的备份恢复命令：

| 命令 | 说明 | 用法 |
|------|------|------|
| `ki backup` | 备份 scope 目录快照 | `ki backup <scope>` |
| `ki restore` | 从快照或 ai-results 还原 | `ki restore <scope> --from-snapshot` |
| `ki config init` | 生成配置文件（含备份目录配置） | `ki config init` |

**快速备份**：
```bash
ki backup my-project
```

**快速恢复**：
```bash
# 列出可用备份
ki restore my-project

# 从快照恢复
ki restore my-project --from-snapshot --yes

# 从 ai-results 重放
ki restore my-project --from-results
```

**备份存储位置**：
- 快照：`{backupDir}/{scope}/snapshots/snapshot.{timestamp}.tar.gz`
- ai-results：`{backupDir}/{scope}/ai-results/ai-results.{timestamp}.{mode}.json`

> 详细用法见 [CLI 参考 → backup](./cli.md#backup)、[CLI 参考 → restore](./cli.md#restore)、[CLI 参考 → config](./cli.md#config)

### 手动备份策略

**备份策略**：二进制完整备份，直接复制 `kb/` 目录。

> 系统使用原子写入（tmp → rename）保证写入安全，不会因写入中断导致文件损坏。不再自动生成 backup 目录，由用户自行备份。

---

## 数据存储结构

### 核心数据目录

```
KiSearch/
├── kb/                          # 运行时数据目录
│   ├── {scope}/                 # 每个 scope 独立目录
│   │   ├── group-index.json     # Group 树索引 + source 块
│   │   ├── relations-cache.json # Relation 缓存（评分/淘汰/词云）
│   │   ├── scan-index.json      # 扫描状态账本（可选）
│   │   └── {group}/             # 本地 KB 原文
│   │       └── index.json       # 模块说明原文
│   └── _template/               # 模板目录（初始化新 scope 用）
└── ...
```

### 关键文件说明

| 文件 | 作用 | 备份优先级 |
|------|------|-----------|
| `group-index.json` | Group 树结构索引 + source 块 | **必须** |
| `relations-cache.json` | Relation 缓存（含 memoryId） | **必须** |
| `scan-index.json` | 扫描状态账本 | 建议 |
| `{group}/index.json` | 本地 KB 原文 | 建议 |

---

## 备份策略

### 1. 单 scope 备份（推荐）

使用 `ki backup` 命令备份指定 scope：

```bash
# 备份 scope 目录快照
ki backup my-project

# 列出已有备份
ki backup my-project --list
```

备份文件存储在 `{backupDir}/{scope}/snapshots/snapshot.{timestamp}.tar.gz`。

### 2. 批量备份所有 scope

```bash
# 列出所有 scope
ki manage-index --action list-scopes

# 逐个备份
for scope in $(ki manage-index --action list-scopes | jq -r '.scopes[].scope'); do
  ki backup "$scope"
done
```

### 3. 手动备份（高级）

**备份整个 `kb/` 目录**，包含所有 scope 的数据：

```bash
# 备份命令
rsync -av KiSearch/kb/ /path/to/backup/kb/

# 或使用 tar 打包
tar -czf KiSearch-backup-$(date +%Y%m%d_%H%M%S).tar.gz KiSearch/kb/
```

**备份内容**：
- 所有 scope 的 `group-index.json`
- 所有 scope 的 `relations-cache.json`
- 所有 scope 的 `scan-index.json`
- 所有 scope 的本地 KB 原文

---

## 恢复策略

### 1. 从快照恢复（推荐）

使用 `ki restore` 命令从备份快照恢复：

```bash
# 列出可用备份（输出中的 backupDir / locations 字段会给出备份文件的物理路径）
ki restore my-project

# 从最新快照恢复（需 --yes 确认）
ki restore my-project --from-snapshot --yes

# 文件名：snapshot.20260616-223000.tar.gz
# timestamp：20260616-223000 
# 从指定时间戳的快照恢复（timestamp 格式：YYYYMMDD-HHMMSS）
ki restore my-project --from-snapshot --timestamp 20260616-223000 --yes

# 指定备份根目录（不传则使用配置中的默认 backupDir）
# --backup-dir 对「列出/快照还原/结果重放」均生效，
# 按 <backup-dir>/<scope>/{snapshots,ai-results} 布局查找
ki restore my-project --backup-dir /path/to/other-backups
ki restore my-project --from-snapshot --backup-dir /path/to/other-backups --yes
```

### 2. 从 ai-results 重放

如果保存了 ai-results 备份文件，可以重放恢复：

```bash
# 先预览总览（不加 --yes 时仅展示总览并退出，不执行）
ki restore my-project --from-results

# 确认总览无误后加 --yes 重新执行，真正重放还原
ki restore my-project --from-results --yes

# 从指定目录重放
ki restore my-project --from-results --dir /path/to/ai-results --yes
```

> CLI 为非交互式：`--from-snapshot` 与 `--from-results` 均不会弹出交互提示、不会挂起。未加 `--yes` 时，仅展示还原总览（目标目录、现有数据规模、还原/重放来源与文件数）并以 `CONFIRMATION_REQUIRED` 退出、不执行任何还原；确认总览无误后加 `--yes` 重新执行才会真正还原。

### 3. 从模板重新初始化

当没有备份且数据损坏时，可删除 scope 目录后重新初始化：

```bash
# 删除损坏的 scope 目录
rm -rf kb/{scope}

# 触发自动初始化（运行任一 ki 命令即可）
ki manage-index --action list-scopes
ki sync-relation --scope {scope} --group "初始化" --relation "初始条目" --module-info "初始化" --keywords "初始化"

# 重新导入数据（如有原始 ai-results.json）
ki scan-kb import --scope {scope} --results ai-results.json
```

---

## 故障恢复场景

### 场景 1：group-index.json 损坏

**症状**：读取 Group 树失败，报 JSON 解析错误

**恢复步骤**：
```bash
# 从快照恢复整个 scope
ki restore {scope} --from-snapshot --yes
```

### 场景 2：relations-cache.json 损坏

**症状**：Relation 查询失败，报 JSON 解析错误

**恢复步骤**：
```bash
# 从快照恢复整个 scope
ki restore {scope} --from-snapshot --yes
```

### 场景 3：整个 scope 数据丢失

**症状**：`kb/{scope}/` 目录不存在或为空

**恢复步骤**：
```bash
# 从快照恢复
ki restore {scope} --from-snapshot --yes

# 或重新初始化 scope
ki manage-index --scope {scope} --action create --name "初始化"
```

### 场景 4：本地 KB 原文丢失

**症状**：`get-module-info` 返回空内容

**恢复步骤**：
```bash
# 从快照恢复
ki restore {scope} --from-snapshot --yes

# 或重新导入知识库
ki scan-kb import --scope {scope} --results ai-results.json
```

---

## 相关文档

- 架构说明：[`architecture.md`](./architecture.md)
- CLI 参考：[`cli.md`](./cli.md)
- 异常处理：[`error-handling.md`](./error-handling.md)
- 工作流：[`workflows.md`](./workflows.md)
