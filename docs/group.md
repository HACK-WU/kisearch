# Group 管理

> Group 的创建、删除与查询。命令族固定为 `ki group create|delete|list`，组的位置只由**单一路径**表达。

## 触发场景

- 需要新建一个 Group 节点（或为某个 scope 首次建库）
- 需要删除整个 Group（知识库侧）
- 需要查看某 scope 下的 Group 树、Relation 分区与热度
- 排查索引结构（哪些组存在、组里有什么）

## 数据分层

```
Layer 1  group-index.json          Group 树（层级导航）
Layer 2  .relations/ 分片 + manifest  Relation 元数据（hot/warm/cold/emerging）
Layer 3  kb/<scope>/<group>/       本地 KB（index.json + assets）
```

删除 Group 只作用于以上三层，外加向量与 FTS；**不触碰** `source.dir` / wiki 源目录。

---

## 创建

```bash
ki group create <path> [--scope <s>]
```

| 参数 | 说明 |
|---|---|
| `<path>` | 单个组路径，如 `我的项目/API` |
| `--scope` | 项目隔离标识；default 模式可省略 |

行为：

- 只创建**单个节点**，父路径必须已存在（不自动补祖先，也没有 `--parents`）。
- **不做语义补全**：近似路径直接报错，并返回候选列表。
- scope 不存在时自动创建，返回 `createdScope: true`（`agents-md-init` 依赖此语义）。

```bash
ki group create "我的项目" --scope my-project
ki group create "我的项目/API" --scope my-project
```

```json
{ "ok": true, "scope": "my-project", "path": "我的项目/API", "createdScope": false }
```

---

## 删除

```bash
ki group delete <path> [--yes] [--scope <s>]
```

| 参数 | 说明 |
|---|---|
| `<path>` | 单个组路径；只精确匹配 |
| `--yes` | 确认执行；缺省只输出预览 |
| `--scope` | 项目隔离标识 |

不带 `--yes` 时零写入，只返回预览：

```json
{
  "ok": true,
  "scope": "my-project",
  "path": "我的项目/API",
  "willDelete": {
    "groups": ["我的项目/API", "我的项目/API/用户"],
    "relations": 12,
    "kbFiles": 18,
    "assets": 4,
    "vectors": 27,
    "ftsDocs": 3,
    "emptyParents": []
  },
  "willKeep": { "wikiDir": "/Users/u/docs/我的项目/API" },
  "hint": "确认无误后追加 --yes 执行（执行时另会按 group 清扫 ki-relation / ki-path 辅助向量）"
}
```

> `willDelete.vectors` 是**可确定的部分**：内容向量（来自 relations 的 memoryIds）+ 组路径向量。
> `ki-relation` / `ki-path` 辅助向量的 docId 不含 group，只有执行时按 group 元数据枚举才知道条数，故不计入预览；
> 且跨组共享的 docId 会被保留，**实际删除数可能少于预览值**（结果里的 `sharedKept` / `sharedContentKept` 会说明保留了哪些）。
>
> ⚠️ 历史遗留（仅理论边界）：只有在 **2026-08-05 之前**的版本写入过关系向量的库，才会有"没有 `group` 字段"的辅助向量，
> 按 group 枚举不到它们，需要用 `ki rebuild-vector` 重建清理；此后版本写入的向量都带 `group`。

带 `--yes` 执行后：

- 删除 relations 分片（含子组）、`kb/<scope>/<group>/`（含 assets）、group-index 树节点。
- 删除 dense 向量与 FTS；失败不阻断元数据删除，结果以 `degraded` + `orphanIds` 表示。
- **辅助向量清扫**：按写入时落在向量文档上的 `group` 标量字段枚举 `ki-relation` / `ki-path` 并删除，
  解决「删组后 `ki search` 仍命中关系名」。跨组共享的确定性 docId 会被保护：
  同名 relation 或同内容仍被存活组引用时保留（`sharedKept` / `sharedContentKept` 计数）。
- **不移动、不删除、不进回收站**任何 `source.dir` / wiki 文件；不存在 `.ki/trash`。

```json
{
  "ok": true,
  "deleted": { "groups": ["我的项目/API"], "relations": 12, "kbDir": true, "tree": true },
  "vectors": {
    "deleted": 27, "failed": 0, "skipped": 0, "orphanIds": [],
    "auxFound": 12, "sharedKept": 0, "sharedContentKept": 0
  },
  "fts": { "deleted": 3, "failed": 0, "orphanIds": [] },
  "degraded": false,
  "warnings": []
}
```

---

## 查询

```bash
ki group list [<path>] [--groups <a,b>] [--mode <mode>] [--depth <n>] [--hot-count <n>]
              [--no-auto-fallback] [--json] [--with-counts] [--scope <s>]
```

`list` 承接原查询命令的全部能力：评分分区（hot/warm/cold/emerging/full）、树渲染、未命中语义兜底。

- `--mode` **默认 `full`（渲染完整树）**：只有 `ki group create` 建出来的纯树组在 `hot` 视图里看不到组名，
  与命令语义冲突；要看分区视图时显式传 `--mode hot|warm|cold|emerging`。
- 位置参数 `<path>`：以该组为根的子树视图（原 `--subtree` 已取消）。
- `--groups a,b`：批量展示指定组的 Relations；与位置参数互斥。
- `--json`：结构化输出，默认只含路径与 `children`；`--with-counts` 才附加 `relations` 计数（逐组读分片，慢路径）。

```bash
ki group list --scope my-project
ki group list "我的项目/API" --scope my-project
ki group list --groups "我的项目/API,我的项目/前端" --mode hot,warm --scope my-project
ki group list --json --with-counts --scope my-project
```

---

## 旧命令迁移

旧命令已物理删除，调用时只打印迁移提示（不执行）：

- 创建：`ki group create "<父路径>/<名称>" [--scope <s>]`
- 删除：`ki group delete "<路径>" --yes [--scope <s>]`
- 查询：`ki group list [<路径>] [--scope <s>]`
- scope 枚举：`ki scope list`

## 相关文档

- [命令参考](./cli.md)
- [MCP 工具](./mcp-http.md)
- [错误处理](./error-handling.md)
