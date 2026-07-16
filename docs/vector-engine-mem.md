# 向量引擎实现原理（基于 `mem` 命令）

> 调研来源：代码搜索 ✓（scripts/lib/mem-client.ts、scripts/store.ts、scripts/search.ts、scripts/bulk-store.ts、scripts/sync-relation.ts、scripts/lib/path-search.ts）
> 调研范围：文本向量化、文本向量检索、底层 `mem` CLI 调用封装

## 1. 架构定位：KiSearch 是"交付层"，`mem` 是"向量引擎"

KiSearch 本身**不持有任何向量状态**（不维护向量库、不做 embedding、不实现相似度计算）。它只负责：

- 知识目录的本地结构化组织（Group 树、`relations-cache`、`local KB`）
- 把"文本向量化"和"向量检索"两类能力**完全委托给 `mem` CLI 命令**

```
┌─────────────────────────────────────────────┐
│  KiSearch 脚本（store / search / sync-relation …） │
│  本地索引（Group 树 + relations-cache + local KB）  │
└───────────────┬─────────────────────────────┘
                │  spawnSync / exec 调用
                ▼
┌─────────────────────────────────────────────┐
│  mem CLI（全局安装）                            │
│  mem store / mem search / mem bulk-store      │
│  + mem scope list / mem --version             │
│  底层：LanceDB 向量库 + Embedding API          │
└─────────────────────────────────────────────┘
```

`mem` 命令来自 [memory-lancedb-mcp](https://github.com/HACK-WU/memory-lancedb-mcp)，需全局安装并配置 Embedding API。所有向量状态、scope 隔离、召回算法都在 `mem` 一侧完成。

## 2. 统一封装层：`scripts/lib/mem-client.ts`

所有 `mem` 调用都收口在 `mem-client.ts`，是一层"薄封装"。核心职责：

### 2.1 PATH 注入（解决 `spawnSync` 找不到命令）

`mem` 通常经 nvm / homebrew / npm 全局安装，`spawnSync` 不一定继承这些路径。封装层通过 `buildEnhancedPath()` 显式拼接：

- nvm 各 node 版本的 `bin` 目录（`$NVM_DIR/versions/node/*/bin`）
- 常见系统路径：`/usr/local/bin`、`/opt/homebrew/bin`
- npm 全局 bin（`npm bin -g`）
- **当前 `process.env.PATH` 优先**，追加项作为补充

结果缓存在 `_enhancedEnv`，所有 `execMem` / `execMemAsync` 都注入该环境。

### 2.2 stdout 清洗（从混合日志中抽 JSON）

`mem` 的 stdout 可能夹带 `[mem:info]` 等前导日志行。`extractJson()` 做两阶段解析：

1. 快路径：整段以 `{` / `[` 开头则直接 `JSON.parse`
2. 慢路径：从末尾反向查找最后一个 `\n{` / `\n[`，截取其后的 JSON 文本

### 2.3 同步 / 异步两套执行

| 函数 | 底层 | 适用场景 |
|------|------|----------|
| `execMem`（同步） | `execFileSync` | CLI 主流程、需要立即拿到结果 |
| `execMemAsync` | `execFile` + Promise | fire-and-forget（如 `sync-relation` 后台向量写回） |

两者都**以数组方式传参**（不使用 shell），避免命令注入与 shell 解析问题。非 0 退出但 stdout 有内容时（如 store 已打印 Memory ID），仍返回已有输出而非直接报错。

## 3. 文本向量化（写入）

### 3.1 单条：`memStore` / `ki store`

`scripts/store.ts` 的 `executeStore` → `mem-client.ts` 的 `memStore`：

1. `validateScope(scope)` 校验 scope 合法性（仅字母数字连字符下划线）
2. `ensureMemAvailable()` 检测 `mem` 是否可用
3. 关键词追加：把 `keywords` 拼到 text 末尾，格式 `${text}\n\n[关键词] ${keywords.join(', ')}`，提升语义召回精度
4. 组装 `mem` 参数：`store <text> --scope <scope> [--tags] [--category] [--importance]`
5. 从输出用正则 `/Memory ID:\s*(\S+)/` 提取 Memory ID；失败再尝试 JSON 解析 `id` / `memoryId` 字段
6. 返回 `{ memoryId }`

约束：`text` 超过 50,000 字符（`MAX_TEXT_LENGTH`）直接报错。

### 3.2 批量：`memBulkStore` / `ki bulk_store`

`scripts/bulk-store.ts` 的 `executeBulkStore` → `memBulkStore`：

1. 读取输入 JSON 数组，逐条校验 `text` 字段
2. 构造 bulk 数据（默认 `tags: ki-search`、`category: other`、`importance: 0.5`）
3. **写入临时文件** `/tmp/ki-mem-bulk-<ts>.json`
4. 调用 `mem bulk-store -f <tmpFile> --json --scope <scope>`（`spawnSync`）
5. 解析返回：`details.ok`（成功+id）、`details.errors`、`details.skipped`，按 `index` 排序回填结果
6. `finally` 中删除临时文件

超时按条目数动态放大：`DEFAULT_TIMEOUT_MS + entries.length * 10_000`。

### 3.3 双写模式：`sync-relation` 的异步向量回写

`scripts/sync-relation.ts` 是典型场景——它先把结构化数据写入本地索引（`relations-cache` + `local KB`），**向量写入异步执行**，不阻塞主流程：

1. 同步阶段完成：关键词校验 → Group 补建 → cache 写入（WAL）→ Wiki 写回
2. `setImmediate(() => vectorWriteBack(...))` 把向量写入推到后台宏任务
3. `vectorWriteBack` 内部 `await` 两件事：
   - `storeOnePathAsync({ text: relText, tag: 'ki-relation', scope })`：把 `relation/group/关键词` 拼成路径文本向量化（供语义兜底定位）
   - `memStoreAsync({ text: moduleInfo, keywords, tags: 'ki-search' })`：把 module-info 原文向量化
4. 向量写入完成后，**单独回写 `memoryId` 到 `relations-cache`**，供后续 `delete` 定位原向量

失败策略：向量写入失败只 `console.warn`，不影响已完成的本地索引主流程。`memoryId` 回写失败则用 search 兜底查找，不阻断业务。

## 4. 文本向量检索（查询）

### 4.1 语义检索：`memSearch` / `ki search`

`scripts/search.ts` 的 `executeSearch` → `mem-client.ts` 的 `memSearch`：

1. `validateScope` + `ensureMemAvailable`
2. 组装参数：`search <query> --scope <scope> --json [--limit] [--tags]`
3. 解析 `mem` 输出，兼容两种格式：
   - `{ details: { memories: [...] } }`
   - `{ results: [...] }`
4. 每条结果映射为 `{ memoryId, content, score, tags }`，其中 **score 优先取 `sources.vector.score`（纯向量余弦相似度），fallback 到顶层 hybrid `score`，再兜底 0**
5. 客户端补过滤：
   - `threshold`：低于阈值的丢弃
   - `tags`：JSON 模式下 `mem --tags` 不是硬过滤，封装层用 `content.includes('【标签:${tags}】')` 补做硬过滤

### 4.2 路径语义兜底：`searchPath`

`scripts/lib/path-search.ts` 用于 Group 路径 / Relation 名称的模糊匹配（精确匹配失败时的兜底）：

- 标签固定为 `ki-path` 或 `ki-relation`
- 直接 `execFileSync('mem', ['search', ...])`，超时 15s
- 匹配阈值 `DEFAULT_THRESHOLD = 0.75`，低于则视为未命中
- 从返回文本 `extractPathFromContent` 还原路径：
  - `ki-path`：`|` 之前部分空格转回 `/`
  - `ki-relation`：`|` 之前部分即 relation 名称
- 任何异常（超时 / 进程错误 / API 失败）**静默降级返回 null**

> 取分逻辑与 `mem-client.ts` 保持一致：优先 `sources.vector.score`，fallback `score`。

## 5. 标签体系（三层隔离）

`mem` 侧通过 `--tags` 区分向量用途，避免不同知识类型在语义空间互相干扰：

| 标签 | 用途 | 写入位置 |
|------|------|----------|
| `ki-search` | 通用知识语义搜索（模块原文） | `store` / `bulk-store` / `sync-relation` |
| `ki-path` | Group 路径定位 | `path-vectorize.ts` |
| `ki-relation` | Relation 名称 / 归属查询 | `path-vectorize.ts` / `sync-relation` |

`search` 默认 `tags: ki-search`；指定标签可显著提升检索准确率。

## 6. Scope 与配置

- 所有 `mem` 操作都绑定 `scope`，实现项目物理隔离
- 配置文件：`~/.config/memory-mcp/config.yaml`，结构为 `scopes.definitions.<scope>`，每个 scope 含 `description` 与 `acl`
- 首次使用某 scope 前必须先在配置中注册，否则 `mem store` 报 `Access denied to scope: <scope>`
- `mem-client.ts` 提供 `getMemScopes()`：合并 `mem scope list`（有数据的 scope）与配置文件中定义的 scope（可能尚无数据），进程内缓存
- `ensureMemScope(scope)`：未注册时仅警告（首次 `store` 会隐式创建），不阻塞导入

## 7. 可用性检测与错误处理

- `checkMemAvailable()`：实际执行 `mem --version`，区分 `ENOENT`（未安装）、`ETIMEDOUT` / killed（超时）等
- `ensureMemAvailable()`：进程内缓存版，业务逻辑优先使用
- `store` / `search` / `bulk-store` 在 `mem` 不可用时返回结构化错误（如 `{ ok: false, error, degraded: true }`），不抛未捕获异常
- 安装 `mem` 命令（二选一，二者最终都提供全局 `mem` 命令）：
  - README 推荐：来自 `HACK-WU/memory-lancedb-mcp` 项目的一键脚本 `curl -fsSL .../install-latest.sh | bash`
  - 代码错误提示中的回退方式：`npm install -g @anthropic/mem`
  - 安装后需确保 `~/.config/memory-mcp/config.yaml` 已配置 Embedding API 密钥并注册对应 scope

## 8. 小结

KiSearch 的文本向量化与向量检索本质是**对 `mem` CLI 的结构化封装**：

- **向量化** = `mem store` / `mem bulk-store`（文本 + 关键词 + 标签 → Memory ID）
- **检索** = `mem search --json`（自然语言 query → 带 score 的结果集，优先取向量余弦分）
- **本地索引** = Group 树 + `relations-cache` + `local KB`，与向量库解耦，可独立恢复
- **异步双写** = `sync-relation` 先落本地索引，再用 `setImmediate` + `memStoreAsync` 后台向量化并回写 `memoryId`

设计上严格遵循"ki 不持有向量状态"原则：所有向量能力、召回算法、scope 治理都在 `mem` 一侧，KiSearch 只做编排与交付。
