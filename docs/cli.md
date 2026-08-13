# CLI 参考

所有脚本都通过 `ki` 命令执行（已通过 `npm link` 创建全局链接）。

**CLI 简化约定（批次 4，REQ-11/12）**：
- **高频参数短别名**：`-s`(--scope)、`-q`(--query)、`-t`(--text)、`-g`(--group)、`-r`(--relation)、`-i`(--input)、`-o`(--output)、`-n`(--name)，覆盖所有常用/必填参数
- **必填文本参数位置化**：`ki search "sas"`、`ki store "内容"` 直接传位置参数；原 `--query`/`--text` option 保留兼容（两种写法均可，位置参数优先）
- **超长内容警告（REQ-10）**：`sync-relation --module-info` 超过 1000 字符时输出警告（建议拆分或改用 `scan-kb import --source`），不自动切分

**配置优先级**：
1. `--config <path>` 命令行参数（按扩展名判定 YAML / JSON 解析器）
2. `$HOME/.ki/config.yaml` → `config.yml` → `config.json`
3. 内置默认值（`dataDir` = `$HOME/.ki-data`）

**首次使用**：运行 `ki config init` 生成 YAML 配置文件模板（`~/.ki/config.yaml`）。配置格式以 YAML 为主，保留对旧版 `config.json` 的读取兼容。

**校验**：运行 `ki doctor` 一键校验配置文件 / 目录 / API 密钥 / 向量维度是否就绪。

**注意**：环境变量 `KI_DATA_DIR` 已不再作为运行时配置来源，仅使用配置文件机制（`ki config init` 会自动探测并迁移）。

---

## `scan-kb`（统一入口）

外部知识库导入的统一入口，支持 `import`、`diff` 两个子命令。
（批次 3：`scan` 子命令与 ai-results 输入契约已删除，改为 `--source` 原文直导 / git diff 增量直连，无 AI 依赖。）

### `import` 子命令（推荐）

统一导入外部知识库，首次全量或增量更新。

**全量直导**（首次导入，无 AI）：

```bash
ki scan-kb import \
  -s <scope> \
  --source <dir> \
  --root-name <name> \
  [--chunk-size <chars>] \
  [--chunk-overlap <chars>] \
  [--no-vector]
```

| 参数 | 必填 | 说明 |
|------|------|------|
| `-s, --scope` | 是 | 项目隔离标识 |
| `--source` | 是 | Markdown 目录绝对路径（仅 `--mode full` 时必填；`--mode incremental` 缺省复用 source 块） |
| `--root-name` | 是（full）/ 否（incremental） | 根 Group 名 |
| `--chunk-size` | 否 | 切分块大小（字符，默认 1000） |
| `--chunk-overlap` | 否 | 相邻 chunk 重叠（字符，默认 150） |
| `--no-vector` | 否 | 非向量化模式：仅写 KB 层（relations-cache + local KB + Group 树），跳过向量写入（不产生 memoryId，无法被 `ki search` 召回，仅 `query-group`/`get-module-info` 可访问） |

**示例：首次全量导入**

```bash
ki scan-kb import -s my-project --source /path/to/wiki --root-name wiki
```

自动切分：大文件按段落边界（`\n\n > \n > 。 > ；`）优先切分，relation 命名为 `文件名-N`（如 `deploy-01`），sourcePath 为 `文件路径#N`（文件级 diff 前缀聚合键）。切分参数持久化到 source 块。

输出：
```json
{
  "ok": true,
  "mode": "full",
  "scope": "my-project",
  "stats": { "total": 15, "vectorized": 15, "errors": 0 },
  "groups": ["wiki", "wiki/api"],
  "source": { "dir": "/path/to/wiki", "rootName": "wiki", "commit": "<40-hex>" }
}
```

**示例：增量直连**（git diff 驱动，无 AI）

```bash
# 修改 source 目录文件后：
ki scan-kb import --scope my-project --source /path/to/wiki --mode incremental
```

输出：
```json
{
  "ok": true,
  "mode": "incremental",
  "scope": "my-project",
  "stats": { "total": 3, "added": 1, "modified": 1, "deleted": 1, "errors": 0 },
  "previousCommit": "<40-hex>",
  "newCommit": "<40-hex>"
}
```

### `diff` 子命令

检测自上次导入以来的变更。

```bash
ki scan-kb diff \
  --scope <scope> \
  [--output <file>]
```

**示例：查看变更**

```bash
ki scan-kb diff --scope my-project
```

输出：
```json
{
  "ok": true,
  "action": "diff",
  "scope": "my-project",
  "baseCommit": "abc123",
  "headCommit": "def456",
  "added": [{ "path": "docs/new-feature.md", "absPath": "/path/to/wiki/docs/new-feature.md" }],
  "modified": [{ "path": "docs/api.md", "memoryId": "<32-hex>" }],
  "deleted": [{ "path": "docs/old-feature.md", "memoryId": "<32-hex>" }],
  "stats": { "added": 1, "modified": 1, "deleted": 1, "total": 3 }
}
```

---

## `manage-index`

管理 Group 树索引节点，以及查询已初始化的 scope 列表。

### 列出所有 scope

```bash
ki manage-index --action list-scopes
```

**示例：**

```bash
ki manage-index --action list-scopes
```

输出：
```json
{
  "ok": true,
  "scopes": [
    { "scope": "my-project", "topGroups": ["API", "设计文档"] },
    { "scope": "qoder-wiki", "topGroups": ["QoderWiki"] }
  ],
  "total": 2
}
```

> `list-scopes` 不需要 `--scope` 参数。

### 创建顶层 Group

```bash
ki manage-index \
  --scope <scope> --action create --name <name>
```

> 不指定 `--parent` 即创建顶层 Group。

**示例：**

```bash
ki manage-index --scope my-project --action create --name "API"
```

输出：
```json
{
  "ok": true,
  "path": "我的项目"
}
```

### 创建子节点

```bash
ki manage-index \
  --scope <scope> --action create --parent <path> --name <name>
```

**示例：**

```bash
ki manage-index --scope my-project --action create --parent "我的项目" --name "API"
```

输出：
```json
{
  "ok": true,
  "path": "我的项目/API"
}
```

### 删除节点

```bash
ki manage-index \
  --scope <scope> --action delete --parent <path> --name <name> [--force]
```

**示例：删除空节点**

```bash
ki manage-index --scope my-project --action delete --parent "我的项目" --name "API"
```

输出：
```json
{
  "ok": true,
  "path": "我的项目/API"
}
```

**示例：强制删除非空节点**

```bash
ki manage-index --scope my-project --action delete --parent "我的项目" --name "API" --force
```

输出：
```json
{
  "ok": true,
  "path": "我的项目/API"
}
```

---

## `scope`

scope 生命周期管理，**同时作用于 KB 目录层与向量语义层**。包含 `list` / `delete` / `clear` 三个子命令。

> **两层一致性**：`delete` / `clear` 为破坏性操作，需向量服务可用且强制 `--yes`；向量服务不可用时拒绝执行，以免两层不一致。

### `list` 子命令

列出所有 scope（KB 目录层 + 向量语义层并集），标注每个 scope 存在于哪层、是否已在配置注册。

```bash
ki scope list
```

输出：
```json
{
  "ok": true,
  "scopeMode": "default",
  "vectorAvailable": true,
  "count": 2,
  "scopes": [
    { "scope": "default", "kb": true, "vector": true, "registered": true },
    { "scope": "my-project", "kb": true, "vector": false, "registered": false }
  ]
}
```

| 字段 | 说明 |
|------|------|
| `kb` | 该 scope 在 KB 目录层存在（`dataDir/{scope}/`） |
| `vector` | 该 scope 在向量语义层存在（zvec collection 的 `scope` 字段） |
| `registered` | 该 scope 已在 `config.scopes` 中注册 |

> 向量服务不可用时降级：`vectorAvailable:false` + `vectorReason`，`scopes` 仅依 KB 目录与配置列出。

### `delete` 子命令

彻底删除 scope：清向量文档 + 删 KB 目录 + 移除 `config.scopes` 条目（尽力而为）。`default` 不可删除。

```bash
ki scope delete <name> --yes
```

**示例：预览（不带 `--yes`，仅回显将删项并拒绝）**

```bash
ki scope delete my-project
```

输出：
```json
{
  "ok": false,
  "error": "破坏性操作需 --yes 确认：将删除向量 15 条 + KB 目录 + 配置条目",
  "requireConfirm": true,
  "willDelete": { "vectorCount": 15, "kbExists": true, "registered": true }
}
```

**示例：确认删除**

```bash
ki scope delete my-project --yes
```

输出：
```json
{
  "ok": true,
  "scope": "my-project",
  "deletedVectors": 15,
  "kbRemoved": true,
  "configRemoved": true
}
```

### `clear` 子命令

清空 scope 内容但**保留 scope 与配置**：清向量文档 + 清 KB 目录内容（保留目录本身）。带 `--tags` 时仅清向量层对应 tag，不动 KB 目录（tag 是向量层概念，KB 层无 tag）。

```bash
ki scope clear <name> [--tags t1,t2] --yes
```

| 参数 | 说明 |
|------|------|
| `<name>` | scope 名称（必填） |
| `--tags <tags>` | 仅清指定标签，逗号分隔多值（省略则清全部并清 KB 目录内容） |
| `--yes` | 确认执行（缺省则仅预览并拒绝） |

**示例：清空整个 scope（保留目录与配置）**

```bash
ki scope clear my-project --yes
```

输出：
```json
{
  "ok": true,
  "scope": "my-project",
  "tags": "all",
  "deletedVectors": 15,
  "kbCleared": true
}
```

**示例：仅清向量层指定 tag**

```bash
ki scope clear my-project --tags ki-search --yes
```

输出（`kbCleared:false`，不动 KB 目录）：
```json
{
  "ok": true,
  "scope": "my-project",
  "tags": ["ki-search"],
  "deletedVectors": 8,
  "kbCleared": false
}
```

---

## `tag`

向量层 tag 发现（**只读**）。tag 是文档上的标量字段，无独立生命周期；本命令用于发现某 scope 下用过哪些 tag，便于后续 `ki search` / `ki doc list --tags` 精确过滤。

> 删除某 tag 下内容请用 `ki doc delete` / `ki scope clear --tags`；tag 本身无单独删除 / 改名语义。

### `list` 子命令

列出指定 scope 下用过的 tag（含文档数，按数量降序）。

```bash
ki tag list [--scope <scope>] [--scan-limit <n>]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--scope <scope>` | 项目隔离标识 | `default` |
| `--scan-limit <n>` | 扫描上限（超出则结果为近似，`truncated:true`） | `10000` |

**示例：**

```bash
ki tag list --scope my-project
```

输出：
```json
{
  "ok": true,
  "scope": "my-project",
  "count": 2,
  "scanned": 23,
  "truncated": false,
  "tags": [
    { "tag": "ki-search", "count": 15 },
    { "tag": "note", "count": 8 }
  ]
}
```

> 引擎无 distinct：一次扫描 + 内存去重计数；`scanned` 为实际扫描条数，超过 `--scan-limit` 时 `truncated:true` 表示结果为“已扫描范围内”的近似值。

---

## 数值参数语义（CLI-11）

| 参数 | 出现命令 | 语义 |
|------|----------|------|
| `--limit <n>` | `search` / `doc list` | **返回条数上限**（结果截断，非扫描上限）；默认 `10` |
| `--hot-count <n>` | `query-group` | 热门分区展示个数；默认 `5` |
| `--scan-limit <n>` | `tag list` | **扫描上限**（引擎扫描条数上限，超出则 `truncated:true` 近似）；默认 `10000` |

> 三者语义不同：`--limit` 截断**返回**条数，`--scan-limit` 限制**扫描**条数，`--hot-count` 控制展示个数。历史命名保留（统一为 `--limit` 语义易混淆，本期仅文档化标注）。

---

## `doc`

向量层文档的查看与删除（管理面）。包含 `list` / `delete` 两个子命令。

### `list` 子命令

列出指定 scope 下文档（**顺序不保证**，引擎无排序 / 时间字段）。

```bash
ki doc list [--scope <scope>] [--limit <n>] [--tags t1,t2] [--full]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--scope <scope>` | 项目隔离标识 | `default` |
| `--limit <n>` | 返回条数上限 | `10` |
| `--tags <tags>` | 过滤标签，逗号分隔多值 | 不传则返回全部 |
| `--full` | 显示完整内容（默认截断预览 200 字） | `false` |

**示例：**

```bash
ki doc list --scope my-project --limit 5
```

输出：
```json
{
  "ok": true,
  "scope": "my-project",
  "tags": ["ki-search"],
  "count": 2,
  "docs": [
    { "docId": "abc123", "scope": "my-project", "tag": "ki-search", "content": "用户登录接口的实现…" },
    { "docId": "def456", "scope": "my-project", "tag": "ki-search", "content": "数据查询接口的实现…" }
  ]
}
```

### `delete` 子命令

按 docid 删除向量层记忆（可多个）。删前自动取回用于预览 / 核对（docid 不透明，防删错）。

> **scope 护栏**：docid = `sha256(text+scope)`，一条 doc 只属于一个 scope。delete **只删归属 `--scope` 指定 scope 的 docid**；传入的 docid 若属于其他 scope，会被列入 `scopeMismatch` 并**跳过不删**（防跨 scope 误删）。

```bash
ki doc delete <docid...> [--scope <scope>] --yes
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `<docid...>` | 一个或多个 docid（必填） | — |
| `--scope <scope>` | 项目隔离标识（护栏：仅删归属该 scope 的 docid，跨 scope 跳过） | `default` |
| `--yes` | 确认执行删除（缺省则仅预览并拒绝） | `false` |

**示例：预览（不带 `--yes`）**

```bash
ki doc delete abc123 zzz999 --scope my-project
```

输出（回显将删项 + 未找到项 + 跨 scope 跳过项）：
```json
{
  "ok": false,
  "error": "破坏性操作需 --yes 确认：将删除 1 条（1 条未找到）",
  "requireConfirm": true,
  "willDelete": [{ "docId": "abc123", "scope": "my-project", "tag": "ki-search", "content": "用户登录接口…" }],
  "notFound": ["zzz999"],
  "scopeMismatch": []
}
```

**示例：确认删除**

```bash
ki doc delete abc123 --scope my-project --yes
```

输出：
```json
{
  "ok": true,
  "scope": "my-project",
  "requested": 1,
  "deleted": 1,
  "errors": []
}
```

> ⚠️ `doc delete` 仅删向量层单条记忆；若该 docid 来自 `scan-kb` / `sync-relation`，KB 层 `relations-cache` 的 `memoryId` 会变悬空引用。删关系请用 `ki delete-relation`。

---

## `search`

语义检索知识库内容（**hybrid 混合检索**：向量语义 + 全文 BM25 两路召回，RRF 融合排序）。

```bash
ki search "<自然语言查询>" [-s <scope>] [--limit <n>] [--threshold <score>] [--tags t1,t2]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `<query>`（位置） | 自然语言查询文本（**必填**；`-q/--query` 等效，位置参数优先） | - |
| `-s, --scope <scope>` | 项目隔离标识 | `default` |
| `--limit <n>` | 返回条数上限 | `10` |
| `--threshold <score>` | 融合得分阈值，过滤低于此值的命中 | `0`（不过滤） |
| `--tags <tags>` | 过滤标签（逗号分隔多值，OR 组合） | 不传则搜索全部 tag（每个 tag 最多返回 `--limit` 条，且 `ki-search` 内容优先） |
| `--original` | 返回 local KB 文件级原文（`original` 字段，未清洗；同一文件多 chunk 命中去重） | 不传（默认仅返回向量匹配数据，不含 `original`，REQ-09） |

> 位置参数与 `-q/--query` 双通道均可（位置参数优先）；两者都缺时明确报错。

**示例：**

```bash
ki search "仪表盘配置" -s monitor
```

输出（`score` 为 RRF 融合分，值域通常为 0.0x 级别，非异常；`content` 为向量层存储文本）：

```json
{
  "ok": true,
  "scope": "monitor",
  "results": [
    {
      "memoryId": "6271ebe0…",
      "content": "本文件面向“钉钉通知渠道”的集成与使用…",
      "score": 0.0327,
      "tag": "ki-search",
      "group": "BKMonitorWiki/告警系统设计/通知渠道管理",
      "relation": "钉钉集成"
    }
  ]
}
```

**定位字段**：`content` 是向量层存储文本（纯化后为 index.json 原始值，不再拼接任何前缀）。每条结果按 `memoryId` 反查 `relations-cache.json`，附加定位字段（命中 KB 条目时存在，否则缺省）：

| 字段 | 含义 |
|------|------|
| `group` | 该记忆所属 Group 路径（定位到模块） |
| `relation` | 文件级 relation 名（`hot_relation.text`，文件名去扩展名；用于定位原文，非原文全文） |
| `original` | local KB 文件级原文（**仅 `--original` 开启时**；`originalRetrieved` 标记获取成功，多 chunk 命中仅首条携带并标 `deduplicated`，失败降级 `originalHint`） |

> 批次 3（REQ-05/09）：`keywords` 与 `isFullText` 字段已从 search 输出与 relations-cache 移除（keywords 机制、isFullText 标记全链路删除）。

反查使用**内存缓存**：首次构建 `Map<memoryId, …>` 后复用，文件 mtime/size 变化或 10 分钟 TTL 过期才重建，`ki search` 连续调用无额外 IO 开销。

> `restore --rebuild-vector` 重建的内容向量与 `scan-kb import` 采用相同的 content 纯化格式（index.json 原始值）。`ki-relation` 向量的 content 仅含关系名，Group 归属经结构化 `group` 字段存储（避免 Group 路径词参与 BM25/语义匹配造成误匹配）；`ki-path` 向量 content 为 Group 路径本身。

**关于相关性**：hybrid 检索 = 向量语义 + 全文（BM25）两路融合。头部结果由向量语义主导（通常高度相关）；当查询含宽泛词（如"配置"、"API"）时，全文路可能召回较多低分边缘结果——这是混合检索"召回广"的设计特性，非数据异常。若需收紧，用 `--threshold` 过滤低分命中：

```bash
ki search --query "仪表盘配置" --scope monitor --threshold 0.03
```

（实测保留 score ≥ 0.03 的高度相关命中、过滤边缘结果；阈值需按数据校准——RRF 融合分与 topk 相关。）

**threshold 建议区间**：`0.02 ~ 0.03`。RRF 融合分（`rankConstant=60`）的理论上限约 **0.033**（向量 + 全文两路都排第 1 时），因此：
- `0.03`：最严格，只留两路强命中的高度相关结果
- `0.02`：宽松，额外保留单路强命中
- **超过 0.033 会过滤掉所有结果**（空返回）

> 结合 `ki tag list --scope <scope>` 发现可用标签，用 `--tags` 精确过滤。

---

## `query-group`

查询 Group 树和 Relation 分区（词云展示已移除，REQ-05）。

```bash
ki query-group --scope <scope> [--groups <g1,g2>] [--mode <mode>] [--hot-count <count>] [--depth <depth>]
```

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--scope` | 项目隔离标识 | 必填 |
| `--groups` | 逗号分隔的 Group 路径 | - |
| `--mode` | 展示分区：`hot` / `warm` / `cold` / `emerging` / `full`（支持逗号分隔） | `hot` |
| `--hot-count` | 热门展示个数 | `5` |
| `--depth` | 索引层级深度 | `4` |

**mode 说明**：
- `hot`：热门索引（高频使用）
- `warm`：常温索引
- `cold`：冷区索引（低频使用）
- `emerging`：新兴热区（近期活跃）
- `full`：完整索引树

**💡 向量语义兜底**：当 `--groups` 指定的 Group 路径在索引树中不存在时，自动通过向量搜索进行模糊匹配。例如输入部分名称 `"部署运维"` 可匹配到 `"部署与运维"`，`"通知渠道"` 可匹配到 `"告警系统设计/通知渠道管理"`。命中后输出带 `💡 近似匹配` 前缀的提示。

**示例：模糊 Group 路径匹配**

```bash
ki query-group --scope monitor --groups "部署运维"
```

输出：
```
💡 近似匹配："部署运维" → "BK-Monitor-Wiki/部署与运维"（score: 0.89）

=== BK-Monitor-Wiki/部署与运维 ===

🔥 热门知识 (Top 5):
├── Kubernetes集群管理 (score: 0) [📥]
└── 容器化部署 (score: 0) [📥]
```

**示例：查看热门索引**

```bash
ki query-group --scope my-project
```

输出：
```
=== 知识索引 [scope: my-project] ===

🔥 热门索引 (Top 5):
├── 项目/API (score: 8.5) [热]
├── 项目/前端/状态管理 (score: 6.2) [热]
├── 项目/后端/数据库 (score: 4.8) [常温]
├── 项目/部署/CI-CD (score: 3.2) [常温]
└── 项目/文档/README (score: 1.5) [冷]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

**示例：查看特定 Group 的 Relations**

```bash
ki query-group --scope my-project --groups "项目/API"
```

输出：
```
=== 项目/API ===

🔥 热门知识 (Top 5):
├── 用户登录接口 (score: 8.5) [热]
├── 数据查询接口 (score: 6.2) [热]
├── 文件上传接口 (score: 4.8) [常温]
├── 权限验证接口 (score: 3.2) [常温]
└── 日志记录接口 (score: 1.5) [冷]
```

**示例：查看多个分区**

```bash
ki query-group --scope my-project --mode hot,warm
```

输出：
```
=== 知识索引 [scope: my-project] ===

🔥 热门索引 (Top 5):
├── 项目/API (score: 8.5) [热]
├── 项目/前端/状态管理 (score: 6.2) [热]
├── 项目/后端/数据库 (score: 4.8) [常温]
├── 项目/部署/CI-CD (score: 3.2) [常温]
└── 项目/文档/README (score: 1.5) [冷]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

**示例：查看完整索引树**

```bash
ki query-group --scope my-project --mode full
```

输出：
```
=== 知识索引 [scope: my-project] ===

📁 完整索引树:
我的项目/ (score: 25.2) [热]
├── API/ (score: 15.5) [热]
│   ├── 用户管理/ (score: 8.5) [热]
│   ├── 数据查询/ (score: 6.2) [热]
│   └── 文件操作/ (score: 4.8) [常温]
├── 前端/ (score: 6.2) [热]
│   ├── 状态管理/ (score: 6.2) [热]
│   └── 组件库/ (score: 3.2) [常温]
└── 部署/ (score: 3.2) [常温]
    ├── CI-CD/ (score: 3.2) [常温]
    └── 监控/ (score: 1.5) [冷]

📊 统计信息:
- 总索引数: 15
- 热区索引: 5 (新兴热: 2, 历史热: 3)
- 常温区索引: 6
- 冷区索引: 4
```

---

## `get-module-info`

按 Group + Relation 读取本地 KB 中的 Markdown 原文。支持 Relation 名称的向量语义兜底：精确名称未命中时自动尝试模糊匹配。

```bash
ki get-module-info \
  --scope <scope> --group <group> --relation <relation>
```

**示例：读取模块原文**

```bash
ki get-module-info --scope my-project --group "项目/API" --relation "用户登录接口"
```

输出：
```markdown
## 登录流程

用户输入账号密码后进入认证流程，服务端校验成功后返回 token。

### 接口参数

- `username`: 用户名（必填）
- `password`: 密码（必填）

### 返回结果

```json
{
  "code": 200,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
}
```
```

---

## `sync-relation`

把 Relation 和模块说明写入本地索引。支持单条模式和批量模式。

### 单条模式

```bash
ki sync-relation \
  -s <scope> -g <group> \
  -r <text> --module-info <markdown>
```

> **超长警告（REQ-10）**：`--module-info` 超过 1000 字符时输出警告，建议拆分多条写入或改用 `scan-kb import --source <dir>` 自动切分；`sync-relation` 不自动切分（保持单条关系语义）。

> **非向量化模式（`--no-vector`）**：仅写 KB 层（relations-cache + local KB + Wiki 写回），**跳过向量写入**——不调用 embedding API、不产生 `memoryId`，写入的关系**无法被 `ki search` 召回**（只能通过 `query-group` / `get-module-info` 访问）。单条与批量模式均支持（**注：批量模式当前本就不做向量写入（历史现状），`--no-vector` 仅作显式声明**）：
> ```bash
> # 单条非向量化
> ki sync-relation -s <scope> -g <group> -r <text> --module-info <md> --no-vector
> # 批量非向量化
> ki sync-relation -s <scope> -i batch.json --no-vector
> ```
> 单条模式返回值 `vectorStored: false` + `vectorReason` 说明；批量模式返回 `vector: false` 标注。
>
> **MCP 工具 `ki_sync_relation` 同样支持**：入参 `vector: boolean`（默认 `true`），传 `false` 即非向量化——CLI 与 MCP 行为一致。

> **自定义标签（`--tags` / MCP `tags`）**：为**文档内容**（`module-info`）额外指定多个业务标签（逗号分隔），叠加在默认 `ki-search` 之上。`ki-search` 始终写入；自定义标签各写一条内容向量（zvec tag 单值字段，多 tag 以「同内容多 doc」实现）。不传则只写 `ki-search`（与旧行为一致）。指定后可按 `ki search --tags <自定义标签>` 定向召回：
> ```bash
> # 内容打 api + auth 两个自定义标签（叠加 ki-search）
> ki sync-relation -s <scope> -g <group> -r <text> --module-info <md> --tags "api,auth"
> ```
> - 内部保留标签（`ki-search` / `ki-relation` / `ki-path`）会被过滤，不可作为自定义标签
> - 返回值透出 `contentTags`（向量化时为 `["ki-search","api","auth"]`；无自定义标签则为 `["ki-search"]`；非向量化（`--no-vector`）为 `[]`）
> - **重复同步**同一 relation 时，若自定义标签变化（如 `api` 改为 `auth`），旧标签的内容向量会被自动清理，避免残留
> - MCP 工具 `ki_sync_relation` 同样支持入参 `tags`（逗号分隔字符串）

**示例：写入单条知识**

```bash
ki sync-relation \
  -s my-project \
  -g "项目/API" \
  -r "用户登录接口" \
  --module-info "## 登录流程\n用户输入账号密码后进入认证流程，服务端校验成功后返回 token。"
```

输出：
```json
{
  "ok": true,
  "scope": "my-project",
  "relation": "用户登录接口",
  "evicted": null,
  "vectorStored": true,
  "wikiSynced": true,
  "wikiFile": "/path/to/wiki-content/API/用户登录接口.md"
}
```

**Wiki 写回**：sync-relation 写入 KB 后，会自动尝试将内容同步写回外部 Wiki 文件（Markdown 格式）。Wiki 目录发现优先级：

1. `group-index.json` 的 `source` 块（由 `scan-kb import` 自动记录）
2. `config.yaml` 中 scope 级 `wikiSync.sourceDir` 兜底配置

如果 `wikiSynced` 为 `false`，输出中会包含 `wikiReason` 说明原因（如未配置 Wiki 目录、relation 含非法路径字符等）。Wiki 写回失败不阻塞主流程，仅记录警告。

### 批量模式

```bash
ki sync-relation \
  -s <scope> -i <jsonFile>
```

**示例：批量写入**

```bash
ki sync-relation -s my-project -i batch-input.json
```

`batch-input.json` 格式：
```json
{
  "items": [
    {
      "group": "项目/API",
      "relation": "用户登录接口",
      "module_info": "## 登录流程\n用户输入账号密码后进入认证流程..."
    },
    {
      "group": "项目/API",
      "relation": "数据查询接口",
      "module_info": "## 查询流程\n支持分页查询和条件筛选..."
    }
  ]
}
```

输出：
```json
{
  "ok": true,
  "results": [
    {
      "relation": "用户登录接口",
      "evicted": null,
      "wikiSynced": true
    },
    {
      "relation": "数据查询接口",
      "evicted": null,
      "wikiSynced": true
    }
  ],
  "total": 2,
  "failed": 0
}
```

### 关键词约束

> （已随批次 3 REQ-05 删除：`sync-relation` 不再接收 `--keywords`，关键词机制全链路移除。）

---

## `mcp`

启动 MCP (Model Context Protocol) Server，向 AI Agent 暴露知识索引能力。支持两种传输：

- **stdio（默认）**：每个客户端各自拉起一个子进程，适合单机单 IDE。
- **HTTP 共享单例（`--http`）**：以单进程 HTTP 服务运行，作为向量库唯一持锁者，多个 IDE（本地/远程）经 URL 共享同一进程，从根本上消除多进程锁冲突。详见 [MCP HTTP 共享单例模式](./mcp-http.md)。

```bash
ki mcp                                  # stdio 模式（默认，启动时经多实例冲突守卫）
ki mcp --http                           # HTTP 模式，默认绑定 127.0.0.1:7423（回环，免鉴权，开箱即用）
ki mcp token generate                   # 一键生成托管 Token（~/.ki/mcp-token，0600），已存在则拒绝覆盖
ki mcp token show                       # 查看当前托管 Token（配置多个 IDE 时免去翻文件）
ki mcp --http --host 0.0.0.0            # 对外监听（远程/跨机共享），自动读取托管 Token
ki mcp --http --web                     # HTTP 模式 + 可视化前端页面（浏览器访问 http://127.0.0.1:7423/）
ki mcp token reset --yes                # 轮换 Token（破坏性，需显式确认）
ki mcp --status                         # 只读查看 HTTP 单例运行状态（跳过预检）
ki mcp stop                             # 一键关闭本机所有 ki mcp 实例（stdio + HTTP）并清理残留 lock
```

stdio 模式无需任何参数，启动后通过 JSON-RPC 协议与 AI Agent 通信。

> **启动守卫（stdio 与 HTTP 通用，均在预检之前执行）**：不允许多个 ki mcp 进程静默共存降级。
> - `ki mcp --http`：探活命中健康实例 → 复用退出（`exit 0`，不做预检）；检测到存活 stdio 实例 → 拒绝启动（`exit 1`，提示冲突 pid）。
> - `ki mcp`（stdio）：检测到健康 HTTP 单例或存活 stdio 实例 → 拒绝启动（`exit 1`），提示迁移 URL 型接入；守卫通过后写入 `~/.ki/mcp-stdio.lock`（pid 存活校验，陈旧锁自动清理）。
> 详见 [MCP HTTP 共享单例模式](./mcp-http.md)。

### HTTP 模式参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--http` | — | 启用 Streamable HTTP 传输（不传则走 stdio） |
| `--host <h>` | `127.0.0.1` | 监听地址。默认回环（`127.0.0.1`/`localhost`/`::1`）免鉴权；对外监听改 `0.0.0.0` 并必须带 Token |
| `--port <n>` | `7423` | 监听端口（1-65535） |
| `--token <t>` | — | Bearer Token（显式传入，优先级最高）。**非回环绑定时必须有 Token**，推荐 `ki mcp token generate` 托管 |
| `--allowed-hosts <a,b>` | — | 开启 DNS rebinding 保护并限定允许的 Host 头（逗号分隔） |
| `--status` | — | 只读诊断：探活 `/healthz` 并读取 `~/.ki/mcp-http.lock`，输出 JSON 状态（含托管 Token 存在性；不启动服务、跳过预检） |
| `--web` | — | HTTP 模式下同时提供可视化前端静态页面（`web/dist`，浏览器访问 `http://<host>:<port>/`）；未找到构建产物时提示但不阻塞 MCP 启动。含 `/api/*` 扩展路由（`/api/health`、`/api/doc/list`、`/api/import/*`），详见 [MCP HTTP 共享单例模式](./mcp-http.md) |

### 关闭实例（`ki mcp stop`）

按 lock 文件 + healthz 探活定位本机所有 ki mcp 服务进程（stdio 与 HTTP），先 SIGTERM 优雅退出、超时 SIGKILL 兜底，最后清理残留 lock，输出 JSON 报告。直接对真正的服务进程发信号，避免手动 kill 顶层壳时留下持锁孤儿进程的多层进程链问题；杀前校验 `/proc/<pid>/cmdline` 防止 pid 复用误杀无辜进程。

> 若被关闭的 stdio 实例由 IDE 以 command 型配置拉起，IDE 可能自动重启它；如需长期使用 HTTP 单例，请先将 IDE 配置迁移为 URL 型接入再 `ki mcp --http`。

### 托管 Token 子命令

| 命令 | 说明 |
|------|------|
| `ki mcp token generate` | 生成密码学强随机 Token（32 字节熵）并托管到 `~/.ki/mcp-token`（0600）；**已存在时拒绝覆盖**（`MCP_TOKEN_EXISTS`）并提示改用 reset |
| `ki mcp token show` | 查看当前托管 Token 明文（含路径与创建时间）；不存在时报错（`MCP_TOKEN_NOT_FOUND`）并提示先 generate，文件存在但为空时报错（`MCP_TOKEN_EMPTY`）并提示用 reset 重建 |
| `ki mcp token reset --yes` | 轮换：生成新 Token 覆盖旧值。无 `--yes` 时拒绝执行（`MCP_TOKEN_RESET_CONFIRM`）；重置后需更新客户端 Authorization 头并重启运行中的服务 |

> **默认回环（secure by default）**：`ki mcp --http` 默认绑定 `127.0.0.1`，无网络暴露面、开箱即用，覆盖本机多 IDE 共享；需远程/跨机共享时才显式 `--host 0.0.0.0` 主动开启（配合托管 Token 或 `--token`）。
>
> **条件鉴权**：绑定回环地址时无网络暴露面，免鉴权；绑定非回环地址（`0.0.0.0`/外网 IP）时必须提供 Token，否则拒绝启动。Token 来源三级优先：`--token` > `KI_MCP_TOKEN` > 托管文件 `~/.ki/mcp-token`，**绝不写入配置文件**；非回环启动时会明示本次生效的 Token 来源。
>
> **幂等单例**：`ki mcp --http` 启动时先探活 `GET /healthz`（在启动预检之前），若目标地址已有健康的 kisearch 实例则复用并退出——即使当前 shell 环境不完整（如缺 embedding Key）也能正常复用，重复运行在任何环境下都安全。运行中写 `~/.ki/mcp-http.lock`（记录 pid/host/port）供排查。
>
> **状态自查**：`ki mcp --status` 组合 `/healthz` 探活与 lock 文件，输出 `{ ok, running, target, healthz, lock, hint }` JSON，用于确认单例是否在跑、由谁持有；详见 [MCP HTTP 共享单例模式](./mcp-http.md)。

### 暴露的 MCP 工具

| 工具名 | 类型 | 功能 | 对应 CLI 命令 |
|--------|------|------|--------------|
| `ki_query_group` | 读 | 查询 Group 树 + Relations 分区 | `query-group` |
| `ki_get_module_info` | 读 | 读取本地 KB Markdown 内容 | `get-module-info` |
| `ki_manage_index_list` | 读 | 列出所有 scope | `manage-index --action list-scopes` |
| `ki_scope_list` | 读 | 列出所有 scope（KB + 向量两层并集） | `scope list` |
| `ki_tag_list` | 读 | 列出指定 scope 下用过的 tag（含文档数） | `tag list` |
| `ki_search` | 读 | 语义检索（hybrid 混合检索，输出 group/relation 定位字段） | `search` |
| `ki_manage_index_create` | 写 | 创建 Group 节点 | `manage-index --action create` |
| `ki_sync_relation` | 写 | 写入 Relation + 模块说明（可非向量化） | `sync-relation` |
| `ki_store` | 写 | 向量化存储单条知识 | `store` |
| `ki_bulk_store` | 写 | 批量向量化存储知识 | `bulk-store` |
| `ki_delete_relation` | 写 | 删除 Relation（cache + KB + wiki + 向量四层清理） | `delete-relation` |

> **安全约束**：MCP 工具集不含 scope / doc 级破坏性操作（无 `scope delete` / `doc delete` 等价物）；仅 `ki_delete_relation` 可按 Group + Relation 删除单条知识条目。

### MCP 客户端配置

**stdio 模式**——在 MCP 客户端配置文件（如 `~/.qoder/shared_client/mcp.json`）中添加：

```json
{
  "mcpServers": {
    "ki": {
      "command": "ki",
      "args": ["mcp"]
    }
  }
}
```

**HTTP 共享单例模式**——先在服务器上手动跑一次 `ki mcp --http`（幂等），各 IDE 用 URL 型条目接入：

```json
{
  "mcpServers": {
    "ki": {
      "url": "http://<host>:7423/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

> 绑定回环地址（仅本机）时免鉴权，可省略 `headers`。完整说明见 [MCP HTTP 共享单例模式](./mcp-http.md)。

### 工具参数说明

#### `ki_query_group`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 是 | — | 项目隔离标识 |
| `groups` | string | 否 | — | 逗号分隔的 Group 路径（支持模糊匹配） |
| `hot_count` | number | 否 | 5 | 热门展示个数 |
| `depth` | number | 否 | 4 | 索引层级深度（1-10） |
| `mode` | string | 否 | `hot` | 展示分区：hot/warm/cold/emerging/full |

#### `ki_get_module_info`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | string | 是 | 项目隔离标识 |
| `group` | string | 是 | Group 路径（支持模糊匹配） |
| `relation` | string | 是 | Relation 名称 |

#### `ki_sync_relation`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | string | 是 | 项目隔离标识 |
| `group` | string | 是 | Group 路径（支持 / 层级嵌套） |
| `relation` | string | 是 | Relation 名称 |
| `module_info` | string | 是 | 本地 KB Markdown 内容 |
| `vector` | boolean | 否 | 是否写入向量层（默认 `true`；`false` = 非向量化，仅写 KB 层，无 memoryId、不可被 `ki_search` 召回） |
| `tags` | string | 否 | 文档内容自定义标签（逗号分隔多个，叠加在默认 `ki-search` 之上，如 `"api,auth"`） |

#### `ki_manage_index_create`

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `scope` | string | 是 | 项目隔离标识 |
| `name` | string | 是 | 新节点名称（不能包含 /） |
| `parent` | string | 否 | 父节点路径（省略则挂在根层） |

#### `ki_manage_index_list`

无参数，返回所有 scope 及顶层 Group。

#### `ki_scope_list`

无参数，返回所有 scope（KB 目录层 + 向量语义层并集），标注每个 scope 存在于哪层、是否已在配置注册。

#### `ki_tag_list`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 否 | `default` | 项目隔离标识（省略则用 default） |

#### `ki_search`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 否 | `default` | 项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内） |
| `query` | string | 是 | — | 自然语言查询文本 |
| `limit` | number | 否 | 10 | 返回条数上限 |
| `threshold` | number | 否 | — | 相似度阈值（0-1，过滤低分命中） |
| `tags` | string | 否 | — | 过滤标签（不传则搜索全部；多个用逗号分隔，OR 组合） |

#### `ki_store`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 否 | `default` | 项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内） |
| `text` | string | 是 | — | 待向量化文本 |
| `tags` | string | 否 | `ki-search` | 逗号分隔 tags |

#### `ki_bulk_store`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 否 | `default` | 项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内） |
| `input` | string | 是 | — | 批量数据 JSON 文件路径（数组：`[{ "text": "...", "tags": "..." }]`） |

#### `ki_delete_relation`

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `scope` | string | 否 | `default` | 项目隔离标识（省略则用 default；strict 模式下必须传且须在白名单内） |
| `group` | string | 是 | — | Group 路径（支持模糊匹配） |
| `relation` | string | 是 | — | Relation 名称（精确匹配） |

---

## `config`

配置管理命令，用于生成和管理 ki 配置文件。

### `init` 子命令

生成配置文件模板到 `~/.ki/config.yaml`（YAML 格式，含注释），并同时创建 `dataDir` / `backupDir` / `vectorDir` 目录。

```bash
ki config init [--dir <path>] [--force]
```

| 参数 | 说明 |
|------|------|
| `--dir <path>` | 目标目录，默认 `$HOME` |
| `--force` | 强制覆盖已有的配置文件 |

**示例：生成配置文件**

```bash
ki config init
```

输出：
```json
{
  "ok": true,
  "action": "config_init",
  "configPath": "/Users/me/.ki/config.yaml",
  "existed": false,
  "createdDirs": ["/Users/me/.ki-data", "/Users/me/.ki-backup", "/Users/me/.ki/vector"],
  "message": "配置文件已生成（YAML）：/Users/me/.ki/config.yaml\n请根据实际需要修改 dataDir / vectorDir / embedding / scopes 字段。\napiKey 为必填：可在 embedding.apiKey 中写明文，或用 ${VAR_NAME} 引用环境变量（不做隐式回退）。"
}
```

**配置文件结构（YAML）**：

```yaml
dataDir: $HOME/.ki-data       # KB 源数据目录
backupDir: $HOME/.ki-backup   # 备份目录
vectorDir: $HOME/.ki/vector   # zvec collection 目录（所有 scope 共享，靠 metadata 隔离）

embedding:                    # Embedding 提供方（OpenAI 兼容，实际提供商由 baseURL 决定）
  provider: siliconflow
  baseURL: https://api.siliconflow.cn/v1
  model: Qwen/Qwen3-Embedding-8B
  dimension: 4096             # 向量维度（必须与建库时一致）
  apiKey: ${SILICONFLOW_API_KEY}  # 必填：明文 sk-xxx 或 ${VAR_NAME} 引用环境变量（变量名自定义）

scopeMode: default            # default: 自动创建 scope；strict: 必须显式注册

scopes:
  # 默认 scope：`ki config init` 自动生成，留空（{}）即数据落在 dataDir/default（ki doctor 会检查此项）
  default: {}
  # 自定义 scope（可选，按需添加）；kbDir 会在其下自动创建 kb/{scope} 子目录
  my-project:
    kbDir: /data/special-kb              # 实际数据在 /data/special-kb/kb/my-project
    sourceDir: .qoder/repowiki/zh/content
    rootName: QoderWiki
    wikiSync:
      enabled: true
      sourceDir: /path/to/wiki-content
```

**字段说明**：

| 字段 | 层级 | 说明 |
|------|------|------|
| `dataDir` | 顶级 | 全局默认数据存储目录，各 scope 数据默认放在 `dataDir/{scope}/` 下 |
| `backupDir` | 顶级 | 备份快照存储目录 |
| `vectorDir` | 顶级 | zvec 向量库目录，所有 scope 共享一个 collection，靠 metadata 隔离（独立，不进备份） |
| `embedding.provider` | 顶级 | Embedding 提供方：`siliconflow` \| `openai-compatible`（均为 OpenAI 兼容客户端，实际提供商由 baseURL 决定） |
| `embedding.baseURL` | 顶级 | API 端点（决定实际对接的提供商；换成其他厂商端点即可对接其他提供商） |
| `embedding.model` | 顶级 | 模型名称 |
| `embedding.dimension` | 顶级 | 向量维度，必须与建库时一致 |
| `embedding.apiKey` | 顶级 | API 密钥（**必填**）：支持明文（`sk-xxx`）或环境变量引用（`${VAR_NAME}`，变量名自定义）；不做任何隐式回退 |
| `scopeMode` | 顶级 | `default`：未传 `--scope` 静默落 default，任意 scope 自动创建；`strict`：必须显式传入已注册 scope |
| `scopes.default` | scope | 默认 scope，由 `ki config init` 自动生成（空对象 `{}`）；未传 `--scope` 时使用，数据落在 `dataDir/default`，`ki doctor` 会检查其是否存在 |
| `scopes.<scope>.kbDir` | scope | 覆盖该 scope 的 KB 基础目录，实际数据存于 `kbDir/kb/{scope}`（自动嵌套子目录，避免污染源目录）；未配置时回退到 `dataDir/{scope}` |
| `scopes.<scope>.sourceDir` | scope | 外部知识库源目录（由 `scan-kb import` 自动记录） |
| `scopes.<scope>.rootName` | scope | 导入根节点名称（由 `scan-kb import` 自动记录） |
| `scopes.<scope>.wikiSync.enabled` | scope | 是否启用 Wiki 写回（默认 `true`） |
| `scopes.<scope>.wikiSync.sourceDir` | scope | Wiki 写回目标目录 |

> `apiKey` 为必填项，写在配置文件 `embedding.apiKey`：可直接写明文密钥，或用 `${VAR_NAME}` 引用任意同名环境变量（推荐，避免明文入库）。系统**不做任何隐式回退**（不会回退到固定的 `SILICONFLOW_API_KEY`），以免在非硅基流动提供商下误用密钥。若仍想用 `SILICONFLOW_API_KEY`，显式写 `apiKey: ${SILICONFLOW_API_KEY}` 即可。
>
> ⚠️ **向后不兼容变更**：旧版仅靠环境变量 `SILICONFLOW_API_KEY`（未写 `embedding.apiKey`）的配置，升级后需在配置文件显式声明 `apiKey`。

**配置优先级**：
1. `--config <path>` 命令行参数（按扩展名判定 YAML / JSON 解析器）
2. `$HOME/.ki/config.yaml` → `config.yml` → `config.json`
3. 内置默认值

**路径展开规则**：
- `$HOME` → `process.env.HOME`
- `~` → 同 `$HOME`
- 相对路径 → 相对于配置文件所在目录

---

## `doctor`

配置诊断命令，一次性只读检查 ki 运行环境是否就绪，输出 ✅/⚠️/❌ 分级报告。

```bash
ki doctor
```

**检查项**（约 10 项）：

| 检查项 | 说明 |
|--------|------|
| 配置文件 | 是否成功加载配置文件（`_configPath`） |
| dataDir / backupDir / vectorDir | 目录是否存在且可写 |
| API 密钥 | 配置 `embedding.apiKey`（明文或 `${VAR_NAME}` 引用）是否已解析出密钥 |
| 连通性 / 密钥有效性 / 向量维度 | 发起一次 embedding 探测（5s 超时、不重试），映射为端点连通性、密钥有效性、维度匹配三项 |
| zvec collection | `vectorDir` 是否已初始化 |
| scopes.default | 是否配置了默认 scope |

**退出码**：存在 ❌ 失败项时退出码为 `1`，否则为 `0`（便于 CI / 脚本判定）。

> `ki mcp` 在启动前会自动执行同样的健康检查，报告写入 stderr（不污染 stdio 协议）；存在 ❌ 失败项将拒绝启动，仅 ⚠️ 警告时继续启动。

---

## `backup`

备份 scope 目录快照。

```bash
ki backup <scope>               # 备份 scope 目录快照
ki backup <scope> --list        # 列出已有备份
```

| 参数 | 说明 |
|------|------|
| `<scope>` | 项目隔离标识（必填） |
| `--list` | 列出已有备份而非执行备份 |

**示例：备份 scope**

```bash
ki backup my-project
```

输出：
```json
{
  "ok": true,
  "action": "backup",
  "scope": "my-project",
  "snapshot": "snapshot.20260616-223000.tar.gz",
  "snapshotPath": "/Users/me/.ki-backup/my-project/snapshots/snapshot.20260616-223000.tar.gz",
  "message": "scope 快照已保存：/Users/me/.ki-backup/my-project/snapshots/snapshot.20260616-223000.tar.gz"
}
```

**示例：列出备份**

```bash
ki backup my-project --list
```

输出：
```json
{
  "ok": true,
  "action": "backup_list",
  "scope": "my-project",
  "snapshots": [
    "snapshot.20260616-223000.tar.gz",
    "snapshot.20260616-210000.tar.gz"
  ]
}
```

**备份存储位置**：
- 快照：`{backupDir}/{scope}/snapshots/snapshot.{timestamp}.tar.gz`

（ai-results 备份已随批次 3 删除，备份仅保留 scope 快照。）

---

## `restore`

从快照还原 scope 数据。

```bash
ki restore <scope> --list                  # 列出可用备份（显式 flag，与 backup --list 一致）
ki restore <scope>                         # 列出可用备份（无参兼容）
ki restore <scope> --from-snapshot [--timestamp <ts>] [--yes]
ki restore <scope> --from-snapshot --rebuild-vector   # 还原后重建向量（内容+关系+路径）
```

| 参数 | 说明 |
|------|------|
| `<scope>` | 项目隔离标识（必填） |
| `--list` | 列出可用备份（显式 flag；无操作参数时默认同样列出） |
| `--from-snapshot` | 从 tar.gz 快照覆盖还原（破坏性操作，需 `--yes` 确认） |
| `--timestamp <ts>` | 指定快照 timestamp（可选，默认使用最新） |
| `--rebuild-vector` | 还原后（或独立）从已还原 KB 重建向量：内容(ki-search) + 关系(ki-relation) + 路径(ki-path) |
| `--backup-dir <dir>` | 指定备份根目录（默认用配置 backupDir） |
| `--yes` | 跳过交互确认 |

（`--from-results` 重放已删除，REQ-04：ai-results 输入契约移除。）

**示例：列出可用备份**

```bash
ki restore my-project
```

输出：
```json
{
  "ok": true,
  "action": "restore_list",
  "scope": "my-project",
  "backupDir": "/Users/me/.ki-backup",
  "locations": {
    "snapshots": "/Users/me/.ki-backup/my-project/snapshots"
  },
  "available": {
    "snapshots": ["snapshot.20260616-223000.tar.gz"]
  },
  "hint": "使用 --from-snapshot 选择还原模式"
}
```

**示例：从快照还原**

```bash
ki restore my-project --from-snapshot --yes
```

输出：
```json
{
  "ok": true,
  "action": "restore_snapshot",
  "scope": "my-project",
  "snapshot": "snapshot.20260616-223000.tar.gz",
  "restoredAt": "2026-06-16T22:30:00.000Z"
}
```

**安全机制**：
- 还原前自动创建当前状态快照（安全网，写默认 backupDir）
- 快照还原失败时自动从安全网恢复
- 破坏性操作需 `--yes` 确认

---

## `export`

将 KB scope 中的结构化数据反向导出为 Markdown 文件目录。

```bash
ki export <scope> --output <dir> [--root-name <name>] [--yes]
```

| 参数 | 说明 |
|------|------|
| `<scope>` | 项目隔离标识（必填） |
| `--output <dir>` | 输出目录（必填） |
| `--root-name <name>` | 指定根节点名称（可选，默认导出所有） |
| `--yes` | 输出目录已存在且非空时确认覆盖（缺省则拒绝并提示加 `--yes`） |

**示例：导出 scope 为 Markdown**

```bash
ki export my-project --output ./wiki-output
```

输出：
```json
{
  "ok": true,
  "action": "export",
  "scope": "my-project",
  "outputDir": "/path/to/wiki-output",
  "stats": {
    "total": 15,
    "exported": 12,
    "empty": 3
  },
  "skipped": []
}
```

**导出格式**：

每个 Relation 导出为一个 Markdown 文件，包含 YAML frontmatter：

```markdown
---
groupPath: 项目/API
relation: 用户登录接口
exportedAt: 2026-06-16T22:30:00.000Z
---

## 登录流程

用户输入账号密码后进入认证流程，服务端校验成功后返回 token。
```

**目录结构**：
```
wiki-output/
├── 项目/
│   ├── API/
│   │   ├── 用户登录接口.md
│   │   └── 数据查询接口.md
│   └── 前端/
│       └── 状态管理.md
└── ...
```

**特性**：
- 仅使用 scope 本地数据（group-index.json + relations-cache.json + local KB index.json）
- 不依赖外部向量服务（使用内置 zvec 引擎）
- 自动处理 YAML 特殊字符

---

## 常用工作流

### 本地知识沉淀

1. `manage-index` 创建 Group
2. `sync-relation` 写入模块说明
3. `query-group` 检查导航与热点
4. `get-module-info` 验证原文可读性

### AI Agent 通过 MCP 使用

1. 配置 `mcp.json`（见上方 MCP 客户端配置）
2. 重启 AI Agent 客户端
3. Agent 自动调用 `ki_query_group` / `ki_get_module_info` 查询知识
4. Agent 需要沉淀知识时调用 `ki_sync_relation` / `ki_manage_index_create`

### 外部知识库导入（原文直导，无 AI）

1. `scan-kb import --scope <s> --source <dir> --root-name <name>`（首次全量）
2. 修改 source 目录文件后：`scan-kb import --scope <s> --source <dir> --mode incremental`（git diff 驱动增量）

---

## 相关文档

- [架构与协作关系](./architecture.md) - 了解 kisearch 与向量数据库的分层关系
- [MCP HTTP 共享单例模式](./mcp-http.md) - 多 IDE 共享同一持锁进程的部署与鉴权
- [scan-kb 子命令详解](./scan-kb.md) - 含 `import`、`diff` 的详细说明（原文直导 / 增量直连）
- [异常处理与恢复建议](./error-handling.md) - 常见错误和解决方案
- [典型工作流](./workflows.md) - 完整的使用场景和最佳实践
- [备份与恢复](./backup-restore.md) - 数据备份和恢复策略