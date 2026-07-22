# KiSearch

> AI Agent 知识索引整理工具 - 对外部知识进行结构化索引和导航

基于 [memory-lancedb-mcp](https://github.com/HACK-WU/memory-lancedb-mcp) 项目的知识索引模块独立而来。

## 这是什么

`KiSearch` 是一个独立的 AI Agent 知识索引工具，解决的是一个更贴近 Agent 使用体验的问题：

- **向量数据库**擅长语义召回、长期持久化、跨会话记忆治理
- **知识索引**擅长把项目知识组织成 AI 更容易浏览和落地使用的结构化视图

两者组合后，形成一个完整系统：

- **发现层**：向量数据库负责语义检索、长期存储、冷热治理
- **交付层**：`KiSearch` 负责 Group 导航、热门 Relation 缓存、原文交付

换句话说，向量数据库更像"**长期记忆引擎**"，而 `KiSearch` 更像"**面向 Agent 的知识目录与本地交付层**"。

## 特性

- **本地知识目录层**：在向量数据库之上提供结构化导航和热关系缓存
- **向量语义兜底**：精确 Group 路径未命中时，自动通过向量搜索模糊定位，支持部分名称/近似表述
- **TypeScript 直接执行**：使用 jiti 运行时，无需编译步骤
- **CLI 驱动**：所有操作通过命令行接口完成
- **MCP 协议支持**：启动 `ki mcp` 即可通过 stdio 传输向 AI Agent 暴露 8 个 MCP 工具
- **独立部署**：可独立安装和使用，通过 `mem` CLI 命令调用向量存储

## 文档导航

### AI Agent Skills

> **`skills/`** — Agent 行为规则，按需加载。加载顺序见 [`rules/ai-codekb-memory.md`](./rules/ai-codekb-memory.md)。

| Skill | 场景 | 核心能力 |
|-------|------|---------|
| [**ki-foundation**](./skills/ki-foundation/SKILL.md) | 前置知识（必读） | ki 架构心智模型 + 命令参考 |
| [**codekb-skill**](./skills/codekb-skill/SKILL.md) | 代码知识库检索/写入 | 四步走查询 + 白名单/黑名单 |
| [**memory-skill**](./skills/memory-skill/SKILL.md) | 项目记忆/用户画像读写 | 归档机制 + 自动沉淀 + Group 结构 |

```
涉及项目知识？
  ├─ 否 → 不加载
  └─ 是 → 已加载过 ki-foundation？→ 否 → 按顺序加载：
      ① ki-foundation  （必读前置）
      ② codekb-skill  （代码知识场景）
         memory-skill  （项目记忆/用户偏好场景）
```

### 操作指南

| 文档 | 场景 |
|------|------|
| [`docs/build-kb.md`](./docs/build-kb.md) | 首次构建知识索引 |
| [`docs/update-kb.md`](./docs/update-kb.md) | 增量更新知识索引 |
| [`docs/query-kb.md`](./docs/query-kb.md) | 知识库查询 |
| [`docs/manage-index.md`](./docs/manage-index.md) | 索引结构管理 |
| [`docs/verify-index.md`](./docs/verify-index.md) | 验证操作结果 |

### Agent 行为规则（完整版）

| 文档 | 覆盖范围 |
|------|----------|
| [`docs/codekb-agent-guide.md`](./docs/codekb-agent-guide.md) | 代码知识库：四步走、白名单/黑名单、ki_search 语义兜底、写入 KB 规则 |
| [`docs/memory-agent-guide.md`](./docs/memory-agent-guide.md) | 记忆系统：归档机制、自动沉淀、Group 结构、用户画像 |
| [`docs/ki-command-guide.md`](./docs/ki-command-guide.md) | 公共命令参考：query-group / get-module-info / sync-relation / manage-index / search / store |

### 设计文档与架构

- **架构与协作关系**：[`docs/architecture.md`](./docs/architecture.md)
- **CLI 参考**：[`docs/cli.md`](./docs/cli.md)
- **scan-kb 子命令详解**：[`docs/scan-kb.md`](./docs/scan-kb.md)
- **异常处理与恢复建议**：[`docs/error-handling.md`](./docs/error-handling.md)
- **典型工作流**：[`docs/workflows.md`](./docs/workflows.md)
- **备份与恢复**：[`docs/backup-restore.md`](./docs/backup-restore.md)
- **记忆系统需求**：[`docs/memory-system-requirements.md`](./docs/memory-system-requirements.md)
- **数据流图**：[`docs/memory-system-dataflow.md`](./docs/memory-system-dataflow.md)

## 核心概念

| 概念 | 含义 |
|------|------|
| `scope` | 项目隔离标识，不同 scope 物理隔离 |
| `Group` | 知识分组路径，例如 `项目/API`、`项目/前端/状态管理` |
| `Relation` | 某个 Group 下可被检索和命中的知识条目 |
| `module-info` | Relation 对应的 Markdown 原文说明 |
| 热门 Relation | 被频繁访问、优先展示的本地知识 |
| 关键词词云 | 为 AI 组装检索语句提供的自然语言提示 |
| 标签（Tag） | `ki-search`（通用语义搜索）、`ki-path`（路径级搜索）、`ki-relation`（关系检索）三层标签，指定标签可显著提升查询准确率 |

## 快速开始

### 前置条件

1. **全局安装 `mem` 命令**：知识索引的所有向量化操作都依赖 `mem` 命令，请先通过全局安装确保 `mem` 可用：
   ```bash
   curl -fsSL https://raw.githubusercontent.com/HACK-WU/memory-lancedb-mcp/master/scripts/install-latest.sh -o install-latest.sh
   bash install-latest.sh
   ```

2. **配置嵌入 API**：确保 `~/.config/memory-mcp/config.yaml` 中已配置嵌入 API 密钥。配置文档详见：[memory-lancedb-mcp 配置文档](https://github.com/HACK-WU/memory-lancedb-mcp#configuration-reference)

3. **注册 scope**：首次使用某个 scope 前，需在配置文件中注册该 scope（详见下方"外部知识库导入"部分）。

### 安装

**方式一：使用 install-latest.sh 安装 ki CLI（推荐）**

```bash
# 下载并安装最新版 ki CLI
curl -fsSL https://raw.githubusercontent.com/HACK-WU/KiSearch/master/scripts/install-latest.sh | bash
```

然后通过 `ki setup` 安装配套 Skills / Rules 到项目目录：

```bash
# 单目录安装
ki setup --skills -t ~/projects/my-app
ki setup --rules -t ~/projects/my-app

# 多目录安装
ki setup --skills -t ~/projects/app -t ~/projects/api

# 配置文件方式（创建 ~/.ki-targets，每行一个目录）
ki setup --skills
```

> 💡 如未安装 ki CLI，可用 `skill-install.sh` 作为备用方案。

**方式二：完整安装（开发 & CLI 使用）**

```bash
# 克隆项目
git clone git@github.com:HACK-WU/KiSearch.git
cd KiSearch

# 安装依赖
npm install

# 创建全局链接（支持任意路径执行）
npm link
```

### 配置数据目录

推荐使用配置文件管理数据目录。首次使用时，运行以下命令生成配置模板：

```bash
ki config init
```

配置文件默认生成在 `~/.ki/config.yaml`（YAML 格式，含注释），并同时创建 `dataDir` / `backupDir` / `vectorDir` 目录。生成内容如下：

```yaml
# ─── 基础路径 ───
dataDir: $HOME/.ki-data       # KB 源数据目录
backupDir: $HOME/.ki-backup   # 备份目录

# ─── 向量配置 ───
vectorDir: $HOME/.ki/vector   # zvec collection 目录（所有 scope 共享，靠 metadata 隔离）

# Embedding 提供方（apiKey 从环境变量 SILICONFLOW_API_KEY 读取，不写入此文件）
embedding:
  provider: siliconflow
  baseURL: https://api.siliconflow.cn/v1
  model: Qwen/Qwen3-Embedding-8B
  dimension: 4096             # 向量维度（必须与建库时一致）

# ─── scope 护栏 ───
scopeMode: default            # default: 自动创建 scope；strict: 必须显式注册

scopes:
  default: {}                 # 默认 scope：留空即数据落在 dataDir/default
```

**配置优先级**：
1. `--config <path>` 命令行参数（按扩展名判定 YAML / JSON 解析器）
2. `$HOME/.ki/config.yaml` → `config.yml` → `config.json`
3. 内置默认值

> 注意：
> - 配置格式以 **YAML 为主**，同时保留对旧版 `config.json` 的读取兼容；当自动探测到旧版 JSON 配置时会提示执行 `ki config init` 迁移到 YAML。
> - 环境变量 `KI_DATA_DIR` 已不再作为运行时配置来源；`ki config init` 会自动探测并迁移到配置文件。
> - 生成配置后可执行 `ki doctor` 一键校验配置、目录、API 密钥与向量维度是否就绪。

### 使用示例


```bash
# 1. 初始化索引（创建顶层 Group）
ki manage-index \
  --scope my-project \
  --action create \
  --name "API"

# 2. 创建分组
ki manage-index \
  --scope my-project \
  --action create \
  --parent "我的项目" \
  --name "API"

# 3. 写入一条知识
ki sync-relation \
  --scope my-project \
  --group "我的项目/API" \
  --relation "用户登录接口" \
  --module-info "## 登录流程\n用户输入账号密码后进入认证流程，服务端校验成功后返回 token。" \
  --keywords "登录,认证,token"

# 4. 查询 Group 视图
ki query-group \
  --scope my-project \
  --groups "我的项目/API"

# 5. 列出所有已初始化的 scope
ki manage-index --action list-scopes

# 6. 读取模块原文
ki get-module-info \
  --scope my-project \
  --group "我的项目/API" \
  --relation "用户登录接口"
```

## 命令列表

| 命令 | 说明 |
|------|------|
| `scan-kb` | 统一入口：import / diff / scan / vectorize |
| `manage-index` | Group 树 CRUD + 查询 scope 列表 |
| `query-group` | 查询 Group + 词云 + 分区（支持模糊 Group 路径语义兜底） |
| `get-module-info` | 读取本地 KB 原文（支持模糊 Relation 名称语义兜底） |
| `sync-relation` | 写入 Relation + 关键词校验 |
| `mcp` | 启动 MCP Server（stdio 传输，8 个工具；启动前自动执行健康预检） |
| `config` | 配置管理：init（生成 YAML 配置文件） |
| `doctor` | 配置诊断：校验配置文件/目录/API 密钥/向量维度等，输出 ✅/⚠️/❌ 报告 |
| `backup` | 备份 scope 目录快照 |
| `restore` | 从快照或 ai-results 还原 |
| `export` | 导出 KB 为 Wiki Markdown |
| `import-kb` | @deprecated 旧导入 |
| `migrate-keywords` | 数据迁移 |
| `search` | 语义检索（通过 mem 向量搜索，支持标签过滤） |
| `store` | 向量化存储单条知识 |
| `bulk-store` | 批量向量化存储知识 |

## MCP Server

启动 MCP Server 后，AI Agent 可直接通过标准 MCP 协议使用 ki 的知识索引能力：

```bash
ki mcp
```

> **🩺 启动预检**：`ki mcp` 在启动前会自动执行一次健康检查（等价于 `ki doctor`），报告写入 stderr（不污染 stdio 协议）。若存在 ❌ 失败项（如缺少 API 密钥、向量维度不匹配）将拒绝启动；仅 ⚠️ 警告时继续启动。启动异常时可先运行 `ki doctor` 定位问题。

### MCP 客户端配置

在 MCP 客户端配置中添加：

```json
{
  "mcpServers": {
    "ki": {
      "command": "ki",
      "args": ["mcp"],
      "env": {
        "SILICONFLOW_API_KEY": "<your-api-key>"
      }
    }
  }
}
```

> **⚠️ 注意**：MCP 进程不继承 shell 环境变量（如 `.zshrc` 中的 export），必须通过 `env` 字段显式传入。`SILICONFLOW_API_KEY` 为 mem 向量引擎的 API 密钥。若不配置，向量搜索/存储工具将不可用。KB 数据目录通过配置文件管理（`ki config init`），无需环境变量。

### 暴露的工具

| 工具 | 功能 | 向量标签 |
|------|------|----------|
| `ki_query_group` | 查询 Group 树 + Relations + 词云（语义兜底） | — |
| `ki_get_module_info` | 读取本地 KB Markdown 内容（语义兜底） | — |
| `ki_manage_index_list` | 列出所有 scope | — |
| `ki_manage_index_create` | 创建 Group 节点 | — |
| `ki_sync_relation` | 写入 Relation + 关键词（含向量双写） | `ki-relation` |
| `ki_search` | 语义检索知识库内容 | `ki-search`（默认） |
| `ki_store` | 向量化存储单条知识 | `ki-search` |
| `ki_bulk_store` | 批量向量化存储知识 | `ki-search` |

> MCP 工具集遵循零破坏性约束，不含 delete/force 操作。详见 [CLI 参考 → mcp](./docs/cli.md#mcp)。
>
> **💡 提高查询准确率**：`ki_search` 支持 `tags` 参数按标签过滤。根据查询意图指定标签可**显著提升语义检索准确率**，避免不同知识类型交叉干扰：
> - **通用知识搜索** → 不传或 `tags: "ki-search"`（默认）
> - **文件/路径定位** → `tags: "ki-path"`
> - **关系/归属查询** → `tags: "ki-relation"`

## `ai-results.json` 最小示例

如果你只想先知道 `ai-results.json` 长什么样，可以先看这个最小示例：

```json
{
  "meta": {
    "sourceDir": ".qoder/repowiki/zh/content",
    "rootName": "QoderWiki"
  },
  "entries": [
    {
      "path": "核心概念/Scope 隔离机制.md",
      "groupPath": "QoderWiki/核心概念",
      "relation": "Scope 隔离机制",
      "summary": "Scope 隔离通过服务端 scope 注入、agentId 绕过与 wrapper 层 ACL 检查三段式实现。",
      "keywords": ["Scope", "隔离", "访问控制", "ACL", "agentId"],
      "action": "add"
    }
  ]
}
```

更完整的字段说明、校验规则和导入建议见：[`docs/scan-kb.md`](./docs/scan-kb.md)

## 典型工作流

### 本地知识沉淀

1. `manage-index.ts` 创建 Group
2. `sync-relation.ts` 写入模块说明
3. `query-group.ts` 查看导航与热点
4. `get-module-info.ts` 读取原文回答

### 外部知识库导入（推荐：S-04 统一流程）

> 前置条件：**首次使用某个 `scope` 前**，需在 `~/.config/memory-mcp/config.yaml` 注册该 scope，否则 `mem store` 会提示 `Access denied to scope: <scope>`。
>
> **配置结构说明：**
>
> - `scopes.default`：默认 scope 名称，未指定 scope 时使用，通常设为 `global`。
> - `scopes.definitions`：所有 scope 的定义，每个 key 即 scope 名称，包含：
>   - `description`：该 scope 的用途说明，便于识别。
>   - `acl`：访问控制列表，声明该 scope **允许读取哪些 scope 的数据**。例如 `["global", "mcp-test"]` 表示该 scope 可访问 `global` 和自身的记忆。通常至少包含 `global` 和自身 scope 名。
>
> **示例：多 scope 配置**
>
> ```yaml
> scopes:
>   default: global
>   definitions:
>     mcp-test:
>       description: KiSearch test scope
>       acl:
>         - global
>         - mcp-test
>     qoder-wiki:
>       description: qoder repowiki external KB scope
>       acl:
>         - global
>         - qoder-wiki
> ```
>
> 上面定义了两个 scope：`mcp-test` 用于知识库测试，`qoder-wiki` 用于外部 Wiki 导入。每个 scope 的 `acl` 都包含 `global` 和自身，确保能读取公共记忆与自身数据。

#### 首次导入（2 步）

1. AI 生成 `ai-results.json`（顶层 `meta: { sourceDir, rootName }` + `entries[]`）
2. 一条命令完成：

```bash
ki scan-kb import \
  --scope my-project \
  --results ai-results.json
```

CLI 内部完成：格式校验 → 批量 `mem store` 向量化 → Group 树创建 → `relations-cache` 写入（含 `memoryId`） → `local KB` 写入 → `group-index.source` 块记录（含 git HEAD commit）。

#### 增量更新（3 步）

1. `scan-kb diff --scope my-project` 输出变更文件列表（含已导入条目的 `memoryId`）
2. AI 根据 diff 处理变更，生成增量 `ai-results.json`（每条带 `action: 'add' | 'modify' | 'delete'`）
3. `scan-kb import --scope my-project --mode incremental --results ai-results.json`

增量语义：

- `add`：新增 → 向量化 + 写入索引
- `modify`：更新 → `mem delete <oldId>` + 重新向量化（拿新 id）+ 替换索引
- `delete`：删除 → `mem delete <oldId>` + 移除索引

### 外部知识库导入（旧流程，仍可用）

旧的 7 步流程仍保留兼容：`scan` → `scan --results` → `vectorize` → `memory_store` → `vectorize --complete` → `import-kb`。`vectorize` 子命令已标记 DEPRECATED，建议迁移到 `import` 子命令。

## 约束与边界

- **Scope 隔离**：仅允许字母、数字、连字符、下划线；禁止路径遍历 `../`；不同 scope 物理隔离
- **关键词规则**：仅自然语言词汇，禁止代码符号（类名、方法名、路径等）；关键词必须真实出现在 `module-info` 原文中，避免随意指定关键词
- **数据版本**：所有 JSON 文件包含 `version` 字段，当前版本 1
- **WAL 写入**：所有 JSON 写入采用临时文件 → 原子 rename
- **自动迁移**：读取旧格式 `group-index.json`（`roots`）自动迁移为新格式（`groups`）
- **幂等安全**：重复操作不产生副作用（重复导入覆盖更新）
- **快速失败**：输入校验失败立即退出，不静默降级
- **异常恢复**：运行时数据损坏自动从 `_template/` 恢复

## 开发

```bash
# 运行单个测试
npm test

# 运行所有测试
npm run test:all

# 直接执行脚本
npx jiti scripts/scan-kb.ts --help
```

## 一句话总结

`KiSearch` 和向量数据库不是二选一关系，而是上下分层关系：

- **向量数据库**负责"记得住、搜得到、管得住"
- **KiSearch** 负责"看得见、找得快、交付原文"

两者配合后，AI 才同时具备：

- **长期记忆能力**
- **项目结构化导航能力**
- **本地快速命中能力**
- **可直接回答的原文交付能力**

## License

MIT