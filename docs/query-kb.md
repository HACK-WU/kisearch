# 知识库查询

在某个 scope 里找到知识并拿到原文。核心思路：**能按索引定位就别做语义检索**。

## 三条路径

```text
问题
├─ 知道大概在哪个 Group   → 路径 1 索引直查（精确、无噪声）
├─ 只记得自然语言描述     → 路径 2 语义检索（模糊召回）
└─ 都没有                → 路径 3 问用户要线索，命中后写入
```

## 路径 1：索引直查

适合「知道在哪，只要读出来」。

```bash
# 1) 看 Group 树（找目标组）
ki group list --scope <scope> --mode full

# 2) 看某组下有哪些 Relation（可一次看多个组）
ki group list --scope <scope> --groups "项目/API,项目/前端"

# 3) 读原文（批量用逗号分隔，≤10 条且须同 Group）
ki get-module-info --scope <scope> --group "项目/API" --relation "用户登录接口,鉴权中间件"
```

说明：

- `<path>` 位置参数是**子树导航**（这个 Group 下有哪些子 Group），`--groups` 是**展示 Relation**，两者互斥。
- Group / Relation 路径不精确时会自动向量兜底，输出带 `💡 近似匹配` 前缀。
- `--mode` 支持 `hot` / `warm` / `cold` / `emerging` / `full`；`full` 每区最多渲染 50 条，超出会提示未展示数量。

## 路径 2：语义检索

适合「只记得内容，不知道归在哪个组」。

```bash
ki search "用户登录流程" -s <scope>
```

| 参数 | 说明 |
|---|---|
| `--limit <n>` | 整次检索返回的**总条数**上限（默认 10；引擎单次候选上限 1000） |
| `--threshold <score>` | 融合分阈值，建议 `0.02 ~ 0.03`（RRF 理论上限约 0.033，超过会过滤掉全部结果） |
| `--tags t1,t2` | 按标签过滤（OR）；不传 = 搜全部标签，`ki-search` 内容优先 |
| `--mode hybrid\|fulltext` | `hybrid` 默认（语义 + 全文）；`fulltext` 只查全文索引，不调用 embedding |
| `--timeout <seconds>` | 查询 embedding 超时，超时后降级为关键词检索并在结果中标记 `degraded` |
| `--original` | 额外返回 local KB 文件级原文（`original` 字段） |

每条结果都带定位字段：`group` / `relation` / `tag` / `score` / `content`。需要整篇原文时用 `--original`，或拿 `group` + `relation` 走路径 1 的 `ki get-module-info`。

> `score` 是 RRF 融合分（通常 0.0x），不是相似度百分比。降级为关键词检索时分数是 BM25 量级，两套尺度不可直接比较。

## 路径 3：未命中

1. 先确认 scope 正确：`ki scope list` 看该 scope 是否在 KB / 向量层存在。
2. 用 `--mode fulltext` 再试一次——`--no-vector` 导入的文档只写全文索引，语义路可能召回不到。
3. 仍未命中：向用户索取模块名 / 文件路径 / 功能描述，再按 [import.md](./import.md) 或下面的写入方式补进知识库。

```bash
ki group create "项目/API" --scope <scope>
ki sync-relation \
  --scope <scope> \
  --group "项目/API" \
  --relation "用户登录接口" \
  --module-info "## 登录流程\n..."
```

## MCP 对应

| 动作 | 工具 | 关键参数 |
|---|---|---|
| 看 Group / Relation | `ki_group_list` | `groups`、`subtree`、`mode`、`hot_count` |
| 语义检索 | `ki_search` | `query`、`limit`、`tags`、`mode`、`threshold` |
| 读原文 | `ki_get_module_info` | `group` + `relation` 或 `relations[]`（≤10） |
| 写入 | `ki_sync_relation` / `ki_bulk_sync_relation` | `group`、`relation`、`module_info` |

## 常见错误

| 现象 | 原因 | 处理 |
|---|---|---|
| `Group "X" 在 relations-cache 中不存在` | Group 路径错误或未创建 | `ki group list --mode full` 核对路径；必要时 `ki group create` |
| `本地 KB 中未找到 "X" 的内容` | Relation 存在但原文缺失 | 用 `ki sync-relation` 补写 |
| 检索结果为空 | 阈值过高 / 文档是 `--no-vector` 导入 | 降低 `--threshold`；改用 `--mode fulltext` |
| 结果里没有 `original` | 未传 `--original` | 加 `--original`，或按 `group`+`relation` 读原文 |

## 相关文档

- [cli.md](./cli.md) —— `search` / `group list` / `get-module-info` 完整参数
- [mcp-tools.md](./mcp-tools.md) —— MCP 工具参数
- [tags-design.md](./tags-design.md) —— 三层标签的语义
- [error-handling.md](./error-handling.md) —— 完整报错清单
