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

> `query-group.ts` 对“cache 不存在”是**合法降级**（视为该 scope 尚无 Relation，不报错）；只有下述结构损坏才 fail-loud。

### `relations-cache.json` 结构损坏（`CACHE_SHAPE_INVALID`）

影响：`query-group.ts`（CLI 与 `ki_query_group` MCP 工具，后者表现为 `ok:false` + 同文案 `error`，不抛异常）

典型现象：

```
❌ CACHE_SHAPE_INVALID: relations-cache.json 结构校验失败：/root/.ki/kb/<scope>/relations-cache.json（共 2 个 Group 损坏）
  - 工具库/Redis：hot_relations 缺失或不是数组
  - 部署运维：hot_relations 缺失或不是数组
建议：先执行 ki restore <scope> --from-snapshot 查看快照总览（还原会删除并覆盖该 scope 目录，确认来源快照无误后再按提示加 --yes 执行）；或手动修正下列 Group 的 hot_relations 字段（应为数组，无 Relation 时为 []）
```

原因：`groups[*].hot_relations` 是必需字段（写入方建组时即初始化为 `[]`），缺失或不是数组只可能是文件被外部改坏或迁移中断。这里**故意不做静默降级**：把损坏的 Group 当成“0 分 / 0 条 Relation”会让人误判该模块没有知识，而且据此算出的冷热分区本身就是错的。

与 `CORRUPT_JSON` 分层互补：JSON **语法**解析失败由 `readJson` 报 `CORRUPT_JSON`；语法正确但**结构**不合法报本错误（口径同 `CONFIG_FIELD_INVALID`：语法正确 ≠ 内容合法）。

恢复：优先 `ki restore <scope> --from-snapshot` **先预览快照总览**（会列出即将删除覆盖的目录与还原来源快照），确认无误后按提示加 `--yes` 重新执行——错误提示里刻意不预置 `--yes`，因为快照还原是「删除 + 覆盖 scope 目录」的不可逆操作，且默认取最新快照（可能早于现有数据）；无备份时按错误清单手动补齐 `hot_relations`（一次最多列 5 个 Group，修完重跑会继续报下一批）。

已知边界（本校验**不**覆盖的两类损坏）：

- `partition_config` 缺字段不走本校验（整体回退 `DEFAULT_PARTITION_CONFIG`，无字段级合并）；字段为负数时也不拦（如 `maxHotCount: -1` 会在截断处抛 `RangeError: Invalid array length`，错误信息不含可诊断上下文）。缺字段的后果比报错更隐蔽：`{}` 或缺 `hotPercent`/`warmPercent`/`reservedEmerging` 时 NaN 传播会让**冷热分层退化**（实测：40 个 Group → 热区 40 / 常温 0 / 冷区 0；1 个 Group 内 40 条 Relation → 全进热区），此时「三区之和 = 总数」的守恒形式上仍成立，但分层已失效。
- 只校验 `hot_relations` 是否为**数组**，不校验数组**元素**形态。元素缺 `useCount` 时评分为 `NaN`、渲染出 `undefined (score: NaN)`，且 Group 聚合分被 `|| 0` 吞成 0 分（静默失真）；元素为 `null` 时退化为裸 TypeError。

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
