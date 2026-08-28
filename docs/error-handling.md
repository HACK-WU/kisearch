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

### 配置文件字段不合法（`CONFIG_FIELD_INVALID`）

典型现象（任何 ki 命令，包括 `ki doctor` / `ki mcp` 启动）：

```
❌ 配置加载失败：CONFIG_FIELD_INVALID: 配置文件字段校验失败：/root/.ki/config.yaml（共 2 处）
  - datadir：非预期字段，您是否想输入 "dataDir"？（可用：dataDir | backupDir | ...）
  - embedding.dimension：应为数字，实际为 string（4096）
```

原因：配置除语法外还会校验**字段名 / 类型 / 取值**，避免拼错的字段静默落默认值。只要有一处非法，所有命令直接拒绝运行（不再带着错配继续跑）。

恢复：按错误清单逐条修配置（一次已列出至多 10 条，修完重跑会继续报下一批）；字段含义与合法取值见 [configuration.md · 字段校验](./configuration.md#字段校验)。注意两个写法陷阱：只写键名不赋值（`dataDir:` 后空着）会报错；YAML 合并键 `<<:` 本项目不生效，只能用整值引用 `*anchor`。

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

> 历史：`--mode incremental` 与 `diff` 子命令已废弃移除（git diff 依赖被「幂等追加」语义替代）。

### `sourceDir 不存在或不是目录`

原因：`--source` 路径写错，或传入的是文件而非目录。

恢复：确认路径指向外部 Markdown 知识库根目录。

### 目录无 md 文件

原因：`--source` 目录下没有格式白名单内的 Markdown 文件（默认 `.md`，可用 `scopes.<scope>.import.extensions` 扩展）。

恢复：确认 source 目录包含 `.md` 文件，或调整格式白名单配置。

### `--group` 为空

原因：`--group` 传了空值。

恢复：检查 `--group` 参数。缺省不传时落到 `default` group。

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
