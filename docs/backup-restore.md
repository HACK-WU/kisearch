## 备份与恢复

本文档说明 `kisearch` 的数据备份和恢复策略。

### CLI 命令（推荐）

ki 提供内置的备份恢复命令：

| 命令 | 说明 | 用法 |
|------|------|------|
| `ki backup` | 备份 scope 目录快照 | `ki backup <scope>` |
| `ki restore` | 从快照还原 | `ki restore <scope> --from-snapshot` |
| `ki restore --rebuild-vector` | 重建向量（还原后或独立；支持 `--group` 过滤 / `--tags` 打标的局部重建） | `ki restore <scope> --rebuild-vector [--group <path>] [--tags <t1,t2>]` |
| `ki config init` | 生成配置文件（含备份目录配置） | `ki config init` |

**快速备份**：
```bash
ki backup scope-name
```

**快速恢复**：
```bash
# 列出可用备份
ki restore scope-name

# 从快照恢复
ki restore scope-name --from-snapshot --yes
```

**备份存储位置**：
- 快照：`{backupDir}/{scope}/snapshots/snapshot.{timestamp}.tar.gz`

> （ai-results 备份已随批次 3 删除：REQ-04 移除 ai-results 输入契约，备份仅保留 scope 快照。）

> 详细用法见 [CLI 参考 → backup](./cli.md#backup)、[CLI 参考 → restore](./cli.md#restore)、[CLI 参考 → config](./cli.md#config)

### 手动备份策略

**备份策略**：二进制完整备份，直接复制 `kb/` 目录。

> 系统使用原子写入（tmp → rename）保证写入安全，不会因写入中断导致文件损坏。不再自动生成 backup 目录，由用户自行备份。

---

## 数据存储结构

### 核心数据目录

```
kisearch/
├── kb/                          # 运行时数据目录
│   ├── {scope}/                 # 每个 scope 独立目录
│   │   ├── group-index.json     # Group 树索引 + source 块
│   │   ├── relations-cache.json # Relation 缓存（评分/淘汰/分区）
│   │   ├── scan-index.json      # 扫描状态账本（已废弃，批次 3 移除 scan 子命令）
│   │   └── {group}/             # 本地 KB 原文
│   │       └── index.json       # 模块说明原文
│   └── _template/               # 模板目录（初始化新 scope 用）
└── ...
```

### 关键文件说明

| 文件 | 作用 | 备份优先级 |
|------|------|-----------|
| `group-index.json` | Group 树结构索引 + source 块 | **必须** |
| `relations-cache.json` | Relation 缓存（含 memoryIds/sourcePath） | **必须** |
| `scan-index.json` | 扫描状态账本 | 建议 |
| `{group}/index.json` | 本地 KB 原文 | 建议 |

---

## 备份策略

### 1. 单 scope 备份（推荐）

使用 `ki backup` 命令备份指定 scope：

```bash
# 备份 scope 目录快照
ki backup scope-name

# 列出已有备份
ki backup scope-name --list
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
rsync -av kisearch/kb/ /path/to/backup/kb/

# 或使用 tar 打包
tar -czf kisearch-backup-$(date +%Y%m%d_%H%M%S).tar.gz kisearch/kb/
```

**备份内容**：
- 所有 scope 的 `group-index.json`
- 所有 scope 的 `relations-cache.json`
- 所有 scope 的 `scan-index.json`
- 所有 scope 的本地 KB 原文

---

## 恢复策略

### 1. 从快照恢复（推荐）

操作流程：**先列出可用快照 → 选择目标快照 → 执行恢复**。

```bash
# 第 1 步：列出可用快照
ki restore scope-name
```

输出示例（多个快照）：
```json
{
  "ok": true,
  "action": "restore_list",
  "scope": "scope-name",
  "available": {
    "snapshots": [
      "snapshot.20260616-223000.tar.gz",
      "snapshot.20260615-100000.tar.gz",
      "snapshot.20260614-080000.tar.gz"
    ]
  }
}
```

```bash
# 第 2 步：从指定快照恢复（timestamp 从文件名提取，格式：YYYYMMDD-HHMMSS）
ki restore scope-name --from-snapshot --timestamp 20260615-100000 --yes

# 或：从最新快照恢复（省略 --timestamp 默认使用最新）
ki restore scope-name --from-snapshot --yes
```

**指定备份根目录**（不传则使用配置中的默认 `backupDir`）：
```bash
# --backup-dir 对「列出/快照还原」均生效，
# 按 <backup-dir>/<scope>/snapshots 布局查找；安全网快照始终写默认 backupDir
ki restore scope-name --backup-dir /path/to/other-backups
ki restore scope-name --from-snapshot --timestamp 20260615-100000 --backup-dir /path/to/other-backups --yes
```

> CLI 为非交互式：`--from-snapshot` 不会弹出交互提示、不会挂起。未加 `--yes` 时，仅展示还原总览（目标目录、现有数据规模、还原来源与文件数）并以 `CONFIRMATION_REQUIRED` 退出、不执行任何还原；确认总览无误后加 `--yes` 重新执行才会真正还原。

**还原后重建向量**（向量文档不随快照还原，如需语义检索需重建）：
```bash
# 还原后全量重建（内容 + 关系 + 路径向量）
ki restore scope-name --from-snapshot --rebuild-vector --yes

# 局部重建：仅重建指定 Group 子树（幂等覆盖，不清空其他向量）
ki restore scope-name --rebuild-vector --group wiki/部署运维

# 重建打标：为重建范围内文档附加标签（与已有标签合并去重，跨命令累积：先 a 再 b = a∪b）
ki restore scope-name --rebuild-vector --tags api,auth
```

> 局部重建（带 `--group`/`--tags`）成功后不清除导入中断标记，仅全量重建清除；参数值缺失/全为保留标签时拒绝执行，避免误降级为全量清空重建。局部重建亦**不可与 `--from-snapshot` 组合**（快照还原后向量层需与快照 KB 全量对齐）。详见 [cli.md](./cli.md) 的 `restore` 章节。

### 2. 从模板重新初始化

当没有备份且数据损坏时，可删除 scope 目录后重新初始化：

```bash
# 删除损坏的 scope 目录
rm -rf kb/{scope}

# 触发自动初始化（运行任一 ki 命令即可）
ki manage-index --action list-scopes
ki sync-relation --scope {scope} --group "初始化" --relation "初始条目" --module-info "初始化"

# 重新导入数据（原文直导，幂等追加）
ki scan-kb import --scope {scope} --source /path/to/wiki --group wiki
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

# 或重新导入知识库（原文直导，幂等追加）
ki scan-kb import --scope {scope} --source /path/to/wiki --group wiki
```

---

## 相关文档

- 架构说明：[`architecture.md`](./architecture.md)
- CLI 参考：[`cli.md`](./cli.md)
- 异常处理：[`error-handling.md`](./error-handling.md)
- 工作流：[`workflows.md`](./workflows.md)
