# 异常处理与恢复

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

### `ki group` 参数缺失

常见错误：

- `create` 缺少位置参数 `<path>`
- `scopeMode: strict` 下缺少 `--scope`

> 忘记 scope 名称？执行 `ki scope list` 查看全部 scope 及所在层。

### `ki sync-relation` 单条模式参数不完整

单条模式要求 `--relation` 与 `--module-info`；`--group` 可留空（落到与 scope 同名的组）。

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

### relations 元数据不存在（`relations-cache.json` / `.relations/manifest.json`）

影响：`ki sync-relation`、`ki get-module-info`

恢复：先执行任一会触发 `ensureScopeDir` 的命令初始化 scope。

> `ki group list` 对“cache 不存在”是**合法降级**（视为该 scope 尚无 Relation，不报错）；只有下述结构损坏才 fail-loud。

### relations 元数据结构损坏（`CACHE_SHAPE_INVALID`）

影响：`ki group list`（CLI 与 `ki_group_list` MCP 工具，后者表现为 `ok:false` + 同文案 `error`，不抛异常）

典型现象：

```
❌ CACHE_SHAPE_INVALID: relations 元数据结构校验失败：/root/.ki/kb/<scope>/.relations/manifest.json（共 2 个 Group 损坏）
  - 工具库/Redis：hot_relations 缺失或不是数组
  - 部署运维：hot_relations 缺失或不是数组
建议：先执行 ki restore <scope> --from-snapshot 查看快照总览（还原会删除并覆盖该 scope 目录，确认来源快照无误后再按提示加 --yes 执行）；或手动修正下列 Group 的 hot_relations 字段（应为数组，无 Relation 时为 []）
```

原因：`groups[*].hot_relations` 是必需字段（写入方建组时即初始化为 `[]`），缺失或不是数组只可能是文件被外部改坏或迁移中断。这里**故意不做静默降级**：把损坏的 Group 当成“0 分 / 0 条 Relation”会让人误判该模块没有知识，而且据此算出的冷热分区本身就是错的。

条目级损坏同样报此错（报错文案为「relations 元数据条目校验失败」，会列出具体的 Group 与 Relation）：`hot_relations` 元素不是对象、缺 `useCount`、或 `lastUsedTime` 既不是 `null` 也不是毫秒时间戳。这几种数据会让评分变成 `NaN`（Group 排名静默失真）或直接抛 `TypeError`，因此同样按损坏拦截。

与 `CORRUPT_JSON` 分层互补：JSON **语法**解析失败报 `CORRUPT_JSON`；语法正确但**结构**不合法报本错误（口径同 `CONFIG_FIELD_INVALID`：语法正确 ≠ 内容合法）。

恢复：优先 `ki restore <scope> --from-snapshot` **先预览快照总览**（会列出即将删除覆盖的目录与还原来源快照），确认无误后按提示加 `--yes` 重新执行——错误提示里刻意不预置 `--yes`，因为快照还原是「删除 + 覆盖 scope 目录」的不可逆操作，且默认取最新快照（可能早于现有数据）；无备份时按错误清单手动补齐 `hot_relations`（一次最多列 5 个 Group，修完重跑会继续报下一批）。

### `group-index.json` 损坏

影响：`ki group list` 等 Group 命令

恢复：从用户备份恢复，或从模板重新初始化。

### 本地 KB 文件不存在

影响：`ki get-module-info`

恢复：使用 `ki sync-relation` 重新写入 `module-info`。

---

## 三类：导入相关错误


### `sourceDir 不存在或不是目录`

原因：`--source` 路径写错，或传入的是文件而非目录。

恢复：确认路径指向外部 Markdown 知识库根目录。

### 目录无 md 文件

原因：`--source` 目录下没有格式白名单内的 Markdown 文件（默认 `.md`，可用 `scopes.<scope>.import.extensions` 扩展）。

恢复：确认 source 目录包含 `.md` 文件，或调整格式白名单配置。

### `--group` 缺省时的落点

`--group` 可以留空：目录导入按源目录的**顶层子目录名**各建根节点；单文档导入用 **scope 名**。需要固定落点时显式传 `--group <path>`。

### `scope "X" 没有待重试的未完成清单` / `未完成清单为空，无需重试`

原因：`ki import --retry-incomplete` 找不到 `<scope>/.ki-import-incomplete.json`（上次导入全部成功，或从未部分成功过）。

恢复：按常规方式执行一次导入（`ki import --scope X --source <dir>`）；若上次已全部成功，无需重试。若提示里带「跨源覆盖前的备份清单」，说明上一批（另一源目录）的未完成项被保留为 `.ki-import-incomplete.prev.json`——如需重试，先把它改名回主清单文件名。

### `scope "X" 的未完成清单损坏`（`... 无法解析`）

原因：`<scope>/.ki-import-incomplete.json` 内容不是合法 JSON（手工编辑、写入被截断、磁盘问题）。清单是「只重试未完成部分」的唯一凭据，损坏时**不会**被静默当成"没有待办"。

恢复：删除该文件后重新导入（幂等追加）；或直接 `ki import --scope X --source <原目录>` 全量重导。HTTP 端同样以 400 明确拒绝，不会退化成"用前端表单参数重试"。

### `上次导入的源目录已不存在：<dir>`

原因：清单记录的原源目录被移动/删除。

恢复：用 `--source` 显式指定当前源目录后重试：`ki import --scope X --source <new-dir> --retry-incomplete`。

### `重试清单中的 N 个文件在当前源目录均不存在`

原因：清单内文件已全部被删除或改名（`retryFilter.missing` 会列出具体路径）。

恢复：确认 `--source` 指向原目录；若文件确已移除，删除清单即可（`rm <scope>/.ki-import-incomplete.json`）。

### `unknown scope: "<scope>"（scopeMode=strict）` / `scopeMode=strict：必须显式传入 scope 参数`

原因：`scopeMode: strict` 下未传 scope，或 scope 未在 `~/.ki/config.yaml` 的 `scopes` 中注册。

恢复：在 config.yaml 注册（key 即 scope 名），或把 `scopeMode` 改为 `default`：

```yaml
scopeMode: strict
scopes:
  my-project:
    kbDir: /data/kb        # 可选
```

---

## 四类：展示参数问题

### `--mode` 无效

`ki group list` 的 `--mode` 有效值：`hot` / `warm` / `cold` / `emerging` / `full`。
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

- `ki import` 详细流程：[`import.md`](./import.md)
- 典型工作流：[`workflows.md`](./workflows.md)
- 备份与恢复：[`backup-restore.md`](./backup-restore.md)
