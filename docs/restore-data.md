# 知识库恢复 SKILL

> 从备份恢复 knowledge-indexer 运行时数据的完整流程。支持从备份恢复、从模板重新初始化两种模式。

## 触发场景

- 用户提到"恢复数据"、"从备份恢复"、"数据损坏"
- `group-index.json` 或 `relations-cache.json` 文件损坏（JSON 解析失败）
- 需要重置某个 scope 的数据
- 用户要求"重新初始化"、"reset"某个 scope

## 备份机制

knowledge-indexer 使用 WAL（Write-Ahead Log）机制，每次写入前自动备份：

```
kb/{scope}/
├── group-index.json
├── relations-cache.json
├── backup/
│   ├── group-index.{timestamp}.bak.json
│   ├── relations-cache.{timestamp}.bak.json
│   └── ...
└── {rootName}/
    └── index.json
```

**备份格式**：`{filename}.{ISO8601}.bak.json`

## 恢复流程

### 场景一：从备份恢复（推荐）

当单个文件损坏时，从 `backup/` 目录恢复。

**Step 1：查看可用备份**

```bash
ls -la kb/{scope}/backup/
```

**Step 2：选择备份文件恢复**

```bash
# 复制最新的备份文件
cp kb/{scope}/backup/group-index.{latest-timestamp}.bak.json kb/{scope}/group-index.json
cp kb/{scope}/backup/relations-cache.{latest-timestamp}.bak.json kb/{scope}/relations-cache.json
```

**Step 3：验证恢复结果**

```bash
# 查询 Group 结构
ki query-group --scope {scope}

# 读取模块信息
ki get-module-info --scope {scope} --group "{rootName}" --relation "{relation}"
```

### 场景二：从模板重新初始化

当整个 scope 数据损坏或需要完全重置时。

**Step 1：备份现有数据（可选）**

```bash
# 如果还有可用数据，先备份
cp -r kb/{scope} kb/{scope}.bak.$(date +%Y%m%d%H%M%S)
```

**Step 2：删除损坏的 scope 目录**

```bash
rm -rf kb/{scope}
```

**Step 3：触发自动初始化**

运行任意会调用 `ensureScopeDir` 的命令，系统会自动从 `_template/` 初始化：

```bash
# 方法一：查询 Group 结构（自动初始化）
ki manage-index --scope {scope} --action create-root --root-name "项目根"

# 方法二：列出 scope 确认初始化成功
ki manage-index --action list-scopes
```

**Step 4：重新导入数据**

如果有原始的 `ai-results.json`，重新执行导入：

```bash
ki scan-kb import --scope {scope} --results ai-results.json
```

## 恢复决策树

```
数据异常
    │
    ├─ JSON 解析失败？
    │   └─ 是 → 从 backup/ 找最近备份恢复
    │
    ├─ 文件不存在？
    │   └─ 是 → 从 _template/ 初始化
    │
    └─ 向量数据丢失？
        └─ 重新执行 scan-kb import
```

## 常见问题

### Q: 备份文件太多，如何选择？

选择时间戳最新的备份对（group-index 和 relations-cache 应该时间戳一致或接近）。

### Q: 恢复后向量数据丢失怎么办？

本地索引恢复后，向量数据库中的记忆需要重新导入。使用原始 `ai-results.json` 执行 `scan-kb import`。

### Q: 如何防止数据丢失？

1. 定期备份 `kb/` 目录
2. 使用 git 管理 `ai-results.json` 文件
3. 重要操作前手动创建快照

## 相关文档

- 异常处理详细说明：`docs/error-handling.md`
- 典型工作流：`docs/workflows.md`
- 备份与恢复：`docs/backup-restore.md`
- 备份机制实现：`scripts/lib/wal.ts`
- 数据存储层：`scripts/lib/store.ts`
