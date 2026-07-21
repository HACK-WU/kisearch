---
id: REQ-20260717-003
feature: KiSearch 重构：向量配置独立化 + 引擎适配 + 多标签分区 + scope 运行时化
status: 已确认
created: 2026-07-21
updated: 2026-07-21
version: 1
tags: [refactor, config, engine-adapter, multi-tag, scope, cli-server]
depends_on: [REQ-20260717-001, REQ-20260717-002]
author: AI
document_type: requirement-mining
---

# 需求挖掘报告：KiSearch 重构部分

> 本报告是 `requirement.md`（REQ-20260717-001）的上层重构需求挖掘，聚焦用户指定的三个重构部分 + 补充 scope 需求。基座模块（REQ-20260717-002 / `zvec-base-module.md`）已实现完成（14/14 冒烟通过 + e2e 验收通过），本报告在其之上定义上层接线需求。

## 1. 需求本质

表层是「换引擎 + 多标签 + 独立配置」，本质是把 ki 从**「无状态薄封装 + 外部 `mem` 进程」**改造为**「自持有向量状态的常驻服务」**。三个重构点是同一件事的三个断面：

| 断面 | 现状（依赖 mem） | 目标（自持有 zvec） |
|---|---|---|
| 配置 | 向量配置寄生在 `~/.config/memory-mcp/config.yaml`（embedding/scope/db 都归 mem） | ki 自己拥有向量配置（**新增**） |
| 引擎 | `mem-client.ts` spawnSync `mem` CLI，正则洗 stdout | 进程内 `ZvecEngine`（worker actor，异步）；CLI 走常驻 server 优先 + per-call 兜底 |
| 检索 | 单标签 `ki-search`，扁平结果 | 多标签默认三分区，按 tag 分组输出 |
| scope | config.json 预声明，未配置不可用 | 向量 scope 自动创建（metadata）；KB 目录映射保留配置 + 未配置时继承 default |

## 2. 决策记录（用户拍板）

| # | 决策点 | 选择 | 理由 |
|---|---|---|---|
| Q0 | CLI 执行模型 | **C：server 优先 + per-call 兜底** | 最完整；正常用 <5ms，server 没起也不报错（~1s） |
| Q1 | 向量 DB 路径 | **独立 vectorDir，不进备份** | 与当前 mem 行为一致；向量靠 restore 重放 ai-results 派生 |
| Q2 | 检索输出结构 | **统一按 tag 分组（partitions 结构）** | 传不传 --tags 都按 tag 分组；MCP JSON 消费方需适配（用户接受，自有系统可同步改） |
| Q3 | 存量迁移 | **靠恢复机制，从现有备份重建** | 不做 `ki reindex`；用户 restore-from-results 时自然重向量化到 zvec |
| Q4 | scope 配置 | **保留 scopes + 向量 scope 自动创建 + KB 配置继承** | 向量 scope 无需预声明（zvec metadata）；未配置 scope 的 KB 目录映射继承 default scope 配置 |
| Q5 | MCP scope 参数 | **启动不传 scope，可访问任意 scope** | 对齐基座模块「单集合 + metadata 过滤」模型 |
| Q6 | 默认 scope | **内置 `default`，不传时用它** | `--scope` 缺省值从 config 读取改为硬编码 `"default"` |

### 关于 Q2 破坏性变更的确认

用户原始需求说「对用户无感」，同时选择了 results 统一按 tag 分组（破坏性变更）。确认理解：
- **CLI 人类用户**：输出从扁平变分区是**期望的新功能**（用户明确要的「分区显示」），不算回归。
- **MCP JSON 消费方（AI agent）**：结果结构从 `{ results: [...] }` 统一变为 `{ partitions: { ... } }` **是破坏性变更**，用户接受（自有系统可同步适配）。
- **统一结构**：无论是否传 `--tags`，输出始终为 `partitions` 结构。传 `--tags ki-search` 时 partitions 只含该 tag 的分区。

## 3. 技术需求清单

### REQ-11：向量配置独立化 + YAML 格式迁移（新增）

**现状**：ki 的 `~/.ki/config.json` 只有 `dataDir/backupDir/scopes`，完全没有向量相关配置；embedding provider（apiKey/model/维度）、向量 db 路径、scope 定义全部读 mem 的 `config.yaml`（`mem-client.ts:372 readMemConfigScopes`）。去掉 mem 后这些必须由 ki 接管。同时配置文件从 JSON 迁移为 YAML（支持注释描述，见 REQ-15 `ki init`）。

**目标配置结构**（`~/.ki/config.yaml`）：

```yaml
# ─── 基础路径 ───
# KB 源数据目录（存放各 scope 的 markdown / ai-results.json / group-index.json）
dataDir: ~/.ki/data
# 备份目录（snapshot tar.gz 存放位置）
backupDir: ~/.ki/backup

# ─── 向量配置（新增） ───
# zvec collection 目录（独立，不进备份；所有 scope 共享一个 collection，靠 metadata 隔离）
vectorDir: ~/.ki/vector
# Embedding 提供方配置
embedding:
  provider: siliconflow          # 或 "openai-compatible"
  baseURL: https://api.siliconflow.cn/v1
  model: Qwen/Qwen3-Embedding-8B
  dimension: 4096                # 必须与基座模块 schema 一致
  # apiKey 不写这里，从环境变量 SILICONFLOW_API_KEY 读取

# ─── KB 目录映射（保留，向量 scope 隔离由 zvec metadata 替代） ───
scopes:
  # 默认 scope：未传 --scope 时使用；未配置的 scope 继承此配置
  default:
    kbDir: ~/.ki/data/default    # KB 数据目录（缺省 fallback: dataDir/{scope}）
    sourceDir: ~/projects/my-wiki # 源文件目录（wiki-sync / diff / import 依赖）
    rootName: wiki               # Group 树根名
    # wikiSync:                  # 可选：Wiki 自动同步
    #   enabled: true
    #   sourceDir: ~/projects/my-wiki
  # 已配置的 scope 使用自身配置
  my-project:
    kbDir: ~/.ki/data/my-project
    sourceDir: ~/projects/another-wiki
    rootName: docs
```

**要点**：
- **配置格式迁移**：JSON → YAML。`config.ts` 的 `parseAndExpand` 改用 YAML parser（如 `yaml` npm 包）。旧 `config.json` 自动检测并提示迁移（不自动转换，避免数据丢失）。
- **apiKey 落点**：env 优先（`SILICONFLOW_API_KEY`），config 兜底。缺失时按 REQ-03「清晰报错」抛 `ConfigError`，不静默失败。
- **vectorDir**：一个目录，放一个 zvec collection（所有 scope 共享，靠 metadata `scope` 字段隔离）。对齐基座模块 §0「单集合句柄」模型。
- **scopes 保留**：`scopes` 字段保留 KB 目录映射职责（`kbDir`/`sourceDir`/`rootName`/`wikiSync`），向量 scope 隔离由 zvec metadata 替代（见 REQ-14 继承机制）。
- **配置校验**：启动时校验 `embedding.dimension === 4096`（对齐基座模块 §0 维度决策）、apiKey 可达性。
- **向后兼容**：检测到旧 `config.json` 时提示用户执行 `ki init` 迁移；`scopes` 字段语义完全兼容，无需迁移。

**验收标准**：
- `config.ts` 能解析 YAML 格式配置
- `ki config` 展示新格式（含 vectorDir/embedding/scopes）
- 缺 apiKey 时清晰报错（不静默返回空结果）
- 检测到旧 `config.json` 时提示迁移（不自动转换）

---

### REQ-12：CLI↔MCP server 通信通道 + per-call 兜底（新增）

**现状**：`ki search`/`ki store` 等 CLI 命令是短命 Node 进程，当前 spawn `mem` CLI。换 zvec 后有两个问题：
1. zvec 文件锁排他（基座模块 v6 实测：MCP server 持有 collection 时 CLI 无法再 open，连 read-only 也冲突）
2. 每次 open 加载 jieba 词典 ~700ms-1s（CLI 短命进程无法摊销）

**目标架构（Q0=C）**：

```
正常路径（server 运行中）：
  ki search → [检测 server 是否运行] → 是 → MCP client 协议发请求 → server（热 worker）→ <10ms 返回

兜底路径（server 未运行）：
  ki search → [检测 server 是否运行] → 否 → ZvecEngine.open() 临时开 worker → ~1s 执行 → 关闭
```

**要点**：
- **Server 检测**：PID 文件（`~/.ki/vector/server.pid`）+ 端口/socket 探测。PID 存在但进程已死时清理并走兜底。
- **通信通道**：CLI 使用 MCP client SDK 连本地 server。复用已有工具定义（search/store/bulk_store/...），零额外协议。传输方式：stdio（spawning `ki mcp --serve`）或 Unix socket / HTTP（取决于 MCP SDK 支持度，设计阶段定）。
- **兜底路径**：复用基座模块 `ZvecEngine.open()` + `ZvecEngine.probe()`（检测锁/损坏）。兜底时如果 server 持有锁（PID 活但 socket 不通），等待超时后报清晰错误。
- **CLI 命令覆盖**：所有需要向量能力的 CLI 命令都走此通道——直接调用向量的 CLI 命令：`search`/`store`/`bulk_store`/`sync-relation`/`query-group`/`get-module-info`/`import-kb`/`manage-index`/`delete-relation`；库函数（被 CLI 命令调用）：`path-search`/`path-vectorize`/`batch-vectorize`/`incremental`/`group-resolve`。
- **纯 KB 操作不受影响**：`scan-kb`/`migrate-keywords`/`backup`/`restore`/`export`/`config` 不涉及向量，不走此通道。

**验收标准**：
- server 运行时：CLI 命令 <10ms 完成
- server 未运行时：CLI 命令 ~1s 完成（不报错）
- server PID 死亡：自动清理 PID 文件，走兜底路径

---

### REQ-13：多标签默认检索 + 统一分区输出（新增，扩展 REQ-05）

**现状**：
- `ki search --tags` 默认 `ki-search`（单值），输出 `{ ok, results: [] }` 扁平数组
- 标签过滤靠 `content.includes('【标签:xxx】')` 客户端文本 hack（`mem-client.ts:170`）
- 内部调用（path-search 查 `ki-path`、query-group 查 `ki-path`）是单标签

**目标**：
- **默认多标签**：`ki search` 不传 `--tags` → 默认查 `[ki-search, ki-path, ki-relation]`
- **统一分区输出**：无论是否传 `--tags`，输出始终为 `partitions` 结构：

```jsonc
// 不传 --tags（默认三标签分区）
{
  "ok": true,
  "partitions": {
    "ki-search":   [ { "id": "...", "score": 0.95, "content": "...", "scope": "default", ... } ],
    "ki-path":     [ { "id": "...", "score": 0.88, "content": "...", "scope": "default", ... } ],
    "ki-relation": [ { "id": "...", "score": 0.82, "content": "...", "scope": "default", ... } ]
  }
}

// 传 --tags ki-search（单标签，仍是 partitions 结构）
{
  "ok": true,
  "partitions": {
    "ki-search": [ { "id": "...", "score": 0.95, "content": "...", "scope": "default", ... } ]
  }
}
```

- **CLI 人类输出**：分区显示，每个分区有标题（`=== ki-search ===`）+ 结果列表。
- **标签升为一等字段**：tag 从 content 文本 hack 升为 zvec metadata 标量字段 `tags`（数组），检索用 metadata 过滤（`tags IN ['ki-search']`）。**但** content 文本格式保持不变（`【标签:xxx】` 前缀保留），因为 `extractPathFromContent`（path-search.ts:133）依赖它。
- **内部调用**：path-search 查 `ki-path`、query-group 查 `ki-path` 等内部调用通过底层 `ZvecEngine.hybridSearch` 直接获取扁平结果（不走分区封装），保持简洁。**分区封装仅在顶层 `ki search` / MCP search 工具层应用**。

**验收标准**：
- 不传 `--tags`：返回 `partitions` 结构，含 3 个分区
- 传 `--tags ki-search`：返回 `partitions` 结构，含 1 个分区（ki-search）
- 不同标签检索互不串扰（REQ-05 验收标准不变）
- content 文本格式不变（path-search/relation 抽取不受影响）
- 内部调用（path-search/query-group）仍获取扁平结果，不受分区封装影响

---

### REQ-14：scope 运行时化 + 配置继承（新增）

**现状**：scope 在 `~/.ki/config.json` 预声明（`config.ts` 的 `KiConfig.scopes: Record<string, ScopeConfig>`）：
```jsonc
{
  "scopes": {
    "default":     { "kbDir": "...", "sourceDir": "...", "rootName": "..." },
    "my-project":  { "kbDir": "...", "sourceDir": "...", "rootName": "..." }
  }
}
```
`scopes` 同时承载两类职责：①向量 scope 隔离（本次由 zvec metadata 替代）②KB 目录映射 kbDir/sourceDir/rootName/wikiSync（**保留**）。此外 `mem-client.ts` 从 mem 的 `~/.config/memory-mcp/config.yaml` 读取 scope 列表（`readMemConfigScopes`，line 372），`ensureMemScope` 会校验 scope 是否存在。

**目标**：
- **向量 scope 自动创建**：`ki store --scope my-new-scope` 直接写入 `scope: "my-new-scope"` metadata，向量层面无需预声明。`ensureMemScope` 校验移除（scope 不再需要预先存在）。
- **KB 配置继承**：`scopes` 配置保留，但新增 **三级 fallback** 解析规则：
  1. `scopes[scope]` 已配置 → 使用自身配置（kbDir/sourceDir/rootName/wikiSync）
  2. `scopes[scope]` 未配置 → **继承 `scopes["default"]` 的配置**
  3. `scopes["default"]` 也未配置 → 现有 fallback（`getScopeDataDir` → `dataDir/{scope}`，其余返回 null）
- **默认 scope**：不传 `--scope` 时使用 `"default"`（硬编码）
- **MCP server 无 scope 参数**：启动时打开唯一 zvec collection，不绑定 scope；scope 过滤在每次 query 时按 metadata 执行
- **scope 查询**：需要列举已有 scope 时，查 zvec collection 的 distinct `scope` metadata 值（而非仅读 config）

**config.ts 改造点**（4 个函数加继承逻辑）：
- `getScopeDataDir(config, scope)`：已 有 `dataDir/{scope}` fallback，增加 `scopes["default"].kbDir` 中间层
- `getScopeSourceDir(config, scope)`：增加 `scopes["default"].sourceDir` fallback
- `getScopeRootName(config, scope)`：增加 `scopes["default"].rootName` fallback
- `getScopeWikiSync(config, scope)`：增加 `scopes["default"].wikiSync` fallback

**与基座模块的契合**：基座模块 §0「单集合句柄：scope 用 metadata 过滤隔离」——向量 scope 隔离完全由 metadata 处理，config 中的 scopes 仅服务于 KB 目录映射，两者职责分离。

**验收标准**：
- 任意 scope 名称可直接用于向量操作（store/search），无需预配置
- 未配置的 scope 的 KB 目录映射继承 default scope 配置
- 已配置的 scope 使用自身配置，不受继承影响
- 不传 `--scope` 时使用 `"default"`
- MCP server 启动不需要 scope 参数
- `ki config` 仍显示 scopes 配置（含 default）

---

### REQ-15：配置文件初始化 `ki init`（新增）

**现状**：无配置初始化命令。用户首次使用时需手动创建 `~/.ki/config.json`，或依赖 `config.ts` 的 `buildDefaults()` 静默使用默认值（仅打印 stderr 提示）。配置格式为 JSON，不支持注释，用户难以理解各字段含义。

**目标**：
- **`ki init` 命令**：交互式或一键生成 `~/.ki/config.yaml`，包含所有配置项的注释描述和示例值
- **生成的配置文件**：每个字段都有行内注释说明用途、缺省值、是否必填
- **交互模式**（无参数）：逐步询问关键配置（dataDir / vectorDir / embedding provider / apiKey 来源 / default scope 的 sourceDir + rootName），其余用默认值
- **一键模式**（`ki init --yes`）：全部使用默认值，直接生成配置文件
- **已存在检测**：配置文件已存在时提示「已存在，是否覆盖？」，默认不覆盖
- **旧格式迁移提示**：检测到 `~/.ki/config.json` 时提示「检测到旧版 JSON 配置，建议执行 `ki init` 重新生成 YAML 配置」

**生成的配置文件示例**（`ki init` 产出）：

```yaml
# KiSearch 配置文件
# 生成时间: 2026-07-21T12:00:00Z
# 文档: https://github.com/your-repo/knowledge-indexer

# ─── 基础路径 ───
# KB 源数据目录：存放各 scope 的 markdown / ai-results.json / group-index.json
dataDir: ~/.ki/data

# 备份目录：snapshot tar.gz 存放位置
backupDir: ~/.ki/backup

# ─── 向量配置 ───
# zvec collection 目录：向量数据库存储位置（独立，不进备份）
# 所有 scope 共享一个 collection，靠 metadata 字段隔离
vectorDir: ~/.ki/vector

# Embedding 提供方配置
# apiKey 从环境变量 SILICONFLOW_API_KEY 读取，不写在此文件中
embedding:
  provider: siliconflow              # embedding 提供方: siliconflow | openai-compatible
  baseURL: https://api.siliconflow.cn/v1  # API 端点
  model: Qwen/Qwen3-Embedding-8B    # 模型名称
  dimension: 4096                    # 向量维度（必须与建库时一致）

# ─── KB 目录映射 ───
# 每个 scope 可配置 KB 目录映射；未配置的 scope 自动继承 default 的配置
scopes:
  # 默认 scope：未传 --scope 时使用
  default:
    kbDir: ~/.ki/data/default        # KB 数据目录（缺省: dataDir/{scope}）
    sourceDir: ~/projects/my-wiki    # 源文件目录（wiki-sync / diff / import 依赖）
    rootName: wiki                   # Group 树根名
    # wikiSync:                      # 可选: Wiki 自动同步
    #   enabled: true
    #   sourceDir: ~/projects/my-wiki
```

**要点**：
- **新增 CLI 命令**：`ki init`（在 `bin/ki.mjs` 的 COMMANDS 映射中添加 `init: 'scripts/init.ts'`）
- **YAML 输出**：使用 `yaml` npm 包序列化，保留注释（或用模板字符串拼接带注释的 YAML）
- **目录创建**：`ki init` 同时创建 `dataDir`/`backupDir`/`vectorDir` 目录（如不存在）
- **与 REQ-11 协同**：`ki init` 是 REQ-11 YAML 格式迁移的用户入口

**验收标准**：
- `ki init --yes` 生成完整 `~/.ki/config.yaml`，含所有字段 + 注释
- `ki init`（交互模式）逐步询问关键配置
- 配置文件已存在时提示是否覆盖
- 生成的配置文件可被 `config.ts` 正确解析
- 同时创建 dataDir/backupDir/vectorDir 目录

---

### REQ-16：配置诊断 `ki doctor` + MCP 启动检查（新增）

**现状**：无配置诊断命令。配置错误（apiKey 缺失、URL 不通、维度不匹配、目录不存在等）只在运行时暴露，用户难以快速定位问题。`ki mcp` 启动时也不做配置预检，启动后才发现 embedding 不可用或 zvec db 路径错误。

**目标**：

#### `ki doctor` 命令

一键诊断所有配置项，输出结构化检查报告：

| 检查项 | 检查内容 | 通过 | 失败 |
|---|---|---|---|
| 配置文件 | `~/.ki/config.yaml` 存在且可解析 | ✅ 格式正确 | ❌ 不存在 / YAML 语法错误 |
| dataDir | 目录存在且可写 | ✅ | ❌ 不存在 / 无写权限 |
| backupDir | 目录存在且可写 | ✅ | ❌ 同上 |
| vectorDir | 目录存在且可写 | ✅ | ❌ 同上 |
| embedding.apiKey | 环境变量 `SILICONFLOW_API_KEY` 存在 | ✅ | ❌ 未设置 |
| embedding.URL 连通性 | `baseURL/embeddings` 可达（HEAD 或最小 embedding 请求） | ✅ 响应正常 | ❌ 连接超时 / 404 / DNS 解析失败 |
| embedding.密钥有效性 | 用 apiKey 发送 1 条最小 embedding 请求验证 | ✅ 返回向量 | ❌ 401 Unauthorized / 403 Forbidden |
| embedding.维度 | 返回向量维度 === config.dimension | ✅ 一致 | ❌ 不一致（需改 config 或换 model） |
| zvec collection | vectorDir 下 collection 存在且可 open | ✅ | ⚠️ 首次使用，未创建（正常） |
| scopes.default | default scope 配置存在 | ✅ | ⚠️ 未配置 default，新 scope 将无 KB 目录映射可继承 |

**输出示例**：

```
KiSearch 配置诊断
━━━━━━━━━━━━━━━━
✅ 配置文件     ~/.ki/config.yaml 格式正确
✅ dataDir      ~/.ki/data 存在且可写
✅ backupDir    ~/.ki/backup 存在且可写
✅ vectorDir    ~/.ki/vector 存在且可写
✅ apiKey       SILICONFLOW_API_KEY 已设置
✅ URL 连通性   https://api.siliconflow.cn/v1/embeddings 可达
✅ 密钥有效性   embedding 请求成功（维度 4096）
✅ 维度匹配     config=4096, 实际=4096
⚠️ zvec collection  首次使用，未创建（执行 ki store 后自动创建）
✅ scopes.default  已配置

诊断结果: 8 通过, 1 警告, 0 失败
```

#### `ki mcp` 启动时配置检查

`ki mcp` 启动时自动执行 `ki doctor` 的检查逻辑：
- **全部通过**：正常启动 server
- **有警告（⚠️）**：打印警告信息，正常启动（如 zvec collection 未创建是正常的）
- **有失败（❌）**：打印失败原因，**拒绝启动**，提示用户运行 `ki doctor` 排查或 `ki init` 重新配置

**要点**：
- **新增 CLI 命令**：`ki doctor`（在 `bin/ki.mjs` 的 COMMANDS 映射中添加 `doctor: 'scripts/doctor.ts'`）
- **检查逻辑复用**：`ki mcp` 启动检查与 `ki doctor` 共用同一套检查函数（`scripts/lib/health-check.ts`）
- **embedding 连通性检查**：发送 1 条最短文本（如 `"test"`）的 embedding 请求，验证 URL + 密钥 + 维度三合一
- **非破坏性**：`ki doctor` 不修改任何配置或数据，纯只读检查
- **超时控制**：URL 连通性检查超时 5s，避免网络不通时长时间卡住

**验收标准**：
- `ki doctor` 输出结构化检查报告，含每项的 ✅/❌/⚠️ 状态
- embedding URL 不通时清晰报错（不超时卡死）
- apiKey 缺失时清晰报错
- 维度不匹配时报错（config=4096 vs actual=XXX）
- `ki mcp` 启动时自动执行检查，有 ❌ 时拒绝启动
- `ki mcp` 启动检查有 ⚠️ 时打印警告但正常启动

## 4. 现有 REQ 扩展映射

| 现有 REQ | 原始描述 | 本次扩展 |
|---|---|---|
| REQ-01 | zvec 引擎层封装 | ✅ 已完成（基座模块）。上层适配见 REQ-12 |
| REQ-02 | 常驻 MCP server | + server 同时服务 MCP 客户端和 CLI（REQ-12）+ 启动时配置预检（REQ-16） |
| REQ-03 | Embedding 集成 | + 独立配置（REQ-11），不再读 mem 的 config.yaml |
| REQ-04 | 原生混合检索 | ✅ 基座模块已支持 |
| REQ-05 | 三层标签/scope 隔离 | + 多标签默认（REQ-13）+ scope 运行时化（REQ-14） |
| REQ-06 | 写入流水线迁移 | + sync→async 迁移（14 个文件：9 直接 import + 3 直接调 CLI + 2 间接）+ memoryId→docId 映射 |
| REQ-07 | 性能验收 | 范围不变，e2e 已通过 |
| REQ-08 | path-search 兜底 | + content 文本格式保持不变（path-search/relation 抽取依赖） |
| REQ-09 | MCP 生命周期/监管 | 范围不变 |
| REQ-10 | 向后兼容 | + CLI 命令接口不变 + 备份/恢复不受影响 + 输出结构变更（已确认接受）+ 配置格式 JSON→YAML（`ki init` 迁移） |

## 5. 不变量与兼容性边界

### 必须不变

| 不变量 | 说明 | 验证方式 |
|---|---|---|
| CLI 命令接口 | `ki search --query X`、`ki store --scope Y` 等命令和参数不变 | e2e 回归 |
| 备份内容 | backup 只打包 KB 源目录（markdown + ai-results.json），不含向量 | backup.ts 不改 |
| 恢复流程 | restore-from-results 重放 ai-results 触发重向量化 | restore.ts 适配新引擎 |
| content 文本格式 | `【标签:xxx】` 前缀 + path/relation 文本格式不变 | path-search/relation 抽取不变 |
| 内部单标签调用 | path-search 查 `ki-path`、query-group 查 `ki-path` 等保持单标签 | 内部调用不走多标签默认 |
| scope 隔离语义 | 不同 scope 数据不串扰 | metadata 过滤 |

### 有意变更（用户确认接受）

| 变更项 | 旧 | 新 | 影响 |
|---|---|---|---|
| 默认检索标签 | `ki-search` 单标签 | `[ki-search, ki-path, ki-relation]` 三标签 | 顶层 `ki search` 行为变化 |
| 输出结构 | `{ results: [...] }` 扁平 | `{ partitions: { ... } }` 统一分组 | MCP JSON 消费方需适配 |
| scope 配置 | config.json 预声明，未配置不可用 | 向量 scope 自动创建（metadata）；未配置 scope 继承 default 的 KB 目录映射 | 未配置 scope 也可使用 |
| 向量配置 | 寄生 mem config.yaml | ki config.yaml 独立持有 | 新增配置字段 |
| 配置格式 | JSON（config.json） | YAML（config.yaml）+ `ki init` 初始化 | 支持注释描述 |
| 配置诊断 | 无（运行时暴露错误） | `ki doctor` 一键诊断 + `ki mcp` 启动预检 | 快速定位配置问题 |
| 底层引擎 | spawnSync `mem` CLI | 进程内 ZvecEngine（async） | 内部全异步化 |
| 底层引擎 | spawnSync `mem` CLI | 进程内 ZvecEngine（async） | 内部全异步化 |

## 6. 底层引擎适配细节（REQ-06 扩展）

### 6.1 mem-client.ts 替换面

`mem-client.ts` 对外导出 **10 个函数**（memSearch / memStore / memStoreAsync / memBulkStore / checkMemAvailable / ensureMemAvailable / getMemScopes / checkMemScope / ensureMemScope / resetMemScopesCache），另有 1 个内部函数 `readMemConfigScopes`。

消费方分三类：

**A. 直接 import mem-client.ts 的文件（9 个）**：

| 消费方 | 调用的 mem 函数 | 适配要点 |
|---|---|---|
| search.ts | memSearch | → ZvecEngine.hybridSearch，多标签分区 |
| store.ts | memStore | → ZvecEngine.upsert，tag 升为 metadata |
| bulk-store.ts | memBulkStore | → ZvecEngine.upsert (批量)，保留 ok/errors/skipped 汇总 |
| sync-relation.ts | memStoreAsync | → upsert (async)；memoryId→docId 回写链 |
| delete-relation.ts | memSearch | → hybridSearch |
| query-group.ts | memSearch (ki-path) | → hybridSearch(tag=ki-path) |
| manage-index.ts | ensureMemAvailable | → ensureVectorAvailable；含 mem delete 级联删除 |
| lib/import.ts | ensureMemScope | → 移除（scope 运行时化后无需校验） |
| lib/incremental.ts | ensureMemScope | → 移除（同上） |

**B. 绕过 mem-client.ts、直接 `execFileSync('mem')` 调用 mem CLI 的文件（3 个）**：

| 消费方 | 直接调用的 mem 命令 | 适配要点 |
|---|---|---|
| lib/path-search.ts | `mem search`（execFileSync） | → ZvecEngine.hybridSearch(tag=ki-path)；extractPathFromContent 保留 |
| lib/path-vectorize.ts | `mem store` / `mem search` / `mem delete`（execFileSync） | → upsert / hybridSearch / delete |
| lib/batch-vectorize.ts | `mem store` / `mem delete`（execFileSync） | → upsert / delete |

**C. 通过 path-search.ts 间接使用 mem 的文件（2 个）**：

| 消费方 | 间接调用路径 | 适配要点 |
|---|---|---|
| get-module-info.ts | → searchPath() → mem search | path-search 适配后自动受益 |
| lib/group-resolve.ts | → searchPath() → mem search | 同上 |

**总计 14 个文件需要适配**（9 直接 import + 3 直接调 CLI + 2 间接）。

### 6.2 sync → async 迁移

- `memSearch`/`memStore` 是 `spawnSync`（同步）；`ZvecEngine` 所有方法是 Promise（worker actor 模型）
- A 类（9 个直接 import 文件）和 B 类（3 个直接 execFileSync 文件）的调用链需改 async；C 类（2 个间接文件）随 path-search 适配自动受益
- **对用户接口无影响**：CLI action 可 async（Commander.js 支持）、MCP handler 本就是 async
- 内部改动面大但机械（加 `await` + 函数签名加 `async`）

### 6.3 memoryId → docId 映射

- mem 返回 `memoryId`，`sync-relation` 会回写进 KB（REQ-06）
- zvec 用 doc `id`（由上层生成或用 hash）
- **映射策略**：doc id 直接用原 memoryId 的生成规则（内容 hash 或 `ki-{tag}-{hash}`），保证回写链不断
- sync-relation 的回写逻辑不需改，只是 id 来源从 mem 换成 ZvecEngine 返回

### 6.4 可用性降级

- 当前：`ensureMemAvailable`（`execFileSync('mem', ['--version'])` 检测）→ 缺失时报错
- 重构后：`ensureVectorAvailable` = embedding 可达 + db 可开
  - server 模式：server 启动时校验
  - 兜底模式：CLI per-call open 时校验
  - 缺失时清晰报错（不静默返回空）

## 7. 风险与关键路径

| 风险 | 影响 | 缓解 |
|---|---|---|
| CLI↔server 通信通道实现复杂度 | REQ-12 工作量不确定 | 设计阶段先验证 MCP client SDK 的 stdio/socket 通信能力 |
| jieba 加载 ~1s（兜底路径） | CLI 兜底时慢 | 可接受（比现状 4s 好）；未来可考虑 jieba 词典缓存/延迟加载 |
| async 迁移遗漏 | 某条调用链忘记 await 导致返回 Promise 而非结果 | TypeScript 编译期检查 + e2e 回归 |
| memoryId 回写链断裂 | sync-relation 找不到已写入的 relation | doc id 用原 memoryId 生成规则，保证一致性 |
| zvec 文件锁竞争 | server 运行时 CLI 兜底路径 open 失败 | 兜底路径先 probe 锁状态；锁冲突时引导用户检查 server |
| 旧 config.json 兼容 | 升级用户缺 vectorDir/embedding 字段 | 缺字段时用默认值 + 清晰警告；scopes 完全兼容无需迁移 |

## 8. 依赖关系

```
REQ-11（向量配置 + YAML）─┬→ REQ-15（ki init 初始化）
                         ├→ REQ-16（ki doctor 诊断 + MCP 启动检查）
                         ├→ REQ-12（CLI↔server 通道）
                         ├→ REQ-13（多标签分区）→ REQ-05 扩展
                         └→ REQ-14（scope 运行时化）→ REQ-05 扩展

REQ-01（基座模块）✅ 完成 → REQ-06 扩展（引擎适配 + async 迁移）
```

实施顺序建议：
1. REQ-11（向量配置 + YAML 格式）— 一切的前置
2. REQ-15（ki init 初始化）— 与 REQ-11 同步，提供配置生成入口
3. REQ-16（ki doctor 诊断）— 与 REQ-11/15 同步，提供配置验证入口
4. REQ-14（scope 运行时化 + 继承）— 与 REQ-11 同步，简化配置
5. REQ-06 扩展（引擎适配 + async 迁移）— 核心工作量大头
6. REQ-12（CLI↔server 通道）— 在引擎适配完成后接线
7. REQ-13（多标签分区）— 最后做，依赖引擎适配完成

## 9. 下一步建议

1. **`design-craft`**：基于本需求挖掘报告做技术设计，重点设计：
   - CLI↔server 通信通道架构（stdio vs socket vs HTTP）
   - mem-client.ts → ZvecEngine 适配层接口设计
   - 多标签分区输出的 MCP 工具 schema 变更
   - config.ts 改造（新格式 + 旧格式兼容）
2. **`work-breakdown`**：拆分实施工作项，引擎适配（14 个文件 async 迁移）可并行化
3. **`dependency-docs`**：整理 MCP client SDK 的通信能力文档（REQ-12 前置）
