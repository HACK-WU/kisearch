## 异常处理与恢复

本文档汇总 `knowledge-index` 当前实现中的**常见报错、警告与恢复方式**。

整体原则：

- **输入非法时快速失败**
- **可恢复场景尽量给出 hint / next_step**
- **能够兜底时优先退化，而不是直接崩溃**

---

## 一类：参数校验错误

### 非法 `scope`

典型现象：

- `--scope ../etc`
- `--scope bad/scope`

结果：直接拒绝，防止路径遍历或跨 scope 污染。

恢复：只使用字母、数字、连字符、下划线，不要包含 `/`、`..`。

### `manage-index.ts` 参数缺失

常见错误：

- `create` 缺少 `--name`
- 非 `list-scopes` 操作缺少 `--scope`

> 忘记 scope 名称？执行 `ki manage-index --action list-scopes` 列出所有已初始化的 scope。

### `sync-relation.ts` 单条模式参数不完整

单条模式要求同时提供 `--group`、`--relation`、`--module-info`。

---

## 二类：数据文件缺失或损坏

### `relations-cache.json` 不存在

影响：`sync-relation.ts`、`get-module-info.ts`

恢复：先执行任一会触发 `ensureScopeDir` 的命令初始化 scope。

### `group-index.json` 损坏

影响：`query-group.ts`、`manage-index.ts`

恢复：从用户备份恢复，或从模板重新初始化。

### 本地 KB 文件不存在

影响：`get-module-info.ts`

恢复：使用 `sync-relation.ts` 重新写入 `module-info`。

---

## 三类：`scan-kb.ts` 相关错误

### `scan-kb diff` 返回 `status: 'first_import'`

原因：`group-index.source` 块不存在，说明尚未首次导入。

恢复：先执行 `scan-kb import` 完成全量导入。

### `scan-kb diff` 返回 0 变更

可能原因：

1. 文件修改后未 `git commit`（diff 依赖 git commit 记录）
2. `source.commit` 已是最新 HEAD

恢复：确认文件变更已 commit，再执行 diff。

### `sourceDir 不存在或不是目录`

原因：`--source` 路径写错，或传入的是文件而非目录。

恢复：确认路径指向外部 Markdown 知识库根目录。

### 增量导入时 rootName 与首次不一致

原因：`--mode incremental` 缺省复用 source 块时，source 块中记录的 `rootName` 与预期不符（增量不允许更改 rootName）。

恢复：保持与首次导入相同的 `--source` 目录（rootName 从 source 块读取）。

### 增量导入 source 目录无 md 文件

原因：`--mode incremental` 传入的 source 目录中没有 Markdown 文件。

恢复：确认 source 目录路径正确，且包含 `.md` 文件。

### 增量导入未首次导入

原因：`--mode incremental` 时 scope 尚无 `group-index.source` 块（从未全量导入）。

恢复：先执行 `scan-kb import --source <dir> --root-name <name>` 完成全量导入。

### 未知 --mode

原因：`--mode` 只接受 `full` / `incremental`。

恢复：检查 `--mode` 参数拼写。

### `Access denied to scope: <scope>`

原因：scope 未在 `~/.ki/config.yaml` 的 `scopes.definitions` 中注册。

恢复：在 config.yaml 中添加 scope 定义：

```yaml
scopes:
  definitions:
    my-project:
      description: "项目描述"
      acl: ["global", "my-project"]
```

---

## 四类：增量导入相关错误

### 增量删除失败

现象：增量 modify/delete 时 `deleteMemory`（内部函数，非独立命令）返回错误。

处理：不阻塞流程，记录为 warning 继续执行。旧记录可能残留在向量数据库中，但不影响新记录的写入。

### `relations-cache 中未找到 sourcePath`

现象：删除条目时 `removeFromCache` 返回 false。

原因：缓存中没有对应 `sourcePath` 的 relation，可能是首次导入时未写入 `sourcePath`。

处理：记录 warning，继续清理 local KB。

---

## 五类：展示参数问题

### `--mode` 无效

`query-group.ts` 的 `--mode` 有效值：`hot` / `warm` / `cold` / `emerging` / `full`。
支持逗号分隔多值，如 `--mode hot,warm`。

无效参数会报错退出并提示有效值列表。

---

## 推荐排障顺序

1. **先看命令参数是否完整**
2. **再看 `--scope` 是否正确且已注册**
3. **再看输入路径是否真的存在**
4. **再看运行时数据文件是否缺失或损坏**
5. **最后再检查工作流顺序是否跳步了**

## 最常见的恢复口诀

```text
参数先补齐
路径先确认
scope 先注册
索引先生成
再做下一步
```

## 相关文档

- `scan-kb` 详细流程：[`scan-kb.md`](./scan-kb.md)
- 典型工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
