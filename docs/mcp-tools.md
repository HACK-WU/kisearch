# MCP 工具参考

`ki mcp` 共暴露 **13 个**工具。所有工具均接受可选 `scope`（缺省 `default`；`strict` 模式下必须在授权白名单内）。

> 工具定义以 [`src/lib/mcp-tools/`](../src/lib/mcp-tools/) 为准。接入方式见 [mcp-http.md](./mcp-http.md)。

## 读

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `ki_search` | 语义检索（hybrid / fulltext） | `query`（必填）、`limit`（默认 10，总条数上限）、`tags`（不传=搜全部）、`mode`、`threshold`、`timeout`、`include_original` |
| `ki_group_list` | Group 树 + Relations，支持 hot/warm/cold/emerging/full 分区与向量兜底 | `groups`（单数别名 `group`）、`subtree`、`mode`（默认 hot）、`hot_count`、`depth`、`auto_fallback` |
| `ki_get_module_info` | 读取本地 KB 原文；同 Group 批量 ≤10 条 | `group`（必填）、`relation` 或 `relations[]`（二选一） |
| `ki_scope_list` | 列出所有 scope 及 KB/向量状态 | — |
| `ki_tag_list` | 列出 scope 下的 tag 及文档数（只读） | `scope` |

## 写

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `ki_sync_relation` | 写入/更新单条 Relation + 本地 KB（自动补建 Group 树） | `group`、`relation`、`module_info`、`vector`（`false`=FTS-only）、`tags` |
| `ki_bulk_sync_relation` | 批量写入（一次 embedding + 一次向量写入，单次 ≤50 条） | `items[]`（`group` / `relation` / `module_info` / `tags`）、`vector` |
| `ki_store` | 只写向量层单条文本 | `text`、`tags` |
| `ki_bulk_store` | 只写向量层批量文本 | `input`（批量 JSON 文件路径） |
| `ki_edit_relation` | 对大 Relation 多轮按行编辑；`finish` 后一次性更新索引 | `action`（edit/view/finish/cancel）、`scope`、`group`、`relation` |

## 组织与删除

| 工具 | 作用 | 说明 |
|---|---|---|
| `ki_group_create` | 创建 Group 节点 | 父级必须已存在；scope 不存在时自动创建并返回 `createdScope` |
| `ki_group_delete_empty` | 删除空 Group 节点 | 仅限无子组、无 relation、无 KB 文件；非空节点请用 CLI `ki group delete <path> --yes` |
| `ki_delete_relation` | 删除单条 Relation（cache + KB + wiki + 向量四层） | 有未结束的 `ki_edit_relation` 草稿时会拒绝，需先 cancel/finish |

## 刻意不暴露的能力

MCP 不提供 scope / doc 级联删除，也不提供 `--force` 类操作：需要级联或强制操作时使用 CLI（见 [cli.md](./cli.md)）。

## 与「长期记忆」的对应关系

| Agent 动作 | 工具 |
|---|---|
| 回忆 | `ki_search`、`ki_group_list`、`ki_get_module_info` |
| 记住 | `ki_sync_relation`、`ki_bulk_sync_relation` |
| 更新 | `ki_sync_relation`、`ki_bulk_sync_relation`、`ki_edit_relation` |
| 组织 | `ki_group_create`、`tags`、`scope` |
| 遗忘 | `ki_delete_relation` |

> `ki_store` / `ki_bulk_store` 只写向量层，不写 relations-cache 与本地 KB，容易产生孤儿向量；持久化记忆请优先使用 `ki_sync_relation` / `ki_bulk_sync_relation`。
